#!/usr/bin/env node
'use strict';
/**
 * Packt ~/.claude/projects (optional anthropic-proxy-logs) als tar.gz und POSTet an das Dashboard.
 *
 *   CLAUDE_SYNC_URL=http://127.0.0.1:3333 CLAUDE_SYNC_TOKEN=geheim node scripts/claude-data-sync-client.js
 *   node scripts/claude-data-sync-client.js --url=https://usage.example.com --token=geheim --proxy-logs
 *
 * tar: macOS/Linux im PATH; Windows oft nur unter System32 — siehe resolveTarBin().
 */
var cp = require('child_process');
var fs = require('fs');
var path = require('path');
var os = require('os');
var http = require('http');
var https = require('https');

function resolveTarBin() {
  var fromEnv = process.env.CLAUDE_SYNC_TAR;
  if (fromEnv && String(fromEnv).trim()) return String(fromEnv).trim();
  if (process.platform === 'win32') {
    var sysTar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
    try {
      if (fs.existsSync(sysTar)) return sysTar;
    } catch (e) {}
  }
  return 'tar';
}

var urlStr = process.env.CLAUDE_SYNC_URL || '';
var token = process.env.CLAUDE_SYNC_TOKEN || '';
var includeProxyLogs = false;
var tarBin = resolveTarBin();

for (var ai = 2; ai < process.argv.length; ai++) {
  var a = process.argv[ai];
  var um = a.match(/^--url=(.+)$/);
  if (um) urlStr = um[1].trim();
  var tm = a.match(/^--token=(.+)$/);
  if (tm) token = tm[1].trim();
  if (a === '--proxy-logs') includeProxyLogs = true;
  if (a === '--help' || a === '-h') {
    console.log(
      [
        'Usage: CLAUDE_SYNC_URL=http://host:3333 CLAUDE_SYNC_TOKEN=secret node scripts/claude-data-sync-client.js',
        '   or: node scripts/claude-data-sync-client.js --url=... --token=... [--proxy-logs]',
        '',
        'Packs ~/.claude/projects (and optionally anthropic-proxy-logs) and POSTs to /api/claude-data-sync.'
      ].join('\n')
    );
    process.exit(0);
  }
}

urlStr = String(urlStr || '').trim();
token = String(token || '').trim();
if (/^Bearer\s+/i.test(token)) {
  token = token.replace(/^Bearer\s+/i, '').trim();
}

if (!urlStr || !token) {
  console.error('claude-data-sync-client: set CLAUDE_SYNC_URL and CLAUDE_SYNC_TOKEN (or --url / --token)');
  process.exit(1);
}

var home = process.env.USERPROFILE || process.env.HOME || os.homedir();
var claudeDir = path.join(home, '.claude');
var projectsDir = path.join(claudeDir, 'projects');
try {
  if (!fs.statSync(projectsDir).isDirectory()) {
    console.error('claude-data-sync-client: missing directory ' + projectsDir);
    process.exit(1);
  }
} catch (e) {
  console.error('claude-data-sync-client: cannot read ' + projectsDir + ': ' + (e.message || e));
  process.exit(1);
}

var toPack = ['projects'];
if (includeProxyLogs) {
  var logsDir = path.join(claudeDir, 'anthropic-proxy-logs');
  try {
    if (fs.statSync(logsDir).isDirectory()) toPack.push('anthropic-proxy-logs');
  } catch (e2) {}
}

var tmpTar = path.join(os.tmpdir(), 'claude-sync-out-' + process.pid + '-' + Date.now() + '.tgz');
var args = ['czf', tmpTar, '-C', claudeDir].concat(toPack);
var tr = cp.spawn(tarBin, args, { stdio: 'inherit', windowsHide: true });
tr.on('error', function (err) {
  console.error('claude-data-sync-client: tar failed to start: ' + (err.message || err));
  if (process.platform === 'win32' && tarBin === 'tar') {
    console.error('claude-data-sync-client: try: $env:CLAUDE_SYNC_TAR="C:\\Windows\\System32\\tar.exe"');
  }
  process.exit(1);
});
tr.on('close', function (code) {
  if (code !== 0) {
    console.error('claude-data-sync-client: tar exited ' + code);
    process.exit(1);
  }
  var buf;
  try {
    buf = fs.readFileSync(tmpTar);
  } catch (e3) {
    console.error('claude-data-sync-client: read archive: ' + (e3.message || e3));
    process.exit(1);
  } finally {
    try {
      fs.unlinkSync(tmpTar);
    } catch (e4) {}
  }

  var u;
  try {
    u = new URL(urlStr.indexOf('://') < 0 ? 'https://' + urlStr : urlStr);
  } catch (e5) {
    console.error('claude-data-sync-client: bad URL');
    process.exit(1);
  }
  var isHttps = u.protocol === 'https:';
  var mod = isHttps ? https : http;
  var port = u.port ? parseInt(u.port, 10) : isHttps ? 443 : 80;
  var pathname = (u.pathname || '/').replace(/\/$/, '') + '/api/claude-data-sync';
  if (pathname.indexOf('//') === 0) pathname = pathname.slice(1);

  var opts = {
    hostname: u.hostname,
    port: port,
    path: pathname,
    method: 'POST',
    headers: {
      'Content-Type': 'application/gzip',
      'Content-Length': String(buf.length),
      Authorization: 'Bearer ' + token
    }
  };

  var req = mod.request(opts, function (res) {
    res.on('error', function (e) {
      console.error('claude-data-sync-client: response stream error: ' + (e.message || e));
      process.exit(1);
    });
    var chunks = [];
    res.on('data', function (c) {
      chunks.push(c);
    });
    res.on('end', function () {
      var body = Buffer.concat(chunks).toString('utf8');
      if (res.statusCode >= 200 && res.statusCode < 300) {
        console.log(body);
        process.exit(0);
      }
      console.error('claude-data-sync-client: HTTP ' + res.statusCode + ' ' + body);
      if (res.statusCode === 401) {
        console.error(
          'claude-data-sync-client: local token length=' +
            token.length +
            ' — must match CLAUDE_USAGE_SYNC_TOKEN in the pod. Check: GET ' +
            urlStr.replace(/\/$/, '') +
            '/api/debug/status (claude_data_sync_enabled).'
        );
      }
      process.exit(1);
    });
  });
  req.on('error', function (e) {
    console.error('claude-data-sync-client: request failed: ' + (e.message || e));
    process.exit(1);
  });
  req.write(buf);
  req.end();
});
