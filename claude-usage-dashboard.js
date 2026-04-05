#!/usr/bin/env node
// Claude Code Token Usage Dashboard — standalone, zero dependencies
// Usage: node claude-usage-dashboard.js [--port=3333]
// Tages-Cache: ~/.claude/usage-dashboard-days.json (Vortage). Bei passender jsonl-Anzahl nur noch „heute“ aus JSONL.
// Vollscan erzwingen: CLAUDE_USAGE_NO_CACHE=1  oder  Cache-Datei löschen / neue .jsonl-Datei ändert die Anzahl.

var http = require('http');
var fs = require('fs');
var path = require('path');
var os = require('os');

var PORT = 3333;
var REFRESH_SEC = 30;
process.argv.forEach(function(a) {
  var m = a.match(/--port=(\d+)/);
  if (m) PORT = parseInt(m[1]);
  var r = a.match(/--refresh=(\d+)/);
  if (r) REFRESH_SEC = Math.max(5, parseInt(r[1]));
});

var HOME = process.env.USERPROFILE || process.env.HOME || os.homedir();
var BASE = path.join(HOME, '.claude', 'projects');
// Vor-Tage als ein JSON (unter ~/.claude); JSONL wird nur noch für den lokalen Kalendertag „heute“ voll geparst.
var USAGE_DAY_CACHE_VERSION = 3;
var USAGE_DAY_CACHE_FILE = path.join(HOME, '.claude', 'usage-dashboard-days.json');

// Session-/Rate-Limits werden von Anthropic (Claude API) bzw. Claude Code erzwungen;
// in den JSONL-Logs stehen primär erfolgreiche usage-Zeilen. Treffer für "Hit Limit"
// sind Zeilen, die typische Limit-/Fehler-Muster enthalten (siehe scanLineHitLimit).
// Kein absoluter Pfad / kein Benutzername in UI oder API-JSON (nur generische Quelle).

function expandUserPath(p) {
  if (typeof p !== 'string') return '';
  p = p.trim();
  if (!p) return '';
  if (p === '~') return HOME;
  if (p.indexOf('~/') === 0 || p.indexOf('~\\') === 0) return path.join(HOME, p.slice(2));
  if (p.charAt(0) === '~' && (p.length === 1 || p.charAt(1) === path.sep)) {
    return path.join(HOME, p.slice(1).replace(/^[\/\\]+/, ''));
  }
  return path.resolve(p);
}

/** Unterverzeichnisse von parentDir mit Namen HOST-* (z. B. HOST-B, HOST-C). Label = Ordnername. */
function discoverHostImportDirs(parentDir) {
  var out = [];
  var absParent = path.resolve(parentDir);
  try {
    var entries = fs.readdirSync(absParent, { withFileTypes: true });
    for (var i = 0; i < entries.length; i++) {
      if (!entries[i].isDirectory()) continue;
      var name = entries[i].name;
      if (!/^HOST-/i.test(name)) continue;
      out.push({ path: path.join(absParent, name), label: name });
    }
  } catch (e) {}
  out.sort(function (a, b) {
    return a.label.localeCompare(b.label, undefined, { sensitivity: 'base' });
  });
  return out;
}

function isExtraBasesAutoMode(raw) {
  var s = String(raw || '')
    .trim()
    .toLowerCase();
  return s === 'true' || s === '1' || s === 'yes' || s === 'auto' || s === 'on';
}

function getScanRoots() {
  var roots = [{ path: BASE, label: 'local' }];
  var raw = process.env.CLAUDE_USAGE_EXTRA_BASES || '';
  if (!raw.trim()) return roots;
  if (isExtraBasesAutoMode(raw)) {
    var rootRaw = (process.env.CLAUDE_USAGE_EXTRA_BASES_ROOT || '').trim();
    var autoRoot = rootRaw ? expandUserPath(rootRaw) : process.cwd();
    if (autoRoot) {
      var discovered = discoverHostImportDirs(autoRoot);
      for (var di = 0; di < discovered.length; di++) {
        roots.push(discovered[di]);
      }
    }
    return roots;
  }
  var parts = raw.split(';');
  for (var i = 0; i < parts.length; i++) {
    var chunk = parts[i].trim();
    if (!chunk) continue;
    var abs = expandUserPath(chunk);
    if (!abs) continue;
    var baseName = path.basename(abs.replace(/[\/\\]+$/, ''));
    var label = baseName || 'extra-' + roots.length;
    roots.push({ path: abs, label: label });
  }
  return roots;
}

function scanRootsCacheKey(roots) {
  return roots
    .map(function (r) {
      return r.path;
    })
    .join('|');
}

function collectTaggedJsonlFiles() {
  var roots = getScanRoots();
  var seen = Object.create(null);
  var tagged = [];
  for (var ri = 0; ri < roots.length; ri++) {
    var R = roots[ri];
    var list;
    try {
      list = walkJsonl(R.path);
    } catch (e) {
      list = [];
    }
    for (var fi = 0; fi < list.length; fi++) {
      var fp = path.resolve(list[fi]);
      if (seen[fp]) continue;
      seen[fp] = true;
      tagged.push({ path: fp, label: R.label, rootPath: R.path });
    }
  }
  return { tagged: tagged, roots: roots };
}

function buildLimitSourceNote() {
  var roots = getScanRoots();
  var s = 'Datenquelle: ~/.claude/projects';
  if (roots.length > 1) s += ' + weitere Wurzeln (CLAUDE_USAGE_EXTRA_BASES)';
  return s;
}

function buildLimitSourceNoteEn() {
  var roots = getScanRoots();
  var s = 'Data source: ~/.claude/projects';
  if (roots.length > 1) s += ' + additional roots (CLAUDE_USAGE_EXTRA_BASES)';
  return s;
}

function displayScannedFileLine(entry) {
  if (typeof entry === 'string') return displayPathForUi(entry);
  var p = entry.path;
  var label = entry.label || 'local';
  var rel;
  if (p.indexOf(HOME) === 0) {
    rel = displayPathForUi(p);
  } else if (entry.rootPath) {
    try {
      rel = path.relative(entry.rootPath, p).replace(/\\/g, '/');
      if (!rel || rel.indexOf('..') === 0) rel = p.replace(/\\/g, '/');
    } catch (e) {
      rel = p.replace(/\\/g, '/');
    }
  } else {
    rel = p.replace(/\\/g, '/');
  }
  return label + ' \u00b7 ' + rel;
}

function displayPathForUi(absPath) {
  if (typeof absPath !== 'string') return '';
  if (absPath.indexOf(HOME) === 0) {
    var rest = absPath.slice(HOME.length).replace(/\\/g, '/');
    return '~/' + rest.replace(/^\/+/, '');
  }
  return absPath.replace(/\\/g, '/');
}

// ── JSONL Parser ────────────────────────────────────────────────────────

function isClaudeModel(model) {
  return typeof model === 'string' && /^claude-/i.test(model);
}

// Wie token_forensics.js (Tagesübersicht): sehr hoher Cache-Read → „?“
var CACHE_READ_FORENSIC_THRESH = 500000000;

function scanLineHitLimit(line) {
  if (line.indexOf('rate_limit') >= 0) return true;
  if (line.indexOf('RateLimit') >= 0) return true;
  if (line.indexOf('rate limit') >= 0) return true;
  if (line.indexOf('"status":429') >= 0) return true;
  if (line.indexOf('"status_code":429') >= 0) return true;
  if (line.indexOf('429') >= 0 && line.indexOf('error') >= 0) return true;
  if (line.indexOf('overloaded') >= 0) return true;
  if (line.indexOf('Too Many Requests') >= 0) return true;
  if (line.indexOf('session') >= 0 && line.indexOf('limit') >= 0) return true;
  return false;
}

// Interpretative Heuristik (kein API-Nachweis). Kein „90%“-Label: Claude-UI kann 90% oder 100% zeigen — unabhängig davon.
var FORENSIC_MIN_OUTPUT_FOR_PEAK_CMP = 60000;
var FORENSIC_PEAK_RATIO_MIN = 6;
var FORENSIC_PEAK_MIN_CALLS = 120;
var FORENSIC_PEAK_MIN_HOURS = 4;

function computeForensicForDay(dayKey, r, peakDate, peakTotal) {
  var total = r.input + r.output + r.cache_read + r.cache_creation;
  var activeH = Object.keys(r.hours).length;
  var implied90 = total > 0 ? Math.round(total / 0.9) : 0;
  var vs_peak = peakTotal > 0 && total > 0 ? Math.round(peakTotal / total) : 0;
  var code = '\u2014';
  var hint = 'Kein Forensic-Flag.';

  if (r.cache_read > CACHE_READ_FORENSIC_THRESH) {
    code = '?';
    hint =
      'Cache read \u2265500M (wie token_forensics.js) \u2014 starkes Session-/Cache-Signal m\u00f6glich.';
  } else if ((r.hit_limit || 0) > 0) {
    code = 'HIT';
    hint =
      'JSONL enth\u00e4lt diesen Tag Rate-/Limit-/429-\u00e4hnliche Zeilen \u2014 eher harter API-/Session-Stop. Unabh\u00e4ngig davon zeigt die Claude-UI oft 90% oder 100%; das sind verschiedene Signale.';
  } else if (
    peakTotal > 0 &&
    total > 0 &&
    dayKey !== peakDate &&
    peakTotal / total >= FORENSIC_PEAK_RATIO_MIN &&
    activeH >= FORENSIC_PEAK_MIN_HOURS &&
    r.calls >= FORENSIC_PEAK_MIN_CALLS &&
    r.output >= FORENSIC_MIN_OUTPUT_FOR_PEAK_CMP
  ) {
    code = '<<P';
    hint =
      'Viel weniger Gesamt-Tokens als am Peak-Tag (' +
      peakDate +
      '), aber mit sp\u00fcrbar viel Output und vielen Calls \u2014 fr\u00fcher grob als \u201e90%?\u201c bezeichnet. Trifft nicht zu, wenn du im 5h-Fenster kaum gearbeitet hast (dann eher Zufall/Subagent-Rauschen); UI-Prozentsatz kann trotzdem 100% sein.';
  }

  return {
    forensic_code: code,
    forensic_hint: hint,
    forensic_implied_cap_90: implied90,
    forensic_vs_peak: vs_peak
  };
}

function walkJsonl(dir) {
  var files = [];
  try {
    var entries = fs.readdirSync(dir, { withFileTypes: true });
    for (var i = 0; i < entries.length; i++) {
      var fp = path.join(dir, entries[i].name);
      if (entries[i].isDirectory()) files = files.concat(walkJsonl(fp));
      else if (entries[i].name.endsWith('.jsonl')) files.push(fp);
    }
  } catch (e) {}
  return files;
}

// Pro Tick: Balance aus erstem vollen Ergebnis (weniger Ticks) vs. HTTP/SSE-Responsivität.
var SCAN_FILES_PER_TICK = 20;
(function () {
  var e = process.env.CLAUDE_USAGE_SCAN_FILES_PER_TICK;
  if (!e) return;
  var n = parseInt(e, 10);
  if (!isNaN(n) && n >= 1 && n <= 80) SCAN_FILES_PER_TICK = n;
})();

function pad2(n) {
  return n < 10 ? '0' + n : String(n);
}

function localCalendarTodayStr() {
  var d = new Date();
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}

function emptyHostSlice() {
  return {
    input: 0,
    output: 0,
    cache_read: 0,
    cache_creation: 0,
    calls: 0,
    sub_calls: 0,
    sub_cache: 0,
    sub_output: 0,
    hours: {},
    hit_limit: 0
  };
}

function emptyDailyBucket() {
  return {
    input: 0,
    output: 0,
    cache_read: 0,
    cache_creation: 0,
    calls: 0,
    sub_calls: 0,
    sub_cache: 0,
    sub_output: 0,
    hours: {},
    models: {},
    hit_limit: 0,
    hosts: {}
  };
}

function hostSliceFromRow(h) {
  if (!h || typeof h !== 'object') return emptyHostSlice();
  return {
    input: h.input || 0,
    output: h.output || 0,
    cache_read: h.cache_read || 0,
    cache_creation: h.cache_creation || 0,
    calls: h.calls || 0,
    sub_calls: h.sub_calls || 0,
    sub_cache: h.sub_cache || 0,
    sub_output: h.sub_output || 0,
    hours: h.hours && typeof h.hours === 'object' ? h.hours : {},
    hit_limit: h.hit_limit || 0
  };
}

function rowToDailyEntry(row) {
  var hosts = {};
  if (row.hosts && typeof row.hosts === 'object') {
    var hk = Object.keys(row.hosts);
    for (var i = 0; i < hk.length; i++) {
      hosts[hk[i]] = hostSliceFromRow(row.hosts[hk[i]]);
    }
  }
  return {
    input: row.input || 0,
    output: row.output || 0,
    cache_read: row.cache_read || 0,
    cache_creation: row.cache_creation || 0,
    calls: row.calls || 0,
    sub_calls: row.sub_calls || 0,
    sub_cache: row.sub_cache || 0,
    sub_output: row.sub_output || 0,
    hours: row.hours && typeof row.hours === 'object' ? row.hours : {},
    models: row.models && typeof row.models === 'object' ? row.models : {},
    hit_limit: row.hit_limit || 0,
    hosts: hosts
  };
}

function readUsageDayCache() {
  try {
    return JSON.parse(fs.readFileSync(USAGE_DAY_CACHE_FILE, 'utf8'));
  } catch (e) {
    return null;
  }
}

function writeUsageDayCache(payload) {
  var dir = path.dirname(USAGE_DAY_CACHE_FILE);
  try {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  } catch (e) {}
  var tmp = USAGE_DAY_CACHE_FILE + '.tmp';
  var body = JSON.stringify(payload);
  fs.writeFileSync(tmp, body, 'utf8');
  try {
    fs.renameSync(tmp, USAGE_DAY_CACHE_FILE);
  } catch (e) {
    fs.writeFileSync(USAGE_DAY_CACHE_FILE, body, 'utf8');
  }
}

// onlyDate: wenn gesetzt (YYYY-MM-DD), nur Zeilen dieses Kalendertags aus JSONL übernehmen (Vortage kommen aus Datei-Cache).
function processJsonlFile(fileRef, daily, onlyDate) {
  var f = typeof fileRef === 'string' ? fileRef : fileRef.path;
  var hostLabel = typeof fileRef === 'string' ? 'local' : fileRef.label || 'local';
  var isSub = f.indexOf('subagent') >= 0;
  try {
    var lines = fs.readFileSync(f, 'utf8').split('\n');
    for (var li = 0; li < lines.length; li++) {
      var line = lines[li];
      if (!line.trim()) continue;
      var rec;
      try {
        rec = JSON.parse(line);
      } catch (e) {
        continue;
      }
      var ts = rec.timestamp || '';
      if (ts.length >= 10 && scanLineHitLimit(line)) {
        var dayLimit = ts.slice(0, 10);
        if (onlyDate && dayLimit !== onlyDate) {
          /* skip */
        } else {
          if (!daily[dayLimit]) daily[dayLimit] = emptyDailyBucket();
          daily[dayLimit].hit_limit = (daily[dayLimit].hit_limit || 0) + 1;
          if (!daily[dayLimit].hosts) daily[dayLimit].hosts = {};
          if (!daily[dayLimit].hosts[hostLabel]) daily[dayLimit].hosts[hostLabel] = emptyHostSlice();
          var hl = daily[dayLimit].hosts[hostLabel];
          hl.hit_limit = (hl.hit_limit || 0) + 1;
        }
      }

      var u = rec.message && rec.message.usage;
      if (!u) continue;
      var modelRaw = (rec.message && rec.message.model) || 'unknown';
      if (!isClaudeModel(modelRaw)) continue;
      if (ts.length < 19) continue;
      var day = ts.slice(0, 10);
      if (onlyDate && day !== onlyDate) continue;
      var hour = parseInt(ts.slice(11, 13));
      if (!daily[day]) daily[day] = emptyDailyBucket();
      var dd = daily[day];
      if (!dd.hosts) dd.hosts = {};
      if (!dd.hosts[hostLabel]) dd.hosts[hostLabel] = emptyHostSlice();
      var hh = dd.hosts[hostLabel];
      var inTok = u.input_tokens || 0;
      var outTok = u.output_tokens || 0;
      var crTok = u.cache_read_input_tokens || 0;
      var ccTok = u.cache_creation_input_tokens || 0;
      dd.input += inTok;
      dd.output += outTok;
      dd.cache_read += crTok;
      dd.cache_creation += ccTok;
      dd.calls++;
      dd.hours[hour] = (dd.hours[hour] || 0) + 1;
      hh.input += inTok;
      hh.output += outTok;
      hh.cache_read += crTok;
      hh.cache_creation += ccTok;
      hh.calls++;
      hh.hours[hour] = (hh.hours[hour] || 0) + 1;
      if (isSub) {
        dd.sub_calls++;
        dd.sub_cache += crTok;
        dd.sub_output += outTok;
        hh.sub_calls++;
        hh.sub_cache += crTok;
        hh.sub_output += outTok;
      }
      var model = modelRaw;
      if (!dd.models[model]) dd.models[model] = { calls: 0, output: 0, cache_read: 0 };
      dd.models[model].calls++;
      dd.models[model].output += outTok;
      dd.models[model].cache_read += crTok;
    }
  } catch (e) {}
}

function hostSliceToApi(h) {
  var total = h.input + h.output + h.cache_read + h.cache_creation;
  var activeH = Object.keys(h.hours || {}).length;
  return {
    input: h.input,
    output: h.output,
    cache_read: h.cache_read,
    cache_creation: h.cache_creation,
    total: total,
    calls: h.calls || 0,
    active_hours: activeH,
    hit_limit: h.hit_limit || 0,
    cache_output_ratio: h.output > 0 ? Math.round(h.cache_read / h.output) : 0,
    overhead: h.output > 0 ? Math.round(total / h.output) : 0,
    sub_calls: h.sub_calls || 0,
    sub_pct: h.calls > 0 ? Math.round(((h.sub_calls || 0) / h.calls) * 100) : 0,
    sub_cache: h.sub_cache || 0,
    sub_cache_pct: h.cache_read > 0 ? Math.round(((h.sub_cache || 0) / h.cache_read) * 100) : 0,
    output_per_hour: activeH > 0 ? Math.round(h.output / activeH) : 0,
    hours: h.hours || {}
  };
}

function buildUsageResult(daily, fileCount, filePaths, roots) {
  var days = Object.keys(daily).sort();
  var result = [];
  for (var di = 0; di < days.length; di++) {
    var key = days[di];
    var r = daily[key];
    var total = r.input + r.output + r.cache_read + r.cache_creation;
    var activeH = Object.keys(r.hours).length;
    var hostsRaw = r.hosts || {};
    var hostsApi = {};
    var hKeys = Object.keys(hostsRaw).sort();
    for (var hi = 0; hi < hKeys.length; hi++) {
      hostsApi[hKeys[hi]] = hostSliceToApi(hostsRaw[hKeys[hi]]);
    }
    result.push({
      date: key,
      input: r.input,
      output: r.output,
      cache_read: r.cache_read,
      cache_creation: r.cache_creation,
      total: total,
      calls: r.calls,
      active_hours: activeH,
      cache_output_ratio: r.output > 0 ? Math.round(r.cache_read / r.output) : 0,
      overhead: r.output > 0 ? Math.round(total / r.output) : 0,
      sub_calls: r.sub_calls,
      sub_pct: r.calls > 0 ? Math.round(r.sub_calls / r.calls * 100) : 0,
      sub_cache: r.sub_cache,
      sub_cache_pct: r.cache_read > 0 ? Math.round(r.sub_cache / r.cache_read * 100) : 0,
      output_per_hour: activeH > 0 ? Math.round(r.output / activeH) : 0,
      total_per_hour: activeH > 0 ? Math.round(total / activeH) : 0,
      hit_limit: r.hit_limit || 0,
      models: r.models,
      hours: r.hours,
      hosts: hostsApi,
      forensic_code: '\u2014',
      forensic_hint: '',
      forensic_implied_cap_90: 0,
      forensic_vs_peak: 0
    });
  }

  var peakDate = '';
  var peakTotal = 0;
  for (var pi = 0; pi < result.length; pi++) {
    if (result[pi].total > peakTotal) {
      peakTotal = result[pi].total;
      peakDate = result[pi].date;
    }
  }
  for (var qi = 0; qi < result.length; qi++) {
    var row = result[qi];
    var rr = daily[row.date];
    if (!rr) continue;
    var f = computeForensicForDay(row.date, rr, peakDate, peakTotal);
    row.forensic_code = f.forensic_code;
    row.forensic_hint = f.forensic_hint;
    row.forensic_implied_cap_90 = f.forensic_implied_cap_90;
    row.forensic_vs_peak = f.forensic_vs_peak;
  }

  var scanned = [];
  var tagged = filePaths;
  if (tagged && tagged.length) {
    for (var si = 0; si < tagged.length; si++) {
      scanned.push(displayScannedFileLine(tagged[si]));
    }
  }

  var byLabel = Object.create(null);
  for (var bi = 0; bi < (tagged || []).length; bi++) {
    var lb = tagged[bi].label || 'local';
    byLabel[lb] = (byLabel[lb] || 0) + 1;
  }
  var scan_sources = [];
  if (roots && roots.length) {
    for (var ri = 0; ri < roots.length; ri++) {
      var rl = roots[ri].label;
      scan_sources.push({
        label: rl,
        jsonl_files: byLabel[rl] || 0,
        path_hint: displayPathForUi(roots[ri].path)
      });
    }
  }

  var host_labels = [];
  if (roots && roots.length) {
    for (var rj = 0; rj < roots.length; rj++) {
      host_labels.push(roots[rj].label);
    }
  }

  return {
    days: result,
    parsed_files: fileCount,
    scanned_files: scanned,
    scan_sources: scan_sources,
    host_labels: host_labels,
    generated: new Date().toISOString(),
    limit_source_note: buildLimitSourceNote(),
    limit_source_note_en: buildLimitSourceNoteEn(),
    scope: 'claude-models-only',
    forensic_peak_date: peakDate,
    forensic_peak_total: peakTotal,
    forensic_note:
      'Forensic: ? = Cache\u2265500M; HIT = Limit-Zeilen in JSONL; <<P = stark unter Peak bei hohem Output (nicht \u201e90%\u201c/100% der UI). Impl@90% = total/0.9 nur Rechenbeispiel. Alles heuristisch.',
    forensic_note_en:
      'Forensic: ? = cache \u2265500M; HIT = limit-like lines in JSONL; <<P = far below peak with high output (not Claude UI \u201c90%\u201d/100%). Impl@90% = total/0.9 is illustrative only. All heuristic.'
  };
}

function parseAllUsage() {
  var coll = collectTaggedJsonlFiles();
  var tagged = coll.tagged;
  var daily = {};
  for (var fi = 0; fi < tagged.length; fi++) {
    processJsonlFile(tagged[fi], daily);
  }
  return buildUsageResult(daily, tagged.length, tagged, coll.roots);
}

// Inkrementell: setImmediate zwischen Batches. Mit gültigem Tages-Cache nur JSONL für localCalendarTodayStr().
function parseAllUsageIncremental(done, onProgress) {
  var coll;
  try {
    coll = collectTaggedJsonlFiles();
  } catch (e) {
    done(e, null);
    return;
  }
  var tagged = coll.tagged;
  var roots = coll.roots;
  var rootsKey = scanRootsCacheKey(roots);
  var noDayCache =
    process.env.CLAUDE_USAGE_NO_CACHE === '1' || process.env.CLAUDE_USAGE_NO_CACHE === 'true';
  var todayStr = localCalendarTodayStr();
  var cache = !noDayCache ? readUsageDayCache() : null;
  var useTodayOnly = false;
  if (
    cache &&
    cache.version === USAGE_DAY_CACHE_VERSION &&
    cache.jsonl_file_count === tagged.length &&
    cache.scan_roots_key === rootsKey &&
    Array.isArray(cache.days) &&
    cache.days.length > 0
  ) {
    useTodayOnly = true;
  }

  var daily = {};
  if (useTodayOnly) {
    for (var ci = 0; ci < cache.days.length; ci++) {
      if (cache.days[ci].date === todayStr) continue;
      daily[cache.days[ci].date] = rowToDailyEntry(cache.days[ci]);
    }
    daily[todayStr] = emptyDailyBucket();
  }

  var onlyArg = useTodayOnly ? todayStr : null;
  var fi = 0;
  if (typeof onProgress === 'function') {
    try {
      onProgress({
        daily: daily,
        tagged: tagged,
        roots: roots,
        fi: 0,
        useTodayOnly: useTodayOnly,
        todayStr: todayStr
      });
    } catch (eProg0) {}
  }
  function tick() {
    var n = SCAN_FILES_PER_TICK;
    while (n-- > 0 && fi < tagged.length) {
      processJsonlFile(tagged[fi], daily, onlyArg);
      fi++;
    }
    if (fi < tagged.length) {
      if (typeof onProgress === 'function') {
        try {
          onProgress({
            daily: daily,
            tagged: tagged,
            roots: roots,
            fi: fi,
            useTodayOnly: useTodayOnly,
            todayStr: todayStr
          });
        } catch (eProg1) {}
      }
      setImmediate(tick);
    } else {
      try {
        var result = buildUsageResult(daily, tagged.length, tagged, roots);
        result.calendar_today = todayStr;
        result.day_cache_mode = useTodayOnly ? 'heute-jsonl+vortage-cache' : 'vollstaendiger-jsonl-scan';
        result.day_cache_mode_en = useTodayOnly
          ? 'today JSONL + past days from cache'
          : 'full JSONL scan';
        if (!noDayCache) {
          try {
            writeUsageDayCache({
              version: USAGE_DAY_CACHE_VERSION,
              jsonl_file_count: tagged.length,
              scan_roots_key: rootsKey,
              days: result.days,
              saved: new Date().toISOString()
            });
          } catch (we) {
            console.error('usage-dashboard: Tages-Cache schreiben fehlgeschlagen:', we.message || we);
          }
        }
        done(null, result);
      } catch (err) {
        done(err, null);
      }
    }
  }
  setImmediate(tick);
}

// ── HTML Dashboard (UI-Texte: tpl/de/ui.tpl und tpl/en/ui.tpl, JSON) ───
// In-Memory-Cache: keine doppelte Platten-Lese + kein erneutes replace() auf ~100k HTML pro Request.
// Nach Bearbeitung der .tpl reicht Seitenreload; mtime-Änderung invalidiert den Cache.

var DASHBOARD_SCRIPT_DIR = __dirname;

var __i18nPageCache = {
  mde: null,
  men: null,
  bundles: null,
  inlineJson: '',
  fullHtml: null
};

function getUiTplMtimeMs(lang) {
  try {
    return fs.statSync(path.join(DASHBOARD_SCRIPT_DIR, 'tpl', lang, 'ui.tpl')).mtimeMs;
  } catch (e) {
    return NaN;
  }
}

function loadUiTpl(lang) {
  var p = path.join(DASHBOARD_SCRIPT_DIR, 'tpl', lang, 'ui.tpl');
  try {
    var raw = fs.readFileSync(p, 'utf8');
    if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
    return JSON.parse(raw);
  } catch (e) {
    console.error('usage-dashboard: tpl/' + lang + '/ui.tpl:', e.message);
    return {};
  }
}

function buildI18nBundles() {
  var mde = getUiTplMtimeMs('de');
  var men = getUiTplMtimeMs('en');
  var c = __i18nPageCache;
  if (c.bundles && c.mde === mde && c.men === men) {
    return c.bundles;
  }
  c.bundles = { de: loadUiTpl('de'), en: loadUiTpl('en') };
  c.mde = mde;
  c.men = men;
  c.inlineJson = '';
  c.fullHtml = null;
  return c.bundles;
}

/** Caller must have called buildI18nBundles() so c.bundles is current (e.g. getDashboardHtml). */
function jsonForInlineI18nScript() {
  var c = __i18nPageCache;
  if (c.inlineJson) return c.inlineJson;
  c.inlineJson = JSON.stringify(c.bundles)
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')
    .replace(/</g, '\\u003c');
  return c.inlineJson;
}

function getDashboardHtml() {
  var c = __i18nPageCache;
  var mde = getUiTplMtimeMs('de');
  var men = getUiTplMtimeMs('en');
  if (c.fullHtml && c.mde === mde && c.men === men) return c.fullHtml;
  buildI18nBundles();
  c.fullHtml = DASHBOARD_HTML.replace('__I18N_PLACEHOLDER__', jsonForInlineI18nScript());
  return c.fullHtml;
}

var DASHBOARD_HTML = '<!DOCTYPE html>\n\
<html lang="en">\n\
<head>\n\
<meta charset="utf-8">\n\
<meta name="viewport" content="width=device-width,initial-scale=1">\n\
<title>Claude Code Usage Dashboard</title>\n\
<script src="https://cdn.jsdelivr.net/npm/chart.js@4"></script>\n\
<style>\n\
*{margin:0;padding:0;box-sizing:border-box}\n\
body{font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;background:#0f172a;color:#e2e8f0;padding:20px;padding-top:16px}\n\
h1{font-size:1.5rem;margin-bottom:4px;color:#f8fafc}\n\
.subtitle{color:#94a3b8;font-size:.85rem;margin-bottom:20px}\n\
.meta-details{margin-bottom:14px;border:1px solid #334155;border-radius:8px;background:rgba(30,41,59,.45);overflow:hidden}\n\
.meta-details-summary{cursor:pointer;padding:6px 10px;font-size:.68rem;color:#94a3b8;line-height:1.35;list-style-position:outside;user-select:none}\n\
.meta-details-summary:hover{color:#cbd5e1}\n\
.meta-details[open] .meta-details-summary{color:#cbd5e1;border-bottom:1px solid #334155;padding-bottom:8px}\n\
.meta-details-inner{padding:8px 10px 10px}\n\
.meta-details-inner .subtitle{font-size:.68rem;margin-bottom:8px;line-height:1.35;color:#94a3b8}\n\
.meta-details-inner .subtitle:last-child{margin-bottom:0}\n\
.meta-details-inner #scan-sources{font-size:.65rem!important}\n\
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px;margin-bottom:24px}\n\
.card{background:#1e293b;border-radius:10px;padding:16px;border:1px solid #334155}\n\
.card .label{font-size:.75rem;color:#94a3b8;text-transform:uppercase;letter-spacing:.5px}\n\
.card .value{font-size:1.8rem;font-weight:700;margin-top:4px;color:#f8fafc}\n\
.card .sub{font-size:.75rem;color:#64748b;margin-top:2px}\n\
.card.warn{border-color:#f59e0b}\n\
.card.danger{border-color:#ef4444}\n\
.card.ok{border-color:#22c55e}\n\
.charts{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px;margin-bottom:24px;align-items:stretch}\n\
.charts.full{grid-template-columns:1fr}\n\
.chart-box{background:#1e293b;border-radius:10px;padding:16px;border:1px solid #334155}\n\
.charts-pair{display:grid;grid-template-columns:1fr;gap:16px;margin-bottom:24px;align-items:stretch}\n\
.charts-pair.has-host{grid-template-columns:repeat(2,minmax(0,1fr))}\n\
@media(max-width:900px){.charts-pair.has-host{grid-template-columns:1fr}}\n\
.chart-box h3{font-size:.9rem;color:#94a3b8;margin-bottom:10px}\n\
canvas{width:100%!important}\n\
table{width:100%;border-collapse:collapse;font-size:.8rem}\n\
th{text-align:left;color:#94a3b8;font-weight:500;padding:8px 6px;border-bottom:1px solid #334155;position:sticky;top:0;background:#1e293b}\n\
td{padding:6px;border-bottom:1px solid #1e293b;color:#cbd5e1;font-variant-numeric:tabular-nums}\n\
tr:hover td{background:#334155}\n\
.num{text-align:right}\n\
.hi{color:#fbbf24;font-weight:600}\n\
.crit{color:#ef4444;font-weight:700}\n\
.ok-txt{color:#22c55e}\n\
.bar-wrap{height:6px;background:#334155;border-radius:3px;min-width:80px}\n\
.bar-fill{height:100%;border-radius:3px;background:linear-gradient(90deg,#3b82f6,#8b5cf6)}\n\
.bar-fill.warn{background:linear-gradient(90deg,#f59e0b,#ef4444)}\n\
.top-bar{position:sticky;top:0;z-index:250;display:flex;flex-wrap:wrap;align-items:center;justify-content:flex-end;gap:12px;margin:-8px -8px 18px -8px;padding:10px 8px 14px 8px;background:rgba(15,23,42,.94);border-bottom:1px solid #334155;backdrop-filter:blur(8px)}\n\
.top-bar-cluster{display:flex;flex-wrap:wrap;align-items:center;gap:10px}\n\
.live-pop{position:relative}\n\
.live-pop .refresh{background:#334155;color:#e2e8f0;border:none;padding:8px 14px;border-radius:6px;cursor:pointer;font-size:.8rem;display:block;width:auto;min-width:9rem;text-align:left}\n\
.live-pop .refresh:hover,.live-pop:focus-within .refresh{background:#475569}\n\
.live-files-panel{display:none;position:absolute;top:100%;right:0;margin-top:6px;min-width:min(440px,calc(100vw - 32px));max-width:min(560px,96vw);max-height:min(65vh,480px);overflow:auto;background:#1e293b;border:1px solid #475569;border-radius:8px;padding:10px 12px;box-shadow:0 16px 48px rgba(0,0,0,.5)}\n\
.live-pop:hover .live-files-panel,.live-pop:focus-within .live-files-panel,.live-pop.live-files-open .live-files-panel{display:block}\n\
.live-files-head{font-size:.68rem;color:#94a3b8;text-transform:uppercase;letter-spacing:.04em;margin-bottom:8px}\n\
#live-files-list{list-style:none;margin:0;padding:0;font-size:.72rem;line-height:1.4;color:#cbd5e1;word-break:break-all}\n\
#live-files-list li{padding:5px 0;border-bottom:1px solid #334155}\n\
#live-files-list li:last-child{border-bottom:none}\n\
.live-files-hint{font-size:.65rem;color:#64748b;margin-top:8px;line-height:1.35}\n\
.forensic-details{margin-top:12px;margin-bottom:20px;background:#1e293b;border:1px solid #334155;border-radius:10px;overflow:hidden}\n\
.forensic-summary{cursor:pointer;padding:12px 16px 12px 20px;font-size:.85rem;color:#cbd5e1;line-height:1.4;list-style-position:outside}\n\
.forensic-summary:hover{color:#f8fafc}\n\
.forensic-inner{padding:0 16px 16px;border-top:1px solid #334155}\n\
.forensic-note-p{font-size:.8rem;color:#64748b;line-height:1.45;margin:12px 0}\n\
@media(max-width:1100px){.charts{grid-template-columns:repeat(2,minmax(0,1fr))}}\n\
@media(max-width:720px){.charts{grid-template-columns:1fr}}\n\
.lang-switch{position:relative;display:flex;align-items:center;gap:6px;font-size:.72rem;color:#94a3b8}\n\
.lang-switch-label{margin-right:2px}\n\
.lang-switch .lang-btn{background:#1e293b;color:#e2e8f0;border:1px solid #475569;padding:6px 10px;border-radius:6px;cursor:pointer;font-size:.72rem;line-height:1.2}\n\
.lang-switch .lang-btn:hover{background:#334155}\n\
.lang-switch .lang-btn.active{background:#3b82f6;border-color:#2563eb;color:#fff}\n\
.day-picker-row{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:14px}\n\
.day-picker-row label{color:#94a3b8;font-size:.85rem}\n\
.day-picker-row select{background:#1e293b;color:#e2e8f0;border:1px solid #334155;border-radius:6px;padding:8px 12px;font-size:.9rem;min-width:220px}\n\
.day-picker-hint{font-size:.75rem;color:#64748b;max-width:36rem;line-height:1.4}\n\
</style>\n\
</head>\n\
<body>\n\
<header class="top-bar" role="banner">\n\
<div class="top-bar-cluster">\n\
<div class="lang-switch" id="lang-switch-wrap" role="group" aria-label="Language">\n\
<span id="lang-switch-label" class="lang-switch-label"></span>\n\
<button type="button" class="lang-btn" id="lang-de" data-lang="de" aria-pressed="false">DE</button>\n\
<button type="button" class="lang-btn" id="lang-en" data-lang="en" aria-pressed="false">EN</button>\n\
</div>\n\
<div class="live-pop" id="live-pop" tabindex="-1">\n\
<div class="refresh" id="live-trigger" tabindex="0" role="button" aria-expanded="false" aria-haspopup="true" aria-controls="live-files-panel" title="">\n\
<span id="live-dot" style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#22c55e;margin-right:6px;animation:pulse 2s infinite;vertical-align:middle"></span><span id="live-label">Live</span>\n\
</div>\n\
<div class="live-files-panel" id="live-files-panel" role="region" aria-label="Gescannte JSONL-Dateien">\n\
<div class="live-files-head" id="live-files-head">Gescannte JSONL</div>\n\
<ul id="live-files-list"></ul>\n\
<div class="live-files-hint" id="live-files-hint">Pro Zeile: Quelle \u00b7 Pfad (~ = User-Home dieses Rechners). Hover oder Fokus (Tab) h\u00e4lt die Liste offen.</div>\n\
</div>\n\
</div>\n\
</div>\n\
</header>\n\
<style>@keyframes pulse{0%,100%{opacity:1}50%{opacity:.3}}</style>\n\
<h1 id="main-heading">Claude Code Token Usage</h1>\n\
<details class="meta-details" id="meta-details">\n\
<summary class="meta-details-summary" id="meta-details-summary"></summary>\n\
<div class="meta-details-inner">\n\
<div class="subtitle" id="sub-models">Nur <strong>Claude</strong>-Modelle (<code>claude-*</code>) — keine <code>&lt;synthetic&gt;</code>-Zeilen.</div>\n\
<div class="subtitle" id="meta"></div>\n\
<div class="subtitle" id="limit-source" style="margin-top:4px;line-height:1.45"></div>\n\
<div class="subtitle" id="scan-sources" style="margin-top:2px;color:#64748b;line-height:1.45;display:none"></div>\n\
</div>\n\
</details>\n\
<details class="forensic-details" id="forensic-collapse">\n\
<summary class="forensic-summary" id="forensic-summary-line">Forensic (token_forensics)</summary>\n\
<div class="forensic-inner">\n\
<p class="forensic-note-p" id="forensic-note"></p>\n\
<div class="grid" id="forensic-cards"></div>\n\
<div class="chart-box" style="margin-top:16px;margin-bottom:0">\n\
<h3 id="forensic-chart-h3">Forensic &amp; Hit Limit pro Tag</h3>\n\
<p id="forensic-chart-blurb" style="font-size:.75rem;color:#94a3b8;margin:6px 0 10px;line-height:1.45"><strong style="color:#ef4444">Rot (Balken)</strong> = Z\u00e4hler Hit-Limit-Zeilen in JSONL. <strong style="color:#f59e0b">Linie</strong> = Score 3=? · 2=HIT · 1=&lt;&lt;P (Peak-Vergleich, nicht Claude-UI 90%/100%).</p>\n\
<canvas id="c-forensic"></canvas>\n\
</div>\n\
</div>\n\
</details>\n\
<div class="day-picker-row" id="day-picker-row">\n\
<label id="lbl-day-picker" for="day-picker">Karten &amp; Tabelle (Tag w\u00e4hlen)</label>\n\
<select id="day-picker" aria-label=""></select>\n\
<span class="day-picker-hint" id="day-picker-hint"></span>\n\
</div>\n\
<div class="grid" id="cards"></div>\n\
<div class="charts" id="charts"></div>\n\
<div class="charts-pair" id="charts-host-sub"></div>\n\
<div class="chart-box" style="margin-bottom:24px"><h3 id="daily-detail-heading">Tagesdetail</h3><div style="overflow-x:auto"><table id="tbl"><thead><tr></tr></thead><tbody></tbody></table></div></div>\n\
<script>window.__I18N_BUNDLES=__I18N_PLACEHOLDER__;</script>\n\
<script>\n\
var defined_colors = {\n\
  blue: "#3b82f6", purple: "#8b5cf6", green: "#22c55e", amber: "#f59e0b",\n\
  red: "#ef4444", cyan: "#06b6d4", slate: "#64748b", pink: "#ec4899"\n\
};\n\
function fmt(n) {\n\
  if (n >= 1e9) return (n/1e9).toFixed(1)+"B";\n\
  if (n >= 1e6) return (n/1e6).toFixed(1)+"M";\n\
  if (n >= 1e3) return (n/1e3).toFixed(1)+"K";\n\
  return String(n);\n\
}\n\
function pct(a,b){return b>0?(a/b*100).toFixed(1)+"%":"-";}\n\
function escHtml(s){return String(s==null?"":s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/\"/g,"&quot;");}\n\
\n\
var I18N = (typeof __I18N_BUNDLES === "object" && __I18N_BUNDLES && __I18N_BUNDLES.de && __I18N_BUNDLES.en)\n\
  ? __I18N_BUNDLES\n\
  : { de: {}, en: {} };\n\
function detectLang() {\n\
  try {\n\
    var sv = localStorage.getItem("usageDashboardLang");\n\
    if (sv === "de" || sv === "en") return sv;\n\
  } catch (e0) {}\n\
  var langs = navigator.languages;\n\
  if (langs && langs.length) {\n\
    for (var li = 0; li < langs.length; li++) {\n\
      var x = String(langs[li] || "").toLowerCase();\n\
      if (x.indexOf("de") === 0) return "de";\n\
    }\n\
  }\n\
  var nav = String(navigator.language || "").toLowerCase();\n\
  if (nav.indexOf("de") === 0) return "de";\n\
  return "en";\n\
}\n\
var __lang = detectLang();\n\
function getLang() { return __lang; }\n\
function setLang(code) {\n\
  if (code !== "de" && code !== "en") return;\n\
  __lang = code;\n\
  try { localStorage.setItem("usageDashboardLang", code); } catch (e1) {}\n\
  document.documentElement.lang = code === "de" ? "de" : "en";\n\
  updateLangButtons();\n\
  applyStaticChrome();\n\
  if (typeof __lastUsageData !== "undefined" && __lastUsageData) renderDashboard(__lastUsageData);\n\
}\n\
function t(k) {\n\
  var o = I18N[__lang] || I18N.en;\n\
  if (o[k] !== undefined && o[k] !== "") return o[k];\n\
  return I18N.en[k] !== undefined ? I18N.en[k] : k;\n\
}\n\
function tr(k, m) {\n\
  var s = t(k);\n\
  if (!m) return s;\n\
  for (var x in m) {\n\
    if (Object.prototype.hasOwnProperty.call(m, x)) s = s.split("{" + x + "}").join(String(m[x]));\n\
  }\n\
  return s;\n\
}\n\
function updateLangButtons() {\n\
  var bde = document.getElementById("lang-de");\n\
  var ben = document.getElementById("lang-en");\n\
  if (bde) {\n\
    bde.classList.toggle("active", __lang === "de");\n\
    bde.setAttribute("aria-pressed", __lang === "de" ? "true" : "false");\n\
  }\n\
  if (ben) {\n\
    ben.classList.toggle("active", __lang === "en");\n\
    ben.setAttribute("aria-pressed", __lang === "en" ? "true" : "false");\n\
  }\n\
}\n\
function apiNote(data, deKey, enKey) {\n\
  if (getLang() === "en" && data[enKey]) return data[enKey];\n\
  return data[deKey] || "";\n\
}\n\
function applyStaticChrome() {\n\
  document.title = t("pageTitle");\n\
  var lsw = document.getElementById("lang-switch-wrap");\n\
  if (lsw) lsw.setAttribute("aria-label", t("ariaLangGroup"));\n\
  var lsl = document.getElementById("lang-switch-label");\n\
  if (lsl) lsl.textContent = t("langLabel");\n\
  var mh = document.getElementById("main-heading");\n\
  if (mh) mh.textContent = t("heading");\n\
  var sm = document.getElementById("sub-models");\n\
  if (sm) sm.innerHTML = t("subModelsHtml");\n\
  var lp = document.getElementById("lbl-day-picker");\n\
  if (lp) lp.textContent = t("dayPickerLabel");\n\
  var selp = document.getElementById("day-picker");\n\
  if (selp) selp.setAttribute("aria-label", t("dayPickerAria"));\n\
  var lfp = document.getElementById("live-files-panel");\n\
  if (lfp) lfp.setAttribute("aria-label", t("liveFilesAria"));\n\
  var fh = document.getElementById("forensic-chart-h3");\n\
  if (fh) fh.textContent = t("forensicChartTitle");\n\
  var fb = document.getElementById("forensic-chart-blurb");\n\
  if (fb) fb.innerHTML = t("forensicChartBlurbHtml");\n\
  var lf = document.getElementById("live-files-hint");\n\
  if (lf) lf.textContent = t("liveFilesHint");\n\
  document.documentElement.lang = __lang === "de" ? "de" : "en";\n\
}\n\
\n\
var _charts = {};\n\
var __lastUsageData = null;\n\
function updateScanSourcesRow(data) {\n\
  var el = document.getElementById("scan-sources");\n\
  if (!el) return;\n\
  var srcs = data && data.scan_sources;\n\
  if (srcs && srcs.length > 1) {\n\
    var parts = [];\n\
    for (var si = 0; si < srcs.length; si++) {\n\
      parts.push(srcs[si].label + " (" + (srcs[si].jsonl_files || 0) + " .jsonl)");\n\
    }\n\
    el.textContent = t("scanSourcesPrefix") + parts.join(" \u00b7 ");\n\
    el.title = srcs.map(function (s) { return s.label + ": " + (s.path_hint || ""); }).join("\\n");\n\
    el.style.display = "";\n\
  } else {\n\
    el.textContent = "";\n\
    el.title = "";\n\
    el.style.display = "none";\n\
  }\n\
}\n\
function updateLiveFilesPanel(data) {\n\
  var ul = document.getElementById("live-files-list");\n\
  var head = document.getElementById("live-files-head");\n\
  var trig = document.getElementById("live-trigger");\n\
  if (!ul) return;\n\
  ul.innerHTML = "";\n\
  var files = (data && data.scanned_files) ? data.scanned_files : [];\n\
  var n = files.length;\n\
  if (head) head.textContent = n ? tr("liveFilesHeadN", { n: n }) : t("liveFilesHead0");\n\
  if (data && data.scanning && n === 0) {\n\
    ul.innerHTML = "<li>" + escHtml(t("scanStill")) + "</li>";\n\
    if (trig) trig.setAttribute("title", t("liveTriggerScanning"));\n\
    return;\n\
  }\n\
  if (n === 0) {\n\
    ul.innerHTML = "<li>" + escHtml(t("noJsonlList")) + "</li>";\n\
    if (trig) trig.setAttribute("title", t("liveTriggerZero"));\n\
    return;\n\
  }\n\
  for (var lf = 0; lf < n; lf++) {\n\
    var li = document.createElement("li");\n\
    li.textContent = files[lf];\n\
    ul.appendChild(li);\n\
  }\n\
  if (trig) trig.setAttribute("title", tr("liveTriggerMany", { n: n }));\n\
}\n\
function updateMetaDetailsSummary(data) {\n\
  var sumEl = document.getElementById("meta-details-summary");\n\
  if (!sumEl) return;\n\
  var sp = data && data.scan_progress;\n\
  if (sp && sp.total > 0 && data.scanning && sp.done < sp.total) {\n\
    sumEl.textContent = tr("metaDetailsScanProgress", { done: sp.done, total: sp.total, sec: data.refresh_sec || 30 });\n\
    return;\n\
  }\n\
  var days = data && data.days;\n\
  if (!days || !days.length) {\n\
    if (data && data.scanning) sumEl.textContent = t("metaSummaryScanning");\n\
    else if (data && data.scan_error) sumEl.textContent = tr("metaScanError", { msg: String(data.scan_error).slice(0, 120) });\n\
    else if (data && (data.parsed_files || 0) === 0) sumEl.textContent = t("metaSummaryNoFiles");\n\
    else sumEl.textContent = tr("metaSummaryNoUsage", { files: data.parsed_files || 0 });\n\
    return;\n\
  }\n\
  sumEl.textContent = tr("metaDetailsSummaryLine", { files: data.parsed_files || 0, sec: data.refresh_sec || 30 });\n\
}\n\
function initMetaDetailsPanel() {\n\
  var det = document.getElementById("meta-details");\n\
  if (!det || det.dataset.boundMeta) return;\n\
  det.dataset.boundMeta = "1";\n\
  try {\n\
    if (sessionStorage.getItem("usageMetaDetailsOpen") === "1") det.setAttribute("open", "");\n\
  } catch (e) {}\n\
  det.addEventListener("toggle", function () {\n\
    try {\n\
      sessionStorage.setItem("usageMetaDetailsOpen", det.open ? "1" : "0");\n\
    } catch (e2) {}\n\
  });\n\
}\n\
function renderDashboard(data) {\n\
  __lastUsageData = data;\n\
  updateLiveFilesPanel(data);\n\
  updateScanSourcesRow(data);\n\
  var days = data.days;\n\
  var sp = data.scan_progress;\n\
  var scanInc = data.scanning && sp && sp.total > 0 && sp.done < sp.total;\n\
  if (scanInc && days && days.length > 0) {\n\
    updateMetaDetailsSummary(data);\n\
    clearTimeout(window.__dashRenderDebounce);\n\
    window.__dashRenderDebounce = setTimeout(function () {\n\
      window.__dashRenderDebounce = null;\n\
      renderDashboardCore(__lastUsageData);\n\
    }, 420);\n\
    return;\n\
  }\n\
  if (window.__dashRenderDebounce) {\n\
    clearTimeout(window.__dashRenderDebounce);\n\
    window.__dashRenderDebounce = null;\n\
  }\n\
  renderDashboardCore(data);\n\
}\n\
function renderDashboardCore(data) {\n\
  updateMetaDetailsSummary(data);\n\
  var days = data.days;\n\
  if(!days.length){\n\
    var meta0=document.getElementById("meta");\n\
    var ls0=document.getElementById("limit-source");\n\
    if(ls0) ls0.textContent = apiNote(data, "limit_source_note", "limit_source_note_en");\n\
    if(data.scanning){\n\
      var dps=document.getElementById("day-picker-row");if(dps)dps.style.display="none";\n\
      var sp0 = data.scan_progress;\n\
      if (sp0 && sp0.total > 0) meta0.textContent = tr("metaScanningExpanded", { done: sp0.done, total: sp0.total, sec: data.refresh_sec || 30 });\n\
      else meta0.textContent=t("metaScanning");\n\
      var sumS=document.getElementById("forensic-summary-line");if(sumS)sumS.textContent=t("metaForensicScanning");\n\
      var fnS=document.getElementById("forensic-note");if(fnS)fnS.textContent=tr("metaForensicNoteFirst",{sec:data.refresh_sec||30});\n\
      document.getElementById("cards").innerHTML="";\n\
      var fcS=document.getElementById("forensic-cards");if(fcS)fcS.innerHTML="";\n\
      if(_charts.cForensic){try{_charts.cForensic.destroy();}catch(e){}_charts.cForensic=null;}\n\
      document.getElementById("live-label").textContent=t("liveWaitData");\n\
      return;\n\
    }\n\
    var dpe=document.getElementById("day-picker-row");if(dpe)dpe.style.display="none";\n\
    if(data.scan_error)meta0.textContent=tr("metaScanError",{msg:String(data.scan_error)});\n\
    else if((data.parsed_files||0)===0)meta0.textContent=t("metaNoFiles");\n\
    else meta0.textContent=tr("metaNoUsage",{files:data.parsed_files||0});\n\
    var sum0=document.getElementById("forensic-summary-line");if(sum0)sum0.textContent=t("forensicSummaryNoData");\n\
    var fn0=document.getElementById("forensic-note");if(fn0)fn0.textContent="";\n\
    var fc0=document.getElementById("forensic-cards");if(fc0)fc0.innerHTML="";\n\
    document.getElementById("cards").innerHTML="";\n\
    if(_charts.cForensic){try{_charts.cForensic.destroy();}catch(e){}_charts.cForensic=null;}\n\
    var dpr=document.getElementById("day-picker-row");if(dpr)dpr.style.display="none";\n\
    return;\n\
  }\n\
  var dpr0=document.getElementById("day-picker-row");if(dpr0)dpr0.style.display="";\n\
  \n\
  var calToday = data.calendar_today || "";\n\
  var spM = data.scan_progress;\n\
  var metaLine =\n\
    data.scanning && spM && spM.total > 0 && spM.done < spM.total\n\
      ? tr("metaParsedInProgress", {\n\
          done: spM.done,\n\
          total: spM.total,\n\
          time: new Date(data.generated).toLocaleString(),\n\
          sec: data.refresh_sec || 30\n\
        })\n\
      : tr("metaParsed", { files: data.parsed_files, time: new Date(data.generated).toLocaleString(), sec: data.refresh_sec || 30 });\n\
  var dcm = apiNote(data,"day_cache_mode","day_cache_mode_en");\n\
  if (dcm) metaLine += " | " + dcm;\n\
  metaLine += " " + t("metaChartsHint");\n\
  document.getElementById("meta").textContent = metaLine;\n\
  \n\
  var selEl = document.getElementById("day-picker");\n\
  var prevSel = selEl && selEl.value ? selEl.value : "";\n\
  if (!prevSel) {\n\
    try { prevSel = sessionStorage.getItem("usageDashboardDay") || ""; } catch (e) {}\n\
  }\n\
  var valid = {};\n\
  for (var vi = 0; vi < days.length; vi++) valid[days[vi].date] = true;\n\
  selEl.innerHTML = "";\n\
  for (var di = days.length - 1; di >= 0; di--) {\n\
    var o = document.createElement("option");\n\
    o.value = days[di].date;\n\
    var lab = days[di].date;\n\
    if (days[di].date === calToday) lab += t("calTodaySuffix");\n\
    if ((days[di].total || 0) === 0) lab += t("zeroLogsSuffix");\n\
    o.textContent = lab;\n\
    selEl.appendChild(o);\n\
  }\n\
  var pick = prevSel;\n\
  if (!pick || !valid[pick]) {\n\
    pick = (calToday && valid[calToday]) ? calToday : days[days.length - 1].date;\n\
  }\n\
  selEl.value = pick;\n\
  if (!selEl.dataset.bound) {\n\
    selEl.dataset.bound = "1";\n\
    selEl.addEventListener("change", function () {\n\
      try { sessionStorage.setItem("usageDashboardDay", this.value); } catch (e) {}\n\
      if (__lastUsageData) renderDashboard(__lastUsageData);\n\
    });\n\
  }\n\
  var selDay = null;\n\
  for (var sj = 0; sj < days.length; sj++) {\n\
    if (days[sj].date === pick) { selDay = days[sj]; break; }\n\
  }\n\
  if (!selDay) selDay = days[days.length - 1];\n\
  var hLabs = data.host_labels || [];\n\
  var multiHost = hLabs.length > 1;\n\
  var prevDPick = window.__usageDetailDayPick;\n\
  window.__usageDetailDayPick = pick;\n\
  if (typeof prevDPick !== "undefined" && prevDPick !== pick) window.__usageDetailHost = null;\n\
  if (window.__usageDetailHost && (!multiHost || !selDay.hosts || !selDay.hosts[window.__usageDetailHost])) window.__usageDetailHost = null;\n\
  var hintEl = document.getElementById("day-picker-hint");\n\
  if (hintEl) {\n\
    hintEl.textContent = (pick === calToday && (selDay.total || 0) === 0) ? t("dayPickerHintZero") : "";\n\
  }\n\
  var ddh = document.getElementById("daily-detail-heading");\n\
  if (ddh) {\n\
    if (!ddh.querySelector("#daily-detail-title")) {\n\
      ddh.innerHTML = "<span id=\\"daily-detail-title\\"></span><button type=\\"button\\" id=\\"daily-detail-clear-host\\" style=\\"display:none;margin-left:10px;padding:2px 8px;border-radius:4px;border:1px solid #475569;background:#1e293b;color:#94a3b8;font-size:.72rem;cursor:pointer\\"></button>";\n\
    }\n\
    var ddt = document.getElementById("daily-detail-title");\n\
    var ddc = document.getElementById("daily-detail-clear-host");\n\
    if (ddt) ddt.textContent = t("dailyDetailPrefix") + pick + (window.__usageDetailHost ? " — " + window.__usageDetailHost : "");\n\
    if (ddc) {\n\
      if (window.__usageDetailHost && multiHost) {\n\
        ddc.style.display = "";\n\
        ddc.textContent = t("dailyDetailClearHost");\n\
        if (!ddc.dataset.bound) {\n\
          ddc.dataset.bound = "1";\n\
          ddc.addEventListener("click", function () {\n\
            window.__usageDetailHost = null;\n\
            if (__lastUsageData) renderDashboard(__lastUsageData);\n\
          });\n\
        }\n\
      } else ddc.style.display = "none";\n\
    }\n\
  }\n\
  var ls = document.getElementById("limit-source");\n\
  ls.textContent = apiNote(data, "limit_source_note", "limit_source_note_en");\n\
  ls.title = t("limitSourceTooltip");\n\
  var fn = document.getElementById("forensic-note");\n\
  if(fn) fn.textContent = apiNote(data, "forensic_note", "forensic_note_en");\n\
  document.getElementById("live-label").textContent = tr("liveConnected",{time:new Date().toLocaleTimeString()});\n\
  \n\
  // --- Summary cards (gewählter Tag im Dropdown) ---\n\
  var totalOut = days.reduce(function(s,d){return s+d.output},0);\n\
  var totalCache = days.reduce(function(s,d){return s+d.cache_read},0);\n\
  var totalAll = days.reduce(function(s,d){return s+d.total},0);\n\
  \n\
  // Find peak day\n\
  var peak = days.reduce(function(a,b){return a.total>b.total?a:b});\n\
  var budgetRatio = peak.total > 0 && selDay.total > 0 ? Math.round(peak.total / (selDay.total / 0.9)) : 0;\n\
  var hitSel = selDay.hit_limit || 0;\n\
  var hitAll = days.reduce(function(s,d){return s+(d.hit_limit||0)},0);\n\
  var fc = selDay.forensic_code || "\u2014";\n\
  var fwarn = fc === "?" || fc === "HIT" || fc === "<<P";\n\
  var impl90 = selDay.forensic_implied_cap_90 || 0;\n\
  var sumEl = document.getElementById("forensic-summary-line");\n\
  if (sumEl) {\n\
    sumEl.textContent = tr("forensicSummaryLine",{pick:pick,fc:fc,impl:impl90>0?fmt(impl90):"\u2014",bud:String(budgetRatio),peak:peak.date});\n\
  }\n\
  \n\
  var cards = [\n\
    {label:t("cardDayOutput"),value:fmt(selDay.output),sub:selDay.date,cls:""},\n\
    {label:t("cardDayCacheRead"),value:fmt(selDay.cache_read),sub:tr("cardCacheOutSub",{ratio:selDay.cache_output_ratio}),cls:selDay.cache_output_ratio>500?"warn":""},\n\
    {label:t("cardDayTotal"),value:fmt(selDay.total),sub:tr("cardCallsActiveSub",{calls:selDay.calls,hours:selDay.active_hours}),cls:""},\n\
    {label:t("cardHitDay"),value:String(hitSel),sub:t("cardHitDaySub"),cls:hitSel>0?"warn":"ok"},\n\
    {label:t("cardHitAll"),value:String(hitAll),sub:t("cardHitAllSub"),cls:hitAll>0?"warn":""},\n\
    {label:t("cardOverhead"),value:selDay.overhead+"x",sub:t("cardOverheadSub"),cls:selDay.overhead>1000?"danger":""},\n\
    {label:t("cardPeak"),value:fmt(peak.total),sub:tr("cardPeakSub",{date:peak.date}),cls:"ok"},\n\
    {label:t("cardAllOut"),value:fmt(totalOut),sub:tr("cardAllOutSub",{days:days.length}),cls:""},\n\
    {label:t("cardAllCache"),value:fmt(totalCache),sub:tr("cardAllCacheSub",{pct:pct(totalCache,totalAll)}),cls:""}\n\
  ];\n\
  if (multiHost && selDay.hosts) {\n\
    for (var hci = 0; hci < hLabs.length; hci++) {\n\
      var hlbl = hLabs[hci];\n\
      var hday = selDay.hosts[hlbl];\n\
      if (!hday) continue;\n\
      var hhit = hday.hit_limit || 0;\n\
      cards.push({label: hlbl + t("cardHostParen"),value: fmt(hday.total),sub: tr("cardHostSub",{out:fmt(hday.output),calls:hday.calls,hit:String(hhit)}),cls: hhit > 0 ? "warn" : ""});\n\
    }\n\
  }\n\
  var fcards = [\n\
    {label:t("fcForensicDay"),value:fc,sub:selDay.forensic_hint||"",cls:fwarn?"warn":""},\n\
    {label:t("fcImpl"),value:impl90>0?fmt(impl90):"\u2014",sub:t("fcImplSub"),cls:""},\n\
    {label:t("fcBudget"),value:"~"+budgetRatio+"x",sub:t("fcBudgetSub"),cls:budgetRatio>10?"danger":"warn"}\n\
  ];\n\
  var chtml="";\n\
  cards.forEach(function(c){chtml+="<div class=\\"card "+c.cls+"\\"><div class=\\"label\\">"+escHtml(c.label)+"</div><div class=\\"value\\">"+escHtml(c.value)+"</div><div class=\\"sub\\">"+escHtml(c.sub)+"</div></div>";});\n\
  document.getElementById("cards").innerHTML=chtml;\n\
  var fch="";\n\
  fcards.forEach(function(c){fch+="<div class=\\"card "+c.cls+"\\"><div class=\\"label\\">"+escHtml(c.label)+"</div><div class=\\"value\\">"+escHtml(c.value)+"</div><div class=\\"sub\\">"+escHtml(c.sub)+"</div></div>";});\n\
  var fcg=document.getElementById("forensic-cards");if(fcg)fcg.innerHTML=fch;\n\
  \n\
  // --- Charts ---\n\
  var labels = days.map(function(d){return d.date.slice(5)});\n\
  \n\
  // Create chart containers only once (Reihe 1: Token, C:O, Output/h)\n\
  if (!document.getElementById("c1")) {\n\
    var ch1 = document.createElement("div");ch1.className="chart-box";\n\
    ch1.innerHTML="<h3>"+escHtml(t("chartDailyToken"))+"</h3><canvas id=\\"c1\\"></canvas>";\n\
    var ch2 = document.createElement("div");ch2.className="chart-box";\n\
    ch2.innerHTML="<h3>"+escHtml(t("chartCacheRatio"))+"</h3><canvas id=\\"c2\\"></canvas>";\n\
    var ch3 = document.createElement("div");ch3.className="chart-box";\n\
    ch3.innerHTML="<h3>"+escHtml(t("chartOutPerHour"))+"</h3><canvas id=\\"c3\\"></canvas>";\n\
    var cr0 = document.getElementById("charts");\n\
    cr0.appendChild(ch1);\n\
    cr0.appendChild(ch2);\n\
    cr0.appendChild(ch3);\n\
  }\n\
  if (!document.getElementById("c4")) {\n\
    var ch4 = document.createElement("div");ch4.className="chart-box";\n\
    ch4.innerHTML="<h3>"+escHtml(t("chartSubCachePct"))+"</h3><canvas id=\\"c4\\"></canvas>";\n\
    document.getElementById("charts-host-sub").appendChild(ch4);\n\
  }\n\
  (function reorderChartBoxes(){\n\
    var cr = document.getElementById("charts");\n\
    var pair = document.getElementById("charts-host-sub");\n\
    if (!cr || !pair) return;\n\
    var c1b = document.getElementById("c1") && document.getElementById("c1").closest(".chart-box");\n\
    var c2b = document.getElementById("c2") && document.getElementById("c2").closest(".chart-box");\n\
    var c3b = document.getElementById("c3") && document.getElementById("c3").closest(".chart-box");\n\
    var hb = document.getElementById("chart-host-wrap");\n\
    var c4b = document.getElementById("c4") && document.getElementById("c4").closest(".chart-box");\n\
    if (c1b) cr.appendChild(c1b);\n\
    if (c2b) cr.appendChild(c2b);\n\
    if (c3b) cr.appendChild(c3b);\n\
    if (hb) pair.appendChild(hb);\n\
    if (c4b) pair.appendChild(c4b);\n\
  })();\n\
  \n\
  // Destroy old charts before recreating\n\
  if (_charts.c1hosts) { try { _charts.c1hosts.destroy(); } catch(e1) {} _charts.c1hosts = null; }\n\
  if (_charts.c1) { _charts.c1.destroy(); }\n\
  if (_charts.c2) { _charts.c2.destroy(); }\n\
  var elc1 = document.getElementById("c1");\n\
  if (elc1 && elc1.previousElementSibling && elc1.previousElementSibling.tagName === "H3") elc1.previousElementSibling.textContent = t("chartDailyToken");\n\
  var elc2 = document.getElementById("c2");\n\
  if (elc2 && elc2.previousElementSibling && elc2.previousElementSibling.tagName === "H3") elc2.previousElementSibling.textContent = t("chartCacheRatio");\n\
  \n\
  _charts.c1 = new Chart(document.getElementById("c1"),{\n\
    type:"bar",\n\
    data:{labels:labels,datasets:[\n\
      {label:t("chartDS_cacheRead"),data:days.map(function(d){return d.cache_read}),backgroundColor:"rgba(139,92,246,0.7)",stack:"s"},\n\
      {label:t("chartDS_output"),data:days.map(function(d){return d.output}),backgroundColor:"rgba(59,130,246,0.9)",stack:"s"},\n\
      {label:t("chartDS_cacheCreate"),data:days.map(function(d){return d.cache_creation}),backgroundColor:"rgba(6,182,212,0.5)",stack:"s"}\n\
    ]},\n\
    options:{responsive:true,scales:{y:{stacked:true,ticks:{callback:function(v){return fmt(v)}}},x:{stacked:true}},plugins:{tooltip:{callbacks:{label:function(c){return c.dataset.label+": "+fmt(c.raw);},footer:function(items){if(!items.length)return"";var di=items[0].dataIndex;return tr("chartTooltipCoDay",{ratio:String(days[di].cache_output_ratio)});}}}}}\n\
  });\n\
  \n\
  var hostBarColors = ["rgba(59,130,246,0.88)","rgba(167,139,250,0.88)","rgba(52,211,153,0.88)","rgba(251,191,36,0.88)","rgba(249,115,22,0.88)","rgba(236,72,153,0.88)"];\n\
  if (multiHost) {\n\
    if (!document.getElementById("c1-hosts")) {\n\
      var ch1h = document.createElement("div");\n\
      ch1h.className = "chart-box";\n\
      ch1h.id = "chart-host-wrap";\n\
      ch1h.innerHTML = "<h3></h3><p style=\\"font-size:.72rem;color:#94a3b8;margin:4px 0 10px;line-height:1.4\\"></p><canvas id=\\"c1-hosts\\"></canvas>";\n\
      var pairIns = document.getElementById("charts-host-sub");\n\
      if (pairIns) {\n\
        if (pairIns.firstChild) pairIns.insertBefore(ch1h, pairIns.firstChild);\n\
        else pairIns.appendChild(ch1h);\n\
      }\n\
    }\n\
    var pairBar = document.getElementById("charts-host-sub");\n\
    if (pairBar) pairBar.classList.add("has-host");\n\
    var chw = document.getElementById("chart-host-wrap");\n\
    if (chw) {\n\
      chw.style.display = "";\n\
      var h3h = chw.querySelector("h3");\n\
      var ph = chw.querySelector("p");\n\
      if (h3h) h3h.textContent = t("chartHostTitle");\n\
      if (ph) ph.textContent = t("chartHostBlurb");\n\
    }\n\
    var dsH = [];\n\
    for (var hli = 0; hli < hLabs.length; hli++) {\n\
      var lb0 = hLabs[hli];\n\
      dsH.push({label: lb0,data: days.map(function(d){ var x = d.hosts && d.hosts[lb0]; return x ? (x.total || 0) : 0;}),backgroundColor: hostBarColors[hli % hostBarColors.length],stack: "h"});\n\
    }\n\
    _charts.c1hosts = new Chart(document.getElementById("c1-hosts"),{type:"bar",data:{labels:labels,datasets:dsH},options:{responsive:true,scales:{x:{stacked:true,grid:{color:"rgba(51,65,85,0.5)"}},y:{stacked:true,ticks:{callback:function(v){return fmt(v);}},grid:{color:"rgba(51,65,85,0.5)"}}},plugins:{legend:{labels:{color:"#cbd5e1"}},tooltip:{callbacks:{label:function(c){return c.dataset.label+": "+fmt(c.parsed.y);},footer:function(tipItems){if(!tipItems.length)return"";var di=tipItems[0].dataIndex;var segs=[];for(var ci=0;ci<tipItems.length;ci++){var L=tipItems[ci].dataset.label;var hh=days[di].hosts&&days[di].hosts[L];if(hh)segs.push(tr("chartTooltipCoHostLine",{host:L,ratio:String(hh.cache_output_ratio)}));}var s=0;for(var fi=0;fi<tipItems.length;fi++)s+=tipItems[fi].parsed.y||0;return(segs.length?segs.join(" · ")+" | ":"")+t("hostStackFooter")+fmt(s);}}}}}});\n\
  } else {\n\
    var chw2 = document.getElementById("chart-host-wrap");\n\
    if (chw2) chw2.style.display = "none";\n\
    var pairBar2 = document.getElementById("charts-host-sub");\n\
    if (pairBar2) pairBar2.classList.remove("has-host");\n\
  }\n\
  \n\
  _charts.c2 = new Chart(document.getElementById("c2"),{\n\
    type:"line",\n\
    data:{labels:labels,datasets:[{\n\
      label:t("chartLineCacheOut"),data:days.map(function(d){return d.cache_output_ratio}),\n\
      borderColor:"#f59e0b",backgroundColor:"rgba(245,158,11,0.1)",fill:true,tension:0.3\n\
    }]},\n\
    options:{responsive:true,scales:{y:{beginAtZero:true}},plugins:{tooltip:{callbacks:{label:function(c){return c.raw+"x";},footer:function(items){if(!items.length)return"";var di=items[0].dataIndex;var d=days[di];return tr("chartTooltipOutCacheDay",{out:fmt(d.output),cache:fmt(d.cache_read)});}}}}}\n\
  });\n\
  \n\
  if (_charts.c3) { _charts.c3.destroy(); }\n\
  if (_charts.c4) { _charts.c4.destroy(); }\n\
  var elc3 = document.getElementById("c3");\n\
  if (elc3 && elc3.previousElementSibling && elc3.previousElementSibling.tagName === "H3") elc3.previousElementSibling.textContent = t("chartOutPerHour");\n\
  var elc4 = document.getElementById("c4");\n\
  if (elc4 && elc4.previousElementSibling && elc4.previousElementSibling.tagName === "H3") elc4.previousElementSibling.textContent = t("chartSubCachePct");\n\
  \n\
  _charts.c3 = new Chart(document.getElementById("c3"),{\n\
    type:"bar",\n\
    data:{labels:labels,datasets:[{\n\
      label:t("chartOutPerHLabel"),data:days.map(function(d){return d.output_per_hour}),\n\
      backgroundColor:"rgba(34,197,94,0.7)"\n\
    }]},\n\
    options:{responsive:true,scales:{y:{ticks:{callback:function(v){return fmt(v)}}}},plugins:{tooltip:{callbacks:{label:function(c){return fmt(c.raw)+"/h"}}}}}\n\
  });\n\
  \n\
  var c4El = document.getElementById("c4");\n\
  var c4Data;\n\
  var c4Opts;\n\
  if (multiHost) {\n\
    var ds4 = [];\n\
    for (var c4i = 0; c4i < hLabs.length; c4i++) {\n\
      var lb4 = hLabs[c4i];\n\
      ds4.push({\n\
        label: lb4,\n\
        stack: "subcache",\n\
        data: days.map(function (d) {\n\
          var cr = d.cache_read || 0;\n\
          var x = d.hosts && d.hosts[lb4];\n\
          if (!x || cr <= 0) return 0;\n\
          return Math.round(((x.sub_cache || 0) / cr) * 100);\n\
        }),\n\
        backgroundColor: hostBarColors[c4i % hostBarColors.length]\n\
      });\n\
    }\n\
    c4Data = { labels: labels, datasets: ds4 };\n\
    c4Opts = {\n\
      responsive: true,\n\
      scales: {\n\
        x: { stacked: true, grid: { color: "rgba(51,65,85,0.5)" } },\n\
        y: { max: 100, stacked: true, ticks: { callback: function (v) { return v + "%"; } }, grid: { color: "rgba(51,65,85,0.5)" } }\n\
      },\n\
      plugins: {\n\
        legend: { labels: { color: "#cbd5e1" } },\n\
        tooltip: {\n\
          callbacks: {\n\
            label: function (c) {\n\
              return c.dataset.label + ": " + c.raw + "% " + t("chartTooltipSubCacheOfDay");\n\
            },\n\
            footer: function (items) {\n\
              if (!items.length) return "";\n\
              var di = items[0].dataIndex;\n\
              return tr("chartTooltipSubCacheStackTotal", { pct: String(days[di].sub_cache_pct) });\n\
            }\n\
          }\n\
        }\n\
      }\n\
    };\n\
  } else {\n\
    c4Data = {\n\
      labels: labels,\n\
      datasets: [\n\
        {\n\
          label: t("chartSubCachePct"),\n\
          data: days.map(function (d) { return d.sub_cache_pct; }),\n\
          backgroundColor: days.map(function (d) {\n\
            return d.sub_cache_pct > 50 ? "rgba(239,68,68,0.7)" : "rgba(100,116,139,0.5)";\n\
          })\n\
        }\n\
      ]\n\
    };\n\
    c4Opts = { responsive: true, scales: { y: { max: 100, ticks: { callback: function (v) { return v + "%"; } } } }, plugins: { tooltip: { callbacks: { label: function (c) { return c.raw + "%"; } } } } };\n\
  }\n\
  _charts.c4 = new Chart(c4El, { type: "bar", data: c4Data, options: c4Opts });\n\
  \n\
  var tblDeleg = document.getElementById("tbl");\n\
  if (tblDeleg && !tblDeleg.dataset.hostDetailDeleg) {\n\
    tblDeleg.dataset.hostDetailDeleg = "1";\n\
    tblDeleg.addEventListener("click", function (ev) {\n\
      var tr = ev.target.closest("tr");\n\
      if (!tr || !tr.dataset.detailRow) return;\n\
      if (tr.dataset.detailRow === "host" && tr.dataset.hostLabel) {\n\
        window.__usageDetailHost = tr.dataset.hostLabel;\n\
        if (__lastUsageData) renderDashboard(__lastUsageData);\n\
      } else if (tr.dataset.detailRow === "filtered") {\n\
        window.__usageDetailHost = null;\n\
        if (__lastUsageData) renderDashboard(__lastUsageData);\n\
      }\n\
    });\n\
  }\n\
  \n\
  // --- Table ---\n\
  var cols=t("tableCols").split("|");\n\
  var thead=document.querySelector("#tbl thead tr");\n\
  thead.innerHTML="";\n\
  cols.forEach(function(c,ci){var th=document.createElement("th");th.textContent=c;if(ci>0)th.className="num";thead.appendChild(th);});\n\
  \n\
  var tbody=document.querySelector("#tbl tbody");\n\
  tbody.innerHTML="";\n\
  var filteredHost = window.__usageDetailHost;\n\
  var fhDay = filteredHost && selDay.hosts && selDay.hosts[filteredHost] ? selDay.hosts[filteredHost] : null;\n\
  var tableRows = fhDay\n\
    ? [{\n\
        date: pick,\n\
        output: fhDay.output,\n\
        cache_read: fhDay.cache_read,\n\
        cache_output_ratio: fhDay.cache_output_ratio,\n\
        overhead: fhDay.overhead,\n\
        total: fhDay.total,\n\
        calls: fhDay.calls,\n\
        active_hours: fhDay.active_hours,\n\
        hit_limit: fhDay.hit_limit || 0,\n\
        sub_pct: fhDay.sub_pct,\n\
        sub_cache_pct: fhDay.sub_cache_pct,\n\
        output_per_hour: fhDay.output_per_hour\n\
      }]\n\
    : [selDay];\n\
  for(var i=0;i<tableRows.length;i++){\n\
    var d=tableRows[i];\n\
    var trEl=document.createElement("tr");\n\
    if (fhDay) {\n\
      trEl.dataset.detailRow = "filtered";\n\
      trEl.style.cursor = "pointer";\n\
      trEl.title = t("dailyDetailFilteredRowTitle");\n\
    }\n\
    var hl=d.hit_limit||0;\n\
    var vals=[d.date,fmt(d.output),fmt(d.cache_read),d.cache_output_ratio+"x",d.overhead+"x",fmt(d.total),d.calls,d.active_hours,String(hl),d.sub_pct+"%",d.sub_cache_pct+"%",fmt(d.output_per_hour)];\n\
    vals.forEach(function(v,j){\n\
      var td=document.createElement("td");\n\
      td.textContent=v;\n\
      if(j>0)td.className="num";\n\
      if(j===3&&d.cache_output_ratio>1000)td.classList.add("hi");\n\
      if(j===3&&d.cache_output_ratio>2000)td.classList.add("crit");\n\
      if(j===4&&d.overhead>1500)td.classList.add("hi");\n\
      if(j===8&&hl>0)td.classList.add("hi");\n\
      trEl.appendChild(td);\n\
    });\n\
    tbody.appendChild(trEl);\n\
    if (!fhDay && multiHost && selDay.hosts) {\n\
      for (var ti = 0; ti < hLabs.length; ti++) {\n\
        var tlab = hLabs[ti];\n\
        var hd = selDay.hosts[tlab];\n\
        if (!hd) continue;\n\
        var trh = document.createElement("tr");\n\
        trh.style.color = "#94a3b8";\n\
        trh.style.cursor = "pointer";\n\
        trh.title = t("dailyDetailHostRowTitle");\n\
        trh.dataset.detailRow = "host";\n\
        trh.dataset.hostLabel = tlab;\n\
        var hhl = hd.hit_limit || 0;\n\
        var hvals = ["  \u2514 " + tlab, fmt(hd.output), fmt(hd.cache_read), hd.cache_output_ratio + "x", hd.overhead + "x", fmt(hd.total), hd.calls, hd.active_hours, String(hhl), hd.sub_pct + "%", hd.sub_cache_pct + "%", fmt(hd.output_per_hour)];\n\
        for (var hj = 0; hj < hvals.length; hj++) {\n\
          var tdh = document.createElement("td");\n\
          tdh.textContent = hvals[hj];\n\
          if (hj > 0) tdh.className = "num";\n\
          if (hj === 8 && hhl > 0) tdh.classList.add("hi");\n\
          trh.appendChild(tdh);\n\
        }\n\
        tbody.appendChild(trh);\n\
      }\n\
    }\n\
  }\n\
  \n\
  function forensicScoreDay(d){\n\
    var c=d.forensic_code||"\u2014";\n\
    if(c==="?")return 3;\n\
    if(c==="HIT")return 2;\n\
    if(c==="<<P")return 1;\n\
    return 0;\n\
  }\n\
  var elF=document.getElementById("c-forensic");\n\
  if(elF){\n\
    if(_charts.cForensic){try{_charts.cForensic.destroy();}catch(e){}}\n\
    _charts.cForensic=new Chart(elF,{\n\
      data:{\n\
        labels:labels,\n\
        datasets:[\n\
          {\n\
            type:"bar",\n\
            label:t("forensicDS_hitLimit"),\n\
            data:days.map(function(d){return d.hit_limit||0}),\n\
            backgroundColor:days.map(function(d){return (d.hit_limit||0)>0?"rgba(239,68,68,0.92)":"rgba(71,85,105,0.35)"}),\n\
            borderColor:days.map(function(d){return (d.hit_limit||0)>0?"#dc2626":"transparent"}),\n\
            borderWidth:1,\n\
            yAxisID:"y"\n\
          },\n\
          {\n\
            type:"line",\n\
            label:t("forensicDS_score"),\n\
            data:days.map(forensicScoreDay),\n\
            borderColor:"#f59e0b",\n\
            backgroundColor:"rgba(245,158,11,0.12)",\n\
            pointBackgroundColor:"#fbbf24",\n\
            pointRadius:4,\n\
            tension:0.25,\n\
            yAxisID:"y1",\n\
            borderWidth:2\n\
          }\n\
        ]\n\
      },\n\
      options:{\n\
        responsive:true,\n\
        maintainAspectRatio:true,\n\
        aspectRatio:2.4,\n\
        interaction:{mode:"index",intersect:false},\n\
        scales:{\n\
          x:{grid:{color:"rgba(51,65,85,0.5)"}},\n\
          y:{\n\
            position:"left",\n\
            beginAtZero:true,\n\
            title:{display:true,text:t("forensicAxisHit"),color:"#f87171"},\n\
            ticks:{color:"#94a3b8",precision:0},\n\
            grid:{color:"rgba(51,65,85,0.5)"}\n\
          },\n\
          y1:{\n\
            position:"right",\n\
            min:0,\n\
            max:3.5,\n\
            title:{display:true,text:t("forensicAxisForensic"),color:"#fbbf24"},\n\
            ticks:{stepSize:1,color:"#94a3b8"},\n\
            grid:{drawOnChartArea:false}\n\
          }\n\
        },\n\
        plugins:{\n\
          legend:{labels:{color:"#cbd5e1"}},\n\
          tooltip:{\n\
            callbacks:{\n\
              title:function(items){return items.length?days[items[0].dataIndex].date:"";},\n\
              afterBody:function(items){\n\
                if(!items.length)return"";\n\
                var di=items[0].dataIndex;\n\
                var x=days[di];\n\
                var lines=[];\n\
                lines.push(t("tooltipVsPeak")+(x.forensic_vs_peak>0?x.forensic_vs_peak+"\u00d7":"\u2014"));\n\
                lines.push(t("tooltipImpl90")+(x.forensic_implied_cap_90>0?fmt(x.forensic_implied_cap_90):"\u2014"));\n\
                if(x.forensic_hint)lines.push(x.forensic_hint);\n\
                return lines;\n\
              }\n\
            }\n\
          }\n\
        }\n\
      }\n\
    });\n\
  }\n\
}\n\
\n\
// Sofort aktuellen Cache holen (nicht nur auf erstes SSE warten)\n\
(function(){\n\
  var bde=document.getElementById("lang-de");\n\
  var ben=document.getElementById("lang-en");\n\
  if(bde) bde.addEventListener("click",function(){ setLang("de"); });\n\
  if(ben) ben.addEventListener("click",function(){ setLang("en"); });\n\
  applyStaticChrome();\n\
  initMetaDetailsPanel();\n\
  var lp=document.getElementById("live-pop");\n\
  var tr=document.getElementById("live-trigger");\n\
  if(lp&&tr){\n\
    tr.addEventListener("click",function(e){e.stopPropagation();lp.classList.toggle("live-files-open");});\n\
    document.addEventListener("click",function(){lp.classList.remove("live-files-open");});\n\
    lp.addEventListener("click",function(e){e.stopPropagation();});\n\
  }\n\
})();\n\
fetch("/api/usage").then(function(r){return r.json();}).then(function(d){try{renderDashboard(d);}catch(e){console.error(e);}}).catch(function(){});\n\
\n\
// SSE: auto-update from server push\n\
var evtSource = new EventSource("/api/stream");\n\
evtSource.onmessage = function(e) {\n\
  try { renderDashboard(JSON.parse(e.data)); } catch(err) { console.error(err); }\n\
};\n\
evtSource.onerror = function() {\n\
  document.getElementById("live-dot").style.background = "#ef4444";\n\
  document.getElementById("live-label").textContent = t("sseDisconnected");\n\
};\n\
</script>\n\
</body>\n\
</html>';

// ── Live Data Cache + SSE ────────────────────────────────────────────────

function makeStubCachedData() {
  return {
    days: [],
    parsed_files: 0,
    generated: new Date().toISOString(),
    refresh_sec: REFRESH_SEC,
    limit_source_note: buildLimitSourceNote(),
    limit_source_note_en: buildLimitSourceNoteEn(),
    scope: 'claude-models-only',
    forensic_peak_date: '',
    forensic_peak_total: 0,
    forensic_note: '',
    forensic_note_en: '',
    scanning: true,
    calendar_today: localCalendarTodayStr(),
    day_cache_mode: '',
    day_cache_mode_en: '',
    scanned_files: [],
    scan_sources: [],
    host_labels: ['local']
  };
}

var cachedData = makeStubCachedData();
var sseClients = [];
var scanInProgress = false;
var scanQueued = false;

function broadcastSse() {
  if (!cachedData) return;
  var json = JSON.stringify(cachedData);
  for (var i = sseClients.length - 1; i >= 0; i--) {
    try {
      sseClients[i].write('data: ' + json + '\n\n');
    } catch (e) {
      sseClients.splice(i, 1);
    }
  }
}

// Scan läuft inkrementell (setImmediate zwischen Datei-Batches): Server startet sofort, HTTP bleibt bedienbar.
function runScanAndBroadcast() {
  if (scanInProgress) {
    scanQueued = true;
    return;
  }
  scanInProgress = true;
  var lastPartialEmitMs = 0;
  function applyIncrementalProgress(state) {
    var now = Date.now();
    var mid = state.fi > 0 && state.fi < state.tagged.length;
    if (mid && state.fi > SCAN_FILES_PER_TICK && now - lastPartialEmitMs < 480) return;
    lastPartialEmitMs = now;
    try {
      var partial = buildUsageResult(state.daily, state.tagged.length, state.tagged, state.roots);
      partial.calendar_today = state.todayStr;
      partial.day_cache_mode = state.useTodayOnly ? 'heute-jsonl+vortage-cache' : 'vollstaendiger-jsonl-scan';
      partial.day_cache_mode_en = state.useTodayOnly
        ? 'today JSONL + past days from cache'
        : 'full JSONL scan';
      partial.refresh_sec = REFRESH_SEC;
      partial.scanning = true;
      partial.scan_progress = { done: state.fi, total: state.tagged.length };
      partial.generated = new Date().toISOString();
      cachedData = partial;
      broadcastSse();
    } catch (pe) {}
  }
  parseAllUsageIncremental(function (err, data) {
    try {
      if (err) throw err;
      data.refresh_sec = REFRESH_SEC;
      data.scanning = false;
      delete data.scan_progress;
      if (data.scan_error) delete data.scan_error;
      cachedData = data;
    } catch (e) {
      console.error('parseAllUsageIncremental:', e);
      var msg = e && e.message ? e.message : String(e);
      if (!cachedData || !cachedData.days || cachedData.days.length === 0) {
        cachedData = makeStubCachedData();
      }
      cachedData.scanning = false;
      cachedData.scan_error = msg;
    } finally {
      scanInProgress = false;
      broadcastSse();
      if (scanQueued) {
        scanQueued = false;
        runScanAndBroadcast();
      }
    }
  }, applyIncrementalProgress);
}

// ── HTTP Server ─────────────────────────────────────────────────────────

var server = http.createServer(function (req, res) {
  if (req.url === '/api/usage') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(cachedData));
  } else if (req.url === '/api/i18n-bundles') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(buildI18nBundles()));
  } else if (req.url === '/api/stream') {
    // SSE endpoint
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*'
    });
    res.write('data: ' + JSON.stringify(cachedData) + '\n\n');
    sseClients.push(res);
    req.on('close', function () {
      var idx = sseClients.indexOf(res);
      if (idx >= 0) sseClients.splice(idx, 1);
    });
  } else {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(getDashboardHtml());
  }
});

server.listen(PORT, function () {
  console.log('Claude Code Usage Dashboard running at http://localhost:' + PORT);
  console.log('Auto-refresh every ' + REFRESH_SEC + 's (--refresh=N to change)');
  console.log('Erster Scan läuft inkrementell (SSE-Updates, Zwischenstände); Seite sofort nutzbar.');
  console.log('Press Ctrl+C to stop.');
  runScanAndBroadcast();
});

setInterval(runScanAndBroadcast, REFRESH_SEC * 1000);
