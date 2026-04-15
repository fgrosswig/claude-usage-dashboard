#!/usr/bin/env node
'use strict';
/**
 * scripts/udaa-fieldstudy-export.js
 *
 * Generates anonymized session submissions from local Claude Code JSONL
 * for the UDAA (Usage Drain Anomalies Audit) field study and local testing.
 *
 * Reads:  all .jsonl files under the configured scan roots
 *         (see scripts/usage-scan-roots.js — respects CLAUDE_USAGE_EXTRA_BASES).
 * Writes: one ./out/udaa-fieldstudy/submission_<nonce>.json per session.
 *
 * Only numeric and temporal fields are exported. No prompts, no tool content,
 * no file paths, no hostnames, no cwd, no git branch. Session ids are
 * SHA-256 hashed before export.
 *
 * No network calls. Pure local file operation.
 *
 * Usage:
 *   node scripts/udaa-fieldstudy-export.js [--out <dir>] [--include-sidechain] [--dry-run]
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const child_process = require('node:child_process');

const scanRoots = require('./usage-scan-roots.js');

// ── Constants ────────────────────────────────────────────────────────────

const SCHEMA_VERSION = '1.0';
const CONSENT_VERSION = 'udaa-fieldstudy-v1.0';
const LICENSE = 'CC0-1.0';
const APP_NAME = 'claude-usage-dashboard';
const MIN_TURNS = 2; // Skip sessions with < 2 assistant turns — no temporal pattern to observe.

// Resolve app version from git tag (matches dashboard-server.js resolution).
const APP_VERSION = resolveAppVersion();

function resolveAppVersion() {
  try {
    const tag = child_process
      .execSync('git tag --sort=-v:refname', {
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'ignore']
      })
      .trim()
      .split('\n')[0];
    if (tag) return tag;
  } catch (e) {
    // Expected fallthrough when git is unavailable; surface only in debug mode.
    if (process.env.UDAA_DEBUG) console.error('[udaa-export] git tag lookup failed: ' + e.message);
  }
  try {
    return fs.readFileSync(path.join(__dirname, '..', 'VERSION'), 'utf8').trim();
  } catch (e) {
    // Expected fallthrough when VERSION file is missing; surface only in debug mode.
    if (process.env.UDAA_DEBUG) console.error('[udaa-export] VERSION file read failed: ' + e.message);
  }
  return 'dev';
}

// ── CLI args ─────────────────────────────────────────────────────────────

const cli = parseArgs(process.argv.slice(2));

function parseArgs(args) {
  const out = {
    outDir: './out/udaa-fieldstudy',
    includeSidechain: false,
    dryRun: false
  };
  var i = 0;
  while (i < args.length) {
    const a = args[i];
    if (a === '--out' && i + 1 < args.length) {
      out.outDir = args[i + 1];
      i += 2;
      continue;
    } else if (a.startsWith('--out=')) {
      out.outDir = a.slice(6);
    } else if (a === '--include-sidechain') {
      out.includeSidechain = true;
    } else if (a === '--dry-run') {
      out.dryRun = true;
    } else if (a === '--help' || a === '-h') {
      printHelp();
      process.exit(0);
    } else {
      console.error('Unknown argument: ' + a);
      printHelp();
      process.exit(64);
    }
    i++;
  }
  return out;
}

function printHelp() {
  console.log('Usage: node scripts/udaa-fieldstudy-export.js [options]');
  console.log('');
  console.log('Generates anonymized session submissions from local Claude Code JSONL');
  console.log('for the UDAA field study and local testing.');
  console.log('');
  console.log('Options:');
  console.log('  --out <dir>           Output directory (default: ./out/udaa-fieldstudy)');
  console.log('  --include-sidechain   Include subagent sidechain sessions (default: skip)');
  console.log('  --dry-run             Show summary only, do not write files');
  console.log('  -h, --help            Show this help');
  console.log('');
  console.log('Exported per turn: t_delta_ms, input, output, cache_read, cache_creation, model_id');
  console.log('Never exported:    prompts, tool content, file paths, hostnames, cwd, git branch,');
  console.log('                   real timestamps, session id in clear (SHA-256 hashed instead).');
}

// ── Helpers ──────────────────────────────────────────────────────────────

function sha256Hex(s) {
  return crypto.createHash('sha256').update(String(s)).digest('hex');
}

function uuidv4() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const b = crypto.randomBytes(16);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = b.toString('hex');
  return (
    h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20)
  );
}

// Strip date suffix (e.g. "claude-sonnet-4-6-20251001" → "claude-sonnet-4-6")
// so the exported model id does not leak sub-version granularity.
function normalizeModelId(model) {
  if (!model || typeof model !== 'string') return 'unknown';
  return model.replace(/-\d{8}$/, '').replace(/@\d{8}$/, '');
}

function osFamily() {
  const p = process.platform;
  if (p === 'win32') return 'win32';
  if (p === 'linux') return 'linux';
  if (p === 'darwin') return 'darwin';
  return 'other';
}

function ensureDir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
  }
}

function pad2(n) {
  return n < 10 ? '0' + n : '' + n;
}

function formatStamp(date) {
  return (
    date.getFullYear() +
    '-' +
    pad2(date.getMonth() + 1) +
    '-' +
    pad2(date.getDate()) +
    ' ' +
    pad2(date.getHours()) +
    ':' +
    pad2(date.getMinutes()) +
    ':' +
    pad2(date.getSeconds())
  );
}

// ── JSONL → sessions ─────────────────────────────────────────────────────

function createStats() {
  return {
    parsedLines: 0,
    malformedLines: 0,
    skippedUserTurn: 0,
    skippedSidechain: 0,
    skippedNoUsage: 0,
    skippedEmptyTokens: 0,
    skippedNoSession: 0
  };
}

function extractTurnFromRecord(rec, stats, includeSidechain) {
  if (rec.type !== 'assistant') {
    stats.skippedUserTurn++;
    return null;
  }
  if (rec.isSidechain && !includeSidechain) {
    stats.skippedSidechain++;
    return null;
  }
  const msg = rec.message || {};
  // Skip partial/streaming records (no stop_reason) — they duplicate the final record's token counts
  if (!msg.stop_reason) {
    stats.skippedNoUsage++;
    return null;
  }
  const usage = msg.usage;
  if (!usage) {
    stats.skippedNoUsage++;
    return null;
  }
  const input = usage.input_tokens || 0;
  const output = usage.output_tokens || 0;
  const cacheRead = usage.cache_read_input_tokens || 0;
  const cacheCreation = usage.cache_creation_input_tokens || 0;
  // Claude Code writes bookkeeping/synthetic records with all-zero usage
  // and model_id '<synthetic>'. These are not real API calls and would
  // corrupt the signature metrics — drop them.
  if (input + output + cacheRead + cacheCreation === 0) {
    stats.skippedEmptyTokens++;
    return null;
  }
  const sid = rec.sessionId;
  if (!sid) {
    stats.skippedNoSession++;
    return null;
  }
  const ts = rec.timestamp;
  if (!ts || typeof ts !== 'string' || ts.length < 19) {
    return null;
  }
  return {
    sid: sid,
    version: typeof rec.version === 'string' ? rec.version : 'unknown',
    turn: {
      ts: ts,
      input: input,
      output: output,
      cache_read: cacheRead,
      cache_creation: cacheCreation,
      model_id: normalizeModelId(msg.model)
    }
  };
}

function processJsonlLine(line, sessions, stats, includeSidechain) {
  if (!line) return;
  let rec;
  try {
    rec = JSON.parse(line);
  } catch (e) {
    stats.malformedLines++;
    if (process.env.UDAA_DEBUG) console.error('[udaa-export] malformed JSONL line: ' + e.message);
    return;
  }
  stats.parsedLines++;
  const extracted = extractTurnFromRecord(rec, stats, includeSidechain);
  if (!extracted) return;
  if (!sessions[extracted.sid]) {
    sessions[extracted.sid] = {
      turns: [],
      claudeCodeVersion: extracted.version
    };
  }
  sessions[extracted.sid].turns.push(extracted.turn);
}

function collectSessionsFromFiles(files, includeSidechain) {
  const sessions = Object.create(null);
  const stats = createStats();
  for (const file of files) {
    try {
      scanRoots.forEachJsonlLineSync(file.path, function (line) {
        processJsonlLine(line, sessions, stats, includeSidechain);
      });
    } catch (e) {
      console.error('Failed to read ' + file.path + ': ' + e.message);
    }
  }
  return { sessions: sessions, stats: stats };
}

// ── Sessions → submissions ──────────────────────────────────────────────

function compareTurnByTimestamp(a, b) {
  if (a.ts < b.ts) return -1;
  if (a.ts > b.ts) return 1;
  return 0;
}

function buildSubmission(sessionId, sessionData) {
  const turns = sessionData.turns.slice().sort(compareTurnByTimestamp);
  if (turns.length < MIN_TURNS) return null;
  const t0 = Date.parse(turns[0].ts);
  if (Number.isNaN(t0)) return null;
  const outTurns = turns.map((T) => {
    const tms = Date.parse(T.ts);
    const dt = Number.isNaN(tms) ? 0 : Math.max(0, tms - t0);
    return {
      t_delta_ms: dt,
      input: T.input,
      output: T.output,
      cache_read: T.cache_read,
      cache_creation: T.cache_creation,
      model_id: T.model_id
    };
  });
  return {
    schema_version: SCHEMA_VERSION,
    submission_nonce: uuidv4(),
    consent_version: CONSENT_VERSION,
    license: LICENSE,
    client: {
      app: APP_NAME,
      app_version: APP_VERSION,
      claude_code_version: sessionData.claudeCodeVersion,
      os_family: osFamily()
    },
    session: {
      session_id_hash: sha256Hex(sessionId),
      turn_count: outTurns.length,
      turns: outTurns
    }
  };
}

function buildAllSubmissions(sessions) {
  const submissions = [];
  let skippedShort = 0;
  for (const sid of Object.keys(sessions)) {
    const sub = buildSubmission(sid, sessions[sid]);
    if (sub) {
      submissions.push(sub);
    } else {
      skippedShort++;
    }
  }
  return { submissions: submissions, skippedShort: skippedShort };
}

// ── Output ───────────────────────────────────────────────────────────────

function printSummary(rootCount, fileCount, stats, sessionCount, exportable, skippedShort, includeSidechain) {
  console.log('UDAA field study exporter — summary');
  console.log('  scan roots:               ' + rootCount);
  console.log('  JSONL files found:        ' + fileCount);
  console.log('  lines parsed:             ' + stats.parsedLines);
  if (stats.malformedLines) {
    console.log('  malformed lines:          ' + stats.malformedLines);
  }
  console.log('  skipped (user turn):      ' + stats.skippedUserTurn);
  console.log(
    '  skipped (sidechain):      ' + stats.skippedSidechain + (includeSidechain ? ' (included)' : '')
  );
  console.log('  skipped (no usage):       ' + stats.skippedNoUsage);
  console.log('  skipped (empty tokens):   ' + stats.skippedEmptyTokens);
  console.log('  skipped (no sessionId):   ' + stats.skippedNoSession);
  console.log('  sessions with usage:      ' + sessionCount);
  console.log('  skipped (<' + MIN_TURNS + ' turns):       ' + skippedShort);
  console.log('  sessions exportable:      ' + exportable);
  console.log('');
}

function printDryRunPreview(submissions) {
  console.log('Dry run — no files written.');
  if (!submissions.length) return;
  const sample = submissions[0];
  const lastT = sample.session.turns.at(-1);
  console.log('');
  console.log('Preview of first exportable submission:');
  console.log('  schema_version:           ' + sample.schema_version);
  console.log('  consent_version:          ' + sample.consent_version);
  console.log('  license:                  ' + sample.license);
  console.log('  client.app_version:       ' + sample.client.app_version);
  console.log('  client.os_family:         ' + sample.client.os_family);
  console.log('  session_id_hash (prefix): ' + sample.session.session_id_hash.slice(0, 16) + '…');
  console.log('  turn_count:               ' + sample.session.turn_count);
  console.log('  first turn:               ' + JSON.stringify(sample.session.turns[0]));
  console.log('  last turn:                ' + JSON.stringify(lastT));
}

function writeSubmissions(submissions, outDir) {
  ensureDir(outDir);
  let totalBytes = 0;
  for (const S of submissions) {
    const fn = 'submission_' + S.submission_nonce + '.json';
    const fpOut = path.join(outDir, fn);
    const body = JSON.stringify(S, null, 2);
    fs.writeFileSync(fpOut, body, 'utf8');
    totalBytes += Buffer.byteLength(body, 'utf8');
  }
  console.log('Wrote ' + submissions.length + ' submission file(s) to ' + path.resolve(outDir));
  console.log('Total size: ' + totalBytes + ' bytes  (' + formatStamp(new Date()) + ')');
  console.log('');
  console.log('Review each file before any external submission.');
  console.log('Each file contains only: session id hash, turn count,');
  console.log('and per-turn token counts + model id + session-relative deltas.');
}

// ── Main ─────────────────────────────────────────────────────────────────

function main() {
  const collected = scanRoots.collectTaggedJsonlFiles();
  const files = collected.tagged;
  if (!files.length) {
    console.error('No JSONL files found under the scan roots.');
    console.error('Check $CLAUDE_USAGE_EXTRA_BASES or ~/.claude/projects/.');
    process.exit(2);
  }
  const { sessions, stats } = collectSessionsFromFiles(files, cli.includeSidechain);
  const sessionIds = Object.keys(sessions);
  if (!sessionIds.length) {
    console.error('No assistant turns with usage found in JSONL files.');
    process.exit(3);
  }
  const { submissions, skippedShort } = buildAllSubmissions(sessions);
  printSummary(
    collected.roots.length,
    files.length,
    stats,
    sessionIds.length,
    submissions.length,
    skippedShort,
    cli.includeSidechain
  );
  if (cli.dryRun) {
    printDryRunPreview(submissions);
    return;
  }
  writeSubmissions(submissions, cli.outDir);
}

main();
