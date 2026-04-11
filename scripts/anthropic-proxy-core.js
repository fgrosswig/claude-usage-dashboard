'use strict';
/**
 * Forward proxy: HTTP (client) → HTTPS/HTTP (Anthropic-compatible API host).
 * Logs structured NDJSON; optional heuristic JSONL alignment with Claude/Cursor logs.
 *
 * Not an MITM: clients must set ANTHROPIC_BASE_URL=http://127.0.0.1:<port> (plain HTTP to this proxy).
 */
var fs = require('fs');
var http = require('http');
var https = require('https');
var path = require('path');
var os = require('os');
var crypto = require('crypto');

var DEFAULT_PORT = parseInt(process.env.ANTHROPIC_PROXY_PORT || '8080', 10);
var DEFAULT_UPSTREAM =
  process.env.ANTHROPIC_PROXY_UPSTREAM || 'https://api.anthropic.com';
var MAX_BODY = parseInt(process.env.ANTHROPIC_PROXY_MAX_BODY_MB || '32', 10) * 1024 * 1024;
var MAX_RESPONSE_ACC = parseInt(
  process.env.ANTHROPIC_PROXY_MAX_RESPONSE_MB || '48',
  10
) * 1024 * 1024;
var ALIGN_WINDOW_MS = parseInt(process.env.ANTHROPIC_PROXY_ALIGN_WINDOW_MS || '120000', 10);
var HOME = process.env.USERPROFILE || process.env.HOME || os.homedir();

function pad2(n) {
  return n < 10 ? '0' + n : String(n);
}

function logPathForDay(logDir, d) {
  var day =
    d.getUTCFullYear() +
    '-' +
    pad2(d.getUTCMonth() + 1) +
    '-' +
    pad2(d.getUTCDate());
  return path.join(logDir, 'proxy-' + day + '.ndjson');
}

function appendNdjson(logDir, record) {
  fs.appendFileSync(
    logPathForDay(logDir, new Date()),
    JSON.stringify(record) + '\n',
    'utf8'
  );
}

function redactSecret(s) {
  if (!s || s.length < 10) return '[redacted]';
  return s.slice(0, 7) + '…' + s.slice(-4);
}

function redactHeaders(h) {
  var out = {};
  if (!h) return out;
  for (var k in h) {
    if (!Object.prototype.hasOwnProperty.call(h, k)) continue;
    var kl = k.toLowerCase();
    var v = h[k];
    if (kl === 'x-api-key' || kl === 'authorization' || kl === 'cookie') {
      v = redactSecret(String(Array.isArray(v) ? v.join(',') : v));
    }
    out[k] = v;
  }
  return out;
}

/**
 * Persistiert Anthropic-Policy- / Rate-Limit-Header (z. B. anthropic-ratelimit-unified-*).
 * Siehe Community-Analysen zu 5h/7d-Fenstern; exakte Namen können sich ändern — alles mit Präfix wird mitgenommen.
 */
function extractAnthropicPolicyHeaders(headers) {
  if (!headers || typeof headers !== 'object') return null;
  var out = {};
  for (var k in headers) {
    if (!Object.prototype.hasOwnProperty.call(headers, k)) continue;
    var kl = String(k).toLowerCase();
    if (
      kl.indexOf('anthropic-ratelimit') === 0 ||
      kl.indexOf('anthropic-') === 0 ||
      kl === 'request-id' ||
      kl === 'x-request-id' ||
      kl === 'cf-ray'
    ) {
      var v = headers[k];
      out[k] = Array.isArray(v) ? v.join(', ') : String(v);
    }
  }
  return Object.keys(out).length ? out : null;
}

function buildRequestMeta(req, bodyBuf) {
  var h = req && req.headers ? req.headers : {};
  function pick(name) {
    var a = name.toLowerCase();
    var v = null;
    for (var key in h) {
      if (!Object.prototype.hasOwnProperty.call(h, key)) continue;
      if (String(key).toLowerCase() === a) {
        v = h[key];
        break;
      }
    }
    if (v == null) return null;
    return Array.isArray(v) ? String(v[0]) : String(v);
  }
  return {
    content_length: bodyBuf ? bodyBuf.length : 0,
    anthropic_version: pick('anthropic-version'),
    anthropic_beta: pick('anthropic-beta')
  };
}

function walkJsonl(dir, acc) {
  acc = acc || [];
  try {
    var entries = fs.readdirSync(dir, { withFileTypes: true });
    for (var i = 0; i < entries.length; i++) {
      var fp = path.join(dir, entries[i].name);
      if (entries[i].isDirectory()) walkJsonl(fp, acc);
      else if (entries[i].name.endsWith('.jsonl')) acc.push(fp);
    }
  } catch (e) {}
  return acc;
}

function getAlignRoots() {
  var roots = [];
  var raw = (process.env.ANTHROPIC_PROXY_JSONL_ROOTS || '').trim();
  if (raw) {
    var parts = raw.split(';');
    for (var i = 0; i < parts.length; i++) {
      var t = parts[i].trim();
      if (t) {
        if (t[0] === '~') t = path.join(HOME, t.slice(1).replace(/^\/|\\+/, ''));
        roots.push(path.resolve(t));
      }
    }
  }
  if (roots.length === 0) roots.push(path.join(HOME, '.claude', 'projects'));
  return roots;
}

function readTailUtf8(filePath, maxBytes) {
  try {
    var st = fs.statSync(filePath);
    var start = Math.max(0, st.size - maxBytes);
    var len = st.size - start;
    var fd = fs.openSync(filePath, 'r');
    var buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, start);
    fs.closeSync(fd);
    return buf.toString('utf8');
  } catch (e) {
    return '';
  }
}

/**
 * Find a recent JSONL line with usage near proxyEndIso and matching tokens (weakly).
 */
function alignToJsonl(proxyEndIso, usage, roots, opts) {
  opts = opts || {};
  var windowMs = opts.windowMs != null ? opts.windowMs : ALIGN_WINDOW_MS;
  var tailBytes = opts.tailBytes || 512 * 1024;
  var maxFiles = opts.maxFiles || 48;
  if (!usage || !roots || !roots.length) return null;
  var proxyMs = Date.parse(proxyEndIso);
  if (isNaN(proxyMs)) return null;

  var tout = usage.output_tokens != null ? usage.output_tokens : 0;
  var tin = usage.input_tokens != null ? usage.input_tokens : 0;
  var files = [];
  for (var r = 0; r < roots.length; r++) {
    walkJsonl(roots[r], files);
  }
  files.sort(function (a, b) {
    try {
      return fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs;
    } catch (e) {
      return 0;
    }
  });
  if (files.length > maxFiles) files = files.slice(0, maxFiles);

  var best = null;
  var bestRank = -1e18;

  for (var fi = 0; fi < files.length; fi++) {
    var tail = readTailUtf8(files[fi], tailBytes);
    var lines = tail.split('\n');
    for (var li = 0; li < lines.length; li++) {
      var line = lines[li];
      if (line.indexOf('"usage"') < 0) continue;
      var rec;
      try {
        rec = JSON.parse(line);
      } catch (e) {
        continue;
      }
      var u = rec.message && rec.message.usage;
      if (!u) continue;
      var ts = rec.timestamp || '';
      if (ts.length < 19) continue;
      var tms = Date.parse(ts);
      if (isNaN(tms)) continue;
      var delta = Math.abs(tms - proxyMs);
      if (delta > windowMs) continue;
      var o = u.output_tokens != null ? u.output_tokens : 0;
      var inp = u.input_tokens != null ? u.input_tokens : 0;
      var tokenMatch =
        o === tout && inp === tin ? 3 : Math.abs(o - tout) + Math.abs(inp - tin) <= 24 ? 2 : 1;
      if (tokenMatch === 1 && delta > 45000) continue;
      var rank = tokenMatch * 1e12 - delta + (files[fi].indexOf('subagent') >= 0 ? 0.5 : 0);
      if (rank > bestRank) {
        bestRank = rank;
        best = {
          file: files[fi],
          jsonl_timestamp: ts,
          delta_ms: tms - proxyMs,
          jsonl_output_tokens: o,
          jsonl_input_tokens: inp,
          is_subagent_path: files[fi].toLowerCase().indexOf('subagent') >= 0,
          match_strength: tokenMatch === 3 ? 'exact_tokens' : tokenMatch === 2 ? 'near_tokens' : 'time_only'
        };
      }
    }
  }
  return best;
}

function extractUsageFromJson(obj) {
  if (!obj || typeof obj !== 'object') return null;
  var u = null;
  if (obj.usage && typeof obj.usage === 'object') u = obj.usage;
  else if (obj.message && obj.message.usage) u = obj.message.usage;
  else if (obj.delta && obj.delta.usage) u = obj.delta.usage;
  if (!u) return null;
  // Promote ephemeral sub-fields from cache_creation (message_start event)
  var cc = u.cache_creation;
  if (cc && typeof cc === 'object') {
    if (cc.ephemeral_1h_input_tokens != null) u.ephemeral_1h_input_tokens = cc.ephemeral_1h_input_tokens;
    if (cc.ephemeral_5m_input_tokens != null) u.ephemeral_5m_input_tokens = cc.ephemeral_5m_input_tokens;
  }
  return u;
}

function mergeUsage(into, add) {
  if (!add || typeof add !== 'object') return into;
  into = into || {};
  var keys = [
    'input_tokens',
    'output_tokens',
    'cache_creation_input_tokens',
    'cache_read_input_tokens',
    'ephemeral_1h_input_tokens',
    'ephemeral_5m_input_tokens'
  ];
  for (var i = 0; i < keys.length; i++) {
    var k = keys[i];
    if (add[k] != null) into[k] = add[k];
  }
  return into;
}

/** Parse Anthropic SSE / JSON body for latest usage snapshot */
function usageFromBuffer(buf, contentType) {
  var ct = (contentType || '').toLowerCase();
  var usage = null;
  if (ct.indexOf('text/event-stream') >= 0) {
    var s = buf.toString('utf8');
    var lines = s.split(/\r?\n/);
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (line.indexOf('data:') !== 0) continue;
      var json = line.slice(5).trim();
      if (!json || json === '[DONE]') continue;
      try {
        var o = JSON.parse(json);
        var u = extractUsageFromJson(o);
        usage = mergeUsage(usage, u);
        if (o.type === 'message_delta' && o.usage) usage = mergeUsage(usage, o.usage);
      } catch (e) {}
    }
    return usage;
  }
  try {
    var o = JSON.parse(buf.toString('utf8'));
    return extractUsageFromJson(o);
  } catch (e) {
    return null;
  }
}

function cacheReadRatio(usage) {
  if (!usage) return null;
  var cr = usage.cache_read_input_tokens != null ? usage.cache_read_input_tokens : 0;
  var cc =
    usage.cache_creation_input_tokens != null ? usage.cache_creation_input_tokens : 0;
  var d = cr + cc;
  if (d <= 0) return null;
  return cr / d;
}

function cacheHealthLabel(ratio, usage) {
  if (ratio == null) {
    if (!usage) return 'na';
    var cr0 = usage.cache_read_input_tokens != null ? usage.cache_read_input_tokens : 0;
    var cc0 =
      usage.cache_creation_input_tokens != null ? usage.cache_creation_input_tokens : 0;
    if (cr0 + cc0 <= 0) return 'na';
    return 'unknown';
  }
  if (ratio >= 0.8) return 'healthy';
  if (ratio < 0.4) return 'affected';
  return 'mixed';
}

function responseHintsFromBuffer(buf, contentType) {
  var ct = (contentType || '').toLowerCase();

  // SSE stream: extract stop_reason + content block counts from streamed events
  if (ct.indexOf('text/event-stream') >= 0) {
    var s = buf.toString('utf8');
    var lines = s.split(/\r?\n/);
    var hints = {};
    var toolUse = 0, toolResult = 0, text = 0;
    for (var si = 0; si < lines.length; si++) {
      var sline = lines[si];
      if (sline.indexOf('data:') !== 0) continue;
      var sjson = sline.slice(5).trim();
      if (!sjson || sjson === '[DONE]') continue;
      try {
        var so = JSON.parse(sjson);
        // message_delta contains stop_reason
        if (so.type === 'message_delta' && so.delta) {
          if (so.delta.stop_reason) hints.stop_reason = so.delta.stop_reason;
        }
        // content_block_start contains block types
        if (so.type === 'content_block_start' && so.content_block) {
          var btype = so.content_block.type;
          if (btype === 'tool_use') toolUse++;
          else if (btype === 'tool_result') toolResult++;
          else if (btype === 'text') text++;
        }
      } catch (e) {}
    }
    if (toolUse) hints.response_tool_use_blocks = toolUse;
    if (toolResult) hints.response_tool_result_blocks = toolResult;
    if (text) hints.response_text_blocks = text;
    hints.response_root_type = 'stream';
    return Object.keys(hints).length ? hints : null;
  }

  // JSON response: parse directly
  if (ct.indexOf('application/json') < 0) return null;
  try {
    var o = JSON.parse(buf.toString('utf8'));
    var jHints = {};
    var content = o.content;
    if (Array.isArray(content)) {
      var jToolUse = 0, jToolResult = 0, jText = 0;
      for (var i = 0; i < content.length; i++) {
        var b = content[i];
        if (!b || !b.type) continue;
        if (b.type === 'tool_use') jToolUse++;
        else if (b.type === 'tool_result') jToolResult++;
        else if (b.type === 'text') jText++;
      }
      if (jToolUse) jHints.response_tool_use_blocks = jToolUse;
      if (jToolResult) jHints.response_tool_result_blocks = jToolResult;
      if (jText) jHints.response_text_blocks = jText;
    }
    if (o.stop_reason) jHints.stop_reason = o.stop_reason;
    if (o.type) jHints.response_root_type = o.type;
    return Object.keys(jHints).length ? jHints : null;
  } catch (e) {
    return null;
  }
}

function summarizeRequestBody(buf, logBodies) {
  if (!buf || !buf.length) return { has_body: false };
  var hints = { has_body: true };
  try {
    var o = JSON.parse(buf.toString('utf8'));
    if (o.stream === true) hints.stream = true;
    if (Array.isArray(o.tools) && o.tools.length) {
      hints.tool_defs = o.tools.length;
    }
    if (o.tool_choice && o.tool_choice !== 'none') hints.tool_choice = String(o.tool_choice);
    if (o.model) hints.model = String(o.model);
    if (logBodies) {
      var raw = buf.toString('utf8');
      hints.body_utf8_preview = raw.length > 8192 ? raw.slice(0, 8192) + '…' : raw;
    }
  } catch (e) {
    if (logBodies) {
      hints.body_utf8_preview =
        buf.length > 4096 ? buf.toString('utf8', 0, 4096) + '…' : buf.toString('utf8');
    }
  }
  return hints;
}

function buildUpstreamHeaders(req, targetUrl, bodyLen) {
  var hostHeader = targetUrl.host;
  var out = {};
  var raw = req.headers || {};
  for (var k in raw) {
    if (!Object.prototype.hasOwnProperty.call(raw, k)) continue;
    var kl = k.toLowerCase();
    if (kl === 'host' || kl === 'connection' || kl === 'proxy-connection') continue;
    if (kl === 'content-length') continue;
    out[k] = raw[k];
  }
  out['Host'] = hostHeader;
  out['Content-Length'] = String(bodyLen);
  var xf = req.socket && req.socket.remoteAddress;
  if (xf) {
    var prev = raw['x-forwarded-for'] || raw['X-Forwarded-For'];
    out['X-Forwarded-For'] = prev ? String(prev) + ', ' + xf : xf;
  }
  return out;
}

module.exports = {
  createProxyServer: function (options) {
    options = options || {};
    var port = options.port != null ? options.port : DEFAULT_PORT;
    var upstreamBase = options.upstream || DEFAULT_UPSTREAM;
    var logDir =
      options.logDir ||
      process.env.ANTHROPIC_PROXY_LOG_DIR ||
      path.join(HOME, '.claude', 'anthropic-proxy-logs');
    var alignJsonl =
      options.alignJsonl != null
        ? options.alignJsonl
        : /^1|true|yes|on$/i.test(String(process.env.ANTHROPIC_PROXY_ALIGN_JSONL || ''));
    var logBodies = /^1|true|yes|on$/i.test(String(process.env.ANTHROPIC_PROXY_LOG_BODIES || ''));
    var logStdout = /^1|true|yes|on$/i.test(String(process.env.ANTHROPIC_PROXY_LOG_STDOUT || ''));

    try {
      fs.mkdirSync(logDir, { recursive: true });
    } catch (e) {}

    var targetUrl = new URL(upstreamBase);

    return http.createServer(function (req, res) {
      var reqId = crypto.randomBytes(10).toString('hex');
      var t0 = Date.now();
      var startedIso = new Date(t0).toISOString();

      var bodyChunks = [];
      var bodyLen = 0;
      req.on('data', function (c) {
        bodyChunks.push(c);
        bodyLen += c.length;
        if (bodyLen > MAX_BODY) {
          req.destroy();
          if (!res.headersSent) {
            res.writeHead(413, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('Request body too large for proxy (ANTHROPIC_PROXY_MAX_BODY_MB)');
          }
        }
      });
      req.on('end', function () {
        var bodyBuf = Buffer.concat(bodyChunks);
        var reqHints = summarizeRequestBody(bodyBuf, logBodies);
        var fwdHeaders = buildUpstreamHeaders(req, targetUrl, bodyBuf.length);

        var prot = targetUrl.protocol === 'https:' ? https : http;
        var reqOpts = {
          hostname: targetUrl.hostname,
          port: targetUrl.port || (targetUrl.protocol === 'https:' ? 443 : 80),
          path: req.url,
          method: req.method,
          headers: fwdHeaders
        };
        if (targetUrl.protocol === 'https:') reqOpts.rejectUnauthorized = true;

        var upReq = prot.request(reqOpts, function (upRes) {
          var acc = [];
          var accLen = 0;
          var truncated = false;

          var hopSkip = {
            connection: 1,
            'keep-alive': 1,
            'proxy-authenticate': 1,
            'proxy-authorization': 1,
            'upgrade': 1,
            'transfer-encoding': 1
          };
          var outHdrs = {};
          var rh = upRes.headers || {};
          for (var hk in rh) {
            if (!Object.prototype.hasOwnProperty.call(rh, hk)) continue;
            if (hopSkip[hk.toLowerCase()]) continue;
            outHdrs[hk] = rh[hk];
          }

          res.writeHead(upRes.statusCode || 502, outHdrs);

          upRes.on('data', function (chunk) {
            if (accLen < MAX_RESPONSE_ACC) {
              acc.push(chunk);
              accLen += chunk.length;
              if (accLen >= MAX_RESPONSE_ACC) truncated = true;
            } else {
              truncated = true;
            }
            res.write(chunk);
          });
          upRes.on('end', function () {
            res.end();
            var t1 = Date.now();
            var endedIso = new Date(t1).toISOString();
            var bodyBufResp = Buffer.concat(acc);
            var ct = (upRes.headers && upRes.headers['content-type']) || '';
            var ct0 = Array.isArray(ct) ? ct[0] : ct;
            var usage = usageFromBuffer(bodyBufResp, ct0);
            var ratio = cacheReadRatio(usage);
            var respHints = responseHintsFromBuffer(bodyBufResp, ct0);
            var rec = {
              ts_start: startedIso,
              ts_end: endedIso,
              duration_ms: t1 - t0,
              req_id: reqId,
              method: req.method,
              path: (req.url || '').split('?')[0],
              query_present: (req.url || '').indexOf('?') >= 0,
              upstream: targetUrl.origin,
              req_headers_redacted: redactHeaders(req.headers),
              request_meta: buildRequestMeta(req, bodyBuf),
              request_hints: reqHints,
              upstream_status: upRes.statusCode,
              response_anthropic_headers: extractAnthropicPolicyHeaders(upRes.headers),
              response_content_type: Array.isArray(ct) ? ct.join(',') : ct,
              response_bytes_logged: bodyBufResp.length,
              response_truncated: truncated,
              usage: usage,
              cache_read_ratio: ratio,
              cache_health: cacheHealthLabel(ratio, usage),
              response_hints: respHints,
              source: 'proxy',
              peak_hour: (function() {
                var d = new Date(endedIso);
                var h = d.getUTCHours();
                var wd = d.getUTCDay();
                return wd >= 1 && wd <= 5 && h >= 13 && h < 19;
              })(),
              ttl_tier: (function() {
                if (!usage) return 'unknown';
                var e1h = usage.ephemeral_1h_input_tokens || 0;
                var e5m = usage.ephemeral_5m_input_tokens || 0;
                if (e1h > 0 && e5m === 0) return '1h';
                if (e5m > 0 && e1h === 0) return '5m';
                if (e1h > 0 && e5m > 0) return 'mixed';
                return 'unknown';
              })()
            };
            if (alignJsonl && usage) {
              try {
                rec.jsonl_alignment = alignToJsonl(endedIso, usage, getAlignRoots(), {
                  windowMs: ALIGN_WINDOW_MS
                });
              } catch (ae) {
                rec.jsonl_alignment_error = ae && ae.message ? ae.message : String(ae);
              }
            }
            try {
              appendNdjson(logDir, rec);
            } catch (le) {
              console.error('anthropic-proxy: log write failed:', le.message || le);
            }
            if (logStdout) {
              var umsg = usage
                ? ' in=' +
                  (usage.input_tokens != null ? usage.input_tokens : '?') +
                  ' out=' +
                  (usage.output_tokens != null ? usage.output_tokens : '?') +
                  ' cr=' +
                  (usage.cache_read_input_tokens != null ? usage.cache_read_input_tokens : '?') +
                  ' cc=' +
                  (usage.cache_creation_input_tokens != null ? usage.cache_creation_input_tokens : '?')
                : '';
              console.log(
                '[' +
                  endedIso +
                  '] ' +
                  req.method +
                  ' ' +
                  rec.path +
                  ' -> ' +
                  upRes.statusCode +
                  umsg +
                  (ratio != null
                    ? ' read_ratio=' + ratio.toFixed(3) + ' (' + rec.cache_health + ')'
                    : '') +
                  ' log=' +
                  logPathForDay(logDir, new Date())
              );
            }
          });
        });

        upReq.on('error', function (err) {
          var t1 = Date.now();
          if (!res.headersSent) {
            res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('Upstream error: ' + (err.message || err));
          }
          appendNdjson(logDir, {
            ts_start: startedIso,
            ts_end: new Date(t1).toISOString(),
            duration_ms: t1 - t0,
            req_id: reqId,
            method: req.method,
            path: (req.url || '').split('?')[0],
            error: true,
            upstream_error: err.message || String(err)
          });
        });

        upReq.write(bodyBuf);
        upReq.end();
      });
    });
  },
  DEFAULT_PORT: DEFAULT_PORT,
  DEFAULT_UPSTREAM: DEFAULT_UPSTREAM,
  logPathForDay: logPathForDay
};
