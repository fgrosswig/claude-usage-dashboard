#!/usr/bin/env node
/**
 * generate-release-notes.js — Release Notes aus Transaction Log generieren
 * Liest logs/transactions.json, findet alle Einträge seit dem letzten Git-Tag,
 * gruppiert nach Typ (feat/fix/chore/docs) und Komponente (API, Server, Proxy, …).
 *
 * Usage:
 *   node scripts/generate-release-notes.js              # seit letztem Tag
 *   node scripts/generate-release-notes.js v1.0.1       # seit bestimmtem Tag
 *   node scripts/generate-release-notes.js --public     # öffentliches Repo: keine reinen K8s-Manifest-Commits
 *   node scripts/generate-release-notes.js v1.0.1 --public
 *
 * --public: Unter k8s/ und k8/ nur .md (generische How-tos, TOKEN usw.) erscheinen; reine .yml/.yaml-
 * Manifest-Änderungen werden ausgelassen; bei gemischten Commits zählen Manifeste nicht für die Komponente.
 */
'use strict';
var child_process = require('node:child_process');
var execSync = child_process.execSync;
var fs = require('node:fs');
var path = require('node:path');

var argv = process.argv.slice(2);
var PUBLIC = argv.includes('--public');
var posArgs = argv.find(function (a) { return a !== '--public'; }) || null;
var sinceTagArg = posArgs;

var ROOT = execSync('git rev-parse --show-toplevel').toString().trim();
var LOG_PATH = path.join(ROOT, 'logs', 'transactions.json');

var K8_MANIFEST_RE = /^(k8s|k8)\/.+\.(ya?ml)$/i;

var INTERNAL_ONLY_RE = /^\.woodpecker\/|^\.gitea\/|^\.gitignore$|^(k8s|k8)\/.+\.(ya?ml)$|^scripts\/hooks\/|^scripts\/generate-release-notes\.js$|^scripts\/update-tx-log\.js$|^scripts\/setup-sonarqube-webhook\.ps1$|^scripts\/scrub-for-public\.sh$|^sonar-project\.properties$|^sonar\.token$|^logs\//i;

function isInternalOnlyTx(tx) {
  var changes = tx.changes || [];
  if (!changes.length) return false;
  for (var change of changes) {
    var f = (change.file || '').replaceAll('\\', '/');
    if (!INTERNAL_ONLY_RE.test(f)) return false;
  }
  return true;
}

var COMPONENT_RULES = [
  { pattern: /^k8s\/.*\.md$|^k8\/.*\.md$/i, name: 'Docs' },
  { pattern: /^\.woodpecker\/|^\.gitea\/|^\.github\/|^k8s\/|^k8\//, name: 'CI / Infra' },
  { pattern: /^scripts\/anthropic-proxy|^anthropic-proxy\.js$/, name: 'Proxy' },
  { pattern: /^scripts\/dashboard-http\.js$|^scripts\/dashboard-http\//, name: 'API' },
  {
    pattern:
      /^scripts\/(dashboard-server|token-forensics|claude-data-sync-client|claude-data-ingest|usage-scan-roots|service-logger|extract-dashboard-assets)\.js$/,
    name: 'Server'
  },
  { pattern: /^server\.js$|^start\.js$|^claude-usage-dashboard\.js$|^token_forensics\.js$/, name: 'Server' },
  { pattern: /^public\/|^tpl\//, name: 'Dashboard' },
  { pattern: /^docs\//, name: 'Docs' },
  { pattern: /^scripts\//, name: 'Server' }
];

var COMPONENT_ORDER = ['API', 'Proxy', 'Server', 'Dashboard', 'Docs', 'CI / Infra'];

function componentSortKey(comp) {
  if (!comp) return '999|';
  var parts = comp.split(' + ');
  var best = 999;
  for (var p of parts) {
    var idx = COMPONENT_ORDER.indexOf(p.trim());
    if (idx !== -1 && idx < best) best = idx;
  }
  return String(best).padStart(3, '0') + '|' + comp;
}

// ── Tag bestimmen ────────────────────────────────────────
// When called with a tag (e.g. from CI on tag event), find the PREVIOUS tag
// so we get commits between previous and current tag, not current..HEAD (= 0).
var allTags;
try {
  allTags = execSync('git tag --sort=-v:refname').toString().trim().split('\n').filter(Boolean);
} catch (_) { allTags = []; }

var sinceTag = sinceTagArg;
var displayTag = null;
if (!sinceTag) {
  sinceTag = allTags[0] || null;
}
if (!sinceTag) {
  console.error('Kein Git-Tag gefunden. Usage: node scripts/generate-release-notes.js [tag] [--public]');
  process.exit(1);
}

// If sinceTag is the latest tag, use the one before it as base
var tagIdx = allTags.indexOf(sinceTag);
if (tagIdx === 0 && allTags.length > 1) {
  // sinceTag is the newest tag — use previous tag as base for diff
  displayTag = sinceTag;
  sinceTag = allTags[1];
}

var tagSha;
try {
  tagSha = child_process.execFileSync('git', ['rev-list', '-1', sinceTag]).toString().trim();
} catch (_) {
  console.error('Tag ' + sinceTag + ' nicht gefunden.');
  process.exit(1);
}

// ── Transaction Log lesen ────────────────────────────────
if (!fs.existsSync(LOG_PATH)) {
  console.error('Kein Transaction Log: ' + LOG_PATH);
  process.exit(1);
}
var log;
try {
  log = JSON.parse(fs.readFileSync(LOG_PATH, 'utf8'));
} catch (e) {
  console.error('Transaction Log parse error:', e.message);
  process.exit(1);
}

var txs = log.transactions || [];
if (!txs.length) {
  console.log('Keine Transaktionen im Log.');
  process.exit(0);
}

// ── Einträge seit Tag filtern ────────────────────────────
var sinceSet = Object.create(null);
try {
  var logOut = child_process.execFileSync('git', ['log', '--format=%H%n%h', sinceTag + '..HEAD'])
    .toString().trim();
  if (logOut) {
    for (var sha of logOut.split('\n')) sinceSet[sha] = true;
  }
} catch (_) { /* empty range */ }

var unreleased = [];
for (var tx of txs) {
  var cf = tx.commit_full || '';
  var cshort = tx.commit || '';
  if (!sinceSet[cf] && !sinceSet[cshort]) continue;
  if (/\[tx-log\]/.test(tx.description || '')) continue;
  if (/^Merge (pull request|branch)/.test(tx.description || '')) continue;
  unreleased.push(tx);
}

if (!unreleased.length) {
  console.log('Keine neuen Commits seit ' + sinceTag);
  process.exit(0);
}

function detectComponent(tx, isPublic) {
  var changes = tx.changes || [];
  var found = {};
  for (var change of changes) {
    var f = (change.file || '').replaceAll('\\', '/');
    if (isPublic && K8_MANIFEST_RE.test(f)) continue;
    for (var rule of COMPONENT_RULES) {
      if (rule.pattern.test(f)) {
        found[rule.name] = true;
        break;
      }
    }
  }
  var keys = Object.keys(found);
  return keys.length ? keys.join(' + ') : null;
}

// ── Nach Typ gruppieren ──────────────────────────────────
var TYPE_RE = /^(feat|fix|chore|docs|ci|perf|refactor|test)(?:\([^)]*\))?[:\s]/;
var groups = { feat: [], fix: [], chore: [], docs: [], other: [] };
for (var txj of unreleased) {
  if (PUBLIC && isInternalOnlyTx(txj)) continue;
  var desc = txj.description || '';
  var match = desc.match(TYPE_RE);
  var type = match ? match[1] : 'other';
  if (type === 'ci' || type === 'perf' || type === 'refactor' || type === 'test') type = 'chore';
  var clean = desc.replace(
    /^(feat|fix|chore|docs|ci|perf|refactor|test)(\([^)]*\))?:\s*/,
    ''
  ).trim();
  if (!clean) clean = desc;
  var comp = detectComponent(txj, PUBLIC);
  groups[type].push({ msg: clean, component: comp });
}

var totalItems = 0;
for (var gk in groups) totalItems += groups[gk].length;
if (PUBLIC && totalItems === 0) {
  console.log(
    '(Keine öffentlichen Release-Einträge seit ' + sinceTag + ' — z. B. nur interne Kubernetes-Manifeste.)'
  );
  process.exit(0);
}

var labels = {
  feat: 'Features',
  fix: 'Fixes',
  docs: 'Docs',
  chore: 'Chore / CI',
  other: 'Other'
};

var titleTag = displayTag || sinceTag;
var title = PUBLIC ? '## ' + titleTag + '\n' : '## Changes since ' + sinceTag + '\n';
console.log(title);
var order = ['feat', 'fix', 'docs', 'chore', 'other'];
for (var key of order) {
  var items = groups[key];
  if (!items.length) continue;
  console.log('### ' + labels[key]);
  items.sort(function (a, b) {
    return componentSortKey(a.component).localeCompare(componentSortKey(b.component));
  });
  for (var item of items) {
    var tag = item.component ? '**' + item.component + ':** ' : '';
    console.log('- ' + tag + item.msg);
  }
  console.log('');
}
