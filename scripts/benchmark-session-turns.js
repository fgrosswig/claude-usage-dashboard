'use strict';
/**
 * Same session-turns pipeline as dashboard-server (collectTaggedJsonlFiles + fingerprint + pass1 + finalize).
 * Compare timings with: python3 scripts/session-turns-warm-cache.py --benchmark --days-back 8
 *
 * Usage (repo root):
 *   node scripts/benchmark-session-turns.js
 *   node scripts/benchmark-session-turns.js --days-back=8
 *   node scripts/benchmark-session-turns.js --dates=2026-04-01,2026-04-02
 *   node scripts/benchmark-session-turns.js --iterations=3
 */
var perf = require('node:perf_hooks').performance;
var usageScanRoots = require('./usage-scan-roots');
var collectTaggedJsonlFiles = usageScanRoots.collectTaggedJsonlFiles;
var buildTaggedJsonlFingerprintSync = usageScanRoots.buildTaggedJsonlFingerprintSync;
var forEachJsonlLineSync = usageScanRoots.forEachJsonlLineSync;
var sessionTurnsCore = require('./session-turns-core');

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
      datesCsv = m[1];
      continue;
    }
    if (a === '--dates' && argv[i + 1]) {
      datesCsv = argv[++i];
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
    results: results
  };
}

function main() {
  var opts = parseArgs(process.argv.slice(2));
  var dateKeys = resolveDateKeys(opts.daysBack, opts.datesCsv);
  var iters = Math.max(1, parseInt(opts.iterations, 10) || 1);
  var totals = [];
  var last = null;
  for (var iter = 0; iter < iters; iter++) {
    last = runOnce(dateKeys);
    totals.push(last.total_s);
  }
  process.stdout.write(
    'benchmark-session-turns.js\n' +
      '  repo:          ' +
      process.cwd() +
      '\n' +
      '  dates:         ' +
      dateKeys.length +
      ' (' +
      dateKeys[0] +
      ' .. ' +
      dateKeys[dateKeys.length - 1] +
      ')\n' +
      '  jsonl files:   ' +
      last.jsonl_files +
      '\n' +
      '  last run:\n' +
      '    collect+fp:     ' +
      last.paths_s.toFixed(3).padStart(8, ' ') +
      ' s\n' +
      '    pass1 (read):   ' +
      last.pass1_s.toFixed(3).padStart(8, ' ') +
      ' s\n' +
      '    finalize:       ' +
      last.finalize_s.toFixed(3).padStart(8, ' ') +
      ' s\n' +
      '    total:          ' +
      last.total_s.toFixed(3).padStart(8, ' ') +
      ' s\n' +
      '  raw sid keys:  ' +
      last.raw_session_ids +
      '\n'
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
