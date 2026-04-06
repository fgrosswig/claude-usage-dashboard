#!/usr/bin/env node
// Claude Code Token Usage Dashboard — standalone, zero dependencies
// Usage: node claude-usage-dashboard.js [--port=3333] [--refresh=SEK]
// --refresh = voller Daten-Scan + SSE (Standard 180s, Minimum 60s). Kurze Werte lesen alle JSONL unnötig oft neu ein.
// Tages-Cache: ~/.claude/usage-dashboard-days.json (Vortage). Bei passender jsonl-Anzahl nur noch „heute“ aus JSONL.
// Vollscan erzwingen: CLAUDE_USAGE_NO_CACHE=1  oder  Cache-Datei löschen / neue .jsonl-Datei ändert die Anzahl.

var http = require('http');
var https = require('https');
var fs = require('fs');
var path = require('path');
var os = require('os');

var PORT = 3333;
var REFRESH_SEC = 180;
(function () {
  var e = process.env.CLAUDE_USAGE_SCAN_INTERVAL_SEC;
  if (!e) return;
  var n = parseInt(e, 10);
  if (!isNaN(n) && n >= 60) REFRESH_SEC = n;
})();
process.argv.forEach(function(a) {
  var m = a.match(/--port=(\d+)/);
  if (m) PORT = parseInt(m[1]);
  var r = a.match(/--refresh=(\d+)/);
  if (r) REFRESH_SEC = Math.max(60, parseInt(r[1]));
});

var HOME = process.env.USERPROFILE || process.env.HOME || os.homedir();
var BASE = path.join(HOME, '.claude', 'projects');
// Vor-Tage als ein JSON (unter ~/.claude); JSONL wird nur noch für den lokalen Kalendertag „heute” voll geparst.
var USAGE_DAY_CACHE_VERSION = 4;
var USAGE_DAY_CACHE_FILE = path.join(HOME, '.claude', 'usage-dashboard-days.json');

// ── Anthropic Outage Data (status.claude.com) ─────────────────────────────
var OUTAGE_API_URL = 'https://status.claude.com/api/v2/incidents.json';
var OUTAGE_REFRESH_MS = 5 * 60 * 1000;
var OUTAGE_DISK_CACHE = path.join(HOME, '.claude', 'usage-dashboard-outages.json');
var RELEASES_CACHE = path.join(HOME, '.claude', 'claude-code-releases.json');
var RELEASES_API_URL = 'https://api.github.com/repos/anthropics/claude-code/releases?per_page=100';
// VS Code Marketplace (offizielle Extension-Version History) — API-Flag 0x1 = alle Versionen; 0x200 würde auf „nur letzte“ kürzen.
var MARKETPLACE_CACHE = path.join(HOME, '.claude', 'claude-code-marketplace-versions.json');
var MARKETPLACE_QUERY_URL = 'https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery';
var MARKETPLACE_EXTENSION_ID = 'anthropic.claude-code';
var MARKETPLACE_QUERY_FLAGS = 0x1;

// Releases laden (Disk-Cache oder frisch fetchen)
var releasesCache = { releases: [], fetchedAt: 0 };
try {
  var diskRel = JSON.parse(fs.readFileSync(RELEASES_CACHE, 'utf8'));
  if (Array.isArray(diskRel)) releasesCache.releases = diskRel;
} catch (e) {}

var marketplaceVersionsCache = { items: [], fetchedAt: 0 };
try {
  var diskMp = JSON.parse(fs.readFileSync(MARKETPLACE_CACHE, 'utf8'));
  if (diskMp && Array.isArray(diskMp.versions)) {
    marketplaceVersionsCache.items = diskMp.versions;
    marketplaceVersionsCache.fetchedAt = diskMp.fetchedAt || 0;
  }
} catch (eMp) {}

/** Nur Release-Tags anthropics/claude-code (SSRF-Schutz). */
function isSafeGithubReleaseTagParam(s) {
  if (!s || typeof s !== 'string') return false;
  var t = s.trim();
  if (t.length < 3 || t.length > 48) return false;
  return /^[vV]?[0-9][0-9A-Za-z.\-+]{0,40}$/.test(t);
}

function persistReleasesCacheToDisk() {
  try {
    fs.writeFileSync(RELEASES_CACHE, JSON.stringify(releasesCache.releases), 'utf8');
  } catch (eW) {}
}

/**
 * Einzelrelease per API (wie curl) — für Backfill in claude-code-releases.json.
 */
function httpsFetchGithubReleaseByTag(tag, cb) {
  if (!isSafeGithubReleaseTagParam(tag)) {
    process.nextTick(function () {
      cb(new Error('invalid tag'), null);
    });
    return;
  }
  var done = false;
  function once(err, data) {
    if (done) return;
    done = true;
    cb(err, data);
  }
  var tagEnc = encodeURIComponent(String(tag).trim());
  var opts = {
    hostname: 'api.github.com',
    path: '/repos/anthropics/claude-code/releases/tags/' + tagEnc,
    method: 'GET',
    headers: {
      'User-Agent': 'claude-usage-dashboard',
      Accept: 'application/vnd.github+json'
    }
  };
  var ghReq = https.request(opts, function (ghRes) {
    var chunks = [];
    ghRes.on('data', function (c) {
      chunks.push(c);
    });
    ghRes.on('end', function () {
      try {
        var data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (ghRes.statusCode !== 200 || !data || !data.tag_name) {
          once(new Error('not found'), null);
          return;
        }
        once(null, data);
      } catch (e) {
        once(e, null);
      }
    });
  });
  ghReq.on('error', function (e) {
    once(e, null);
  });
  ghReq.setTimeout(15000, function () {
    ghReq.destroy();
    once(new Error('timeout'), null);
  });
  ghReq.end();
}

/**
 * Fehlende Tags aus den Dashboard-Tagen per HTTPS nachladen, JSON-Cache mergen + Highlights neu ziehen.
 */
function backfillReleaseBodiesForDashboardDays(days, cb) {
  if (!days || !days.length) {
    process.nextTick(cb);
    return;
  }
  var tags = [];
  var seen = Object.create(null);
  for (var di = 0; di < days.length; di++) {
    var vc = days[di].version_change;
    if (!vc || !vc.github_release_links) continue;
    for (var li = 0; li < vc.github_release_links.length; li++) {
      var gl = vc.github_release_links[li];
      var tg = gl.tag || 'v' + gl.version;
      if (tg && !seen[tg]) {
        seen[tg] = true;
        tags.push(String(tg).trim());
      }
    }
  }
  function hasTagInCache(tag) {
    var rels = releasesCache.releases;
    for (var i = 0; i < rels.length; i++) {
      if (String(rels[i].tag_name || '') === tag) return true;
    }
    return false;
  }
  var missing = [];
  for (var m = 0; m < tags.length; m++) {
    if (!hasTagInCache(tags[m])) missing.push(tags[m]);
  }
  if (!missing.length) {
    enrichVersionChangeNotes(days);
    process.nextTick(cb);
    return;
  }
  var ix = 0;
  function step() {
    if (ix >= missing.length) {
      persistReleasesCacheToDisk();
      enrichVersionChangeNotes(days);
      cb();
      return;
    }
    var t = missing[ix++];
    if (!isSafeGithubReleaseTagParam(t)) {
      setImmediate(step);
      return;
    }
    httpsFetchGithubReleaseByTag(t, function (err, rel) {
      if (!err && rel && rel.tag_name) {
        var dupe = false;
        for (var j = 0; j < releasesCache.releases.length; j++) {
          if (String(releasesCache.releases[j].tag_name) === String(rel.tag_name)) {
            dupe = true;
            break;
          }
        }
        if (!dupe) releasesCache.releases.push(rel);
      }
      setImmediate(step);
    });
  }
  step();
}

function refreshReleasesCache() {
  var all = [];
  var page = 1;
  var maxPages = 5;
  function fetchNext() {
    var sep = RELEASES_API_URL.indexOf('?') >= 0 ? '&' : '?';
    var url = RELEASES_API_URL + sep + 'page=' + page;
    httpsGetJson(url, function (err, data) {
      if (err || !Array.isArray(data) || data.length === 0) {
        if (page === 1 && err) {
          console.warn('[releases] GitHub API:', err.message, '(ohne User-Agent liefert api.github.com oft 403 — Cache bleibt klein.)');
        }
        finish();
        return;
      }
      for (var i = 0; i < data.length; i++) all.push(data[i]);
      if (data.length < 100 || page >= maxPages) {
        finish();
        return;
      }
      page++;
      fetchNext();
    });
  }
  function finish() {
    if (!all.length) return;
    var seen = Object.create(null);
    var merged = [];
    for (var a = 0; a < all.length; a++) {
      var ta = all[a] && all[a].tag_name;
      if (ta) seen[String(ta)] = true;
      merged.push(all[a]);
    }
    var prev = releasesCache.releases;
    for (var b = 0; b < prev.length; b++) {
      var pb = prev[b];
      var tb = pb && pb.tag_name;
      if (tb && !seen[String(tb)]) {
        seen[String(tb)] = true;
        merged.push(pb);
      }
    }
    releasesCache.releases = merged;
    releasesCache.fetchedAt = Date.now();
    persistReleasesCacheToDisk();
  }
  fetchNext();
}

/** "v2.1.87", "2.1.87", "…2.1.87…" -> "2.1.87" (GitHub-Release-Keys) */
function normalizeCliSemver(s) {
  if (s == null || s === '') return '';
  var m = String(s).match(/\d+\.\d+\.\d+/);
  return m ? m[0] : '';
}

function semverCmp(a, b) {
  var pa = String(a).split('.');
  var pb = String(b).split('.');
  for (var i = 0; i < 3; i++) {
    var na = parseInt(pa[i], 10) || 0;
    var nb = parseInt(pb[i], 10) || 0;
    if (na < nb) return -1;
    if (na > nb) return 1;
  }
  return 0;
}

function pad2Cal(n) {
  var x = typeof n === 'number' ? n : parseInt(n, 10);
  return x < 10 ? '0' + x : String(x);
}

/** Kalendertag in lokaler Zeitzone (u. a. Anzeige). */
function isoToLocalYmd(iso) {
  if (!iso) return '';
  var d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return d.getFullYear() + '-' + pad2Cal(d.getMonth() + 1) + '-' + pad2Cal(d.getDate());
}

/**
 * UTC-Datum YYYY-MM-DD — gleiche Semantik wie JSONL `timestamp.slice(0, 10)` bei ISO mit Z.
 * Extension-Marker müssen damit gebucht werden, sonst fehlen sie in US-Zeitzonen (Local vs. UTC).
 */
function isoToUtcYmd(iso) {
  if (!iso) return '';
  var d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return d.toISOString().slice(0, 10);
}

function extractReleaseHighlights(body) {
  var raw = String(body || '');
  var slice = raw;
  var sec = raw.match(/^##\s*what[\u2019\x27]?s changed\b/im);
  if (sec && sec.index != null) {
    var after = raw.indexOf('\n', sec.index + sec[0].length);
    slice = after >= 0 ? raw.slice(after + 1) : raw.slice(sec.index + sec[0].length);
  }
  var highlights = [];
  var lines = slice.split('\n');
  for (var li = 0; li < lines.length && li < 140 && highlights.length < 12; li++) {
    var ln = lines[li].replace(/^[\s>*\-•]+/, '').trim();
    if (!ln || ln.length < 6) continue;
    if (/^#{1,6}\s/.test(ln)) break;
    if (/^---+(\s|$)|^\*{3,}(\s|$)/.test(ln)) continue;
    if (/^(full changelog|see also)\b/i.test(ln)) continue;
    if (/^assets\s*\d*\s*$/i.test(ln)) continue;
    highlights.push(ln.slice(0, 220));
  }
  return highlights;
}

/** CLI-/Extension-Version aus JSONL-Zeile (Root oder message). */
function extractCliVersion(rec) {
  if (!rec || typeof rec !== 'object') return '';
  var msg = rec.message;
  var cand =
    rec.version ||
    rec.cli_version ||
    rec.claude_code_version ||
    rec.extension_version ||
    (msg &&
      (msg.cli_version ||
        msg.extension_version ||
        msg.client_version ||
        msg.claude_code_version ||
        msg.version)) ||
    '';
  return normalizeCliSemver(cand);
}

/** Liefert Map: normalisierte Version "2.1.87" -> { tag, date, highlights } */
function getReleasesMap() {
  if (!releasesCache.releases || releasesCache.releases.length === 0) {
    try {
      var diskR = JSON.parse(fs.readFileSync(RELEASES_CACHE, 'utf8'));
      if (Array.isArray(diskR)) releasesCache.releases = diskR;
    } catch (eRel) {}
  }
  var map = {};
  var rels = releasesCache.releases;
  for (var i = 0; i < rels.length; i++) {
    var r = rels[i];
    var nk = normalizeCliSemver(r.tag_name || r.name || '');
    var date = isoToUtcYmd(r.published_at || '');
    if (nk) map[nk] = { tag: r.tag_name, date: date, highlights: extractReleaseHighlights(r.body) };
  }
  return map;
}

/** Semver-Keys aus relMap mit fromNorm < v <= toNorm (für Release-Texte übersprungener Patch-Versionen). */
function versionsInRelMapBetween(relMap, fromNorm, toNorm) {
  if (!relMap || !toNorm) return [];
  var keys = Object.keys(relMap);
  keys.sort(semverCmp);
  var out = [];
  for (var i = 0; i < keys.length; i++) {
    var k = keys[i];
    if (!k) continue;
    if (fromNorm && semverCmp(k, fromNorm) <= 0) continue;
    if (semverCmp(k, toNorm) > 0) continue;
    out.push(k);
  }
  return out;
}

function uniqSortedSemvers(vers) {
  var o = Object.create(null);
  for (var i = 0; i < vers.length; i++) {
    var n = normalizeCliSemver(vers[i]);
    if (n) o[n] = true;
  }
  var ks = Object.keys(o);
  ks.sort(semverCmp);
  return ks;
}

function githubReleaseLinkForVersion(relMap, ver) {
  var nk = normalizeCliSemver(ver);
  if (!nk) return { version: '', url: '', tag: '' };
  var ent = relMap[nk];
  var tag = ent && ent.tag ? String(ent.tag).trim() : 'v' + nk;
  return {
    version: nk,
    tag: tag,
    url: 'https://github.com/anthropics/claude-code/releases/tag/' + encodeURIComponent(tag)
  };
}

/** Füllt Highlights aus allen Releases zwischen from und höchstem added; setzt github_release_links als Fallback. */
function enrichVersionChangeNotes(result) {
  var relMap = getReleasesMap();
  for (var ei = 0; ei < result.length; ei++) {
    var vc = result[ei].version_change;
    if (!vc || !vc.added || !vc.added.length) continue;
    var fromN = vc.from ? normalizeCliSemver(vc.from) : '';
    var addedSorted = vc.added.slice().sort(semverCmp);
    var topN = addedSorted[addedSorted.length - 1];
    var inter = versionsInRelMapBetween(relMap, fromN, topN);
    var mergedHi = (vc.highlights || []).slice();
    var seenH = Object.create(null);
    for (var mi = 0; mi < mergedHi.length; mi++) seenH[String(mergedHi[mi])] = true;
    var prefixMulti = inter.length > 1;
    for (var ii = 0; ii < inter.length; ii++) {
      var iv = inter[ii];
      var ri = relMap[iv];
      if (!ri || !ri.highlights || !ri.highlights.length) continue;
      for (var h = 0; h < ri.highlights.length; h++) {
        var line = (prefixMulti ? '[' + iv + '] ' : '') + ri.highlights[h];
        if (!seenH[line]) {
          mergedHi.push(line);
          seenH[line] = true;
        }
      }
    }
    if (mergedHi.length > 24) mergedHi.length = 24;
    vc.highlights = mergedHi;
    var linkVers = uniqSortedSemvers(inter.concat(addedSorted));
    var links = [];
    var seenV = Object.create(null);
    for (var lj = 0; lj < linkVers.length; lj++) {
      var vj = linkVers[lj];
      if (seenV[vj]) continue;
      seenV[vj] = true;
      var gl = githubReleaseLinkForVersion(relMap, vj);
      if (gl.url) links.push(gl);
    }
    vc.github_release_links = links;
  }
}

function loadReleasesArrayForBuild() {
  var rels = releasesCache.releases;
  if (!rels || !rels.length) {
    try {
      var diskR = JSON.parse(fs.readFileSync(RELEASES_CACHE, 'utf8'));
      if (Array.isArray(diskR)) rels = diskR;
    } catch (eDisk) {}
  }
  return Array.isArray(rels) ? rels : [];
}

function buildByDateFromVersionTimelineItems(items) {
  if (!items || !items.length) return null;
  items = items.slice().sort(function (a, b) {
    if (a.t !== b.t) return a.t - b.t;
    return semverCmp(a.ver, b.ver);
  });
  var groups = [];
  for (var k = 0; k < items.length; k++) {
    var dk = isoToUtcYmd(items[k].when);
    if (!dk) continue;
    if (!groups.length) groups.push([items[k]]);
    else {
      var lastGrp = groups[groups.length - 1];
      var lastDk = isoToUtcYmd(lastGrp[0].when);
      if (lastDk === dk) lastGrp.push(items[k]);
      else groups.push([items[k]]);
    }
  }
  if (!groups.length) return null;
  var byDate = Object.create(null);
  for (var g = 0; g < groups.length; g++) {
    var grp = groups[g];
    var dk = isoToUtcYmd(grp[0].when);
    var prevVer = g > 0 ? groups[g - 1][groups[g - 1].length - 1].ver : null;
    var added = [];
    var hi = [];
    for (var u = 0; u < grp.length; u++) {
      added.push(grp[u].ver);
      hi = hi.concat(grp[u].highlights || []);
    }
    added.sort(semverCmp);
    byDate[dk] = {
      added: added,
      from: prevVer,
      highlights: hi,
      booking_when: grp[0].when
    };
  }
  expandVersionByDateLocalAliases(byDate);
  return byDate;
}

/** Wenn UTC-Tag und lokaler Tag (Server) auseinanderfallen: gleichen Marker auch unter lokalem YMD buchen, falls frei — sonst wirkt ein 3.4.-Release „hinter“ 1.4. nur auf 4.4.-Balken oder fehlt. */
function expandVersionByDateLocalAliases(byDate) {
  var initial = Object.keys(byDate);
  for (var i = 0; i < initial.length; i++) {
    var dk = initial[i];
    var ch = byDate[dk];
    var w = ch && ch.booking_when;
    if (!w) continue;
    var utcDk = isoToUtcYmd(w);
    var locDk = isoToLocalYmd(w);
    if (!locDk || locDk === utcDk) continue;
    if (!byDate[locDk] || byDate[locDk] === ch) {
      byDate[locDk] = ch;
    }
  }
}

function applyVersionChangeByDateMap(result, byDate) {
  if (!byDate) return false;
  var kc = 0;
  for (var kk in byDate) {
    if (Object.prototype.hasOwnProperty.call(byDate, kk)) kc++;
  }
  if (!kc) return false;
  for (var ri = 0; ri < result.length; ri++) {
    result[ri].version_change = null;
  }
  for (var ri2 = 0; ri2 < result.length; ri2++) {
    var ch = byDate[result[ri2].date];
    if (ch) {
      var bw = ch.booking_when || '';
      result[ri2].version_change = {
        added: ch.added,
        from: ch.from,
        highlights: ch.highlights,
        release_when: bw,
        release_utc_ymd: bw ? isoToUtcYmd(bw) : '',
        release_local_ymd: bw ? isoToLocalYmd(bw) : ''
      };
    }
  }
  return true;
}

function buildGitHubVersionTimelineItems() {
  var rels = loadReleasesArrayForBuild();
  var items = [];
  for (var i = 0; i < rels.length; i++) {
    var r = rels[i];
    var ver = normalizeCliSemver(r.tag_name || r.name || '');
    if (!ver || !r.published_at) continue;
    var t = new Date(r.published_at).getTime();
    if (isNaN(t)) continue;
    items.push({
      ver: ver,
      t: t,
      when: r.published_at,
      highlights: extractReleaseHighlights(r.body)
    });
  }
  return items;
}

/**
 * Pro Semver **spätestes** lastUpdated über alle Plattform-Vsix.
 * Früher: Minimum — ein früher Build konnte den Marker auf den Vortag (UTC) legen, während VS Code
 * „Last Updated“ zum letzten Upload passt (z. B. 2.1.92 → eher 4.4. statt 3.4.).
 */
function dedupeMarketplaceVersionsByVersion(rawVers) {
  var by = Object.create(null);
  for (var i = 0; i < rawVers.length; i++) {
    var v = rawVers[i];
    var ver = normalizeCliSemver(v.version || '');
    if (!ver || !v.lastUpdated) continue;
    var t = new Date(v.lastUpdated).getTime();
    if (isNaN(t)) continue;
    if (!by[ver] || t > by[ver].t) {
      by[ver] = { ver: ver, lastUpdated: v.lastUpdated, t: t };
    }
  }
  var keys = Object.keys(by).sort(semverCmp);
  var out = [];
  for (var j = 0; j < keys.length; j++) {
    out.push({ ver: keys[j], lastUpdated: by[keys[j]].lastUpdated });
  }
  return out;
}

function loadMarketplaceVersionsForBuild() {
  var arr = marketplaceVersionsCache.items;
  if (!arr || !arr.length) {
    try {
      var disk = JSON.parse(fs.readFileSync(MARKETPLACE_CACHE, 'utf8'));
      if (disk && Array.isArray(disk.versions)) {
        marketplaceVersionsCache.items = disk.versions;
        arr = disk.versions;
      }
    } catch (eDisk) {}
  }
  return Array.isArray(arr) ? arr : [];
}

/** Einmal pro Scan: verhindert Marker-Sprünge (z. B. 3.4. sichtbar, nach Scan weg), wenn parallel refreshMarketplace den Cache ersetzt. */
function snapshotMarketplaceRowsForScan() {
  var cur = marketplaceVersionsCache.items;
  if (cur && cur.length) return cur.slice();
  try {
    var disk = JSON.parse(fs.readFileSync(MARKETPLACE_CACHE, 'utf8'));
    if (disk && Array.isArray(disk.versions)) return disk.versions.slice();
  } catch (e) {}
  return undefined;
}

/**
 * Snapshot (Scan-Start) mit aktuellem Marketplace-Stand zusammenführen — pro Semver der neueste lastUpdated.
 * Ohne das: erster Scan startet sofort, refreshMarketplace läuft async → eingefrorene Zeilen ohne neue Releases;
 * Extension-Marker fehlen dann für Tage ab z. B. 1.4.
 */
function readMarketplaceVersionsDisk() {
  try {
    var disk = JSON.parse(fs.readFileSync(MARKETPLACE_CACHE, 'utf8'));
    if (disk && Array.isArray(disk.versions) && disk.versions.length) return disk.versions;
  } catch (e) {}
  return null;
}

function mergeMarketplaceRowsPreferNewer(frozenMpRows) {
  var live = loadMarketplaceVersionsForBuild();
  var diskRows = readMarketplaceVersionsDisk();
  var rowsList = [];
  if (frozenMpRows != null && frozenMpRows.length) rowsList.push(frozenMpRows);
  if (live && live.length) rowsList.push(live);
  if (diskRows && diskRows.length) rowsList.push(diskRows);
  if (rowsList.length === 0) return [];
  if (rowsList.length === 1) return rowsList[0].slice();
  var byVer = Object.create(null);
  for (var rli = 0; rli < rowsList.length; rli++) {
    var rows = rowsList[rli];
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      var ver = row.ver || normalizeCliSemver(row.version || '');
      if (!ver || !row.lastUpdated) continue;
      var t = new Date(row.lastUpdated).getTime();
      if (isNaN(t)) continue;
      var ex = byVer[ver];
      if (!ex || t > ex.t) byVer[ver] = { row: row, t: t };
    }
  }
  var keys = Object.keys(byVer).sort(semverCmp);
  var out = [];
  for (var j = 0; j < keys.length; j++) out.push(byVer[keys[j]].row);
  return out;
}

function buildMarketplaceVersionTimelineItems() {
  var rows = loadMarketplaceVersionsForBuild();
  var relMap = getReleasesMap();
  var items = [];
  for (var i = 0; i < rows.length; i++) {
    var row = rows[i];
    var ver = row.ver || normalizeCliSemver(row.version || '');
    if (!ver || !row.lastUpdated) continue;
    var t = new Date(row.lastUpdated).getTime();
    if (isNaN(t)) continue;
    var hi = [];
    var rm = relMap[ver];
    if (rm && rm.highlights) hi = hi.concat(rm.highlights);
    items.push({ ver: ver, t: t, when: row.lastUpdated, highlights: hi });
  }
  return items;
}

/**
 * GitHub + Marketplace zusammenführen: Datum bevorzugt Marketplace (offiziell), fehlende Versionen
 * kommen von GitHub — verhindert „Abbruch“ nach z. B. 27.3., wenn der Marketplace-Cache alt/kurz war.
 */
function buildMergedExtensionTimelineItems(frozenMpRows) {
  var relMap = getReleasesMap();
  var byVer = Object.create(null);
  var ghItems = buildGitHubVersionTimelineItems();
  for (var gi = 0; gi < ghItems.length; gi++) {
    var g = ghItems[gi];
    var ghHi = g.highlights && g.highlights.length ? g.highlights.slice() : [];
    byVer[g.ver] = { ver: g.ver, t: g.t, when: g.when, highlights: ghHi };
  }
  var frozenArg = arguments.length >= 1 ? frozenMpRows : undefined;
  var rows =
    frozenArg !== undefined
      ? mergeMarketplaceRowsPreferNewer(frozenArg)
      : loadMarketplaceVersionsForBuild();
  for (var ri = 0; ri < rows.length; ri++) {
    var row = rows[ri];
    var ver = row.ver || normalizeCliSemver(row.version || '');
    if (!ver || !row.lastUpdated) continue;
    var t = new Date(row.lastUpdated).getTime();
    if (isNaN(t)) continue;
    var hi = [];
    var rm = relMap[ver];
    if (rm && rm.highlights) hi = hi.concat(rm.highlights);
    var prev = byVer[ver];
    if ((!hi || !hi.length) && prev && prev.highlights && prev.highlights.length) {
      hi = prev.highlights.slice();
    }
    byVer[ver] = { ver: ver, t: t, when: row.lastUpdated, highlights: hi };
  }
  var out = [];
  for (var vk in byVer) {
    if (Object.prototype.hasOwnProperty.call(byVer, vk)) out.push(byVer[vk]);
  }
  return out;
}

/**
 * Extension-Marker: Merge Marketplace + GitHub; JSONL-Fallback im Aufrufer.
 * Marketplace-API: https://marketplace.visualstudio.com/items?itemName=anthropic.claude-code (Version History).
 */
function applyExtensionVersionMarkers(result, frozenMpRows) {
  var items = buildMergedExtensionTimelineItems(frozenMpRows);
  var byDate = buildByDateFromVersionTimelineItems(items);
  return !!(byDate && applyVersionChangeByDateMap(result, byDate));
}
var outageCache = { incidents: [], fetchedAt: 0, error: null };

// Disk-Cache laden (sofort verfuegbar, kein Netzwerk noetig)
try {
  var diskOutage = JSON.parse(fs.readFileSync(OUTAGE_DISK_CACHE, 'utf8'));
  if (Array.isArray(diskOutage.incidents)) {
    outageCache.incidents = diskOutage.incidents;
    outageCache.fetchedAt = diskOutage.fetchedAt || 0;
  }
} catch (e) {}

/**
 * GET + JSON. Für api.github.com: User-Agent + Accept (ohne User-Agent liefert GitHub oft 403 → kein Array, leerer Release-Cache).
 */
function httpsGetJson(urlStr, cb) {
  var parsed;
  try {
    parsed = new URL(urlStr);
  } catch (eU) {
    cb(eU, null);
    return;
  }
  var isGithubApi = parsed.hostname === 'api.github.com';
  var headers = Object.create(null);
  if (isGithubApi) {
    headers['User-Agent'] = 'claude-usage-dashboard';
    headers['Accept'] = 'application/vnd.github+json';
  }
  var mod = parsed.protocol === 'https:' ? https : http;
  var opts = {
    hostname: parsed.hostname,
    path: parsed.pathname + parsed.search,
    method: 'GET',
    headers: headers
  };
  if (parsed.port) opts.port = parsed.port;
  var req = mod.request(opts, function (res) {
    if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
      var nextUrl;
      try {
        nextUrl = new URL(res.headers.location, urlStr).href;
      } catch (eL) {
        cb(new Error('bad redirect'), null);
        return;
      }
      return httpsGetJson(nextUrl, cb);
    }
    var chunks = [];
    res.on('data', function (c) {
      chunks.push(c);
    });
    res.on('end', function () {
      var raw = Buffer.concat(chunks).toString('utf8');
      try {
        var data = JSON.parse(raw);
        if (res.statusCode < 200 || res.statusCode >= 300) {
          var msg =
            data && typeof data.message === 'string' ? data.message : 'HTTP ' + res.statusCode;
          cb(new Error(msg), null);
          return;
        }
        cb(null, data);
      } catch (eJ) {
        cb(eJ, null);
      }
    });
  });
  req.on('error', function (e) {
    cb(e, null);
  });
  req.setTimeout(20000, function () {
    req.destroy();
    cb(new Error('timeout'), null);
  });
  req.end();
}

function httpsPostJson(postUrl, jsonBody, cb) {
  var parsed;
  try {
    parsed = new URL(postUrl);
  } catch (e) {
    cb(e, null);
    return;
  }
  var body = JSON.stringify(jsonBody);
  var opts = {
    hostname: parsed.hostname,
    port: parsed.port ? Number(parsed.port) : 443,
    path: parsed.pathname + parsed.search,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      Accept: 'application/json;api-version=7.2-preview.1',
      'Content-Length': Buffer.byteLength(body, 'utf8')
    }
  };
  var req = https.request(opts, function (res) {
    var chunks = [];
    res.on('data', function (c) {
      chunks.push(c);
    });
    res.on('end', function () {
      try {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          cb(new Error('HTTP ' + res.statusCode), null);
          return;
        }
        cb(null, JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (e) {
        cb(e, null);
      }
    });
  });
  req.on('error', function (e) {
    cb(e, null);
  });
  req.setTimeout(15000, function () {
    req.destroy();
    cb(new Error('timeout'), null);
  });
  req.write(body);
  req.end();
}

function refreshMarketplaceExtensionCache() {
  var payload = {
    filters: [{ criteria: [{ filterType: 7, value: MARKETPLACE_EXTENSION_ID }], pageNumber: 1, pageSize: 1 }],
    flags: MARKETPLACE_QUERY_FLAGS
  };
  httpsPostJson(MARKETPLACE_QUERY_URL, payload, function (err, data) {
    if (err || !data || !data.results || !data.results[0] || !data.results[0].extensions || !data.results[0].extensions[0]) {
      return;
    }
    var ext = data.results[0].extensions[0];
    var vers = ext.versions;
    if (!Array.isArray(vers)) return;
    var deduped = dedupeMarketplaceVersionsByVersion(vers);
    marketplaceVersionsCache.items = deduped;
    marketplaceVersionsCache.fetchedAt = Date.now();
    try {
      var dir = path.dirname(MARKETPLACE_CACHE);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        MARKETPLACE_CACHE,
        JSON.stringify({ versions: deduped, fetchedAt: marketplaceVersionsCache.fetchedAt }),
        'utf8'
      );
    } catch (we) {}
    if (!marketplaceRefreshFollowupScanDone && deduped.length) {
      marketplaceRefreshFollowupScanDone = true;
      if (scanInProgress) scanQueued = true;
      else runScanAndBroadcast();
    }
  });
}

function refreshOutageCache() {
  httpsGetJson(OUTAGE_API_URL, function (err, data) {
    if (err) {
      outageCache.error = err.message || String(err);
      console.error('outage-fetch: ' + outageCache.error);
      return;
    }
    if (data && Array.isArray(data.incidents)) {
      outageCache.incidents = data.incidents;
      outageCache.fetchedAt = Date.now();
      outageCache.error = null;
      // Disk-Cache schreiben
      try {
        var dir = path.dirname(OUTAGE_DISK_CACHE);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(OUTAGE_DISK_CACHE, JSON.stringify({ incidents: data.incidents, fetchedAt: outageCache.fetchedAt }), 'utf8');
      } catch (we) {}
    }
  });
}

/** Klassifiziert Incident: "server" (API/Model-Fehler → Retries) vs "client" (Desktop/UI-Bug → kein Token-Impact). */
function classifyIncident(name) {
  var n = (name || '').toLowerCase();
  if (n.indexOf('desktop') >= 0) return 'client';
  if (n.indexOf('dispatch') >= 0) return 'client';
  if (n.indexOf('cowork') >= 0) return 'client';
  if (n.indexOf('connector') >= 0) return 'client';
  return 'server';
}

/** Berechnet pro Kalender-Tag die Ausfallstunden + Incident-Liste + Floating-Bar-Spannen. */
function getOutageDaysMap() {
  var map = {};
  var incs = outageCache.incidents;
  for (var i = 0; i < incs.length; i++) {
    var inc = incs[i];
    if (!inc.created_at) continue;
    var start = new Date(inc.created_at);
    var end = inc.resolved_at ? new Date(inc.resolved_at) : new Date();
    if (isNaN(start.getTime())) continue;
    if (isNaN(end.getTime()) || end <= start) end = new Date(start.getTime() + 3600000);

    // Ueber Mitternacht: pro Kalender-Tag aufteilen
    var cur = new Date(start);
    while (cur < end) {
      var dayStr = cur.toISOString().slice(0, 10);
      var dayStart = new Date(dayStr + 'T00:00:00Z');
      var dayEnd = new Date(dayStart.getTime() + 86400000);
      var segStart = cur > dayStart ? cur : dayStart;
      var segEnd = end < dayEnd ? end : dayEnd;
      var hours = (segEnd - segStart) / 3600000;
      var startH = (segStart - dayStart) / 3600000;
      var endH = (segEnd - dayStart) / 3600000;

      if (!map[dayStr]) map[dayStr] = { outage_hours: 0, server_hours: 0, client_hours: 0, incidents: [], spans: [] };
      var incKind = classifyIncident(inc.name);
      map[dayStr].outage_hours += hours;
      if (incKind === 'server') map[dayStr].server_hours += hours;
      else map[dayStr].client_hours += hours;
      map[dayStr].spans.push({ from: Math.round(startH * 100) / 100, to: Math.round(endH * 100) / 100, name: inc.name || '', impact: inc.impact || 'none', kind: classifyIncident(inc.name) });
      // Incident-Name nur einmal pro Tag
      var found = false;
      for (var fi = 0; fi < map[dayStr].incidents.length; fi++) {
        if (map[dayStr].incidents[fi].name === inc.name) { found = true; break; }
      }
      if (!found) map[dayStr].incidents.push({ name: inc.name || '', impact: inc.impact || 'none', kind: classifyIncident(inc.name), created_at: inc.created_at, resolved_at: inc.resolved_at || null });
      cur = dayEnd;
    }
  }
  // Stunden auf 1 Dezimale runden
  var keys = Object.keys(map);
  for (var k = 0; k < keys.length; k++) {
    map[keys[k]].outage_hours = Math.round(map[keys[k]].outage_hours * 10) / 10;
    map[keys[k]].server_hours = Math.round(map[keys[k]].server_hours * 10) / 10;
    map[keys[k]].client_hours = Math.round(map[keys[k]].client_hours * 10) / 10;
  }
  return map;
}

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

/** Stabiler Schlüssel: aufgelöste Pfade, sortiert (Reihenfolge der Wurzeln darf sonst den Cache brechen). */
function scanRootsCacheKey(roots) {
  var paths = [];
  for (var ri = 0; ri < roots.length; ri++) {
    try {
      paths.push(path.resolve(roots[ri].path));
    } catch (e) {
      paths.push(String(roots[ri].path));
    }
  }
  paths.sort();
  return paths.join('|');
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

function localYesterdayStr() {
  var d = new Date();
  d.setDate(d.getDate() - 1);
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}

function buildDashboardStatePaths() {
  return {
    day_cache: displayPathForUi(USAGE_DAY_CACHE_FILE),
    releases: displayPathForUi(RELEASES_CACHE),
    marketplace: displayPathForUi(MARKETPLACE_CACHE),
    outage: displayPathForUi(OUTAGE_DISK_CACHE)
  };
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
    versions: {},
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
  var versNorm = {};
  var versIn = row.versions && typeof row.versions === 'object' ? row.versions : {};
  var vkeys = Object.keys(versIn);
  for (var vi = 0; vi < vkeys.length; vi++) {
    var nk = normalizeCliSemver(vkeys[vi]);
    if (!nk) continue;
    versNorm[nk] = (versNorm[nk] || 0) + (versIn[vkeys[vi]] || 0);
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
    versions: versNorm,
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
      var cliVer = extractCliVersion(rec);
      if (cliVer) dd.versions[cliVer] = (dd.versions[cliVer] || 0) + 1;
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

function buildUsageResult(daily, fileCount, filePaths, roots, buildOpts) {
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
      versions: r.versions || {},
      hours: r.hours,
      hosts: hostsApi,
      forensic_code: '\u2014',
      forensic_hint: '',
      forensic_implied_cap_90: 0,
      forensic_vs_peak: 0,
      outage_hours: 0,
      outage_incidents: [],
      outage_spans: [],
      outage_likely: false,
      model_change: null,
      version_change: null
    });
  }

  // Model-Change-Detection
  for (var mci = 0; mci < result.length; mci++) {
    var curModels = Object.keys(result[mci].models || {}).sort();
    if (mci === 0) { result[mci].model_set = curModels; continue; }
    var prevModels = Object.keys(result[mci - 1].models || {}).sort();
    result[mci].model_set = curModels;
    var added = [];
    var removed = [];
    for (var cmi = 0; cmi < curModels.length; cmi++) {
      if (prevModels.indexOf(curModels[cmi]) < 0) added.push(curModels[cmi]);
    }
    for (var pmi = 0; pmi < prevModels.length; pmi++) {
      if (curModels.indexOf(prevModels[pmi]) < 0) removed.push(prevModels[pmi]);
    }
    if (added.length > 0 || removed.length > 0) {
      result[mci].model_change = { added: added, removed: removed };
    }
  }

  // Extension-Updates: Marketplace/GitHub nach Kalendertag; JSONL füllt Lücken (z. B. nach 27.3. wenn
  // VSIX-Datum ≠ erster Log-Tag der neuen Version — sonst fehlen Marker trotz sichtbarer Version in den Logs).
  var mpFrozen = buildOpts && buildOpts.marketplaceRows;
  applyExtensionVersionMarkers(result, mpFrozen);
  var relMapJsonl = getReleasesMap();
  for (var vci = 0; vci < result.length; vci++) {
    if (result[vci].version_change) continue;
    var curVers = Object.keys(result[vci].versions || {}).sort(semverCmp);
    if (vci === 0) continue;
    var prevVers = Object.keys(result[vci - 1].versions || {}).sort(semverCmp);
    var vAdded = [];
    for (var cvi = 0; cvi < curVers.length; cvi++) {
      if (prevVers.indexOf(curVers[cvi]) < 0) vAdded.push(curVers[cvi]);
    }
    if (vAdded.length === 0) continue;
    vAdded.sort(semverCmp);
    var relHighlights = [];
    for (var rhi = 0; rhi < vAdded.length; rhi++) {
      var vk = normalizeCliSemver(vAdded[rhi]);
      var ri = vk ? relMapJsonl[vk] : null;
      if (ri && ri.highlights) relHighlights = relHighlights.concat(ri.highlights);
    }
    var fromVer = prevVers.length > 0 ? prevVers[prevVers.length - 1] : null;
    result[vci].version_change = { added: vAdded, from: fromVer, highlights: relHighlights };
  }

  enrichVersionChangeNotes(result);

  var peakDate = '';
  var peakTotal = 0;
  for (var pi = 0; pi < result.length; pi++) {
    if (result[pi].total > peakTotal) {
      peakTotal = result[pi].total;
      peakDate = result[pi].date;
    }
  }
  // Forensic + Outage pro Tag
  var outageDays = getOutageDaysMap();
  for (var qi = 0; qi < result.length; qi++) {
    var row = result[qi];
    var rr = daily[row.date];
    if (!rr) continue;
    var f = computeForensicForDay(row.date, rr, peakDate, peakTotal);
    row.forensic_code = f.forensic_code;
    row.forensic_hint = f.forensic_hint;
    row.forensic_implied_cap_90 = f.forensic_implied_cap_90;
    row.forensic_vs_peak = f.forensic_vs_peak;
    var od = outageDays[row.date];
    if (od) {
      row.outage_hours = od.outage_hours;
      row.outage_server_hours = od.server_hours;
      row.outage_client_hours = od.client_hours;
      row.outage_incidents = od.incidents;
      row.outage_spans = od.spans;
      row.outage_likely = (row.hit_limit || 0) > 0;
    }
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
      'Forensic: ? = cache \u2265500M; HIT = limit-like lines in JSONL; <<P = far below peak with high output (not Claude UI \u201c90%\u201d/100%). Impl@90% = total/0.9 is illustrative only. All heuristic.',
    outage_status: outageCache.fetchedAt > 0 ? 'ok' : (outageCache.error ? 'error' : 'pending'),
    outage_fetched: outageCache.fetchedAt ? new Date(outageCache.fetchedAt).toISOString() : null,
    state_paths: buildDashboardStatePaths()
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
  var frozenMpRows = snapshotMarketplaceRowsForScan();
  var rootsKey = scanRootsCacheKey(roots);
  var noDayCache =
    process.env.CLAUDE_USAGE_NO_CACHE === '1' || process.env.CLAUDE_USAGE_NO_CACHE === 'true';
  var todayStr = localCalendarTodayStr();
  var cache = !noDayCache ? readUsageDayCache() : null;
  var useTodayOnly = false;
  // Exakte Treffer: sonst Vollscan (neue/entfernte .jsonl oder andere Wurzeln).
  if (
    cache &&
    cache.version === USAGE_DAY_CACHE_VERSION &&
    cache.jsonl_file_count === tagged.length &&
    cache.scan_roots_key === rootsKey &&
    Array.isArray(cache.days) &&
    cache.days.length > 0
  ) {
    useTodayOnly = true;
    var maxCached = '';
    for (var cjx = 0; cjx < cache.days.length; cjx++) {
      var djx = cache.days[cjx].date;
      if (djx === todayStr) continue;
      if (!maxCached || djx > maxCached) maxCached = djx;
    }
    var yStr = localYesterdayStr();
    if (maxCached && maxCached < yStr) {
      useTodayOnly = false;
    }
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
        todayStr: todayStr,
        marketplaceRows: frozenMpRows
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
            todayStr: todayStr,
            marketplaceRows: frozenMpRows
          });
        } catch (eProg1) {}
      }
      setImmediate(tick);
    } else {
      try {
        var result = buildUsageResult(daily, tagged.length, tagged, roots, {
          marketplaceRows: frozenMpRows
        });
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
.report-btn{background:#334155;color:#e2e8f0;border:1px solid #475569;padding:8px 16px;border-radius:6px;cursor:pointer;font-size:.8rem;margin-top:12px;display:inline-flex;align-items:center;gap:6px}\n\
.report-btn:hover{background:#475569;border-color:#64748b}\n\
.report-modal-overlay{display:none;position:fixed;inset:0;z-index:9000;background:rgba(0,0,0,.7);backdrop-filter:blur(4px);align-items:center;justify-content:center}\n\
.report-modal-overlay.open{display:flex}\n\
.report-modal{background:#0f172a;border:1px solid #334155;border-radius:12px;width:min(90vw,840px);max-height:85vh;display:flex;flex-direction:column;box-shadow:0 24px 64px rgba(0,0,0,.6)}\n\
.report-modal-head{display:flex;align-items:center;justify-content:space-between;padding:14px 18px;border-bottom:1px solid #334155}\n\
.report-modal-head h3{font-size:1rem;color:#f8fafc;margin:0}\n\
.report-modal-actions{display:flex;gap:8px}\n\
.report-modal-actions button{background:#334155;color:#e2e8f0;border:1px solid #475569;padding:6px 14px;border-radius:6px;cursor:pointer;font-size:.78rem}\n\
.report-modal-actions button:hover{background:#475569}\n\
.report-modal-actions button.primary{background:#3b82f6;border-color:#2563eb;color:#fff}\n\
.report-modal-actions button.primary:hover{background:#2563eb}\n\
.report-modal-body{flex:1;overflow:auto;padding:16px 18px}\n\
.report-modal-body pre{white-space:pre-wrap;word-break:break-word;font-size:.78rem;color:#cbd5e1;line-height:1.55;margin:0;font-family:ui-monospace,SFMono-Regular,Consolas,monospace}\n\
.day-picker-row{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:14px}\n\
.day-picker-row label{color:#94a3b8;font-size:.85rem}\n\
.day-picker-row select{background:#1e293b;color:#e2e8f0;border:1px solid #334155;border-radius:6px;padding:8px 12px;font-size:.9rem;min-width:220px}\n\
.day-picker-hint{font-size:.75rem;color:#64748b;max-width:36rem;line-height:1.4}\n\
.forensic-charts-stack{margin-top:8px}\n\
.service-chart-canvas-wrap{position:relative}\n\
.service-chart-canvas-wrap>canvas{position:relative;z-index:1}\n\
.fs-update-overlay,.main-charts-update-overlay{position:absolute;left:0;top:0;right:0;bottom:0;pointer-events:none;z-index:4;overflow:visible}\n\
.main-charts-wrap{position:relative}\n\
.main-charts-wrap>#charts,.main-charts-wrap>#charts-host-sub{position:relative;z-index:1}\n\
.fs-update-mark,.main-update-mark{position:absolute;margin:0;padding:0;border:none;background:transparent;cursor:pointer;pointer-events:auto;transform:translate(-50%,0);font-size:13px;line-height:1;color:#4ade80;text-shadow:0 0 8px rgba(0,0,0,.75),0 1px 2px rgba(0,0,0,.9);font-weight:700;z-index:2}\n\
.fs-update-mark:hover,.main-update-mark:hover{color:#86efac;filter:brightness(1.15)}\n\
.update-sl-backdrop{display:none;position:fixed;inset:0;z-index:9500;background:rgba(0,0,0,.35)}\n\
.update-sl-backdrop.open{display:block}\n\
.update-sl{position:fixed;top:0;right:0;width:min(420px,92vw);max-height:100vh;height:100vh;z-index:9600;background:#0f172a;border-left:1px solid #334155;box-shadow:-12px 0 40px rgba(0,0,0,.55);transform:translateX(100%);transition:transform .28s ease;overflow:hidden;display:flex;flex-direction:column}\n\
.update-sl.open{transform:translateX(0)}\n\
.update-sl-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;padding:16px 18px;border-bottom:1px solid #334155;flex-shrink:0}\n\
.update-sl-head h3{margin:0;font-size:1rem;color:#f8fafc;font-weight:600;line-height:1.35}\n\
.update-sl-close{background:#334155;color:#e2e8f0;border:1px solid #475569;width:36px;height:36px;border-radius:8px;cursor:pointer;font-size:1.25rem;line-height:1;flex-shrink:0}\n\
.update-sl-close:hover{background:#475569}\n\
.update-sl-body{padding:16px 18px 24px;overflow:auto;flex:1;font-size:.85rem;color:#cbd5e1;line-height:1.5}\n\
.update-sl-body .upd-ver{font-size:1rem;color:#86efac;margin:0 0 12px;font-weight:600}\n\
.update-sl-body .upd-meta{color:#94a3b8;font-size:.78rem;margin:0 0 14px;line-height:1.45}\n\
.update-sl-body ul{margin:8px 0 0;padding-left:1.1rem}\n\
.update-sl-body li{margin:6px 0}\n\
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
<span id="anthropic-status" title="Anthropic Status" style="display:inline-flex;align-items:center;gap:4px;margin-left:10px;font-size:.72rem;color:#94a3b8;cursor:help"><span id="anthropic-dot" style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#475569"></span><span id="anthropic-label">Status</span></span>\n\
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
<div class="subtitle" id="state-cache-paths" style="margin-top:8px;padding-top:8px;border-top:1px solid #334155;color:#64748b;line-height:1.5;font-size:.62rem;white-space:pre-line;word-break:break-all"></div>\n\
</div>\n\
</details>\n\
<details class="forensic-details" id="forensic-collapse">\n\
<summary class="forensic-summary" id="forensic-summary-line">Forensic (token_forensics)</summary>\n\
<div class="forensic-inner">\n\
<p class="forensic-note-p" id="forensic-note"></p>\n\
<div class="grid" id="forensic-cards"></div>\n\
<div class="forensic-charts-stack" id="forensic-charts-stack">\n\
<div class="chart-box" style="margin-top:16px;margin-bottom:0">\n\
<h3 id="forensic-chart-h3">Forensic &amp; Hit Limit pro Tag</h3>\n\
<p id="forensic-chart-blurb" style="font-size:.75rem;color:#94a3b8;margin:6px 0 10px;line-height:1.45"><strong style="color:#ef4444">Rot (Balken)</strong> = Z\u00e4hler Hit-Limit-Zeilen in JSONL. <strong style="color:#f59e0b">Linie</strong> = Score 3=? · 2=HIT · 1=&lt;&lt;P (Peak-Vergleich, nicht Claude-UI 90%/100%).</p>\n\
<canvas id="c-forensic"></canvas>\n\
</div>\n\
<div class="chart-box" style="margin-top:16px;margin-bottom:0">\n\
<h3 id="service-chart-h3">Service Impact</h3>\n\
<p id="service-chart-blurb" style="font-size:.75rem;color:#94a3b8;margin:6px 0 10px;line-height:1.45"></p>\n\
<div class="service-chart-canvas-wrap" id="service-chart-canvas-wrap">\n\
<div class="fs-update-overlay" id="fs-update-overlay" aria-hidden="true"></div>\n\
<canvas id="c-service"></canvas>\n\
</div>\n\
</div>\n\
</div>\n\
<p id="thinking-note" style="font-size:.75rem;color:#f59e0b;margin:12px 0 4px;line-height:1.45"></p>\n\
<button type="button" class="report-btn" id="forensic-report-btn" title="Forensic Report als Markdown generieren">\n\
<span id="report-btn-label">Forensic Report</span>\n\
</button>\n\
</div>\n\
</details>\n\
<div class="report-modal-overlay" id="report-modal-overlay">\n\
<div class="report-modal">\n\
<div class="report-modal-head">\n\
<h3 id="report-modal-title">Forensic Report</h3>\n\
<div class="report-modal-actions">\n\
<button type="button" id="report-copy-btn">Copy</button>\n\
<button type="button" class="primary" id="report-download-btn">Download .md</button>\n\
<button type="button" id="report-close-btn">\u2715</button>\n\
</div>\n\
</div>\n\
<div class="report-modal-body"><pre id="report-content"></pre></div>\n\
</div>\n\
</div>\n\
<div class="day-picker-row" id="day-picker-row">\n\
<label id="lbl-day-picker" for="day-picker">Karten &amp; Tabelle (Tag w\u00e4hlen)</label>\n\
<select id="day-picker" aria-label=""></select>\n\
<span class="day-picker-hint" id="day-picker-hint"></span>\n\
</div>\n\
<div class="grid" id="cards"></div>\n\
<div class="main-charts-wrap" id="main-charts-wrap">\n\
<div class="main-charts-update-overlay" id="main-charts-update-overlay" aria-hidden="true"></div>\n\
<div class="charts" id="charts"></div>\n\
<div class="charts-pair" id="charts-host-sub"></div>\n\
</div>\n\
<div class="chart-box" style="margin-bottom:24px"><h3 id="daily-detail-heading">Tagesdetail</h3><div style="overflow-x:auto"><table id="tbl"><thead><tr></tr></thead><tbody></tbody></table></div></div>\n\
<div id="update-slideout-backdrop" class="update-sl-backdrop"></div>\n\
<aside id="update-slideout" class="update-sl" aria-hidden="true">\n\
<div class="update-sl-head">\n\
<h3 id="update-sl-title"></h3>\n\
<button type="button" class="update-sl-close" id="update-sl-close" aria-label="Close">&times;</button>\n\
</div>\n\
<div class="update-sl-body" id="update-sl-body"></div>\n\
</aside>\n\
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
  if (fh) fh.textContent = t("unifiedChartTitle");\n\
  var fb = document.getElementById("forensic-chart-blurb");\n\
  if (fb) fb.innerHTML = t("forensicChartBlurbHtml");\n\
  var rbl = document.getElementById("report-btn-label");\n\
  if (rbl) rbl.textContent = t("reportBtn");\n\
  var sh3 = document.getElementById("service-chart-h3");\n\
  if (sh3) sh3.textContent = t("serviceChartTitle");\n\
  var sbl = document.getElementById("service-chart-blurb");\n\
  if (sbl) sbl.innerHTML = t("serviceBlurb");\n\
  var tn = document.getElementById("thinking-note");\n\
  if (tn) tn.textContent = t("thinkingNote");\n\
  var lf = document.getElementById("live-files-hint");\n\
  if (lf) lf.textContent = t("liveFilesHint");\n\
  document.documentElement.lang = __lang === "de" ? "de" : "en";\n\
  var usc = document.getElementById("update-sl-close");\n\
  if (usc) usc.setAttribute("aria-label", t("updateSlideoutClose"));\n\
}\n\
\n\
var _charts = {};\n\
var __lastUsageData = null;\n\
function updateStatePathsRow(data) {\n\
  var el = document.getElementById("state-cache-paths");\n\
  if (!el) return;\n\
  var sp = data && data.state_paths;\n\
  if (!sp) {\n\
    el.textContent = "";\n\
    return;\n\
  }\n\
  el.textContent =\n\
    t("statePathsTitle") +\n\
    "\\n" +\n\
    t("statePathDay") +\n\
    sp.day_cache +\n\
    "\\n" +\n\
    t("statePathReleases") +\n\
    sp.releases +\n\
    "\\n" +\n\
    t("statePathMarketplace") +\n\
    sp.marketplace +\n\
    "\\n" +\n\
    t("statePathOutage") +\n\
    sp.outage;\n\
}\n\
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
    sumEl.textContent = tr("metaDetailsScanProgress", { done: sp.done, total: sp.total, sec: data.refresh_sec || 180 });\n\
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
  sumEl.textContent = tr("metaDetailsSummaryLine", { files: data.parsed_files || 0, sec: data.refresh_sec || 180 });\n\
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
var USAGE_EXT_VLINE_END_OFFSET = 22;\n\
var __usageUpdatePluginRegistered = false;\n\
function registerUsageUpdateVLinePlugin() {\n\
  if (__usageUpdatePluginRegistered || typeof Chart === "undefined") return;\n\
  __usageUpdatePluginRegistered = true;\n\
  Chart.register({\n\
    id: "usageUpdateVerticalLines",\n\
    beforeDatasetsDraw: function (chart) {\n\
      var cid = chart.canvas && chart.canvas.id;\n\
      if (cid === "c-forensic" || cid === "c2") return;\n\
      if (cid !== "c-service" && cid !== "c1" && cid !== "c3" && cid !== "c4" && cid !== "c1-hosts") return;\n\
      var idxs = window.__usageVersionDayIndices;\n\
      if (!idxs || !idxs.length) return;\n\
      var xScale = chart.scales.x;\n\
      if (!xScale || typeof xScale.getPixelForTick !== "function") return;\n\
      var ca = chart.chartArea;\n\
      if (!ca) return;\n\
      var n = chart.data.labels ? chart.data.labels.length : 0;\n\
      if (!n) return;\n\
      var ctx = chart.ctx;\n\
      var yEnd = ca.top + USAGE_EXT_VLINE_END_OFFSET;\n\
      var bot = ca.bottom;\n\
      if (yEnd >= bot) return;\n\
      ctx.save();\n\
      ctx.setLineDash([3, 4]);\n\
      ctx.strokeStyle = "rgba(74, 222, 128, 0.38)";\n\
      ctx.lineWidth = 1;\n\
      for (var k = 0; k < idxs.length; k++) {\n\
        var di = idxs[k];\n\
        if (di < 0 || di >= n) continue;\n\
        var x = xScale.getPixelForTick(di);\n\
        if (x == null || isNaN(x)) continue;\n\
        ctx.beginPath();\n\
        ctx.moveTo(x, bot);\n\
        ctx.lineTo(x, yEnd);\n\
        ctx.stroke();\n\
      }\n\
      ctx.restore();\n\
    }\n\
  });\n\
}\n\
registerUsageUpdateVLinePlugin();\n\
function chartTickXToParentLeft(chart, hostEl, tickIndex) {\n\
  if (!chart || !chart.scales || !chart.scales.x || !chart.canvas || !hostEl) return null;\n\
  var xScale = chart.scales.x;\n\
  if (typeof xScale.getPixelForTick !== "function") return null;\n\
  var x = xScale.getPixelForTick(tickIndex);\n\
  if (x == null || isNaN(x)) return null;\n\
  var cw = chart.width;\n\
  var ch = chart.height;\n\
  if (!cw || !ch) return null;\n\
  var canvas = chart.canvas;\n\
  var cr = canvas.getBoundingClientRect();\n\
  var hr = hostEl.getBoundingClientRect();\n\
  var xCss = (x / cw) * cr.width;\n\
  return cr.left - hr.left + xCss;\n\
}\n\
function chartAreaTopInParent(chart, hostEl) {\n\
  if (!chart || !chart.canvas || !hostEl) return 0;\n\
  var cr = chart.canvas.getBoundingClientRect();\n\
  var hr = hostEl.getBoundingClientRect();\n\
  var t = chart.chartArea ? chart.chartArea.top : 0;\n\
  return cr.top - hr.top + (t / chart.height) * cr.height;\n\
}\n\
function chartAreaBottomInParent(chart, hostEl) {\n\
  if (!chart || !chart.canvas || !hostEl) return 0;\n\
  var cr = chart.canvas.getBoundingClientRect();\n\
  var hr = hostEl.getBoundingClientRect();\n\
  var b = chart.chartArea ? chart.chartArea.bottom : chart.height;\n\
  return cr.top - hr.top + (b / chart.height) * cr.height;\n\
}\n\
/** Y-Koordinate (px von hostEl-Oberkante) für einen Canvas-Y-Wert (von Canvas-Oberkante). */\n\
function chartYInParent(chart, hostEl, yCanvas) {\n\
  if (!chart || !chart.canvas || !hostEl) return 0;\n\
  var cr = chart.canvas.getBoundingClientRect();\n\
  var hr = hostEl.getBoundingClientRect();\n\
  var ch = chart.height;\n\
  if (!ch || yCanvas == null || isNaN(yCanvas)) return cr.top - hr.top;\n\
  return cr.top - hr.top + (yCanvas / ch) * cr.height;\n\
}\n\
function layoutFsUpdateOverlay() {\n\
  var wrap = document.getElementById("service-chart-canvas-wrap");\n\
  var overlay = document.getElementById("fs-update-overlay");\n\
  if (!wrap || !overlay || !_charts.cService || !_charts.cService.chartArea) return;\n\
  overlay.innerHTML = "";\n\
  var idxs = window.__usageVersionDayIndices || [];\n\
  if (!idxs.length) return;\n\
  var n = _charts.cService.data.labels ? _charts.cService.data.labels.length : 0;\n\
  var ch = _charts.cService;\n\
  var triTop = chartYInParent(ch, wrap, ch.chartArea.top + 4);\n\
  for (var q = 0; q < idxs.length; q++) {\n\
    var di = idxs[q];\n\
    if (di < 0 || di >= n) continue;\n\
    var leftAbs = chartTickXToParentLeft(ch, wrap, di);\n\
    if (leftAbs == null) continue;\n\
    var mark = document.createElement("button");\n\
    mark.type = "button";\n\
    mark.className = "fs-update-mark";\n\
    mark.textContent = "\\u25b2";\n\
    mark.style.left = leftAbs + "px";\n\
    mark.style.top = triTop + "px";\n\
    mark.setAttribute("aria-label", t("updateDotAria"));\n\
    mark.dataset.dayIndex = String(di);\n\
    (function (idx) {\n\
      mark.addEventListener("mouseenter", function () {\n\
        clearTimeout(__updateDotHoverTimer);\n\
        __updateDotHoverTimer = setTimeout(function () {\n\
          openUpdateSlideout(idx);\n\
        }, 400);\n\
      });\n\
      mark.addEventListener("mouseleave", function () {\n\
        clearTimeout(__updateDotHoverTimer);\n\
      });\n\
    })(di);\n\
    overlay.appendChild(mark);\n\
  }\n\
}\n\
function layoutMainChartsUpdateOverlay() {\n\
  var stack = document.getElementById("main-charts-wrap");\n\
  var overlay = document.getElementById("main-charts-update-overlay");\n\
  if (!stack || !overlay || !_charts.c1 || !_charts.c1.chartArea) return;\n\
  overlay.innerHTML = "";\n\
  var idxs = window.__usageVersionDayIndices || [];\n\
  if (!idxs.length) return;\n\
  var n = _charts.c1.data.labels ? _charts.c1.data.labels.length : 0;\n\
  var ch = _charts.c1;\n\
  var triTop = chartYInParent(ch, stack, ch.chartArea.top + 4);\n\
  for (var q = 0; q < idxs.length; q++) {\n\
    var di = idxs[q];\n\
    if (di < 0 || di >= n) continue;\n\
    var leftAbs = chartTickXToParentLeft(ch, stack, di);\n\
    if (leftAbs == null) continue;\n\
    var mark = document.createElement("button");\n\
    mark.type = "button";\n\
    mark.className = "main-update-mark";\n\
    mark.textContent = "\\u25b2";\n\
    mark.style.left = leftAbs + "px";\n\
    mark.style.top = triTop + "px";\n\
    mark.setAttribute("aria-label", t("updateDotAria"));\n\
    mark.dataset.dayIndex = String(di);\n\
    (function (idx) {\n\
      mark.addEventListener("mouseenter", function () {\n\
        clearTimeout(__updateDotHoverTimer);\n\
        __updateDotHoverTimer = setTimeout(function () {\n\
          openUpdateSlideout(idx);\n\
        }, 400);\n\
      });\n\
      mark.addEventListener("mouseleave", function () {\n\
        clearTimeout(__updateDotHoverTimer);\n\
      });\n\
    })(di);\n\
    overlay.appendChild(mark);\n\
  }\n\
}\n\
function layoutUpdateGuideOverlays() {\n\
  layoutFsUpdateOverlay();\n\
  layoutMainChartsUpdateOverlay();\n\
}\n\
function openUpdateSlideout(dayIndex) {\n\
  var data = __lastUsageData;\n\
  if (!data || !data.days || data.days[dayIndex] == null) return;\n\
  var d = data.days[dayIndex];\n\
  var vc = d.version_change;\n\
  var titleEl = document.getElementById("update-sl-title");\n\
  var bodyEl = document.getElementById("update-sl-body");\n\
  var panel = document.getElementById("update-slideout");\n\
  var back = document.getElementById("update-slideout-backdrop");\n\
  if (!titleEl || !bodyEl || !panel || !back) return;\n\
  titleEl.textContent = d.date + " — " + t("updateSlideoutHeading");\n\
  bodyEl.textContent = "";\n\
  if (!vc) {\n\
    bodyEl.appendChild(document.createTextNode(t("updateSlideoutNoDetail")));\n\
  } else {\n\
    var pVer = document.createElement("p");\n\
    pVer.className = "upd-ver";\n\
    var verStr = vc.added && vc.added.length ? vc.added.join(", ") : "";\n\
    if (vc.from) verStr = vc.from + " \\u2192 " + verStr;\n\
    pVer.textContent = verStr;\n\
    bodyEl.appendChild(pVer);\n\
    var meta = document.createElement("p");\n\
    meta.className = "upd-meta";\n\
    var metaParts = [];\n\
    if (vc.release_when) metaParts.push(String(vc.release_when));\n\
    if (vc.release_utc_ymd) metaParts.push("UTC: " + vc.release_utc_ymd);\n\
    if (vc.release_local_ymd && vc.release_local_ymd !== vc.release_utc_ymd) metaParts.push("local: " + vc.release_local_ymd);\n\
    meta.textContent = metaParts.join(" \\u00b7 ");\n\
    if (meta.textContent) bodyEl.appendChild(meta);\n\
    var hl = vc.highlights || [];\n\
    var gl = vc.github_release_links || [];\n\
    if (hl.length) {\n\
      var h3 = document.createElement("div");\n\
      h3.style.fontWeight = "600";\n\
      h3.style.color = "#94a3b8";\n\
      h3.style.marginTop = "10px";\n\
      h3.textContent = t("updateSlideoutHighlights");\n\
      bodyEl.appendChild(h3);\n\
      var ul = document.createElement("ul");\n\
      for (var hi = 0; hi < Math.min(8, hl.length); hi++) {\n\
        var li = document.createElement("li");\n\
        li.textContent = String(hl[hi]).slice(0, 400);\n\
        ul.appendChild(li);\n\
      }\n\
      bodyEl.appendChild(ul);\n\
    } else if (gl.length) {\n\
      var pNote = document.createElement("p");\n\
      pNote.className = "upd-meta";\n\
      pNote.style.marginTop = "10px";\n\
      pNote.textContent = t("updateSlideoutHighlightsEmpty");\n\
      bodyEl.appendChild(pNote);\n\
    }\n\
    if (gl.length) {\n\
      var ghH = document.createElement("div");\n\
      ghH.style.fontWeight = "600";\n\
      ghH.style.color = "#94a3b8";\n\
      ghH.style.marginTop = "10px";\n\
      ghH.textContent = t("updateSlideoutGithubReleases");\n\
      bodyEl.appendChild(ghH);\n\
      var ulg = document.createElement("ul");\n\
      ulg.style.marginTop = "6px";\n\
      ulg.style.paddingLeft = "1.2em";\n\
      for (var gi = 0; gi < gl.length; gi++) {\n\
        var gli = document.createElement("li");\n\
        var a = document.createElement("a");\n\
        a.href = gl[gi].url;\n\
        a.textContent = "v" + gl[gi].version;\n\
        a.target = "_blank";\n\
        a.rel = "noopener noreferrer";\n\
        a.style.color = "#93c5fd";\n\
        gli.appendChild(a);\n\
        ulg.appendChild(gli);\n\
      }\n\
      bodyEl.appendChild(ulg);\n\
    }\n\
  }\n\
  panel.classList.add("open");\n\
  back.classList.add("open");\n\
  panel.setAttribute("aria-hidden", "false");\n\
}\n\
function closeUpdateSlideout() {\n\
  var panel = document.getElementById("update-slideout");\n\
  var back = document.getElementById("update-slideout-backdrop");\n\
  if (panel) {\n\
    panel.classList.remove("open");\n\
    panel.setAttribute("aria-hidden", "true");\n\
  }\n\
  if (back) back.classList.remove("open");\n\
}\n\
var __updateSlideoutUiBound = false;\n\
var __updateDotHoverTimer = null;\n\
function initUpdateSlideoutOnce() {\n\
  if (__updateSlideoutUiBound) return;\n\
  __updateSlideoutUiBound = true;\n\
  document.body.addEventListener("click", function (ev) {\n\
    var dot = ev.target.closest(".fs-update-mark, .main-update-mark");\n\
    if (dot && dot.dataset.dayIndex != null) {\n\
      ev.preventDefault();\n\
      openUpdateSlideout(parseInt(dot.dataset.dayIndex, 10));\n\
    }\n\
  });\n\
  var back = document.getElementById("update-slideout-backdrop");\n\
  if (back) back.addEventListener("click", closeUpdateSlideout);\n\
  var cls = document.getElementById("update-sl-close");\n\
  if (cls) cls.addEventListener("click", closeUpdateSlideout);\n\
  document.addEventListener("keydown", function (e) {\n\
    if (e.key === "Escape") closeUpdateSlideout();\n\
  });\n\
}\n\
var __layoutOvTimer = null;\n\
window.addEventListener("resize", function () {\n\
  clearTimeout(__layoutOvTimer);\n\
  __layoutOvTimer = setTimeout(function () {\n\
    layoutUpdateGuideOverlays();\n\
  }, 160);\n\
});\n\
function renderDashboard(data) {\n\
  __lastUsageData = data;\n\
  updateLiveFilesPanel(data);\n\
  updateScanSourcesRow(data);\n\
  updateStatePathsRow(data);\n\
  var days = data.days;\n\
  var sp = data.scan_progress;\n\
  var scanInc = data.scanning && sp && sp.total > 0 && sp.done < sp.total;\n\
  if (scanInc && days && days.length > 0) {\n\
    updateMetaDetailsSummary(data);\n\
    clearTimeout(window.__dashRenderDebounce);\n\
    window.__dashRenderDebounce = setTimeout(function () {\n\
      window.__dashRenderDebounce = null;\n\
      renderDashboardCore(__lastUsageData);\n\
    }, 2200);\n\
    return;\n\
  }\n\
  if (window.__dashRenderDebounce) {\n\
    clearTimeout(window.__dashRenderDebounce);\n\
    window.__dashRenderDebounce = null;\n\
  }\n\
  renderDashboardCore(data);\n\
  updateStatusLamp(data);\n\
}\n\
function renderDashboardCore(data) {\n\
  updateMetaDetailsSummary(data);\n\
  var days = data.days;\n\
  if(!days.length){\n\
    window.__usageVersionDayIndices = [];\n\
    var fsO = document.getElementById("fs-update-overlay");\n\
    var mO = document.getElementById("main-charts-update-overlay");\n\
    if (fsO) fsO.innerHTML = "";\n\
    if (mO) mO.innerHTML = "";\n\
    var meta0=document.getElementById("meta");\n\
    var ls0=document.getElementById("limit-source");\n\
    if(ls0) ls0.textContent = apiNote(data, "limit_source_note", "limit_source_note_en");\n\
    if(data.scanning){\n\
      var dps=document.getElementById("day-picker-row");if(dps)dps.style.display="none";\n\
      var sp0 = data.scan_progress;\n\
      if (sp0 && sp0.total > 0) meta0.textContent = tr("metaScanningExpanded", { done: sp0.done, total: sp0.total, sec: data.refresh_sec || 180 });\n\
      else meta0.textContent=t("metaScanning");\n\
      var sumS=document.getElementById("forensic-summary-line");if(sumS)sumS.textContent=t("metaForensicScanning");\n\
      var fnS=document.getElementById("forensic-note");if(fnS)fnS.textContent=tr("metaForensicNoteFirst",{sec:data.refresh_sec||180});\n\
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
          sec: data.refresh_sec || 180\n\
        })\n\
      : tr("metaParsed", { files: data.parsed_files, time: new Date(data.generated).toLocaleString(), sec: data.refresh_sec || 180 });\n\
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
  window.__usageVersionDayIndices = [];\n\
  for (var uxi = 0; uxi < days.length; uxi++) {\n\
    if (days[uxi].version_change) window.__usageVersionDayIndices.push(uxi);\n\
  }\n\
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
    options:{responsive:true,animation:false,scales:{y:{stacked:true,ticks:{callback:function(v){return fmt(v)}}},x:{stacked:true}},plugins:{tooltip:{callbacks:{label:function(c){return c.dataset.label+": "+fmt(c.raw);},footer:function(items){if(!items.length)return"";var di=items[0].dataIndex;return tr("chartTooltipCoDay",{ratio:String(days[di].cache_output_ratio)});}}}}}\n\
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
    _charts.c1hosts = new Chart(document.getElementById("c1-hosts"),{type:"bar",data:{labels:labels,datasets:dsH},options:{responsive:true,animation:false,scales:{x:{stacked:true,grid:{color:"rgba(51,65,85,0.5)"}},y:{stacked:true,ticks:{callback:function(v){return fmt(v);}},grid:{color:"rgba(51,65,85,0.5)"}}},plugins:{legend:{labels:{color:"#cbd5e1"}},tooltip:{callbacks:{label:function(c){return c.dataset.label+": "+fmt(c.parsed.y);},footer:function(tipItems){if(!tipItems.length)return"";var di=tipItems[0].dataIndex;var segs=[];for(var ci=0;ci<tipItems.length;ci++){var L=tipItems[ci].dataset.label;var hh=days[di].hosts&&days[di].hosts[L];if(hh)segs.push(tr("chartTooltipCoHostLine",{host:L,ratio:String(hh.cache_output_ratio)}));}var s=0;for(var fi=0;fi<tipItems.length;fi++)s+=tipItems[fi].parsed.y||0;return(segs.length?segs.join(" · ")+" | ":"")+t("hostStackFooter")+fmt(s);}}}}}});\n\
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
    options:{responsive:true,animation:false,scales:{y:{beginAtZero:true}},plugins:{tooltip:{callbacks:{label:function(c){return c.raw+"x";},footer:function(items){if(!items.length)return"";var di=items[0].dataIndex;var d=days[di];return tr("chartTooltipOutCacheDay",{out:fmt(d.output),cache:fmt(d.cache_read)});}}}}}\n\
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
    options:{responsive:true,animation:false,scales:{y:{ticks:{callback:function(v){return fmt(v)}}}},plugins:{tooltip:{callbacks:{label:function(c){return fmt(c.raw)+"/h"}}}}}\n\
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
      animation: false,\n\
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
    c4Opts = { responsive: true, animation: false, scales: { y: { max: 100, ticks: { callback: function (v) { return v + "%"; } } } }, plugins: { tooltip: { callbacks: { label: function (c) { return c.raw + "%"; } } } } };\n\
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
  // ─── Forensic Chart (Original: Hit-Limit Bars + Score Line) ───\n\
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
        animation:false,\n\
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
            min:0,max:3.5,\n\
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
\n\
  // ─── Service Impact Chart (Arbeitszeit vs Ausfall + Cache-Read-Kosten) ───\n\
  var elS=document.getElementById("c-service");\n\
  if(elS){\n\
    // Berechne pro Tag: saubere Arbeitsstunden, betroffene Stunden, Ausfall ausserhalb Arbeit\n\
    var sClean=[],sAffServer=[],sAffClient=[],sOutOnly=[],sCacheRead=[];\n\
    for(var si=0;si<days.length;si++){\n\
      var sd=days[si];\n\
      var wHrs=Object.keys(sd.hours||{}).map(function(h){return parseInt(h);});\n\
      var spans=sd.outage_spans||[];\n\
      var affSrv=0,affCli=0,outTotal=0;\n\
      for(var wi=0;wi<wHrs.length;wi++){\n\
        var wh=wHrs[wi];\n\
        var hitSrv=false,hitCli=false;\n\
        for(var oi=0;oi<spans.length;oi++){\n\
          if(wh>=Math.floor(spans[oi].from)&&wh<Math.ceil(spans[oi].to)){\n\
            if(spans[oi].kind==="server")hitSrv=true;\n\
            else hitCli=true;\n\
          }\n\
        }\n\
        if(hitSrv)affSrv++;\n\
        else if(hitCli)affCli++;\n\
      }\n\
      for(var oi=0;oi<spans.length;oi++) outTotal+=spans[oi].to-spans[oi].from;\n\
      var cleanWork=wHrs.length-affSrv-affCli;\n\
      var outOnly=Math.max(0,Math.round((outTotal-affSrv-affCli)*10)/10);\n\
      sClean.push(cleanWork);\n\
      sAffServer.push(affSrv);\n\
      sAffClient.push(affCli);\n\
      sOutOnly.push(outOnly);\n\
      sCacheRead.push(sd.cache_read||0);\n\
    }\n\
    if(_charts.cService){try{_charts.cService.destroy();}catch(e){}}\n\
    var mcSvc=[];\n\
    for(var mi=0;mi<days.length;mi++){\n\
      var stackTopSvc=sClean[mi]+sAffServer[mi]+sAffClient[mi]+sOutOnly[mi];\n\
      var xCat=labels[mi];\n\
      if(days[mi].model_change)mcSvc.push({x:xCat,y:stackTopSvc+0.25});\n\
    }\n\
    _charts.cService=new Chart(elS,{\n\
      data:{\n\
        labels:labels,\n\
        datasets:[\n\
          {\n\
            type:"bar",label:t("serviceDS_cleanWork"),\n\
            data:sClean,\n\
            backgroundColor:"rgba(59,130,246,0.7)",borderColor:"rgba(59,130,246,0.9)",borderWidth:1,\n\
            stack:"hours",yAxisID:"y"\n\
          },\n\
          {\n\
            type:"bar",label:t("serviceDS_affectedServer"),\n\
            data:sAffServer,\n\
            backgroundColor:"rgba(239,68,68,0.7)",borderColor:"rgba(239,68,68,0.9)",borderWidth:1,\n\
            stack:"hours",yAxisID:"y"\n\
          },\n\
          {\n\
            type:"bar",label:t("serviceDS_affectedClient"),\n\
            data:sAffClient,\n\
            backgroundColor:"rgba(251,191,36,0.6)",borderColor:"rgba(251,191,36,0.9)",borderWidth:1,\n\
            stack:"hours",yAxisID:"y"\n\
          },\n\
          {\n\
            type:"bar",label:t("serviceDS_outageOnly"),\n\
            data:sOutOnly,\n\
            backgroundColor:"rgba(107,114,128,0.35)",borderColor:"rgba(107,114,128,0.5)",borderWidth:1,\n\
            stack:"hours",yAxisID:"y"\n\
          },\n\
          {\n\
            type:"line",label:t("chartDS_cacheRead"),\n\
            data:sCacheRead,\n\
            borderColor:"rgba(139,92,246,0.8)",backgroundColor:"rgba(139,92,246,0.08)",\n\
            pointBackgroundColor:"#8b5cf6",pointRadius:3,tension:0.25,borderWidth:2,\n\
            yAxisID:"yCR",fill:true\n\
          },\n\
          {\n\
            type:"scatter",label:t("forensicDS_modelChange"),\n\
            data:mcSvc,pointStyle:"rectRot",pointRadius:6,\n\
            pointBackgroundColor:"#22d3ee",pointBorderColor:"#06b6d4",pointBorderWidth:2,\n\
            yAxisID:"y",showLine:false,clip:false,parsing:{xAxisKey:"x",yAxisKey:"y"}\n\
          }\n\
        ]\n\
      },\n\
      options:{\n\
        responsive:true,animation:false,maintainAspectRatio:true,aspectRatio:2.4,\n\
        interaction:{mode:"index",intersect:false},\n\
        scales:{\n\
          x:{type:"category",stacked:true,grid:{color:"rgba(51,65,85,0.5)"}},\n\
          y:{stacked:true,position:"left",beginAtZero:true,\n\
            title:{display:true,text:t("serviceAxisHours"),color:"#94a3b8"},\n\
            ticks:{color:"#94a3b8",stepSize:4,callback:function(v){return v+"h";}},\n\
            grid:{color:"rgba(51,65,85,0.5)"}},\n\
          yCR:{position:"right",beginAtZero:true,\n\
            title:{display:true,text:t("chartDS_cacheRead"),color:"#8b5cf6"},\n\
            ticks:{color:"#8b5cf6",callback:function(v){return fmt(v);}},\n\
            grid:{drawOnChartArea:false}}\n\
        },\n\
        plugins:{\n\
          legend:{labels:{color:"#cbd5e1"}},\n\
          tooltip:{\n\
            callbacks:{\n\
              title:function(items){\n\
                if(!items.length)return"";\n\
                var rawT=items[0].raw;\n\
                var diT=items[0].dataIndex;\n\
                if(rawT&&typeof rawT==="object"&&typeof rawT.x==="string"){var ixT=labels.indexOf(rawT.x);if(ixT>=0)diT=ixT;}\n\
                return days[diT]?days[diT].date:"";\n\
              },\n\
              afterBody:function(items){\n\
                if(!items.length)return"";\n\
                var rawB=items[0].raw;\n\
                var di=items[0].dataIndex;\n\
                if(rawB&&typeof rawB==="object"&&typeof rawB.x==="string"){var ixB=labels.indexOf(rawB.x);if(ixB>=0)di=ixB;}\n\
                var d=days[di];\n\
                var lines=[];\n\
                lines.push(t("serviceDS_cleanWork")+": "+sClean[di]+"h");\n\
                if(sAffServer[di]>0)lines.push(t("serviceDS_affectedServer")+": "+sAffServer[di]+"h");\n\
                if(sAffClient[di]>0)lines.push(t("serviceDS_affectedClient")+": "+sAffClient[di]+"h");\n\
                if(sOutOnly[di]>0)lines.push(t("serviceDS_outageOnly")+": "+sOutOnly[di].toFixed(1)+"h");\n\
                lines.push("Cache Read: "+fmt(d.cache_read||0)+" (C:O "+(d.cache_output_ratio||0)+"x)");\n\
                if((d.outage_hours||0)>0){\n\
                  lines.push("");\n\
                  var oIncs=d.outage_incidents||[];\n\
                  for(var oi=0;oi<oIncs.length;oi++)lines.push("["+oIncs[oi].impact.toUpperCase()+"] "+oIncs[oi].name);\n\
                }\n\
                if(d.model_change){\n\
                  if(d.model_change.added&&d.model_change.added.length)lines.push(t("tooltipModelAdded")+d.model_change.added.join(", "));\n\
                  if(d.model_change.removed&&d.model_change.removed.length)lines.push(t("tooltipModelRemoved")+d.model_change.removed.join(", "));\n\
                }\n\
                if(d.version_change){\n\
                  var vl=t("tooltipVersionUpdate");\n\
                  if(d.version_change.from)vl+=d.version_change.from+" \\u2192 ";\n\
                  vl+=d.version_change.added.join(", ");\n\
                  lines.push(vl);\n\
                  var rw=d.version_change.release_when;\n\
                  if(rw){\n\
                    lines.push(t("serviceTooltipReleaseClock")+String(rw));\n\
                    if(d.version_change.release_utc_ymd)lines.push(t("serviceTooltipReleaseUtc")+d.version_change.release_utc_ymd);\n\
                    if(d.version_change.release_local_ymd&&d.version_change.release_local_ymd!==d.version_change.release_utc_ymd)lines.push(t("serviceTooltipReleaseLocal")+d.version_change.release_local_ymd);\n\
                  }\n\
                  var vhl=d.version_change.highlights||[];\n\
                  for(var vhi=0;vhi<Math.min(3,vhl.length);vhi++) lines.push("  \\u2022 "+vhl[vhi].slice(0,80));\n\
                  if(!vhl.length){\n\
                    var vgl=d.version_change.github_release_links||[];\n\
                    if(vgl.length){\n\
                      lines.push(t("serviceTooltipReleaseGithubHint"));\n\
                      for(var vgj=0;vgj<Math.min(3,vgl.length);vgj++) lines.push("  "+vgl[vgj].url);\n\
                    }\n\
                  }\n\
                }\n\
                return lines;\n\
              }\n\
            }\n\
          }\n\
        }\n\
      }\n\
    });\n\
  }\n\
  initUpdateSlideoutOnce();\n\
  requestAnimationFrame(function () {\n\
    requestAnimationFrame(function () {\n\
      layoutUpdateGuideOverlays();\n\
    });\n\
  });\n\
}\n\
\n\
// (renderTimelineChart entfernt)\n\
// ─── Anthropic Status Lamp ───\n\
function updateStatusLamp(data) {\n\
  var dot = document.getElementById("anthropic-dot");\n\
  var label = document.getElementById("anthropic-label");\n\
  if (!dot || !label) return;\n\
  var st = data.outage_status || "pending";\n\
  if (st === "error" || st === "pending") {\n\
    dot.style.background = "#475569";\n\
    label.textContent = t("statusPending");\n\
    dot.parentElement.title = t("statusPendingTip");\n\
    return;\n\
  }\n\
  // Prüfe aktuellste Incidents: gibt es unresolved oder recent?\n\
  var days = data.days || [];\n\
  var today = data.calendar_today || new Date().toISOString().slice(0,10);\n\
  var todayData = null;\n\
  for (var i = days.length - 1; i >= 0; i--) { if (days[i].date === today) { todayData = days[i]; break; } }\n\
  var hasActiveOutage = false;\n\
  var hasRecentIncident = false;\n\
  if (todayData && todayData.outage_incidents) {\n\
    for (var ii = 0; ii < todayData.outage_incidents.length; ii++) {\n\
      var inc = todayData.outage_incidents[ii];\n\
      if (!inc.resolved_at) { hasActiveOutage = true; break; }\n\
      hasRecentIncident = true;\n\
    }\n\
  }\n\
  if (hasActiveOutage) {\n\
    dot.style.background = "#ef4444";\n\
    label.textContent = t("statusOutage");\n\
    dot.parentElement.title = t("statusOutageTip");\n\
  } else if (hasRecentIncident) {\n\
    dot.style.background = "#f59e0b";\n\
    label.textContent = t("statusIncident");\n\
    dot.parentElement.title = t("statusIncidentTip");\n\
  } else {\n\
    dot.style.background = "#22c55e";\n\
    label.textContent = t("statusOk");\n\
    dot.parentElement.title = t("statusOkTip");\n\
  }\n\
}\n\
\n\
// ─── Forensic Report Generator ───\n\
function generateForensicReportMd(data) {\n\
  var days = data.days || [];\n\
  if (!days.length) return t("reportNoData");\n\
  var isDE = __lang === "de";\n\
  var CACHE_THRESH = 500000000;\n\
  var HIT_MIN = 50;\n\
  var md = [];\n\
  var now = new Date().toISOString().replace("T"," ").slice(0,19);\n\
\n\
  // helper\n\
  function pad(s,w){s=String(s);while(s.length<w)s=" "+s;return s;}\n\
  function dayTotal(d){return (d.input||0)+(d.output||0)+(d.cache_read||0)+(d.cache_creation||0);}\n\
\n\
  // Detect peak + limit days\n\
  var peakDay=null,peakVal=0;\n\
  for(var i=0;i<days.length;i++){var tt=dayTotal(days[i]);if(tt>peakVal){peakVal=tt;peakDay=days[i];}}\n\
  var limitDays=[];\n\
  for(var i=0;i<days.length;i++){var d=days[i];var fl=[];if((d.hit_limit||0)>=HIT_MIN)fl.push("HIT("+(d.hit_limit)+")");if((d.cache_read||0)>=CACHE_THRESH)fl.push("CACHE\\u2265500M");if(fl.length)limitDays.push({d:d,flags:fl});}\n\
\n\
  md.push("# Forensic Report \\u2014 Claude Code Token Usage");\n\
  md.push("");\n\
  md.push((isDE?"Erstellt: ":"Generated: ")+now);\n\
  md.push((isDE?"Peak-Tag: ":"Peak day: ")+(peakDay?peakDay.date+" ("+fmt(peakVal)+")":"\\u2014"));\n\
  md.push((isDE?"Limit-Tage: ":"Limit days: ")+limitDays.length);\n\
  md.push("");\n\
\n\
  // 1. Daily overview\n\
  md.push("## 1. "+(isDE?"Tages\\u00fcbersicht":"Daily Overview"));\n\
  md.push("");\n\
  md.push("| "+(isDE?"Datum":"Date")+" | Output | Cache Read | C:O | Calls | "+(isDE?"Std.":"Hours")+" | Limit |");\n\
  md.push("|------------|----------|------------|--------|-------|-------|--------|");\n\
  for(var i=0;i<days.length;i++){var d=days[i];var cr=d.output>0?Math.round(d.cache_read/d.output):0;var lim="\\u2014";if((d.hit_limit||0)>=HIT_MIN)lim="HIT("+(d.hit_limit)+")";if((d.cache_read||0)>=CACHE_THRESH)lim+=(lim!=="\\u2014"?", ":"")+"CACHE\\u2265500M";md.push("| "+d.date+" | "+fmt(d.output)+" | "+fmt(d.cache_read)+" | "+cr+"x | "+d.calls+" | "+(d.active_hours||0)+" | "+lim+" |");}\n\
  md.push("");\n\
\n\
  // 2. Efficiency\n\
  md.push("## 2. "+(isDE?"Effizienz":"Efficiency"));\n\
  md.push("");\n\
  md.push("| "+(isDE?"Datum":"Date")+" | Overhead | Output/h | Total/h | Subagent% |");\n\
  md.push("|------------|----------|----------|---------|-----------|");\n\
  for(var i=0;i<days.length;i++){var d=days[i];var tot=dayTotal(d);var ah=Math.max(1,d.active_hours||1);var oh=d.output>0?(tot/d.output).toFixed(0)+"x":"\\u2014";var sp=(d.sub_pct||0)+"%";md.push("| "+d.date+" | "+oh+" | "+fmt(Math.round(d.output/ah))+" | "+fmt(Math.round(tot/ah))+" | "+sp+" |");}\n\
  md.push("");\n\
\n\
  // 3. Subagent\n\
  md.push("## 3. "+(isDE?"Subagent-Analyse":"Subagent Analysis"));\n\
  md.push("");\n\
  md.push("| "+(isDE?"Datum":"Date")+" | "+(isDE?"Aufrufe":"Calls")+" | Sub | Sub-Cache | Sub-Cache% |");\n\
  md.push("|------------|--------|------|-----------|------------|");\n\
  for(var i=0;i<days.length;i++){var d=days[i];var sc=d.sub_cache||0;var scp=(d.sub_cache_pct||0)+"%";md.push("| "+d.date+" | "+d.calls+" | "+(d.sub_calls||0)+" | "+fmt(sc)+" | "+scp+" |");}\n\
  md.push("");\n\
\n\
  // 4. Budget estimate\n\
  if(limitDays.length>0 && peakDay){\n\
    md.push("## 4. "+(isDE?"Budget-Sch\\u00e4tzung":"Budget Estimate"));\n\
    md.push("");\n\
    md.push((isDE?"Impl@90% = Total / 0.9 (gesch\\u00e4tztes Budget wenn ~90% erreicht).":"Impl@90% = total / 0.9 (estimated budget if ~90% was reached)."));\n\
    md.push("");\n\
    md.push("| "+(isDE?"Datum":"Date")+" | Total | Impl@90% | vs Peak | "+(isDE?"Std.":"Hours")+" | "+(isDE?"Signal":"Signal")+" |");\n\
    md.push("|------------|---------|----------|---------|-------|--------|");\n\
    var prevI=0;\n\
    for(var li=0;li<limitDays.length;li++){var ld=limitDays[li];var tot=dayTotal(ld.d);var impl=Math.round(tot/0.9);var vsp=peakVal>0?(peakVal/impl).toFixed(1)+"x":"\\u2014";var trend="";if(prevI>0){var ch=Math.round(((impl-prevI)/prevI)*100);if(ch>5)trend=" \\u2191"+ch+"%";else if(ch<-5)trend=" \\u2193"+Math.abs(ch)+"%";else trend=" \\u2192";}prevI=impl;md.push("| "+ld.d.date+" | "+fmt(tot)+" | "+fmt(impl)+" | "+vsp+" | "+(ld.d.active_hours||0)+" | "+ld.flags.join(", ")+trend+" |");}\n\
\n\
    // Median\n\
    var ivs=[];\n\
    for(var li=0;li<limitDays.length;li++){var ld=limitDays[li];if(ld.d.calls>=50&&(ld.d.active_hours||0)>=2)ivs.push(Math.round(dayTotal(ld.d)/0.9));}\n\
    if(ivs.length>=2){\n\
      ivs.sort(function(a,b){return a-b;});\n\
      var med=ivs[Math.floor(ivs.length/2)];\n\
      md.push("");\n\
      md.push((isDE?"**Zusammenfassung** (":"**Summary** (")+ivs.length+(isDE?" aussagekr\\u00e4ftige Limit-Tage):":" meaningful limit days):"));\n\
      md.push("- Median Impl@90%: ~"+fmt(med));\n\
      md.push("- "+(isDE?"Bereich: ":"Range: ")+fmt(ivs[0])+" .. "+fmt(ivs[ivs.length-1]));\n\
      md.push("- Peak: "+fmt(peakVal)+" ("+peakDay.date+")");\n\
      if(med>0)md.push("- Peak / Median: "+(peakVal/med).toFixed(1)+"x");\n\
    }\n\
    md.push("");\n\
  }\n\
\n\
  // 5. Peak vs Limit comparison\n\
  if(peakDay && limitDays.length>0){\n\
    var bestLim=null;\n\
    for(var li=limitDays.length-1;li>=0;li--){var ld=limitDays[li];if(ld.d.calls>=50&&(ld.d.active_hours||0)>=2){bestLim=ld;break;}}\n\
    if(!bestLim)bestLim=limitDays[limitDays.length-1];\n\
    if(bestLim && bestLim.d.date!==peakDay.date){\n\
      md.push("## "+(isDE?"Fazit: Peak vs. Limit-Tag":"Conclusion: Peak vs. Limit Day"));\n\
      md.push("");\n\
      var tP=dayTotal(peakDay),tL=dayTotal(bestLim.d);\n\
      md.push("| | "+peakDay.date+" (Peak) | "+bestLim.d.date+" (Limit) |");\n\
      md.push("|---|---|---|");\n\
      md.push("| Output | "+fmt(peakDay.output)+" | "+fmt(bestLim.d.output)+" |");\n\
      md.push("| Cache Read | "+fmt(peakDay.cache_read)+" | "+fmt(bestLim.d.cache_read)+" |");\n\
      md.push("| Total | "+fmt(tP)+" | "+fmt(tL)+" |");\n\
      md.push("| "+(isDE?"Stunden":"Hours")+" | "+(peakDay.active_hours||0)+" | "+(bestLim.d.active_hours||0)+" |");\n\
      md.push("| Calls | "+peakDay.calls+" | "+bestLim.d.calls+" |");\n\
      var crP=peakDay.output>0?Math.round(peakDay.cache_read/peakDay.output):0;\n\
      var crL=bestLim.d.output>0?Math.round(bestLim.d.cache_read/bestLim.d.output):0;\n\
      md.push("| C:O Ratio | "+crP+"x | "+crL+"x |");\n\
      md.push("");\n\
      var impl=Math.round(tL/0.9);\n\
      var drop=impl>0?Math.round(tP/impl):0;\n\
      if(drop>1){\n\
        md.push("**"+(isDE?"Effektive Budget-Reduktion: ~":"Effective budget reduction: ~")+drop+"x**");\n\
        md.push("");\n\
      }\n\
    }\n\
  }\n\
\n\
  // ─── Service Impact: Work vs Outage mit ASCII-Bars ───\n\
  var hasAnyOutage=false;\n\
  for(var oi=0;oi<days.length;oi++){if((days[oi].outage_hours||0)>0){hasAnyOutage=true;break;}}\n\
  if(hasAnyOutage){\n\
    md.push("## "+(isDE?"Service Impact: Arbeitszeit vs. Ausfall":"Service Impact: Work vs. Outage"));\n\
    md.push("");\n\
    md.push((isDE?"Legende: ":"Legend: ")+"\\u2588 = "+(isDE?"saubere Arbeit":"clean work")+" | \\u2593 = "+(isDE?"Arbeit bei Ausfall":"work during outage")+" | \\u2591 = "+(isDE?"Ausfall (keine Arbeit)":"outage (no work)"));\n\
    md.push("");\n\
    // Berechne max Stunden fuer Skalierung\n\
    var maxH=0;\n\
    var svcRows=[];\n\
    for(var si=0;si<days.length;si++){\n\
      var sd=days[si];\n\
      var wHrs=Object.keys(sd.hours||{}).map(function(h){return parseInt(h);});\n\
      var spans=sd.outage_spans||[];\n\
      var affected=0;\n\
      for(var wi=0;wi<wHrs.length;wi++){\n\
        for(var oj=0;oj<spans.length;oj++){\n\
          if(wHrs[wi]>=Math.floor(spans[oj].from)&&wHrs[wi]<Math.ceil(spans[oj].to)){affected++;break;}\n\
        }\n\
      }\n\
      var outTotal=0;\n\
      for(var oj=0;oj<spans.length;oj++) outTotal+=spans[oj].to-spans[oj].from;\n\
      var clean=wHrs.length-affected;\n\
      var outOnly=Math.max(0,Math.round((outTotal-affected)*10)/10);\n\
      var totalH=clean+affected+outOnly;\n\
      if(totalH>maxH)maxH=totalH;\n\
      svcRows.push({date:sd.date,clean:clean,affected:affected,outOnly:outOnly,cr:sd.cache_read||0,co:sd.cache_output_ratio||0,outageH:sd.outage_hours||0,mc:sd.model_change});\n\
    }\n\
    var barW=40;\n\
    md.push("```");\n\
    for(var si=0;si<svcRows.length;si++){\n\
      var r=svcRows[si];\n\
      var totalH=r.clean+r.affected+r.outOnly;\n\
      if(totalH===0&&r.outageH===0) continue;\n\
      var scale=maxH>0?barW/maxH:1;\n\
      var bClean=Math.round(r.clean*scale);\n\
      var bAff=Math.round(r.affected*scale);\n\
      var bOut=Math.round(r.outOnly*scale);\n\
      var bar="";\n\
      for(var b=0;b<bClean;b++) bar+="\\u2588";\n\
      for(var b=0;b<bAff;b++) bar+="\\u2593";\n\
      for(var b=0;b<bOut;b++) bar+="\\u2591";\n\
      var label=r.date.slice(5)+" "+bar+" ";\n\
      if(r.affected>0) label+=r.clean+"h+"+(isDE?r.affected+"h Ausfall":r.affected+"h outage");\n\
      else label+=r.clean+"h";\n\
      if(r.outOnly>0) label+=" (+"+r.outOnly.toFixed(0)+"h "+(isDE?"nur Ausfall":"outage only")+")";\n\
      if(r.cr>0) label+=" | C:"+fmt(r.cr)+" ("+r.co+"x)";\n\
      if(r.mc){\n\
        if(r.mc.added&&r.mc.added.length) label+=" \\u25c7+"+r.mc.added.join(",");\n\
        if(r.mc.removed&&r.mc.removed.length) label+=" \\u25c7-"+r.mc.removed.join(",");\n\
      }\n\
      md.push(label);\n\
    }\n\
    md.push("```");\n\
    md.push("");\n\
    // Zusammenfassung\n\
    var totClean=0,totAff=0,totOutOnly=0;\n\
    for(var si=0;si<svcRows.length;si++){totClean+=svcRows[si].clean;totAff+=svcRows[si].affected;totOutOnly+=svcRows[si].outOnly;}\n\
    md.push((isDE?"**Gesamt:** ":"**Total:** ")+totClean+"h "+(isDE?"saubere Arbeit":"clean work")+" | "+totAff+"h "+(isDE?"Arbeit bei Ausfall":"work during outage")+" | "+Math.round(totOutOnly)+"h "+(isDE?"Ausfall ohne Arbeit":"outage without work"));\n\
    if(totAff>0&&(totClean+totAff)>0){\n\
      var pctAff=Math.round(totAff/(totClean+totAff)*100);\n\
      md.push((isDE?"**Betroffene Arbeitszeit: ":"**Affected work time: ")+pctAff+"%**");\n\
    }\n\
    md.push("");\n\
  }\n\
\n\
  // ─── Extension-Versionen & Releases ───\n\
  var hasVerChange=false;\n\
  for(var vi=0;vi<days.length;vi++){if(days[vi].version_change){hasVerChange=true;break;}}\n\
  if(hasVerChange){\n\
    md.push("## "+(isDE?"Extension-Updates (Claude Code)":"Extension Updates (Claude Code)"));\n\
    md.push("");\n\
    md.push("| "+(isDE?"Datum":"Date")+" | Version | Highlights |");\n\
    md.push("|------------|---------|------------|");\n\
    for(var vi=0;vi<days.length;vi++){\n\
      var vc=days[vi].version_change;\n\
      if(!vc)continue;\n\
      var ver=vc.added.join(", ");\n\
      if(vc.from)ver=vc.from+" \\u2192 "+ver;\n\
      var hl=(vc.highlights||[]).slice(0,3).join("; ");\n\
      if(hl.length>120)hl=hl.slice(0,117)+"...";\n\
      md.push("| "+days[vi].date+" | "+ver+" | "+hl+" |");\n\
    }\n\
    md.push("");\n\
  }\n\
\n\
  // ─── Thinking-Token Hinweis ───\n\
  md.push("> "+(isDE?"\\u26a0 **Hinweis:** Thinking-Tokens (internes Reasoning) erscheinen nicht in der API-Antwort und werden nicht gez\\u00e4hlt. Sie belasten wahrscheinlich das Session-Budget.":"\\u26a0 **Note:** Thinking tokens (internal reasoning) do not appear in the API response and are not counted here. They likely count against the session budget."));\n\
  md.push("");\n\
\n\
  md.push("---");\n\
  md.push((isDE?"*Alle Werte heuristisch \\u2014 kein offizieller API-Nachweis. Generiert vom Claude Usage Dashboard.*":"*All values are heuristic \\u2014 not official API proof. Generated by Claude Usage Dashboard.*"));\n\
  md.push("");\n\
  return md.join("\\n");\n\
}\n\
\n\
function openReportModal(){\n\
  if(!__lastUsageData||!__lastUsageData.days||!__lastUsageData.days.length)return;\n\
  var md=generateForensicReportMd(__lastUsageData);\n\
  document.getElementById("report-content").textContent=md;\n\
  document.getElementById("report-modal-title").textContent=t("reportTitle");\n\
  document.getElementById("report-copy-btn").textContent=t("reportCopy");\n\
  document.getElementById("report-download-btn").textContent=t("reportDownload");\n\
  document.getElementById("report-modal-overlay").classList.add("open");\n\
}\n\
function closeReportModal(){\n\
  document.getElementById("report-modal-overlay").classList.remove("open");\n\
}\n\
function downloadReport(){\n\
  var text=document.getElementById("report-content").textContent;\n\
  var blob=new Blob([text],{type:"text/markdown;charset=utf-8"});\n\
  var url=URL.createObjectURL(blob);\n\
  var a=document.createElement("a");\n\
  a.href=url;a.download="forensic-report-"+new Date().toISOString().slice(0,10)+".md";\n\
  document.body.appendChild(a);a.click();document.body.removeChild(a);URL.revokeObjectURL(url);\n\
}\n\
function copyReport(){\n\
  var text=document.getElementById("report-content").textContent;\n\
  navigator.clipboard.writeText(text).then(function(){\n\
    var btn=document.getElementById("report-copy-btn");\n\
    var orig=btn.textContent;btn.textContent=t("reportCopied");\n\
    setTimeout(function(){btn.textContent=orig;},1500);\n\
  });\n\
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
  var rbtn=document.getElementById("forensic-report-btn");\n\
  if(rbtn){rbtn.addEventListener("click",openReportModal);}\n\
  var rcl=document.getElementById("report-close-btn");\n\
  if(rcl){rcl.addEventListener("click",closeReportModal);}\n\
  var rdl=document.getElementById("report-download-btn");\n\
  if(rdl){rdl.addEventListener("click",downloadReport);}\n\
  var rcp=document.getElementById("report-copy-btn");\n\
  if(rcp){rcp.addEventListener("click",copyReport);}\n\
  var rov=document.getElementById("report-modal-overlay");\n\
  if(rov){rov.addEventListener("click",function(e){if(e.target===rov)closeReportModal();});}\n\
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
    host_labels: ['local'],
    state_paths: buildDashboardStatePaths()
  };
}

var cachedData = makeStubCachedData();
var sseClients = [];
var scanInProgress = false;
var scanQueued = false;
var marketplaceRefreshFollowupScanDone = false;

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
      var partial = buildUsageResult(state.daily, state.tagged.length, state.tagged, state.roots, {
        marketplaceRows: state.marketplaceRows
      });
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
    var scanOk = false;
    try {
      if (err) throw err;
      data.refresh_sec = REFRESH_SEC;
      data.scanning = false;
      delete data.scan_progress;
      if (data.scan_error) delete data.scan_error;
      cachedData = data;
      scanOk = true;
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
      if (scanOk && cachedData && cachedData.days && cachedData.days.length) {
        backfillReleaseBodiesForDashboardDays(cachedData.days, function () {
          cachedData.generated = new Date().toISOString();
          broadcastSse();
        });
      }
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
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      Pragma: 'no-cache'
    });
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
  console.log('Voller Scan alle ' + REFRESH_SEC + 's (--refresh=N, min 60; oder CLAUDE_USAGE_SCAN_INTERVAL_SEC)');
  console.log('Erster Scan läuft inkrementell (SSE-Updates, Zwischenstände); Seite sofort nutzbar.');
  console.log('Press Ctrl+C to stop.');
  refreshOutageCache();
  refreshReleasesCache();
  refreshMarketplaceExtensionCache();
  runScanAndBroadcast();
});

setInterval(runScanAndBroadcast, REFRESH_SEC * 1000);
setInterval(refreshOutageCache, OUTAGE_REFRESH_MS);
setInterval(refreshReleasesCache, 6 * 60 * 60 * 1000);
setInterval(refreshMarketplaceExtensionCache, 6 * 60 * 60 * 1000);
