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
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const argv = process.argv.slice(2);
const PUBLIC = argv.indexOf('--public') !== -1;
const posArgs = argv.filter(function (a) {
  return a !== '--public';
});
const sinceTagArg = posArgs[0] || null;

const ROOT = execSync('git rev-parse --show-toplevel').toString().trim();
const LOG_PATH = path.join(ROOT, 'logs', 'transactions.json');

// Reine Manifeste unter k8s/k8 (kein generisches Markdown) — extern nicht kommunizieren
var K8_MANIFEST_RE = /^(k8s|k8)\/.+\.(ya?ml)$/i;

function isInternalK8ManifestOnlyTx(tx) {
  var changes = tx.changes || [];
  if (!changes.length) return false;
  for (var i = 0; i < changes.length; i++) {
    var f = (changes[i].file || '').replace(/\\/g, '/');
    if (!K8_MANIFEST_RE.test(f)) return false;
  }
  return true;
}

// Reihenfolge: spezifisch zuerst (erste passende Regel gewinnt pro Datei)
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

// Sortierung der Bullets innerhalb einer Sektion (feat/fix/…)
var COMPONENT_ORDER = ['API', 'Proxy', 'Server', 'Dashboard', 'Docs', 'CI / Infra'];

function componentSortKey(comp) {
  if (!comp) return '999|';
  var parts = comp.split(' + ');
  var best = 999;
  for (var p = 0; p < parts.length; p++) {
    var idx = COMPONENT_ORDER.indexOf(parts[p].trim());
    if (idx !== -1 && idx < best) best = idx;
  }
  return String(best).padStart(3, '0') + '|' + comp;
}

// ── Tag bestimmen ────────────────────────────────────────
var sinceTag = sinceTagArg;
if (!sinceTag) {
  try {
    sinceTag = execSync('git tag --sort=-v:refname').toString().trim().split('\n')[0];
  } catch (e) {}
}
if (!sinceTag) {
  console.error('Kein Git-Tag gefunden. Usage: node scripts/generate-release-notes.js [tag] [--public]');
  process.exit(1);
}

// SHA des Tags
var tagSha;
try {
  tagSha = execSync('git rev-list -1 ' + sinceTag).toString().trim();
} catch (e) {
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
  var logOut = execSync('git log --format=%H%n%h ' + sinceTag + '..HEAD')
    .toString().trim();
  if (logOut) {
    var lines = logOut.split('\n');
    for (var li = 0; li < lines.length; li++) sinceSet[lines[li]] = true;
  }
} catch (e) {}

var unreleased = [];
for (var i = 0; i < txs.length; i++) {
  var tx = txs[i];
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
  for (var c = 0; c < changes.length; c++) {
    var f = (changes[c].file || '').replace(/\\/g, '/');
    if (isPublic && K8_MANIFEST_RE.test(f)) continue;
    for (var r = 0; r < COMPONENT_RULES.length; r++) {
      if (COMPONENT_RULES[r].pattern.test(f)) {
        found[COMPONENT_RULES[r].name] = true;
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
for (var j = 0; j < unreleased.length; j++) {
  var txj = unreleased[j];
  if (PUBLIC && isInternalK8ManifestOnlyTx(txj)) continue;
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

var title = PUBLIC ? '## ' + sinceTag + '\n' : '## Changes since ' + sinceTag + '\n';
console.log(title);
var order = ['feat', 'fix', 'docs', 'chore', 'other'];
for (var k = 0; k < order.length; k++) {
  var key = order[k];
  var items = groups[key];
  if (!items.length) continue;
  console.log('### ' + labels[key]);
  items.sort(function (a, b) {
    return componentSortKey(a.component).localeCompare(componentSortKey(b.component));
  });
  for (var l = 0; l < items.length; l++) {
    var tag = items[l].component ? '**' + items[l].component + ':** ' : '';
    console.log('- ' + tag + items[l].msg);
  }
  console.log('');
}
