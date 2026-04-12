'use strict';
// Same session-turns pipeline as dashboard-server (collectTaggedJsonlFiles + fingerprint + pass1 + finalize).
// Compare timings: python3 scripts/session-turns-warm-cache.py --benchmark --days-back 8
//
// Usage (repo root):
//   node scripts/benchmark-session-turns.js
//   node scripts/benchmark-session-turns.js --days-back=8
//   node scripts/benchmark-session-turns.js --dates 2026-04-01,2026-04-02
//   node scripts/benchmark-session-turns.js --dates="2026-04-01,2026-04-02"
//   node scripts/benchmark-session-turns.js --iterations=3
//
// PowerShell: avoid --dates=... with commas (comma is special); prefer --dates "a,b" or --dates a,b .
// pass1 always walks all .jsonl lines; --days-back only widens the turn-day filter (see --help).
var perf = require('node:perf_hooks').performance;
var usageScanRoots = require('./usage-scan-roots');
var collectTaggedJsonlFiles = usageScanRoots.collectTaggedJsonlFiles;
var buildTaggedJsonlFingerprintSync = usageScanRoots.buildTaggedJsonlFingerprintSync;
var forEachJsonlLineSync = usageScanRoots.forEachJsonlLineSync;
var sessionTurnsCore = require('./session-turns-core');

function stripOuterQuotes(s) {
  s = String(s).trim();
  if (s.length < 2) return s;
  var c0 = s.charAt(0);
  var c1 = s.charAt(s.length - 1);
  if ((c0 === '"' && c1 === '"') || (c0 === "'" && c1 === "'")) {
    return s.slice(1, -1).trim();
  }
  return s;
}

function parseArgs(argv) {
  var daysBack = 8;
  var datesCsv = '';
  var iterations = 1;
  for (var i = 0; i < argv.length; i++) {
    var a = argv[i];
    var m;
    m = a.match(/^--days-back=(\d+)$/);
    if (m) {
      daysBack = parseInt(m[1], 10);
      continue;
    }
    if (a === '--days-back' && argv[i + 1]) {
      daysBack = parseInt(argv[++i], 10);
      continue;
    }
    m = a.match(/^--dates=(.+)$/);
    if (m) {
      datesCsv = stripOuterQuotes(m[1]);
      continue;
    }
    if (a === '--dates' && argv[i + 1]) {
      datesCsv = stripOuterQuotes(argv[++i]);
      continue;
    }
    m = a.match(/^--iterations=(\d+)$/);
    if (m) {
      iterations = parseInt(m[1], 10);
      continue;
    }
    if (a === '--iterations' && argv[i + 1]) {
      iterations = parseInt(argv[++i], 10);
      continue;
    }
  }
  return { daysBack: daysBack, datesCsv: datesCsv, iterations: iterations };
}

function resolveDateKeys(daysBack, datesCsv) {
  if (datesCsv && String(datesCsv).trim()) {
    return String(datesCsv)
      .split(',')
      .map(function (x) {
        return x.trim();
      })
      .filter(Boolean);
  }
  var n = Math.max(1, parseInt(daysBack, 10) || 8);
  var out = [];
  for (var i = 0; i < n; i++) {
    var d = new Date();
    d.setUTCHours(0, 0, 0, 0);
    d = new Date(d.getTime() - i * 86400000);
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

function msToS(ms) {
  return ms / 1000;
}

// Gleiche Regel wie pass1: Vereinigung (Vortag, Tag, Folgetag) pro dateKey.
function countAllowedTurnDays(dateKeys) {
  var allowedDays = Object.create(null);
  for (var di = 0; di < dateKeys.length; di++) {
    var dk = dateKeys[di];
    var d = new Date(dk + 'T00:00:00Z');
    var prevDay = new Date(d.getTime() - 86400000).toISOString().slice(0, 10);
    var nextDay = new Date(d.getTime() + 86400000).toISOString().slice(0, 10);
    allowedDays[dk] = true;
    allowedDays[prevDay] = true;
    allowedDays[nextDay] = true;
  }
  return Object.keys(allowedDays).length;
}

function chronologicalMinMax(dateKeys) {
  if (!dateKeys.length) {
    return { min: '', max: '' };
  }
  var sorted = dateKeys.slice().sort();
  return { min: sorted[0], max: sorted[sorted.length - 1] };
}

function formatDateKeyList(dateKeys) {
  var maxShow = 12;
  if (dateKeys.length <= maxShow) {
    return dateKeys.join(', ');
  }
  var head = [];
  for (var i = 0; i < 6; i++) head.push(dateKeys[i]);
  return head.join(', ') + ', … +' + (dateKeys.length - 6) + ' more';
}

function padNum8(s) {
  var n = 8 - s.length;
  if (n <= 0) return s;
  var sp = '';
  for (var i = 0; i < n; i++) sp += ' ';
  return sp + s;
}

function runOnce(dateKeys) {
  var t0 = perf.now();
  var collected = collectTaggedJsonlFiles();
  buildTaggedJsonlFingerprintSync(collected.tagged);
  var t1 = perf.now();
  var allSessions = sessionTurnsCore.pass1CollectSessionsForDayWindowFromFiles(
    dateKeys,
    collected.tagged,
    forEachJsonlLineSync
  );
  var t2 = perf.now();
  var results = Object.create(null);
  for (var i = 0; i < dateKeys.length; i++) {
    var dk = dateKeys[i];
    results[dk] = sessionTurnsCore.finalizeSessionTurnsForDate(dk, allSessions);
  }
  var t3 = perf.now();
  return {
    paths_s: msToS(t1 - t0),
    pass1_s: msToS(t2 - t1),
    finalize_s: msToS(t3 - t2),
    total_s: msToS(t3 - t0),
    jsonl_files: collected.tagged.length,
    raw_session_ids: Object.keys(allSessions).length,
    results: results,
    allowed_turn_days: countAllowedTurnDays(dateKeys)
  };
}

function main() {
  var argv = process.argv.slice(2);
  if (argv.indexOf('--help') >= 0 || argv.indexOf('-h') >= 0) {
    process.stdout.write(
      'benchmark-session-turns.js — gleiche Pipeline wie dashboard (collect, fp, pass1, finalize).\n' +
        '\n' +
        '  node scripts/benchmark-session-turns.js [--days-back=N] [--dates=a,b] [--iterations=N]\n' +
        '\n' +
        'PowerShell: use --dates "a,b" or --dates a,b (avoid --dates=a,b — comma breaks the argument).\n' +
        '\n' +
        'Default --days-back=8 (wie Python warm-cache). Datumsreihenfolge: heute zuerst, dann zurueck.\n' +
        'pass1 liest immer alle JSONL-Zeilen; weniger Tage = engerer Tag-Filter, aber kaum schneller\n' +
        'wenn die Dateien gross sind — zum Vergleich Python vs Node trotzdem gleiches N verwenden.\n'
    );
    return;
  }
  var opts = parseArgs(argv);
  var dateKeys = resolveDateKeys(opts.daysBack, opts.datesCsv);
  var span = chronologicalMinMax(dateKeys);
  var iters = Math.max(1, parseInt(opts.iterations, 10) || 1);
  var totals = [];
  var last = null;
  for (var iter = 0; iter < iters; iter++) {
    last = runOnce(dateKeys);
    totals.push(last.total_s);
  }
  var modeLine =
    opts.datesCsv && String(opts.datesCsv).trim()
      ? '  mode:          --dates (explicit keys)\n'
      : '  mode:          --days-back=' + opts.daysBack + ' (UTC calendar days, today first)\n';
  process.stdout.write(
    'benchmark-session-turns.js\n' +
      '  repo:          ' +
      process.cwd() +
      '\n' +
      modeLine +
      '  date keys:     ' +
      dateKeys.length +
      '  [newest-first: ' +
      formatDateKeyList(dateKeys) +
      ']\n' +
      '  UTC span:      ' +
      span.min +
      ' .. ' +
      span.max +
      ' (chronological)\n' +
      '  pass1 filter:  ' +
      last.allowed_turn_days +
      ' distinct turn-days (prev+day+next per key)\n' +
      '  jsonl files:   ' +
      last.jsonl_files +
      '\n' +
      '  last run:\n' +
      '    collect+fp:     ' +
      padNum8(last.paths_s.toFixed(3)) +
      ' s\n' +
      '    pass1 (read):   ' +
      padNum8(last.pass1_s.toFixed(3)) +
      ' s\n' +
      '    finalize:       ' +
      padNum8(last.finalize_s.toFixed(3)) +
      ' s\n' +
      '    total:          ' +
      padNum8(last.total_s.toFixed(3)) +
      ' s\n' +
      '  raw sid keys:  ' +
      last.raw_session_ids +
      '\n' +
      '  note: pass1 always walks every .jsonl line; days-back widens which turn-days are kept.\n'
  );
  if (iters > 1) {
    var sum = 0;
    for (var ti = 0; ti < totals.length; ti++) sum += totals[ti];
    var avg = sum / totals.length;
    var mn = totals[0];
    var mx = totals[0];
    for (var tj = 1; tj < totals.length; tj++) {
      if (totals[tj] < mn) mn = totals[tj];
      if (totals[tj] > mx) mx = totals[tj];
    }
    process.stdout.write(
      '  iterations=' + iters + ' total_s: min=' + mn.toFixed(3) + ' avg=' + avg.toFixed(3) + ' max=' + mx.toFixed(3) + '\n'
    );
  }
  for (var di = 0; di < dateKeys.length; di++) {
    var dk2 = dateKeys[di];
    var r = last.results[dk2];
    process.stdout.write(
      '  ' + dk2 + '  sessions=' + r.session_count + ' total_turns=' + r.total_turns + '\n'
    );
  }
}

main();
