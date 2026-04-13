#!/usr/bin/env node
'use strict';
/**
 * Generischer Starter: Dashboard oder Anthropic-Proxy (Submodules unter scripts/).
 *
 *   node start.js                  → Dashboard (wie server.js)
 *   node start.js --port=3333      → Dashboard mit Optionen
 *   node start.js dashboard        → Dashboard
 *   node start.js proxy            → Anthropic-Monitor-Proxy
 *   node start.js both             → Dashboard + Proxy (zwei Kindprozesse)
 *   node start.js forensics        → Token-Forensik (CLI, scripts/token-forensics.js)
 */
var path = require('node:path');

var raw = process.argv.slice(2);
var cmd = 'dashboard';
var restStart = 0;

if (raw.length) {
  var first = raw[0];
  if (first.indexOf('-') !== 0) {
    var lc = first.toLowerCase();
    if (
      lc === 'dashboard' ||
      lc === 'server' ||
      lc === 'proxy' ||
      lc === 'anthropic-proxy' ||
      lc === 'usage' ||
      lc === 'forensics' ||
      lc === 'token-forensics' ||
      lc === 'token_forensics' ||
      lc === 'both' ||
      lc === 'all' ||
      lc === 'help' ||
      lc === '-h' ||
      lc === '--help'
    ) {
      cmd = lc;
      restStart = 1;
    }
  }
}

var tail = raw.slice(restStart);
var passthrough = [];
for (var i = 0; i < tail.length; i++) {
  if (tail[i] === '--') {
    passthrough = passthrough.concat(tail.slice(i + 1));
    break;
  }
  passthrough.push(tail[i]);
}

process.argv = [process.argv[0], process.argv[1]].concat(passthrough);

if (cmd === 'help' || cmd === '-h' || cmd === '--help') {
  console.log(
    [
      'Usage: node start.js [dashboard|server|proxy] [dashboard-args...]',
      '',
      '  dashboard | server   Claude Usage Dashboard (default if first arg is an option)',
      '  proxy                Anthropic monitor proxy',
      '  both | all           Dashboard (3333) + proxy (8080) in one terminal',
      '  forensics            Token forensics CLI (same scan roots as dashboard)',
      '',
      'Examples:',
      '  node start.js',
      '  node start.js --port=3333 --refresh=300',
      '  node start.js proxy --port=8080',
      '  node start.js both',
      '  node start.js both -- --port=4444',
      '  node start.js forensics',
      '  node server.js --port=3333',
      '',
      'Both mode: extra args after -- go to the dashboard only. Proxy port: env ANTHROPIC_PROXY_PORT or default 8080.'
    ].join('\n')
  );
  process.exit(0);
}

if ((cmd === 'both' || cmd === 'all') && (process.env.DEV_MODE || '').trim()) {
  console.error('start.js: "both" mode is not allowed with DEV_MODE (local dev uses remote data, not a local proxy)');
  console.error('Use: node start.js dashboard');
  process.exit(1);
}

if (cmd === 'both' || cmd === 'all') {
  var cp = require('node:child_process');
  var spawnOpts = { stdio: 'inherit', cwd: __dirname };
  var dashScript = path.join(__dirname, 'scripts', 'dashboard-server.js');
  var proxyScript = path.join(__dirname, 'scripts', 'anthropic-proxy-cli.js');
  var dashChild = cp.spawn(process.execPath, [dashScript].concat(passthrough), spawnOpts);
  var proxyChild = cp.spawn(process.execPath, [proxyScript], spawnOpts);
  var exiting = false;
  function shutdownBoth(code) {
    if (exiting) return;
    exiting = true;
    try {
      dashChild.kill('SIGTERM');
    } catch (e0) {}
    try {
      proxyChild.kill('SIGTERM');
    } catch (e1) {}
    process.exit(typeof code === 'number' ? code : 0);
  }
  process.on('SIGINT', function () {
    shutdownBoth(0);
  });
  process.on('SIGTERM', function () {
    shutdownBoth(0);
  });
  dashChild.on('exit', function (code) {
    if (!exiting) {
      exiting = true;
      try {
        proxyChild.kill('SIGTERM');
      } catch (e2) {}
      process.exit(code === null ? 1 : code);
    }
  });
  proxyChild.on('exit', function (code) {
    if (!exiting) {
      exiting = true;
      try {
        dashChild.kill('SIGTERM');
      } catch (e3) {}
      process.exit(code === null ? 1 : code);
    }
  });
} else if (cmd === 'proxy' || cmd === 'anthropic-proxy') {
  require(path.join(__dirname, 'scripts', 'anthropic-proxy-cli'));
} else if (cmd === 'forensics' || cmd === 'token-forensics' || cmd === 'token_forensics') {
  require(path.join(__dirname, 'scripts', 'token-forensics'));
} else if (cmd === 'dashboard' || cmd === 'server' || cmd === 'usage') {
  require(path.join(__dirname, 'scripts', 'dashboard-server'));
} else {
  console.error('start.js: unknown command "' + cmd + '" (try: dashboard, proxy, help)');
  process.exit(1);
}
