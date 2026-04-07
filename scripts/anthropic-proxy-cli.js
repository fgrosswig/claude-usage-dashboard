#!/usr/bin/env node
'use strict';
/**
 * CLI für den Anthropic-Monitor-Proxy (Kernlogik: ./anthropic-proxy-core.js).
 * Start: node start.js proxy   oder   node anthropic-proxy.js
 */
var path = require('path');
var os = require('os');
var core = require('./anthropic-proxy-core');

var HOME = process.env.USERPROFILE || process.env.HOME || os.homedir();
var defaultLogDir = path.join(HOME, '.claude', 'anthropic-proxy-logs');

var port = core.DEFAULT_PORT;
var upstream = process.env.ANTHROPIC_PROXY_UPSTREAM || core.DEFAULT_UPSTREAM;
var align = null;

for (var i = 2; i < process.argv.length; i++) {
  var a = process.argv[i];
  var pm = a.match(/^--port=(\d+)$/);
  if (pm) port = parseInt(pm[1], 10);
  var um = a.match(/^--upstream=(.+)$/);
  if (um) upstream = um[1].trim();
  if (a === '--align-jsonl') align = true;
  if (a === '--no-align-jsonl') align = false;
  if (a === '--help' || a === '-h') {
    console.log(
      [
        'Usage: node start.js proxy [--port=8080] [--upstream=https://api.anthropic.com]',
        '   or: node anthropic-proxy.js [--port=8080] [...]',
        '',
        'Route Claude (Beispiel):',
        '  ANTHROPIC_BASE_URL=http://127.0.0.1:8080 claude',
        '',
        'Logs: NDJSON pro Kalendertag unter ~/.claude/anthropic-proxy-logs/ (oder ANTHROPIC_PROXY_LOG_DIR).',
        '',
        'Umgebung:',
        '  ANTHROPIC_PROXY_UPSTREAM — Ziel-API (Standard https://api.anthropic.com)',
        '  ANTHROPIC_PROXY_ALIGN_JSONL=1 — heuristische Zuordnung zu JSONL unter ~/.claude/projects',
        '  ANTHROPIC_PROXY_JSONL_ROOTS — zusätzliche Wurzeln (;-getrennt)',
        '  ANTHROPIC_PROXY_LOG_STDOUT=1 — eine Zeile pro Request',
        '  ANTHROPIC_PROXY_LOG_BODIES=1 — Request-Body-Auszug (Vorsicht: kann Secrets enthalten)',
        '  ANTHROPIC_PROXY_ALIGN_WINDOW_MS=120000',
        '  ANTHROPIC_PROXY_MAX_BODY_MB / ANTHROPIC_PROXY_MAX_RESPONSE_MB',
        '  ANTHROPIC_PROXY_BIND — Abhöradresse (Standard 127.0.0.1; z. B. 0.0.0.0 für Container)'
      ].join('\n')
    );
    process.exit(0);
  }
}

if (isNaN(port) || port < 1 || port > 65535) {
  console.error('anthropic-proxy: invalid --port');
  process.exit(1);
}

var serverOpts = { upstream: upstream };
if (align !== null) serverOpts.alignJsonl = align;

var bindHost = (process.env.ANTHROPIC_PROXY_BIND || '127.0.0.1').trim() || '127.0.0.1';

var server = core.createProxyServer(serverOpts);
server.listen(port, bindHost, function () {
  var logDir = process.env.ANTHROPIC_PROXY_LOG_DIR || defaultLogDir;
  var day = new Date().toISOString().slice(0, 10);
  console.log('Anthropic monitor proxy at http://' + bindHost + ':' + port);
  console.log('Upstream: ' + upstream);
  console.log('Example: ANTHROPIC_BASE_URL=http://127.0.0.1:' + port + ' claude');
  console.log('Log file today: ' + path.join(logDir, 'proxy-' + day + '.ndjson'));
});
