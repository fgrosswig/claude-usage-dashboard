// Claude Code Token Usage Dashboard — standalone, zero dependencies (lädt Submodule aus diesem Ordner)
// Usage: node server.js [--port=3333] [--refresh=SEK] [--no-cache]   oder   node start.js dashboard [--no-cache]
// --refresh = voller Daten-Scan + SSE (Standard 180s, Minimum 60s). Kurze Werte lesen alle JSONL unnötig oft neu ein.
// CLAUDE_USAGE_WALK_SLICE=N (5–500): größer = schnellere Projektbaum-Ermittlung, kleiner = responsiver direkt nach Start (Default 40 readdir/Tick).
// Tages-Cache: ~/.claude/usage-dashboard-days.json (Vortage). Bei passender jsonl-Anzahl nur noch „heute“ aus JSONL.
// Vollscan erzwingen: CLAUDE_USAGE_NO_CACHE=1  oder  Cache-Datei löschen / neue .jsonl-Datei ändert die Anzahl.
// full_jsonl-Grund im Log: siehe scan-Zeile "day_cache_miss …". Identischen Scan überspringen (nur wenn JSONL mtimes unverändert): CLAUDE_USAGE_SKIP_IDENTICAL_SCAN=1
// Marketplace POST-Timeout ms: CLAUDE_USAGE_MARKETPLACE_TIMEOUT_MS (3000-120000, Default 12000).
// Backfill-Pause zwischen GitHub-Release-Tags ms: CLAUDE_USAGE_GITHUB_BACKFILL_DELAY_MS (0-5000, Default 0).
// Push JSONL ins Container-/PVC-Volume: POST /api/claude-data-sync (Body = gzip-Tar), Header Authorization: Bearer <CLAUDE_USAGE_SYNC_TOKEN>.
// Größe: CLAUDE_USAGE_SYNC_MAX_MB (Default 512). Client: scripts/claude-data-sync-client.js

var http = require('http');
var https = require('https');
var fs = require('fs');

// Resolve version from git tag at startup (no hardcoded version)
var __appVersion = (function () {
  try {
    // git tag --sort=-v:refname finds newest tag repo-wide (not just current branch)
    var tag = require('child_process').execSync('git tag --sort=-v:refname 2>/dev/null', { encoding: 'utf8' }).trim().split('\n')[0];
    if (tag) return tag;
  } catch (e) {}
  // In Docker (no git): read from VERSION file, or fallback
  try { return fs.readFileSync(require('path').join(__dirname, '..', 'VERSION'), 'utf8').trim(); } catch (e2) {}
  return 'dev';
})();
var path = require('path');
var os = require('os');
var dashboardHttp = require('./dashboard-http');
var usageScanRoots = require('./usage-scan-roots');
var HOME = usageScanRoots.HOME;
var BASE = usageScanRoots.BASE;
var getScanRoots = usageScanRoots.getScanRoots;
var scanRootsCacheKey = usageScanRoots.scanRootsCacheKey;
var walkJsonl = usageScanRoots.walkJsonl;
var collectTaggedJsonlFiles = usageScanRoots.collectTaggedJsonlFiles;
var collectTaggedJsonlFilesAsync = usageScanRoots.collectTaggedJsonlFilesAsync;
var forEachJsonlLineSync = usageScanRoots.forEachJsonlLineSync;
var getProxyLogDir = usageScanRoots.getProxyLogDir;
var collectProxyNdjsonFiles = usageScanRoots.collectProxyNdjsonFiles;
var serviceLog = require('./service-logger');
var claudeDataIngest = require('./claude-data-ingest');

/** Nach erfolgreichem Scan: Fingerprint aller JSONL (mtime+size); für optionalen Skip bei unveränderten Dateien. */
var __lastScanJsonlFingerprint = '';

function buildTaggedJsonlFingerprintSync(tagged) {
  var parts = [];
  for (var fi = 0; fi < tagged.length; fi++) {
    var ref = tagged[fi];
    var p = typeof ref === 'string' ? ref : ref.path;
    var abs = path.resolve(p);
    try {
      var st = fs.statSync(abs);
      parts.push(abs + ':' + st.mtimeMs + ':' + st.size);
    } catch (eSt) {
      parts.push(abs + ':err');
    }
  }
  parts.sort();
  return parts.join('\n');
}

var PORT = 3333;
var REFRESH_SEC = 180;
(function () {
  var e = process.env.CLAUDE_USAGE_SCAN_INTERVAL_SEC;
  if (!e) return;
  var n = parseInt(e, 10);
  if (!isNaN(n) && n >= 60) REFRESH_SEC = n;
})();
/** Erster JSONL-Scan erst nach dieser Verzögerung (ms), wenn Shell+Assets vorgeladen sind — damit Browser zuerst HTML/CSS/JS bedienen kann. 0–120000, Default 2000. */
var PARSE_START_DELAY_MS = 2000;
(function () {
  var e = process.env.CLAUDE_USAGE_PARSE_START_DELAY_MS;
  if (!e) return;
  var n = parseInt(e, 10);
  if (!isNaN(n) && n >= 0 && n <= 120000) PARSE_START_DELAY_MS = n;
})();
process.argv.forEach(function(a) {
  var m = a.match(/--port=(\d+)/);
  if (m) PORT = parseInt(m[1]);
  var r = a.match(/--refresh=(\d+)/);
  if (r) REFRESH_SEC = Math.max(60, parseInt(r[1]));
  var lv = a.match(/--log-level=(.+)$/);
  if (lv) process.env.CLAUDE_USAGE_LOG_LEVEL = lv[1].trim();
  var lf = a.match(/--log-file=(.+)$/);
  if (lf) process.env.CLAUDE_USAGE_LOG_FILE = lf[1].trim();
  if (a === '--no-cache') process.env.CLAUDE_USAGE_NO_CACHE = '1';
});
serviceLog.refreshFromEnv();

// Vor-Tage als ein JSON (unter ~/.claude); JSONL wird nur noch für den lokalen Kalendertag „heute” voll geparst.
var USAGE_DAY_CACHE_VERSION = 7; // bumped: entrypoints per version in version_stats
var USAGE_DAY_CACHE_FILE = path.join(HOME, '.claude', 'usage-dashboard-days.json');
/** Pro-Datei-Beitrag zum lokalen „heute“ (mtime+size): vermeidet 300+ JSONL bei jedem Refresh. */
var JSONL_TODAY_INDEX_VERSION = 1;
var JSONL_TODAY_INDEX_FILE = path.join(HOME, '.claude', 'usage-dashboard-jsonl-today-index.json');
var TODAY_INDEX_DISABLED =
  process.env.CLAUDE_USAGE_NO_TODAY_INDEX === '1' || process.env.CLAUDE_USAGE_NO_TODAY_INDEX === 'true';

// ── Anthropic Outage Data (status.claude.com) ─────────────────────────────
var OUTAGE_API_URL = 'https://status.claude.com/api/v2/incidents.json';
var OUTAGE_REFRESH_MS = 5 * 60 * 1000;
var OUTAGE_DISK_CACHE = path.join(HOME, '.claude', 'usage-dashboard-outages.json');
var RELEASES_CACHE = path.join(HOME, '.claude', 'claude-code-releases.json');
var RELEASES_API_URL = 'https://api.github.com/repos/anthropics/claude-code/releases?per_page=100';
/** Zuletzt vom Browser gesetztes PAT (Header X-GitHub-Token auf /api/*); `null` = noch kein Header gesehen. */
var lastClientGithubToken = null;

function syncGithubTokenFromBrowserRequest(req) {
  if (!req.headers || typeof req.headers['x-github-token'] === 'undefined') return;
  var prev = lastClientGithubToken;
  var next = String(req.headers['x-github-token'] || '').trim();
  lastClientGithubToken = next;
  var had = prev !== null && prev.length > 0;
  var has = next.length > 0;
  if (!had && has) {
    serviceLog.info('github', 'Client-Session: GitHub-PAT über X-GitHub-Token aktiv (Wert nicht geloggt)');
  } else if (had && !has) {
    serviceLog.info('github', 'Client-Session: GitHub-PAT entfernt (leerer X-GitHub-Token), Fallback GITHUB_TOKEN/GH_TOKEN');
  } else if (had && has && prev !== next) {
    serviceLog.info('github', 'Client-Session: GitHub-PAT ersetzt (neuer Wert, nicht geloggt)');
  }
}

/** PAT: 5000 req/h statt ~60/IP. Priorität: Browser-Header X-GitHub-Token, sonst GITHUB_TOKEN/GH_TOKEN. */
function githubApiRequestHeaders() {
  var h = {
    'User-Agent': 'claude-usage-dashboard/1.0 (Claude Code usage dashboard; +https://github.com/anthropics/claude-code)',
    Accept: 'application/vnd.github+json'
  };
  var tok = '';
  if (lastClientGithubToken !== null && lastClientGithubToken.length > 0) {
    tok = lastClientGithubToken;
  } else {
    var envT = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
    if (envT && String(envT).trim()) tok = String(envT).trim();
  }
  if (tok) h.Authorization = 'Bearer ' + tok;
  return h;
}
// VS Code Marketplace (offizielle Extension-Version History) — API-Flag 0x1 = alle Versionen; 0x200 würde auf „nur letzte“ kürzen.
var MARKETPLACE_CACHE = path.join(HOME, '.claude', 'claude-code-marketplace-versions.json');
var MARKETPLACE_QUERY_URL = 'https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery';
var MARKETPLACE_EXTENSION_ID = 'anthropic.claude-code';
var MARKETPLACE_QUERY_FLAGS = 0x1;
/** POST extensionquery: Standard 12s; Env 3000-120000. */
var MARKETPLACE_POST_TIMEOUT_MS = 12000;
(function () {
  var e = process.env.CLAUDE_USAGE_MARKETPLACE_TIMEOUT_MS;
  if (!e) return;
  var n = parseInt(e, 10);
  if (!isNaN(n) && n >= 3000 && n <= 120000) MARKETPLACE_POST_TIMEOUT_MS = n;
})();
/** Pause zwischen GitHub-Release-Backfill-Requests (ms), 0-5000. */
var GITHUB_BACKFILL_TAG_DELAY_MS = 0;
(function () {
  var e = process.env.CLAUDE_USAGE_GITHUB_BACKFILL_DELAY_MS;
  if (!e) return;
  var n = parseInt(e, 10);
  if (!isNaN(n) && n >= 0 && n <= 5000) GITHUB_BACKFILL_TAG_DELAY_MS = n;
})();

var marketplaceQueryInFlight = false;
var releasesRefreshInFlight = false;

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
    headers: githubApiRequestHeaders()
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
  serviceLog.info('github', 'backfill missing_release_tags=' + missing.length);
  var ix = 0;
  function step() {
    if (ix >= missing.length) {
      persistReleasesCacheToDisk();
      enrichVersionChangeNotes(days);
      serviceLog.info('github', 'backfill done total_releases_cache=' + releasesCache.releases.length);
      cb();
      return;
    }
    var t = missing[ix++];
    if (!isSafeGithubReleaseTagParam(t)) {
      setImmediate(step);
      return;
    }
    serviceLog.debug('github', 'backfill release tag=' + t);
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
      if (GITHUB_BACKFILL_TAG_DELAY_MS > 0) {
        setTimeout(step, GITHUB_BACKFILL_TAG_DELAY_MS);
      } else {
        setImmediate(step);
      }
    });
  }
  step();
}

function refreshReleasesCache() {
  if (releasesRefreshInFlight) {
    serviceLog.debug('releases', 'fetch skip: in flight');
    return;
  }
  releasesRefreshInFlight = true;
  serviceLog.debug('releases', 'fetch start');
  var all = [];
  var page = 1;
  var maxPages = 5;
  function fetchNext() {
    var sep = RELEASES_API_URL.indexOf('?') >= 0 ? '&' : '?';
    var url = RELEASES_API_URL + sep + 'page=' + page;
    httpsGetJson(url, function (err, data) {
      if (err || !Array.isArray(data) || data.length === 0) {
        if (page === 1 && err) {
          var hasTok =
            (lastClientGithubToken && lastClientGithubToken.length > 0) ||
            process.env.GITHUB_TOKEN ||
            process.env.GH_TOKEN;
          var relHint = hasTok
            ? ''
            : ' — bei Rate-Limit: PAT im Dashboard (Meta) oder GITHUB_TOKEN/GH_TOKEN (klassisch: repo:public nur nötig).';
          serviceLog.warn('releases', 'GitHub API: ' + err.message + relHint);
        } else if (page === 1 && !err && (!data || !data.length)) {
          serviceLog.warn('releases', 'GitHub API: leeres Array — kein Update');
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
    if (!all.length) {
      releasesRefreshInFlight = false;
      serviceLog.debug('releases', 'fetch end no_new_rows (GitHub)');
      return;
    }
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
    serviceLog.info(
      'releases',
      'GitHub merge OK unique_tags≈' +
        Object.keys(seen).length +
        ' pages_read≤' +
        page +
        ' disk=' +
        RELEASES_CACHE.replace(/^.*[\\/].claude[\\/]/i, '~/.claude/')
    );
    releasesRefreshInFlight = false;
  }
  fetchNext();
}

/** GitHub-Releases: nur Netzwerk, wenn kein Disk-Cache — sonst manuell POST /api/github-releases-refresh oder CLAUDE_USAGE_GITHUB_RELEASES_FETCH=1. */
function shouldFetchGithubReleasesFromNetwork() {
  var force =
    process.env.CLAUDE_USAGE_GITHUB_RELEASES_FETCH === '1' ||
    process.env.CLAUDE_USAGE_GITHUB_RELEASES_FETCH === 'true' ||
    process.env.CLAUDE_USAGE_GITHUB_RELEASES_FETCH === 'force';
  if (force) return true;
  return !releasesCache.releases || releasesCache.releases.length === 0;
}

function maybeRefreshReleasesCacheOnStartup() {
  if (shouldFetchGithubReleasesFromNetwork()) {
    refreshReleasesCache();
  } else {
    serviceLog.info(
      'releases',
      'GitHub fetch übersprungen (' +
        releasesCache.releases.length +
        ' Releases aus ~/.claude/claude-code-releases.json); manuell: POST /api/github-releases-refresh oder start mit CLAUDE_USAGE_GITHUB_RELEASES_FETCH=1'
    );
  }
}

/** "v2.1.87", "2.1.87", "…2.1.87…" -> "2.1.87" (GitHub-Release-Keys) */
function normalizeCliSemver(s) {
  if (s == null || s === '') return '';
  var m = String(s).match(/\d{1,10}\.\d{1,10}\.\d{1,10}/);
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
    var ln = lines[li].replace(/^[ \t>*\-•]+/, '').trim();
    if (!ln || ln.length < 6) continue;
    if (/^#{1,6}\s/.test(ln)) break;
    if (/^---+(\s|$)|^\*{3,}(\s|$)/.test(ln)) continue;
    if (/^(full changelog|see also)\b/i.test(ln)) continue;
    if (/^assets[\s\d]*$/i.test(ln)) continue;
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

/** Entrypoint aus JSONL-Zeile (Top-Level-Feld in system/assistant-Records). */
function extractEntrypoint(rec) {
  if (!rec || typeof rec !== 'object') return '';
  return rec.entrypoint || '';
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

/**
 * Marketplace + GitHub-Zeitleiste für GET /api/extension-timeline (ohne JSONL).
 * by_date enthält pro Kalendertag dasselbe version_change wie nach enrichVersionChangeNotes.
 */
function buildExtensionTimelineApiResponse() {
  var items = buildMergedExtensionTimelineItems();
  var byDateRaw = buildByDateFromVersionTimelineItems(items);
  var byDateOut = Object.create(null);
  if (byDateRaw) {
    var keys = Object.keys(byDateRaw).sort();
    var synthetic = [];
    for (var i = 0; i < keys.length; i++) {
      var dk = keys[i];
      var ch = byDateRaw[dk];
      var bw = ch.booking_when || '';
      synthetic.push({
        date: dk,
        version_change: {
          added: ch.added.slice(),
          from: ch.from,
          highlights: (ch.highlights || []).slice(),
          release_when: bw,
          release_utc_ymd: bw ? isoToUtcYmd(bw) : '',
          release_local_ymd: bw ? isoToLocalYmd(bw) : ''
        }
      });
    }
    enrichVersionChangeNotes(synthetic);
    for (var j = 0; j < synthetic.length; j++) {
      var row = synthetic[j];
      if (row.version_change) byDateOut[row.date] = row.version_change;
    }
  }
  return {
    generated: new Date().toISOString(),
    marketplace_fetched_at: marketplaceVersionsCache.fetchedAt
      ? new Date(marketplaceVersionsCache.fetchedAt).toISOString()
      : null,
    marketplace_rows: marketplaceVersionsCache.items ? marketplaceVersionsCache.items.length : 0,
    releases_cached: releasesCache.releases ? releasesCache.releases.length : 0,
    by_date: byDateOut
  };
}

/** Fuellt version_change aus JSONL-Versionsprung wenn Timeline keine Buchung hat. */
function applyJsonlGapVersionChanges(result) {
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
 * GET + JSON. GitHub: githubApiRequestHeaders(); optional GITHUB_TOKEN / GH_TOKEN gegen Rate-Limit.
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
    var gh = githubApiRequestHeaders();
    var gk = Object.keys(gh);
    for (var gi = 0; gi < gk.length; gi++) headers[gk[gi]] = gh[gk[gi]];
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

function httpsPostJson(postUrl, jsonBody, cb, timeoutMs) {
  var parsed;
  try {
    parsed = new URL(postUrl);
  } catch (e) {
    cb(e, null);
    return;
  }
  var tMs = typeof timeoutMs === 'number' && timeoutMs > 0 ? timeoutMs : 15000;
  var finished = false;
  function done(err, data) {
    if (finished) return;
    finished = true;
    cb(err, data);
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
          done(new Error('HTTP ' + res.statusCode), null);
          return;
        }
        done(null, JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (e) {
        done(e, null);
      }
    });
  });
  req.on('error', function (e) {
    done(e, null);
  });
  req.setTimeout(tMs, function () {
    req.destroy();
    done(new Error('timeout'), null);
  });
  req.write(body);
  req.end();
}

function refreshMarketplaceExtensionCache() {
  if (marketplaceQueryInFlight) {
    serviceLog.debug('marketplace', 'extensionquery skip: in flight');
    return;
  }
  marketplaceQueryInFlight = true;
  serviceLog.debug('marketplace', 'extensionquery start');
  var payload = {
    filters: [{ criteria: [{ filterType: 7, value: MARKETPLACE_EXTENSION_ID }], pageNumber: 1, pageSize: 1 }],
    flags: MARKETPLACE_QUERY_FLAGS
  };
  httpsPostJson(
    MARKETPLACE_QUERY_URL,
    payload,
    function (err, data) {
      try {
        if (err || !data || !data.results || !data.results[0] || !data.results[0].extensions || !data.results[0].extensions[0]) {
          if (err) {
            serviceLog.warn('marketplace', 'extensionquery failed: ' + (err.message || err));
          } else {
            serviceLog.warn('marketplace', 'extensionquery empty response');
          }
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
          serviceLog.info(
            'marketplace',
            'OK versions=' +
              deduped.length +
              ' extension=' +
              MARKETPLACE_EXTENSION_ID +
              ' disk=' +
              MARKETPLACE_CACHE.replace(/^.*[\/].claude[\/]/i, '~/.claude/')
          );
        } catch (we) {
          serviceLog.error('marketplace', 'write cache failed: ' + (we.message || we));
        }
        if (deduped.length) reapplyExtensionMarkersOnCachedDataAndBroadcast('marketplace_cache_refresh');
      } finally {
        marketplaceQueryInFlight = false;
      }
    },
    MARKETPLACE_POST_TIMEOUT_MS
  );
}

function refreshOutageCache() {
  serviceLog.debug('outage', 'GET status.claude.com');
  httpsGetJson(OUTAGE_API_URL, function (err, data) {
    if (err) {
      outageCache.error = err.message || String(err);
      serviceLog.error('outage', 'fetch failed: ' + outageCache.error);
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
        serviceLog.info(
          'outage',
          'OK incidents=' + data.incidents.length + ' disk=~/.claude/usage-dashboard-outages.json'
        );
      } catch (we) {
        serviceLog.error('outage', 'disk write failed: ' + (we.message || we));
      }
    } else {
      serviceLog.warn('outage', 'response ohne incidents-Array');
    }
  });
}

/** Klassifiziert Incident: "server" (API/Model-Fehler → Retries) vs "client" (Desktop/UI-Bug → kein Token-Impact). */
function classifyIncident(name, impact) {
  if (impact === 'none') return 'client';
  var n = (name || '').toLowerCase();
  if (n.indexOf('desktop') >= 0) return 'client';
  if (n.indexOf('dispatch') >= 0) return 'client';
  if (n.indexOf('cowork') >= 0) return 'client';
  if (n.indexOf('connector') >= 0) return 'client';
  return 'server';
}

/** Worst component status from incident_updates: major_outage > partial_outage > degraded_performance > operational */
var _statusRank = { major_outage: 3, partial_outage: 2, degraded_performance: 1, operational: 0 };
var _impactToStatus = { critical: 'major_outage', major: 'partial_outage', minor: 'degraded_performance', none: 'operational' };
function worstComponentStatus(inc) {
  var worst = 'operational';
  var hasComps = false;
  var updates = inc.incident_updates || [];
  for (var u = 0; u < updates.length; u++) {
    var comps = updates[u].affected_components || [];
    for (var c = 0; c < comps.length; c++) {
      hasComps = true;
      var s = comps[c].new_status || comps[c].old_status || 'operational';
      if ((_statusRank[s] || 0) > (_statusRank[worst] || 0)) worst = s;
    }
  }
  // Fallback: no component data → derive from impact severity
  if (!hasComps) worst = _impactToStatus[inc.impact || 'none'] || 'degraded_performance';
  return worst;
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
      var incImpact = inc.impact || 'none';
      var incKind = classifyIncident(inc.name, incImpact);
      var incCompStatus = worstComponentStatus(inc);
      map[dayStr].outage_hours += hours;
      if (incKind === 'server') map[dayStr].server_hours += hours;
      else map[dayStr].client_hours += hours;
      map[dayStr].spans.push({ from: Math.round(startH * 100) / 100, to: Math.round(endH * 100) / 100, name: inc.name || '', impact: incImpact, kind: incKind, comp_status: incCompStatus });
      // Incident-Name nur einmal pro Tag
      var found = false;
      for (var fi = 0; fi < map[dayStr].incidents.length; fi++) {
        if (map[dayStr].incidents[fi].name === inc.name) { found = true; break; }
      }
      if (!found) map[dayStr].incidents.push({ name: inc.name || '', impact: incImpact, kind: incKind, created_at: inc.created_at, resolved_at: inc.resolved_at || null });
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
// getScanRoots / collectTaggedJsonlFiles / walkJsonl: ./usage-scan-roots.js

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

// Wie scripts/token-forensics.js (Tagesübersicht): sehr hoher Cache-Read → „?“
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
      'Cache read \u2265500M (wie token-forensics CLI) \u2014 starkes Session-/Cache-Signal m\u00f6glich.';
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

// Pro Tick: Balance aus Scan-Durchsatz vs. HTTP/SSE-Responsivität. Jede Datei wird in einem Rutsch
// synchron gelesen (forEachJsonlLineSync); zu viele Dateien pro Tick blockiert die Event-Loop —
// dann verzögern sich z. B. dashboard.css / dashboard.client.js (fs.readFile-Callbacks warten).
// Schnellerer Vollscan bei Bedarf: CLAUDE_USAGE_SCAN_FILES_PER_TICK=20 (max. 80).
var SCAN_FILES_PER_TICK = 3;
(function () {
  var e = process.env.CLAUDE_USAGE_SCAN_FILES_PER_TICK;
  if (!e) return;
  var n = parseInt(e, 10);
  if (!isNaN(n) && n >= 1 && n <= 80) SCAN_FILES_PER_TICK = n;
})();
/** Mindestabstand zwischen teuren buildUsageResult-Zwischenständen (SSE), Standard ~1,5s. */
var SCAN_PARTIAL_EMIT_MIN_MS = 1500;
(function () {
  var e = process.env.CLAUDE_USAGE_SCAN_PARTIAL_MIN_MS;
  if (!e) return;
  var n = parseInt(e, 10);
  if (!isNaN(n) && n >= 400 && n <= 60000) SCAN_PARTIAL_EMIT_MIN_MS = n;
})();

function pad2(n) {
  return n < 10 ? '0' + n : String(n);
}

function localCalendarTodayStr() {
  var d = new Date();
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}

function buildDashboardStatePaths() {
  return {
    day_cache: displayPathForUi(USAGE_DAY_CACHE_FILE),
    jsonl_today_index: displayPathForUi(JSONL_TODAY_INDEX_FILE),
    releases: displayPathForUi(RELEASES_CACHE),
    marketplace: displayPathForUi(MARKETPLACE_CACHE),
    outage: displayPathForUi(OUTAGE_DISK_CACHE)
  };
}

function emptySessionSignals() {
  return { continue: 0, resume: 0, retry: 0, interrupt: 0, truncated: 0 };
}

function bumpSessionSignals(bucket, tagList) {
  if (!bucket.session_signals) bucket.session_signals = emptySessionSignals();
  var sig = bucket.session_signals;
  for (var ti = 0; ti < tagList.length; ti++) {
    var k = tagList[ti];
    if (sig[k] != null) sig[k]++;
  }
}

/** Session-Signale nach JSONL-Stunde (0–23) — gleiche Zeitleiste wie usage hours. */
function bumpHourSessionSignals(bucket, hourKeyStr, tagList) {
  if (!hourKeyStr || !tagList || !tagList.length) return;
  if (!bucket.hour_signals) bucket.hour_signals = {};
  if (!bucket.hour_signals[hourKeyStr]) bucket.hour_signals[hourKeyStr] = emptySessionSignals();
  var sig = bucket.hour_signals[hourKeyStr];
  for (var ti = 0; ti < tagList.length; ti++) {
    var k = tagList[ti];
    if (sig[k] != null) sig[k]++;
  }
}

function mergeHourSignalsInto(dst, src) {
  if (!src || typeof src !== 'object') return;
  if (!dst.hour_signals) dst.hour_signals = {};
  var ks = Object.keys(src);
  for (var i = 0; i < ks.length; i++) {
    var k = ks[i];
    var sk = src[k];
    if (!sk || typeof sk !== 'object') continue;
    if (!dst.hour_signals[k]) dst.hour_signals[k] = emptySessionSignals();
    var dk = dst.hour_signals[k];
    dk.continue += sk.continue || 0;
    dk.resume += sk.resume || 0;
    dk.retry += sk.retry || 0;
    dk.interrupt += sk.interrupt || 0;
  }
}

function unionHourKeyCount(hoursObj, hourSignalsObj) {
  var m = {};
  var k;
  for (k in hoursObj || {}) if (Object.prototype.hasOwnProperty.call(hoursObj, k)) m[k] = true;
  for (k in hourSignalsObj || {})
    if (Object.prototype.hasOwnProperty.call(hourSignalsObj, k)) m[k] = true;
  return Object.keys(m).length;
}

/** Heuristik auf Rohzeile + Objekt: --continue/--resume, Retry/429, Interrupt (siehe Community-JSONL-Analysen). */
function classifyJsonlSessionSignals(line, rec) {
  var tags = [];
  var seen = Object.create(null);
  function add(tag) {
    if (!seen[tag]) {
      seen[tag] = true;
      tags.push(tag);
    }
  }
  var lower = String(line).toLowerCase();
  if (/(?:^|[^\w-])--continue(?:[^\w-]|$)/.test(lower) || /["']--continue["']/.test(line)) {
    add('continue');
  }
  if (/(?:^|[^\w-])--resume(?:[^\w-]|$)/.test(lower) || /["']--resume["']/.test(line)) {
    add('resume');
  }
  if (
    /user_cancel|user_cancelled|user\s*interrupt|interrupted|unterbrochen|stream\s*abort|cancellation|cancelled\s*request/.test(
      lower
    )
  ) {
    add('interrupt');
  }
  if (rec && rec.message && rec.message.stop_reason) {
    var sr = String(rec.message.stop_reason).toLowerCase();
    if (sr.indexOf('cancel') >= 0 || sr === 'user_abort') add('interrupt');
  }
  if (/retrying|will\s*retry|retries\s+exhausted|exponential\s*backoff|auto-?retry|retry\s+attempt/.test(lower)) {
    add('retry');
  }
  if (/\b429\b/.test(lower) && /retry|rate|limit|overloaded|throttl|too\s+many/.test(lower)) {
    add('retry');
  }
  if (rec && rec.error) {
    try {
      var ej = JSON.stringify(rec.error).toLowerCase();
      if (/retry|429|rate|throttl|overloaded/.test(ej)) add('retry');
      if (/interrupt|cancel|abort/.test(ej)) add('interrupt');
    } catch (eJ) {}
  }
  // B5: Tool result truncation
  if (/["']is_truncated["']\s*:\s*true|["']truncated["']\s*:\s*true/.test(line)) {
    add('truncated');
  }
  // API error (system records with subtype api_error or error field)
  if (rec?.type === 'system' && rec?.subtype === 'api_error') {
    add('api_error');
  }
  return tags;
}

function emptyVersionStats() {
  return { calls: 0, output: 0, cache_read: 0, hit_limit: 0, retry: 0, interrupt: 0, continue: 0, resume: 0, truncated: 0, api_error: 0, entrypoints: {} };
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
    hour_signals: {},
    hit_limit: 0,
    session_signals: emptySessionSignals(),
    stop_reasons: {}
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
    hour_signals: {},
    models: {},
    versions: {},
    entrypoints: {},
    version_stats: {},
    hit_limit: 0,
    hosts: {},
    session_signals: emptySessionSignals(),
    stop_reasons: {}
  };
}

function mergeHoursInto(dst, src) {
  if (!src || typeof src !== 'object') return;
  var ks = Object.keys(src);
  for (var i = 0; i < ks.length; i++) {
    var k = ks[i];
    dst[k] = (dst[k] || 0) + (src[k] || 0);
  }
}

function mergeTopSessionSignalsInto(bucket, srcSs) {
  if (!srcSs || typeof srcSs !== 'object') return;
  if (!bucket.session_signals) bucket.session_signals = emptySessionSignals();
  var d = bucket.session_signals;
  d.continue += srcSs.continue || 0;
  d.resume += srcSs.resume || 0;
  d.retry += srcSs.retry || 0;
  d.interrupt += srcSs.interrupt || 0;
  d.truncated += srcSs.truncated || 0;
}

function mergeHostSliceInto(dst, src) {
  if (!src || typeof src !== 'object') return;
  dst.input += src.input || 0;
  dst.output += src.output || 0;
  dst.cache_read += src.cache_read || 0;
  dst.cache_creation += src.cache_creation || 0;
  dst.calls += src.calls || 0;
  dst.sub_calls += src.sub_calls || 0;
  dst.sub_cache += src.sub_cache || 0;
  dst.sub_output += src.sub_output || 0;
  dst.hit_limit += src.hit_limit || 0;
  mergeHoursInto(dst.hours || (dst.hours = {}), src.hours);
  mergeHourSignalsInto(dst, src.hour_signals);
  mergeTopSessionSignalsInto(dst, src.session_signals);
  mergeStopReasons(dst, src);
}

function mergeStopReasons(dst, src) {
  if (!src.stop_reasons) return;
  if (!dst.stop_reasons) dst.stop_reasons = {};
  var sk = Object.keys(src.stop_reasons);
  for (var si = 0; si < sk.length; si++) {
    dst.stop_reasons[sk[si]] = (dst.stop_reasons[sk[si]] || 0) + (src.stop_reasons[sk[si]] || 0);
  }
}

/** Additiver Merge: ''heute''-Fragmente aus mehreren JSONL in einen Tages-Bucket (today_nly + Index). */
function mergeDayBucketInto(target, src) {
  if (!src || typeof src !== 'object') return;
  target.input += src.input || 0;
  target.output += src.output || 0;
  target.cache_read += src.cache_read || 0;
  target.cache_creation += src.cache_creation || 0;
  target.calls += src.calls || 0;
  target.sub_calls += src.sub_calls || 0;
  target.sub_cache += src.sub_cache || 0;
  target.sub_output += src.sub_output || 0;
  target.hit_limit += src.hit_limit || 0;
  mergeHoursInto(target.hours || (target.hours = {}), src.hours);
  mergeHourSignalsInto(target, src.hour_signals);
  mergeTopSessionSignalsInto(target, src.session_signals);
  mergeStopReasons(target, src);
  var hk = Object.keys(src.hosts || {});
  for (var hi = 0; hi < hk.length; hi++) {
    var lab = hk[hi];
    if (!target.hosts[lab]) target.hosts[lab] = emptyHostSlice();
    mergeHostSliceInto(target.hosts[lab], src.hosts[lab]);
  }
  var mk = Object.keys(src.models || {});
  for (var mi = 0; mi < mk.length; mi++) {
    var m = mk[mi];
    var sm = src.models[m];
    if (!sm || typeof sm !== 'object') continue;
    if (!target.models[m]) target.models[m] = { calls: 0, output: 0, cache_read: 0 };
    target.models[m].calls += sm.calls || 0;
    target.models[m].output += sm.output || 0;
    target.models[m].cache_read += sm.cache_read || 0;
  }
  var vk = Object.keys(src.versions || {});
  for (var vi = 0; vi < vk.length; vi++) {
    var v = vk[vi];
    target.versions[v] = (target.versions[v] || 0) + (src.versions[v] || 0);
  }
  var epKeys = Object.keys(src.entrypoints || {});
  for (var ei = 0; ei < epKeys.length; ei++) {
    target.entrypoints[epKeys[ei]] = (target.entrypoints[epKeys[ei]] || 0) + (src.entrypoints[epKeys[ei]] || 0);
  }
  mergeVersionStatsInto(target, src.version_stats);
}

function mergeEntrypointsInto(tgt, srcEntrypoints) {
  if (!tgt.entrypoints) tgt.entrypoints = {};
  var ekKeys = Object.keys(srcEntrypoints || {});
  for (var eki = 0; eki < ekKeys.length; eki++) {
    tgt.entrypoints[ekKeys[eki]] = (tgt.entrypoints[ekKeys[eki]] || 0) + (srcEntrypoints[ekKeys[eki]] || 0);
  }
}

function mergeVersionStatsInto(target, srcVersionStats) {
  if (!srcVersionStats) return;
  if (!target.version_stats) target.version_stats = {};
  var vsKeys = Object.keys(srcVersionStats);
  for (var vsi = 0; vsi < vsKeys.length; vsi++) {
    var vsKey = vsKeys[vsi];
    if (!target.version_stats[vsKey]) target.version_stats[vsKey] = emptyVersionStats();
    var tgt = target.version_stats[vsKey];
    var srcVs = srcVersionStats[vsKey];
    var fKeys = Object.keys(srcVs);
    for (var fki = 0; fki < fKeys.length; fki++) { var f = fKeys[fki];
      if (f === 'entrypoints') {
        mergeEntrypointsInto(tgt, srcVs.entrypoints);
      } else {
        tgt[f] = (tgt[f] || 0) + (srcVs[f] || 0);
      }
    }
  }
}

function readJsonlTodayIndexDisk() {
  try {
    return JSON.parse(fs.readFileSync(JSONL_TODAY_INDEX_FILE, 'utf8'));
  } catch (e) {
    return null;
  }
}

function writeJsonlTodayIndexDisk(payload) {
  var dir = path.dirname(JSONL_TODAY_INDEX_FILE);
  try {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  } catch (e0) {}
  var tmp = JSONL_TODAY_INDEX_FILE + '.tmp';
  var body = JSON.stringify(payload);
  fs.writeFileSync(tmp, body, 'utf8');
  try {
    fs.renameSync(tmp, JSONL_TODAY_INDEX_FILE);
  } catch (e1) {
    fs.writeFileSync(JSONL_TODAY_INDEX_FILE, body, 'utf8');
  }
}

function invalidateJsonlTodayIndexDisk() {
  try {
    if (fs.existsSync(JSONL_TODAY_INDEX_FILE)) fs.unlinkSync(JSONL_TODAY_INDEX_FILE);
  } catch (e) {}
}

function hostSliceFromRow(h) {
  if (!h || typeof h !== 'object') return emptyHostSlice();
  var ss = h.session_signals && typeof h.session_signals === 'object' ? h.session_signals : null;
  var base = emptyHostSlice();
  if (ss) {
    base.session_signals.continue = ss.continue || 0;
    base.session_signals.resume = ss.resume || 0;
    base.session_signals.retry = ss.retry || 0;
    base.session_signals.interrupt = ss.interrupt || 0;
    base.session_signals.truncated = ss.truncated || 0;
  }
  var hsRow = h.hour_signals && typeof h.hour_signals === 'object' ? h.hour_signals : {};
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
    hour_signals: hsRow,
    hit_limit: h.hit_limit || 0,
    session_signals: base.session_signals
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
  var ss0 = row.session_signals && typeof row.session_signals === 'object' ? row.session_signals : null;
  var sigRow = emptySessionSignals();
  if (ss0) {
    sigRow.continue = ss0.continue || 0;
    sigRow.resume = ss0.resume || 0;
    sigRow.retry = ss0.retry || 0;
    sigRow.interrupt = ss0.interrupt || 0;
    sigRow.truncated = ss0.truncated || 0;
  }
  var hourSigRow = row.hour_signals && typeof row.hour_signals === 'object' ? row.hour_signals : {};
  var stopR = row.stop_reasons && typeof row.stop_reasons === 'object' ? row.stop_reasons : {};
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
    hour_signals: hourSigRow,
    models: row.models && typeof row.models === 'object' ? row.models : {},
    versions: versNorm,
    entrypoints: row.entrypoints && typeof row.entrypoints === 'object' ? row.entrypoints : {},
    version_stats: row.version_stats && typeof row.version_stats === 'object' ? row.version_stats : {},
    hit_limit: row.hit_limit || 0,
    hosts: hosts,
    session_signals: sigRow,
    stop_reasons: stopR
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
// isolateTodayFrag: wenn gesetzt und day===onlyDate, Aggregation nur dort (für today-Index / Merge).
function targetDayBucket(daily, dayKey, onlyDate, isolateTodayFrag) {
  if (isolateTodayFrag && onlyDate && dayKey === onlyDate) return isolateTodayFrag;
  if (!daily[dayKey]) daily[dayKey] = emptyDailyBucket();
  return daily[dayKey];
}

/** fileTodayFrag + todayYmdForFrag: Vollscan spiegelt „heute“ pro Datei → Today-Index nach Full-Scan ohne zweiten Lesedurchlauf. */
function processJsonlFile(fileRef, daily, onlyDate, isolateTodayFrag, fileTodayFrag, todayYmdForFrag) {
  var f = typeof fileRef === 'string' ? fileRef : fileRef.path;
  var hostLabel = typeof fileRef === 'string' ? 'local' : fileRef.label || 'local';
  var isSub = f.indexOf('subagent') >= 0;
  try {
    forEachJsonlLineSync(f, function(line) {
      if (!line.trim()) return;
      var rec;
      try {
        rec = JSON.parse(line);
      } catch (e) {
        return;
      }
      var ts = rec.timestamp || '';
      if (ts.length >= 10) {
        var daySig = ts.slice(0, 10);
        if (!onlyDate || daySig === onlyDate) {
          var sigTags = classifyJsonlSessionSignals(line, rec);
          if (sigTags.length) {
            var dSig = targetDayBucket(daily, daySig, onlyDate, isolateTodayFrag);
            bumpSessionSignals(dSig, sigTags);
            var sigVer = extractCliVersion(rec);
            if (sigVer) {
              if (!dSig.version_stats) dSig.version_stats = {};
              if (!dSig.version_stats[sigVer]) dSig.version_stats[sigVer] = emptyVersionStats();
              var svs = dSig.version_stats[sigVer];
              for (var sti2 = 0; sti2 < sigTags.length; sti2++) {
                if (svs[sigTags[sti2]] != null) svs[sigTags[sti2]]++;
              }
            }
            if (!dSig.hosts) dSig.hosts = {};
            if (!dSig.hosts[hostLabel]) dSig.hosts[hostLabel] = emptyHostSlice();
            bumpSessionSignals(dSig.hosts[hostLabel], sigTags);
            var hourKeyStr = null;
            if (ts.length >= 13) {
              var hiSig = parseInt(ts.slice(11, 13), 10);
              if (!isNaN(hiSig) && hiSig >= 0 && hiSig <= 23) hourKeyStr = String(hiSig);
            }
            if (hourKeyStr) {
              bumpHourSessionSignals(dSig, hourKeyStr, sigTags);
              bumpHourSessionSignals(dSig.hosts[hostLabel], hourKeyStr, sigTags);
            }
            if (fileTodayFrag && todayYmdForFrag && daySig === todayYmdForFrag) {
              bumpSessionSignals(fileTodayFrag, sigTags);
              if (!fileTodayFrag.hosts) fileTodayFrag.hosts = {};
              if (!fileTodayFrag.hosts[hostLabel]) fileTodayFrag.hosts[hostLabel] = emptyHostSlice();
              bumpSessionSignals(fileTodayFrag.hosts[hostLabel], sigTags);
              if (hourKeyStr) {
                bumpHourSessionSignals(fileTodayFrag, hourKeyStr, sigTags);
                bumpHourSessionSignals(fileTodayFrag.hosts[hostLabel], hourKeyStr, sigTags);
              }
            }
          }
        }
      }
      if (ts.length >= 10 && scanLineHitLimit(line)) {
        var dayLimit = ts.slice(0, 10);
        if (onlyDate && dayLimit !== onlyDate) {
          /* skip */
        } else {
          var dLim = targetDayBucket(daily, dayLimit, onlyDate, isolateTodayFrag);
          dLim.hit_limit = (dLim.hit_limit || 0) + 1;
          var limVer = extractCliVersion(rec);
          if (limVer) {
            if (!dLim.version_stats) dLim.version_stats = {};
            if (!dLim.version_stats[limVer]) dLim.version_stats[limVer] = emptyVersionStats();
            dLim.version_stats[limVer].hit_limit++;
          }
          if (!dLim.hosts) dLim.hosts = {};
          if (!dLim.hosts[hostLabel]) dLim.hosts[hostLabel] = emptyHostSlice();
          var hl = dLim.hosts[hostLabel];
          hl.hit_limit = (hl.hit_limit || 0) + 1;
          if (fileTodayFrag && todayYmdForFrag && dayLimit === todayYmdForFrag) {
            fileTodayFrag.hit_limit = (fileTodayFrag.hit_limit || 0) + 1;
            if (!fileTodayFrag.hosts) fileTodayFrag.hosts = {};
            if (!fileTodayFrag.hosts[hostLabel]) fileTodayFrag.hosts[hostLabel] = emptyHostSlice();
            var hlf = fileTodayFrag.hosts[hostLabel];
            hlf.hit_limit = (hlf.hit_limit || 0) + 1;
          }
        }
      }

      var u = rec.message && rec.message.usage;
      if (!u) return;
      var modelRaw = (rec.message && rec.message.model) || 'unknown';
      if (!isClaudeModel(modelRaw)) return;
      if (ts.length < 19) return;
      var day = ts.slice(0, 10);
      if (onlyDate && day !== onlyDate) return;
      var hour = parseInt(ts.slice(11, 13));
      var dd = targetDayBucket(daily, day, onlyDate, isolateTodayFrag);
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
      // Stop-reason tracking
      var stopR = (rec.message && rec.message.stop_reason) || 'unknown';
      dd.stop_reasons[stopR] = (dd.stop_reasons[stopR] || 0) + 1;
      var cliVer = extractCliVersion(rec);
      if (cliVer) {
        dd.versions[cliVer] = (dd.versions[cliVer] || 0) + 1;
        if (!dd.version_stats[cliVer]) dd.version_stats[cliVer] = emptyVersionStats();
        var vs = dd.version_stats[cliVer];
        vs.calls++;
        vs.output += outTok;
        vs.cache_read += crTok;
        var vsEp = extractEntrypoint(rec);
        if (vsEp) vs.entrypoints[vsEp] = (vs.entrypoints[vsEp] || 0) + 1;
      }
      var ep = extractEntrypoint(rec);
      if (ep) dd.entrypoints[ep] = (dd.entrypoints[ep] || 0) + 1;
      if (fileTodayFrag && todayYmdForFrag && day === todayYmdForFrag) {
        if (!fileTodayFrag.hosts) fileTodayFrag.hosts = {};
        if (!fileTodayFrag.hosts[hostLabel]) fileTodayFrag.hosts[hostLabel] = emptyHostSlice();
        var fhh = fileTodayFrag.hosts[hostLabel];
        fileTodayFrag.input += inTok;
        fileTodayFrag.output += outTok;
        fileTodayFrag.cache_read += crTok;
        fileTodayFrag.cache_creation += ccTok;
        fileTodayFrag.calls++;
        fileTodayFrag.hours[hour] = (fileTodayFrag.hours[hour] || 0) + 1;
        fhh.input += inTok;
        fhh.output += outTok;
        fhh.cache_read += crTok;
        fhh.cache_creation += ccTok;
        fhh.calls++;
        fhh.hours[hour] = (fhh.hours[hour] || 0) + 1;
        if (isSub) {
          fileTodayFrag.sub_calls++;
          fileTodayFrag.sub_cache += crTok;
          fileTodayFrag.sub_output += outTok;
          fhh.sub_calls++;
          fhh.sub_cache += crTok;
          fhh.sub_output += outTok;
        }
        if (!fileTodayFrag.models[model]) fileTodayFrag.models[model] = { calls: 0, output: 0, cache_read: 0 };
        fileTodayFrag.models[model].calls++;
        fileTodayFrag.models[model].output += outTok;
        fileTodayFrag.models[model].cache_read += crTok;
        if (cliVer) fileTodayFrag.versions[cliVer] = (fileTodayFrag.versions[cliVer] || 0) + 1;
        if (ep) fileTodayFrag.entrypoints[ep] = (fileTodayFrag.entrypoints[ep] || 0) + 1;
      }
    });
  } catch (e) {
    serviceLog.warn('parse', 'jsonl read failed ' + displayPathForUi(f) + ': ' + (e.message || e));
  }
}

function hostSliceToApi(h) {
  var total = h.input + h.output + h.cache_read + h.cache_creation;
  var activeH = unionHourKeyCount(h.hours, h.hour_signals);
  var ss = h.session_signals && typeof h.session_signals === 'object' ? h.session_signals : emptySessionSignals();
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
    hours: h.hours || {},
    hour_signals: h.hour_signals || {},
    session_signals: {
      continue: ss.continue || 0,
      resume: ss.resume || 0,
      retry: ss.retry || 0,
      interrupt: ss.interrupt || 0
    }
  };
}

// ── Release Stability Analysis ──────────────────────────────────────────
var REVERT_KEYWORDS = ['revert', 'rollback', 'roll back', 'backed out', 'regression', 'hotfix'];

function __releaseParseTagEntry(r) {
  var tag = (r.tag_name || '').replace(/^v/, '');
  var parts = tag.split('.');
  if (parts.length < 3) return null;
  var major = Number.parseInt(parts[0], 10) || 0;
  var minor = Number.parseInt(parts[1], 10) || 0;
  var patch = Number.parseInt(parts[2], 10) || 0;
  var body = (r.body || '').toLowerCase();
  var matchedKeywords = [];
  for (var kwi = 0; kwi < REVERT_KEYWORDS.length; kwi++) {
    if (body.includes(REVERT_KEYWORDS[kwi])) matchedKeywords.push(REVERT_KEYWORDS[kwi]);
  }
  return {
    tag: r.tag_name || '',
    date: (r.published_at || '').substring(0, 10),
    major: major,
    minor: minor,
    patch: patch,
    hasRegression: matchedKeywords.length > 0,
    matchedKeywords: matchedKeywords,
    prerelease: !!r.prerelease
  };
}

function __releaseBuildEntries(sorted) {
  var entries = [];
  for (var ri = 0; ri < sorted.length; ri++) {
    var ent = __releaseParseTagEntry(sorted[ri]);
    if (ent) entries.push(ent);
  }
  return entries;
}

function __releaseDaysActive(cur, nextEntry, ri, entriesLen, nowMs) {
  if (ri < entriesLen - 1) {
    var d1 = new Date(cur.date);
    var d2 = new Date(nextEntry.date);
    return Math.max(0, Math.round((d2 - d1) / 86400000));
  }
  return Math.max(0, Math.round((nowMs - new Date(cur.date)) / 86400000));
}

function __releaseSkippedPatches(prev, cur) {
  if (prev && cur.minor === prev.minor) {
    return Math.max(0, cur.patch - prev.patch - 1);
  }
  return 0;
}

function __releaseStabilityOf(cur, isHotfix) {
  if (isHotfix) return 'hotfix';
  if (cur.hasRegression) return 'regression';
  return 'stable';
}

function __releaseBuildOne(cur, prev, nextEntry, ri, nEnt, nowMs) {
  var isHotfix = prev ? (cur.date === prev.date) : false;
  return {
    tag: cur.tag,
    date: cur.date,
    daysActive: __releaseDaysActive(cur, nextEntry, ri, nEnt, nowMs),
    stability: __releaseStabilityOf(cur, isHotfix),
    isHotfix: isHotfix,
    hasRegression: cur.hasRegression,
    matchedKeywords: cur.matchedKeywords,
    skippedPatches: __releaseSkippedPatches(prev, cur)
  };
}

function buildReleaseStabilityData() {
  var rels = releasesCache.releases;
  if (!rels?.length) return null;

  var sorted = rels.slice().sort(function(a, b) {
    return (a.published_at || '').localeCompare(b.published_at || '');
  });

  var entries = __releaseBuildEntries(sorted);
  if (!entries.length) return null;

  var releases = [];
  var totalSkipped = 0;
  var hotfixCount = 0;
  var regressionCount = 0;
  var nowMs = Date.now();
  var nEnt = entries.length;
  for (var ri = 0; ri < nEnt; ri++) {
    var cur = entries[ri];
    var prev = ri > 0 ? entries[ri - 1] : null;
    var r = __releaseBuildOne(cur, prev, entries[ri + 1], ri, nEnt, nowMs);
    releases.push(r);
    if (r.isHotfix) hotfixCount++;
    totalSkipped += r.skippedPatches;
    if (cur.hasRegression) regressionCount++;
  }

  var firstEnt = entries[0];
  var lastEnt = entries.at(-1);
  return {
    releases: releases,
    summary: {
      total: releases.length,
      totalSkipped: totalSkipped,
      hotfixCount: hotfixCount,
      regressionCount: regressionCount,
      stableCount: releases.length - hotfixCount - regressionCount + (hotfixCount > 0 ? releases.filter(function(r) { return r.isHotfix && r.hasRegression; }).length : 0),
      firstDate: firstEnt.date,
      lastDate: lastEnt.date,
      daysSpan: Math.round((new Date(lastEnt.date) - new Date(firstEnt.date)) / 86400000),
      cadenceDays: entries.length > 1
        ? Math.round((new Date(lastEnt.date) - new Date(firstEnt.date)) / 86400000 / (entries.length - 1) * 10) / 10
        : 0
    }
  };
}

function buildUsageResult(daily, fileCount, filePaths, roots, buildOpts) {
  var days = Object.keys(daily).sort();
  var result = [];
  for (var di = 0; di < days.length; di++) {
    var key = days[di];
    var r = daily[key];
    var total = r.input + r.output + r.cache_read + r.cache_creation;
    var activeH = unionHourKeyCount(r.hours, r.hour_signals);
    var hostsRaw = r.hosts || {};
    var hostsApi = {};
    var hKeys = Object.keys(hostsRaw).sort();
    for (var hi = 0; hi < hKeys.length; hi++) {
      hostsApi[hKeys[hi]] = hostSliceToApi(hostsRaw[hKeys[hi]]);
    }
    var rsig = r.session_signals && typeof r.session_signals === 'object' ? r.session_signals : emptySessionSignals();
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
      entrypoints: r.entrypoints || {},
      version_stats: r.version_stats || {},
      hours: r.hours,
      hour_signals: r.hour_signals || {},
      hosts: hostsApi,
      session_signals: {
        continue: rsig.continue || 0,
        resume: rsig.resume || 0,
        retry: rsig.retry || 0,
        interrupt: rsig.interrupt || 0
      },
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
  applyJsonlGapVersionChanges(result);

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
    release_stability: buildReleaseStabilityData(),
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
    processJsonlFile(tagged[fi], daily, null, null, null, null);
  }
  return buildUsageResult(daily, tagged.length, tagged, coll.roots);
}

// Inkrementell: setImmediate zwischen Batches. Mit gültigem Tages-Cache nur JSONL für localCalendarTodayStr().
// JSONL-Pfadliste wird async gesammelt (yieldende Verzeichniswand), damit der Server nach Start sofort HTTP/SSE bedient.
function parseAllUsageIncremental(done, onProgress) {
  setImmediate(function () {
  collectTaggedJsonlFilesAsync(function (err, coll) {
  if (err) {
    done(err, null);
    return;
  }
  try {
  var tagged = coll.tagged;
  var roots = coll.roots;
  var scanFpForPersist = buildTaggedJsonlFingerprintSync(tagged);
  var skipIdentScan =
    process.env.CLAUDE_USAGE_SKIP_IDENTICAL_SCAN === '1' ||
    process.env.CLAUDE_USAGE_SKIP_IDENTICAL_SCAN === 'true';
  if (
    skipIdentScan &&
    scanFpForPersist === __lastScanJsonlFingerprint &&
    cachedData &&
    cachedData.days &&
    cachedData.days.length > 0 &&
    !cachedData.scan_error
  ) {
    serviceLog.info('scan', 'skip parse identical jsonl fingerprint files=' + tagged.length);
    try {
      var cloneSkip = JSON.parse(JSON.stringify(cachedData));
      cloneSkip.generated = new Date().toISOString();
      cloneSkip.scanning = false;
      delete cloneSkip.scan_progress;
      done(null, cloneSkip);
    } catch (eSk) {
      done(eSk, null);
    }
    return;
  }
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
    // Nur Tage *mit* JSONL-Nutzung stehen in cache.days — Lücken (0 Tokens am Vortag) wären sonst
    // maxCached < „gestern“ → fälschlich endlos full_jsonl bei jedem Intervall-Scan.
    useTodayOnly = true;
  } else {
    var missParts = [];
    if (noDayCache) missParts.push('CLAUDE_USAGE_NO_CACHE');
    if (!cache) missParts.push('no_disk_day_cache_or_unreadable');
    else {
      if (cache.version !== USAGE_DAY_CACHE_VERSION) {
        missParts.push('cache_version want=' + USAGE_DAY_CACHE_VERSION + ' got=' + (cache.version != null ? cache.version : 'null'));
      }
      if (cache.jsonl_file_count !== tagged.length) {
        missParts.push('jsonl_count cache=' + cache.jsonl_file_count + ' tagged=' + tagged.length);
      }
      if (cache.scan_roots_key !== rootsKey) {
        missParts.push('scan_roots_key_mismatch');
      }
      if (!Array.isArray(cache.days) || cache.days.length === 0) {
        missParts.push('cache_days_empty');
      }
    }
    serviceLog.info('scan', 'day_cache_miss full_jsonl — ' + missParts.join(' | '));
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
  var todayIndexCtx = null;
  if (useTodayOnly && !TODAY_INDEX_DISABLED) {
    var rawIdx = readJsonlTodayIndexDisk();
    var idxOk =
      rawIdx &&
      rawIdx.version === JSONL_TODAY_INDEX_VERSION &&
      rawIdx.calendar_day === todayStr &&
      rawIdx.jsonl_file_count === tagged.length &&
      rawIdx.scan_roots_key === rootsKey &&
      rawIdx.files &&
      typeof rawIdx.files === 'object';
    todayIndexCtx = {
      files: idxOk ? rawIdx.files : {},
      out: {},
      skipped: 0,
      read: 0,
      valid: idxOk
    };
  }
  /** Nach Full-Scan: pro JSONL Today-Fragment + mtime → nächster Lauf kann fast alles per Index überspringen (vorher: invalidate → 358× Neu-Lesen). */
  var fullScanTodayIndexOut = !useTodayOnly && !TODAY_INDEX_DISABLED ? {} : null;
  var scanT0 = Date.now();
  serviceLog.info(
    'scan',
    'parse start jsonl_files=' +
      tagged.length +
      ' mode=' +
      (useTodayOnly ? 'today_jsonl+day_cache' : 'full_jsonl') +
      ' scan_roots=' +
      roots.length
  );
  var fi = 0;
  function tick() {
    var n = SCAN_FILES_PER_TICK;
    while (n-- > 0 && fi < tagged.length) {
      var refOne = tagged[fi];
      if (todayIndexCtx && onlyArg) {
        var absOne = path.resolve(typeof refOne === 'string' ? refOne : refOne.path);
        var stOne;
        try {
          stOne = fs.statSync(absOne);
        } catch (eStat) {
          stOne = null;
        }
        var entOne = todayIndexCtx.valid ? todayIndexCtx.files[absOne] : null;
        if (
          stOne &&
          entOne &&
          entOne.mtimeMs === stOne.mtimeMs &&
          entOne.size === stOne.size &&
          entOne.frag
        ) {
          mergeDayBucketInto(daily[todayStr], entOne.frag);
          todayIndexCtx.out[absOne] = entOne;
          todayIndexCtx.skipped++;
        } else {
          var fragOne = emptyDailyBucket();
          processJsonlFile(refOne, daily, onlyArg, fragOne, null, null);
          todayIndexCtx.read++;
          if (stOne) {
            todayIndexCtx.out[absOne] = {
              mtimeMs: stOne.mtimeMs,
              size: stOne.size,
              frag: fragOne
            };
          }
        }
      } else {
        var absFull = path.resolve(typeof refOne === 'string' ? refOne : refOne.path);
        var stFull = null;
        try {
          stFull = fs.statSync(absFull);
        } catch (eSF) {
          stFull = null;
        }
        var fragIdx = fullScanTodayIndexOut ? emptyDailyBucket() : null;
        processJsonlFile(refOne, daily, onlyArg, null, fragIdx, fragIdx ? todayStr : null);
        if (fullScanTodayIndexOut && stFull && fragIdx) {
          fullScanTodayIndexOut[absFull] = { mtimeMs: stFull.mtimeMs, size: stFull.size, frag: fragIdx };
        }
      }
      fi++;
    }
    if (fi < tagged.length) {
      serviceLog.debug('parse', 'batch ' + fi + '/' + tagged.length);
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
        var mergedMpForFinal = mergeMarketplaceRowsPreferNewer(frozenMpRows);
        var result = buildUsageResult(daily, tagged.length, tagged, roots, {
          marketplaceRows: mergedMpForFinal.length ? mergedMpForFinal : frozenMpRows
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
            serviceLog.info(
              'cache',
              'day_cache written days=' + (result.days ? result.days.length : 0) + ' jsonl_count=' + tagged.length
            );
          } catch (we) {
            serviceLog.error('cache', 'day_cache write failed: ' + (we.message || we));
          }
        }
        if (useTodayOnly && todayIndexCtx) {
          try {
            writeJsonlTodayIndexDisk({
              version: JSONL_TODAY_INDEX_VERSION,
              calendar_day: todayStr,
              jsonl_file_count: tagged.length,
              scan_roots_key: rootsKey,
              files: todayIndexCtx.out
            });
            serviceLog.info(
              'cache',
              'today_index skipped=' +
                todayIndexCtx.skipped +
                ' read=' +
                todayIndexCtx.read +
                ' jsonl=' +
                tagged.length
            );
          } catch (wi) {
            serviceLog.warn('cache', 'today_index write failed: ' + (wi.message || wi));
          }
        }
        if (!useTodayOnly) {
          if (fullScanTodayIndexOut && !TODAY_INDEX_DISABLED) {
            try {
              writeJsonlTodayIndexDisk({
                version: JSONL_TODAY_INDEX_VERSION,
                calendar_day: todayStr,
                jsonl_file_count: tagged.length,
                scan_roots_key: rootsKey,
                files: fullScanTodayIndexOut
              });
              serviceLog.info(
                'cache',
                'today_index after full_scan entries=' +
                  Object.keys(fullScanTodayIndexOut).length +
                  ' jsonl=' +
                  tagged.length
              );
            } catch (wiFull) {
              serviceLog.warn('cache', 'today_index after full_scan write failed: ' + (wiFull.message || wiFull));
              invalidateJsonlTodayIndexDisk();
            }
          } else if (TODAY_INDEX_DISABLED) {
            invalidateJsonlTodayIndexDisk();
          }
        }
        serviceLog.info(
          'scan',
          'parse done ms=' +
            (Date.now() - scanT0) +
            ' files=' +
            tagged.length +
            ' result_days=' +
            (result.days ? result.days.length : 0)
        );
        __lastScanJsonlFingerprint = scanFpForPersist;
        done(null, result);
      } catch (err) {
        done(err, null);
      }
    }
  }
  setImmediate(tick);
  } catch (eColl) {
    done(eColl, null);
  }
  });
  });
}

// ── HTML Dashboard (Shell: tpl/dashboard.html; UI-Texte: tpl/{de,en}/ui.tpl als JSON) ───
// In-Memory-Cache: Shell + i18n-JSON nur neu einlesen, wenn mtime von dashboard.html, dashboard.css,
// dashboard.client.js oder den ui.tpl-Dateien sich ändert.

/** Repo-Root (tpl/, public/ liegen eine Ebene über scripts/) */
var DASHBOARD_SCRIPT_DIR = path.join(__dirname, '..');

var __i18nPageCache = {
  mde: null,
  men: null,
  mdashboard: null,
  mcss: null,
  mjs: null,
  bundles: null,
  inlineJson: '',
  fullHtml: null
};

var DASHBOARD_TPL_FILE = path.join(DASHBOARD_SCRIPT_DIR, 'tpl', 'dashboard.html');
var DASHBOARD_CSS_FILE = path.join(DASHBOARD_SCRIPT_DIR, 'public', 'css', 'dashboard.css');
var DASHBOARD_CLIENT_JS_FILE = path.join(DASHBOARD_SCRIPT_DIR, 'public', 'js', 'dashboard.client.js');

function getPathMtimeMs(p) {
  try {
    return fs.statSync(p).mtimeMs;
  } catch (e) {
    return NaN;
  }
}

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
    serviceLog.error('i18n', 'tpl/' + lang + '/ui.tpl: ' + e.message);
    return {};
  }
}

function buildI18nBundles() {
  var mde = getUiTplMtimeMs('de');
  var men = getUiTplMtimeMs('en');
  var mko = getUiTplMtimeMs('ko');
  var c = __i18nPageCache;
  if (c.bundles && c.mde === mde && c.men === men && c.mko === mko) {
    return c.bundles;
  }
  c.bundles = { de: loadUiTpl('de'), en: loadUiTpl('en'), ko: loadUiTpl('ko') };
  c.mde = mde;
  c.men = men;
  c.mko = mko;
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
  var mko = getUiTplMtimeMs('ko');
  var md = getPathMtimeMs(DASHBOARD_TPL_FILE);
  var mc = getPathMtimeMs(DASHBOARD_CSS_FILE);
  var mj = getPathMtimeMs(DASHBOARD_CLIENT_JS_FILE);
  if (
    c.fullHtml &&
    c.mde === mde &&
    c.men === men &&
    c.mko === mko &&
    c.mdashboard === md &&
    c.mcss === mc &&
    c.mjs === mj
  ) {
    return c.fullHtml;
  }
  buildI18nBundles();
  var shell = fs.readFileSync(DASHBOARD_TPL_FILE, 'utf8');
  c.fullHtml = shell.replace('__I18N_PLACEHOLDER__', jsonForInlineI18nScript());
  c.mdashboard = md;
  c.mcss = mc;
  c.mjs = mj;
  return c.fullHtml;
}


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

/** Nach Marketplace-Refresh: Marker neu auf cachedData.days ohne JSONL-Vollscan. */
function reapplyExtensionMarkersOnCachedDataAndBroadcast(reason) {
  if (!cachedData || !cachedData.days || !cachedData.days.length) return;
  if (scanInProgress) {
    serviceLog.debug('markers', 'skip reapply: scan in progress (' + reason + ')');
    return;
  }
  try {
    var rows = cachedData.days;
    applyExtensionVersionMarkers(rows, null);
    applyJsonlGapVersionChanges(rows);
    enrichVersionChangeNotes(rows);
    cachedData.generated = new Date().toISOString();
    broadcastSse();
    serviceLog.info('markers', 'extension markers refreshed (' + reason + ')');
  } catch (e) {
    serviceLog.error('markers', 'reapply failed: ' + (e && e.message ? e.message : String(e)));
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
    if (mid && state.fi > SCAN_FILES_PER_TICK && now - lastPartialEmitMs < SCAN_PARTIAL_EMIT_MIN_MS) return;
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
      refreshProxyCache();
      if (__proxyCache.data) cachedData.proxy = __proxyCache.data;
      cachedData.release_stability = buildReleaseStabilityData();
      scanOk = true;
    } catch (e) {
      serviceLog.error('scan', 'parse failed: ' + (e && e.message ? e.message : String(e)));
      var msg = e && e.message ? e.message : String(e);
      if (!cachedData || !cachedData.days || cachedData.days.length === 0) {
        cachedData = makeStubCachedData();
      }
      cachedData.scanning = false;
      cachedData.scan_error = msg;
    } finally {
      scanInProgress = false;
      broadcastSse();
      // Avoid stacking heavy work: refreshProxyCache already parsed all proxy NDJSON in try{}.
      // Session-turns rebuild walks all JSONL again — defer once after first successful scan only.
      if (scanOk && IDLE_SESSION_PRELOAD_MS > 0 && !__sessionTurnsIdlePreloadScheduled) {
        __sessionTurnsIdlePreloadScheduled = true;
        setTimeout(function () {
          try {
            var preloadDay = new Date().toISOString().slice(0, 10);
            var pt0 = Date.now();
            getSessionTurnsCached(preloadDay);
            serviceLog.info('session-turns', 'idle preload date=' + preloadDay + ' (' + (Date.now() - pt0) + 'ms)');
          } catch (pe) {
            serviceLog.warn('session-turns', 'idle preload failed: ' + (pe.message || pe));
          }
        }, IDLE_SESSION_PRELOAD_MS);
      }
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

var claudeDataSyncBusy = false;

function getClaudeUsageSyncToken() {
  return String(process.env.CLAUDE_USAGE_SYNC_TOKEN || '').trim();
}

/** Bearer-Token aus Authorization-Header (case-insensitive, trim). */
function parseBearerFromAuthorization(authHeader) {
  var s = String(authHeader || '').trim();
  var m = /^Bearer\s+(\S.*)$/i.exec(s);
  return m ? String(m[1]).trim() : '';
}

function handleClaudeDataSyncRequest(req, res) {
  var cors = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };
  if (!getClaudeUsageSyncToken()) {
    res.writeHead(404, cors);
    res.end(JSON.stringify({ ok: false, error: 'sync_disabled' }));
    return;
  }
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization'
    });
    res.end();
    return;
  }
  if (req.method !== 'POST') {
    res.writeHead(405, Object.assign({ Allow: 'POST, OPTIONS' }, cors));
    res.end(JSON.stringify({ ok: false, error: 'method_not_allowed' }));
    return;
  }
  var expected = getClaudeUsageSyncToken();
  var presented = parseBearerFromAuthorization(req.headers.authorization);
  if (!presented || presented !== expected) {
    serviceLog.warn(
      'ingest',
      'sync auth failed presented_len=' +
        presented.length +
        ' expected_len=' +
        expected.length +
        (presented ? '' : ' (no Bearer token)')
    );
    res.writeHead(401, cors);
    res.end(JSON.stringify({ ok: false, error: 'unauthorized' }));
    return;
  }
  if (claudeDataSyncBusy) {
    res.writeHead(409, cors);
    res.end(JSON.stringify({ ok: false, error: 'sync_busy' }));
    return;
  }
  claudeDataSyncBusy = true;
  var maxMb = parseInt(process.env.CLAUDE_USAGE_SYNC_MAX_MB || '512', 10);
  if (isNaN(maxMb) || maxMb < 1) maxMb = 512;
  var maxBytes = maxMb * 1024 * 1024;
  var tmpPath = path.join(os.tmpdir(), 'claude-sync-' + process.pid + '-' + Date.now() + '.tgz');
  var ws = fs.createWriteStream(tmpPath);
  var received = 0;
  var aborted = false;
  function failSync(code, body, doUnlink) {
    if (doUnlink) {
      fs.unlink(tmpPath, function () {});
    }
    claudeDataSyncBusy = false;
    res.writeHead(code, cors);
    res.end(JSON.stringify(body));
  }
  req.on('data', function (chunk) {
    if (aborted) return;
    received += chunk.length;
    if (received > maxBytes) {
      aborted = true;
      try {
        req.destroy();
      } catch (de) {}
      try {
        ws.destroy();
      } catch (we) {}
      failSync(413, { ok: false, error: 'payload_too_large', max_mb: maxMb }, true);
      return;
    }
    ws.write(chunk);
  });
  req.on('error', function () {
    if (aborted) return;
    aborted = true;
    try {
      ws.destroy();
    } catch (we2) {}
    fs.unlink(tmpPath, function () {});
    claudeDataSyncBusy = false;
  });
  req.on('end', function () {
    if (aborted) return;
    ws.end();
  });
  ws.on('error', function (e) {
    if (aborted) return;
    aborted = true;
    failSync(500, { ok: false, error: 'write_failed', detail: String(e && e.message ? e.message : e) }, true);
  });
  ws.on('finish', function () {
    if (aborted) {
      fs.unlink(tmpPath, function () {});
      return;
    }
    var destRoot = path.join(HOME, '.claude');
    claudeDataIngest.extractTarGzIntoClaudeRoot(tmpPath, destRoot, function (err, result) {
      fs.unlink(tmpPath, function () {});
      claudeDataSyncBusy = false;
      if (err) {
        serviceLog.error('ingest', 'sync extract failed: ' + (err.message || err));
        res.writeHead(500, cors);
        res.end(JSON.stringify({ ok: false, error: 'extract_failed', detail: String(err.message || err) }));
        return;
      }
      serviceLog.info('ingest', 'sync ok files_written=' + result.filesWritten);
      runScanAndBroadcast();
      res.writeHead(200, cors);
      res.end(JSON.stringify({ ok: true, files_written: result.filesWritten }));
    });
  });
}

/**
 * Nach listen: Dashboard-HTML cachen, CSS/JS einmal async einlesen (Event-Loop frei für erste Requests),
 * danach optional PARSE_START_DELAY_MS, dann ersten Nutzungs-Scan.
 */
function primeDashboardAndScheduleFirstScan() {
  try {
    getDashboardHtml();
  } catch (primeErr) {
    serviceLog.warn(
      'server',
      'dashboard prime: ' + (primeErr && primeErr.message ? primeErr.message : String(primeErr))
    );
  }
  var pending = 2;
  function afterAssets() {
    pending--;
    if (pending !== 0) return;
    if (PARSE_START_DELAY_MS > 0) {
      setTimeout(runScanAndBroadcast, PARSE_START_DELAY_MS);
    } else {
      setImmediate(runScanAndBroadcast);
    }
  }
  fs.readFile(DASHBOARD_CSS_FILE, 'utf8', function () {
    afterAssets();
  });
  fs.readFile(DASHBOARD_CLIENT_JS_FILE, 'utf8', function () {
    afterAssets();
  });
}

// ── HTTP Server ─────────────────────────────────────────────────────────


// ── Proxy NDJSON Log Parsing ──────────────────────────────────────────────
// Separate data track: proxy logs contain API-level metrics (latency, rate limits,
// cache health from actual Anthropic headers) that JSONL session logs do not have.

var __proxyCache = { data: null, generated: null };

function emptyProxyDayBucket() {
  return {
    requests: 0,
    errors: 0,
    total_duration_ms: 0,
    min_duration_ms: Infinity,
    max_duration_ms: 0,
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_creation_tokens: 0,
    cache_health: { healthy: 0, mixed: 0, affected: 0, na: 0 },
    models: {},
    status_codes: {},
    hours: {},
    rate_limit_snapshots: [],
    q5_samples: [],
    cold_starts: 0,
    cache_ratios: [],
    per_hour_latency: {},
    false_429s: 0,
    context_resets: 0,
    _prev_cache_read_high: false,
    // claude-code-cache-fix interop fields
    ttl_tiers: { '1h': 0, '5m': 0, unknown: 0 },
    peak_hour_requests: 0,
    off_peak_requests: 0,
    ephemeral_1h_tokens: 0,
    ephemeral_5m_tokens: 0,
    data_sources: {}
  };
}

/**
 * Compute cumulative 5h-window consumption from chronological q5 samples.
 * Sums only positive deltas between consecutive requests (active consumption),
 * ignoring natural rollback of the rolling 5h window. Tokens of the consuming
 * request are attributed to the delta they caused. Returns:
 *   { consumed: fraction_0_to_many, tokens: sum_input_output, count: num_samples }
 */
function computeQ5Consumption(samples) {
  if (!samples || samples.length < 2) {
    return { consumed: 0, tokens: 0, count: samples?.length || 0 };
  }
  var sorted = samples.slice().sort(function (a, b) {
    if (a.ts < b.ts) return -1;
    if (a.ts > b.ts) return 1;
    return 0;
  });
  var consumed = 0;
  var tokens = 0;
  for (var i = 1; i < sorted.length; i++) {
    var delta = sorted[i].q5 - sorted[i - 1].q5;
    if (delta > 0) {
      consumed += delta;
      tokens += sorted[i].tokens;
    }
  }
  return { consumed: consumed, tokens: tokens, count: sorted.length };
}

function parseProxyNdjsonFiles() {
  var files = collectProxyNdjsonFiles();
  var daily = {};

  for (var fi = 0; fi < files.length; fi++) {
    try {
      forEachJsonlLineSync(files[fi], function(line) {
        if (!line.trim()) return;
        var rec;
        try { rec = JSON.parse(line); } catch (e) { return; }

        // Skip error-only records
        if (rec.error && !rec.ts_end) return;

        var tsEnd = rec.ts_end || rec.ts_start || '';
        if (tsEnd.length < 10) return;
        var dayKey = tsEnd.slice(0, 10);

        if (!daily[dayKey]) daily[dayKey] = emptyProxyDayBucket();
        var dd = daily[dayKey];

        dd.requests++;
        var dur = rec.duration_ms || 0;
        dd.total_duration_ms += dur;
        if (dur < dd.min_duration_ms) dd.min_duration_ms = dur;
        if (dur > dd.max_duration_ms) dd.max_duration_ms = dur;

        var status = rec.upstream_status || 0;
        dd.status_codes[status] = (dd.status_codes[status] || 0) + 1;
        if (status >= 400) dd.errors++;

        // B3: False 429 — client-generated rate limit (no cf-ray = not from Anthropic)
        if (status === 429) {
          var rah = rec.response_anthropic_headers || {};
          if (!rah['cf-ray']) dd.false_429s++;
        }

        // Hour tracking
        if (tsEnd.length >= 13) {
          var hour = parseInt(tsEnd.slice(11, 13), 10);
          if (!isNaN(hour) && hour >= 0 && hour <= 23) {
            dd.hours[hour] = (dd.hours[hour] || 0) + 1;
          }
        }

        // Usage from proxy (already extracted from Anthropic response)
        var u = rec.usage;
        if (u) {
          dd.input_tokens += (u.input_tokens || 0);
          dd.output_tokens += (u.output_tokens || 0);
          dd.cache_read_tokens += (u.cache_read_input_tokens || 0);
          dd.cache_creation_tokens += (u.cache_creation_input_tokens || 0);
        }

        // B4: Context Reset heuristic — cache_creation spikes after high cache_read phase
        if (u && status === 200) {
          var crt = u.cache_read_input_tokens || 0;
          var cct = u.cache_creation_input_tokens || 0;
          if (crt > 100000) dd._prev_cache_read_high = true;
          if (dd._prev_cache_read_high && cct > 0 && crt < cct) {
            dd.context_resets++;
            dd._prev_cache_read_high = false;
          }
        }

        // Cache health
        var ch = rec.cache_health || 'na';
        if (dd.cache_health[ch] !== undefined) dd.cache_health[ch]++;
        else dd.cache_health.na++;

        // Cold-start detection: cache_read_ratio < 0.5 on a 200 request with usage
        var crr = rec.cache_read_ratio;
        if (typeof crr === 'number' && u && status === 200) {
          dd.cache_ratios.push(crr);
          if (crr < 0.5) dd.cold_starts++;
        }

        // Per-hour latency tracking for heatmap
        if (tsEnd.length >= 13 && dur > 0 && status === 200) {
          var lhour = parseInt(tsEnd.slice(11, 13), 10);
          if (!isNaN(lhour) && lhour >= 0 && lhour <= 23) {
            if (!dd.per_hour_latency[lhour]) dd.per_hour_latency[lhour] = { sum: 0, count: 0, max: 0 };
            dd.per_hour_latency[lhour].sum += dur;
            dd.per_hour_latency[lhour].count++;
            if (dur > dd.per_hour_latency[lhour].max) dd.per_hour_latency[lhour].max = dur;
          }
        }

        // Model from request hints
        var model = (rec.request_hints && rec.request_hints.model) || 'unknown';
        if (!dd.models[model]) dd.models[model] = { requests: 0, avg_duration_ms: 0, total_duration_ms: 0, output_tokens: 0 };
        dd.models[model].requests++;
        dd.models[model].total_duration_ms += dur;
        if (u) dd.models[model].output_tokens += (u.output_tokens || 0);

        // Stop-reason from proxy (SSE + JSON responses)
        var rh2 = rec.response_hints || {};
        if (rh2.stop_reason) {
          if (!dd.stop_reasons) dd.stop_reasons = {};
          dd.stop_reasons[rh2.stop_reason] = (dd.stop_reasons[rh2.stop_reason] || 0) + 1;
        }

        // Rate limit snapshot (keep last per day, not all)
        var rlh = rec.response_anthropic_headers;
        if (rlh) {
          var snap = {};
          var hasRl = false;
          for (var rk in rlh) {
            if (rk.indexOf('anthropic-ratelimit') === 0) {
              snap[rk] = rlh[rk];
              hasRl = true;
            }
          }
          if (hasRl) {
            snap._ts = tsEnd;
            // Keep only latest snapshot per day (overwrite)
            dd.rate_limit_snapshots = [snap];

            // Cumulative q5 tracking for tokens-per-pct (see computeQ5Consumption)
            var q5Str = snap['anthropic-ratelimit-unified-5h-utilization'];
            if (q5Str != null) {
              var q5Num = Number.parseFloat(q5Str);
              if (!Number.isNaN(q5Num) && q5Num >= 0) {
                dd.q5_samples.push({
                  ts: tsEnd,
                  q5: q5Num,
                  tokens: (u?.input_tokens || 0) + (u?.output_tokens || 0),
                  cache_read: u?.cache_read_input_tokens || 0,
                  cache_creation: u?.cache_creation_input_tokens || 0
                });
              }
            }
          }
        }

        // ── claude-code-cache-fix interop fields ──────────────────────
        // TTL tier (from cache-fix interceptor, absent in native proxy)
        var ttl = rec.ttl_tier || 'unknown';
        if (dd.ttl_tiers[ttl] !== undefined) dd.ttl_tiers[ttl]++;
        else dd.ttl_tiers.unknown++;

        // Ephemeral token breakdown by TTL tier
        dd.ephemeral_1h_tokens += (rec.ephemeral_1h_input_tokens || 0);
        dd.ephemeral_5m_tokens += (rec.ephemeral_5m_input_tokens || 0);

        // Peak hour (prefer flag from cache-fix, fallback: compute from ts)
        if (rec.peak_hour === true) {
          dd.peak_hour_requests++;
        } else if (rec.peak_hour === false) {
          dd.off_peak_requests++;
        } else if (tsEnd.length >= 13) {
          var phDate = new Date(tsEnd);
          var phUtcH = phDate.getUTCHours();
          var phUtcD = phDate.getUTCDay();
          if (phUtcD >= 1 && phUtcD <= 5 && phUtcH >= 13 && phUtcH < 19) dd.peak_hour_requests++;
          else dd.off_peak_requests++;
        }

        // Data source tracking
        var src = rec.source || 'proxy';
        dd.data_sources[src] = (dd.data_sources[src] || 0) + 1;
      });
    } catch (e) {
      serviceLog.warn('proxy-parse', 'ndjson read failed ' + files[fi] + ': ' + (e.message || e));
    }
  }

  // Build result array
  var days = Object.keys(daily).sort();
  var result = [];
  for (var di = 0; di < days.length; di++) {
    var key = days[di];
    var d = daily[key];
    // Compute model averages
    var modelKeys = Object.keys(d.models);
    for (var mi = 0; mi < modelKeys.length; mi++) {
      var m = d.models[modelKeys[mi]];
      m.avg_duration_ms = m.requests > 0 ? Math.round(m.total_duration_ms / m.requests) : 0;
    }
    result.push({
      date: key,
      requests: d.requests,
      errors: d.errors,
      error_rate: d.requests > 0 ? Math.round(d.errors / d.requests * 10000) / 100 : 0,
      avg_duration_ms: d.requests > 0 ? Math.round(d.total_duration_ms / d.requests) : 0,
      min_duration_ms: d.min_duration_ms === Infinity ? 0 : d.min_duration_ms,
      max_duration_ms: d.max_duration_ms,
      input_tokens: d.input_tokens,
      output_tokens: d.output_tokens,
      cache_read_tokens: d.cache_read_tokens,
      cache_creation_tokens: d.cache_creation_tokens,
      total_tokens: d.input_tokens + d.output_tokens + d.cache_read_tokens + d.cache_creation_tokens,
      cache_read_ratio: (d.cache_read_tokens + d.cache_creation_tokens) > 0
        ? Math.round(d.cache_read_tokens / (d.cache_read_tokens + d.cache_creation_tokens) * 10000) / 10000
        : null,
      cache_health: d.cache_health,
      models: d.models,
      status_codes: d.status_codes,
      hours: d.hours,
      active_hours: Object.keys(d.hours).length,
      rate_limit: d.rate_limit_snapshots.length ? d.rate_limit_snapshots[0] : null,
      per_hour_latency: d.per_hour_latency,
      false_429s: d.false_429s,
      context_resets: d.context_resets,
      stop_reasons: d.stop_reasons || {},
      visible_tokens_per_pct: null,
      visible_tokens_per_pct_method: null,
      q5_consumed_pct: 0,
      q5_samples: 0,
      proxy_active_visible_tokens: 0,
      // claude-code-cache-fix interop
      ttl_tiers: d.ttl_tiers,
      peak_hour_requests: d.peak_hour_requests,
      off_peak_requests: d.off_peak_requests,
      ephemeral_1h_tokens: d.ephemeral_1h_tokens,
      ephemeral_5m_tokens: d.ephemeral_5m_tokens,
      data_sources: d.data_sources
    });
    // Quota benchmark: visible tokens per 1% of 5h window consumption.
    // Cumulative over positive Δq5 between consecutive chronological requests —
    // avoids the snapshot/rolling-window/idle-decay mismatch of dividing whole-day
    // tokens by the final-snapshot utilization.
    var lastResult = result[result.length - 1];
    var q5stats = computeQ5Consumption(d.q5_samples);
    lastResult.q5_consumed_pct = Math.round(q5stats.consumed * 10000) / 100;
    lastResult.q5_samples = q5stats.count;
    lastResult.proxy_active_visible_tokens = q5stats.tokens;
    if (q5stats.consumed > 0.0005 && q5stats.tokens > 0 && q5stats.count >= 3) {
      lastResult.visible_tokens_per_pct = Math.round(q5stats.tokens / (q5stats.consumed * 100));
      lastResult.visible_tokens_per_pct_method = 'cumulative_delta';
    }
  }

  return {
    proxy_days: result,
    proxy_log_dir: getProxyLogDir(),
    proxy_files: files.length,
    generated: new Date().toISOString()
  };
}

function refreshProxyCache() {
  if (__devProxyPending) return;
  try {
    __proxyCache.data = parseProxyNdjsonFiles();
    __proxyCache.generated = new Date().toISOString();
    serviceLog.info('proxy-parse', 'done days=' + (__proxyCache.data.proxy_days ? __proxyCache.data.proxy_days.length : 0) + ' files=' + __proxyCache.data.proxy_files);
  } catch (e) {
    serviceLog.error('proxy-parse', 'failed: ' + (e.message || e));
  }
}

// ── Dev: fetch data from remote when DEV_PROXY_SOURCE + DEV_MODE set ─────
var __devSource = (process.env.DEV_PROXY_SOURCE || '').trim();
var __devMode = (process.env.DEV_MODE || '').trim().toLowerCase(); // "proxy" | "full"
var __devProxyPending = !!__devSource && (__devMode === 'proxy' || __devMode === 'full');
/** Outgoing DEV fetch to remote /api/session-turns (ms). Default 180s so reverse proxies stay below client abort. */
var SESSION_TURNS_REMOTE_TIMEOUT_MS = (function () {
  var ev = String(process.env.CLAUDE_USAGE_SESSION_TURNS_REMOTE_TIMEOUT_MS || '').trim();
  var n = parseInt(ev, 10);
  return !isNaN(n) && n >= 30000 ? n : 180000;
})();

function devFetchRemoteUsage(cb, retryCount) {
  if (!__devSource) return cb();
  retryCount = retryCount || 0;
  var maxRetries = 3;
  var retryDelayMs = 5000;
  var url = __devSource.replace(/\/$/, '') + '/api/debug/proxy-logs';
  if (retryCount === 0) serviceLog.info('dev', 'fetching remote data from ' + url);
  var proto = url.startsWith('https') ? require('https') : require('http');
  proto.get(url, function (resp) {
    var body = '';
    resp.on('data', function (chunk) { body += chunk; });
    resp.on('end', function () {
      // Non-200: retry on 502/503/504 (server restarting after cache-reset)
      if (resp.statusCode >= 500 && retryCount < maxRetries) {
        serviceLog.warn('dev', 'remote returned ' + resp.statusCode + ' — retry ' + (retryCount + 1) + '/' + maxRetries + ' in ' + (retryDelayMs / 1000) + 's');
        setTimeout(function () { devFetchRemoteUsage(cb, retryCount + 1); }, retryDelayMs);
        return;
      }
      if (resp.statusCode !== 200) {
        serviceLog.error('dev', 'remote returned ' + resp.statusCode + ': ' + body.slice(0, 200));
        return cb();
      }
      try {
        var parsed = JSON.parse(body);
        var remote = parsed.usage || null;
        if (!remote) {
          serviceLog.warn('dev', 'remote has old format (no usage key) — need deploy with new /api/debug/proxy-logs');
          return cb();
        }
        // Persist proxy NDJSON files locally so /api/quota-divisor can parse per-request data
        var remoteFiles = parsed.files || [];
        if (remoteFiles.length > 0) {
          var logDir = path.join(os.tmpdir(), 'claude-proxy-logs-dev');
          if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
          for (var pfi = 0; pfi < remoteFiles.length; pfi++) {
            fs.writeFileSync(path.join(logDir, remoteFiles[pfi].name), remoteFiles[pfi].content, 'utf8');
          }
          process.env.ANTHROPIC_PROXY_LOG_DIR = logDir;
          serviceLog.info('dev', 'persisted ' + remoteFiles.length + ' proxy log files to ' + logDir);
        }
        remote.dev_source = __devSource;
        remote.generated = new Date().toISOString();
        // Re-enrich outage spans with comp_status from local outage cache
        var localOutage = getOutageDaysMap();
        var remoteDays = remote.days || [];
        for (var rd = 0; rd < remoteDays.length; rd++) {
          var lo = localOutage[remoteDays[rd].date];
          if (lo) {
            remoteDays[rd].outage_spans = lo.spans;
            remoteDays[rd].outage_hours = lo.outage_hours;
            remoteDays[rd].outage_server_hours = lo.server_hours;
            remoteDays[rd].outage_client_hours = lo.client_hours;
            remoteDays[rd].outage_incidents = lo.incidents;
          }
        }
        cachedData = remote;
        cachedData.release_stability = buildReleaseStabilityData();
        var remoteSt = parsed.session_turns;
        if (remoteSt) {
          var stKeys = Object.keys(remoteSt);
          for (var sti = 0; sti < stKeys.length; sti++) {
            _sessionTurnsCache[stKeys[sti]] = { result: remoteSt[stKeys[sti]], fingerprint: 'remote' };
          }
          serviceLog.info('dev', 'session-turns preloaded: ' + stKeys.length + ' days from remote');
        }
        serviceLog.info('dev', 'remote data fetched: ' + (remote.days || []).length + ' days, proxy_days=' + (remote.proxy && remote.proxy.proxy_days ? remote.proxy.proxy_days.length : 0));
        broadcastSse();
      } catch (e) {
        serviceLog.error('dev', 'remote data parse failed: ' + (e.message || e));
      }
      cb();
    });
  }).on('error', function (e) {
    if (retryCount < maxRetries) {
      serviceLog.warn('dev', 'remote fetch error: ' + (e.message || e) + ' — retry ' + (retryCount + 1) + '/' + maxRetries + ' in ' + (retryDelayMs / 1000) + 's');
      setTimeout(function () { devFetchRemoteUsage(cb, retryCount + 1); }, retryDelayMs);
      return;
    }
    serviceLog.error('dev', 'remote data fetch failed after ' + maxRetries + ' retries: ' + (e.message || e));
    cb();
  });
}

/** Lädt nur Proxy-NDJSON vom Remote (nicht die JSONL-Sessionlogs). JSONL bleibt lokal aus parseAllUsageIncremental — sonst fehlen Tage trotz proxy_days. */
function devFetchProxyLogs(cb) {
  var source = (process.env.DEV_PROXY_SOURCE || '').trim();
  if (!source) return cb();
  // Pre-set log dir to temp BEFORE fetch so any early proxy reads go to the right place
  var logDir = path.join(os.tmpdir(), 'claude-proxy-logs-dev');
  if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
  process.env.ANTHROPIC_PROXY_LOG_DIR = logDir;

  var url = source.replace(/\/$/, '') + '/api/debug/proxy-logs';
  serviceLog.info('dev', 'fetching proxy logs from ' + url);
  var proto = url.startsWith('https') ? require('https') : require('http');
  proto.get(url, function (resp) {
    var body = '';
    resp.on('data', function (chunk) { body += chunk; });
    resp.on('end', function () {
      try {
        var parsed = JSON.parse(body);
        var files = parsed.files || [];
        for (var i = 0; i < files.length; i++) {
          fs.writeFileSync(path.join(logDir, files[i].name), files[i].content, 'utf8');
        }
        serviceLog.info('dev', 'fetched ' + files.length + ' proxy log files to ' + logDir);
      } catch (e) {
        serviceLog.error('dev', 'proxy log fetch parse failed: ' + (e.message || e));
      }
      cb();
    });
  }).on('error', function (e) {
    serviceLog.error('dev', 'proxy log fetch failed: ' + (e.message || e));
    cb();
  });
}

// ── /api/session-turns: per-session turn-level token data for a given date ──

var _sessionTurnsCache = Object.create(null);
/** After first successful JSONL scan, preload today's session-turns once after this delay (ms). 0 = disabled (env CLAUDE_USAGE_IDLE_SESSION_PRELOAD_MS). */
var IDLE_SESSION_PRELOAD_MS = (function () {
  var ev = String(process.env.CLAUDE_USAGE_IDLE_SESSION_PRELOAD_MS || '').trim();
  if (ev === '0' || ev === 'off' || ev === 'false') return 0;
  var n = parseInt(ev, 10);
  return !isNaN(n) && n >= 0 ? n : 20000;
})();
var __sessionTurnsIdlePreloadScheduled = false;

function getSessionTurnsCached(dateKey) {
  var noCache = process.env.CLAUDE_USAGE_NO_CACHE === '1' || process.env.CLAUDE_USAGE_NO_CACHE === 'true';
  var t0 = Date.now();
  var today = new Date().toISOString().slice(0, 10);
  var cached = noCache ? null : _sessionTurnsCache[dateKey];
  if (cached && dateKey < today) {
    serviceLog.info('session-turns', 'date=' + dateKey + ' historical HIT (0ms)');
    return cached.result;
  }
  var collected = collectTaggedJsonlFiles();
  var fp = buildTaggedJsonlFingerprintSync(collected.tagged);
  var fpMs = Date.now() - t0;
  if (cached && cached.fingerprint === fp) {
    serviceLog.info('session-turns', 'date=' + dateKey + ' fingerprint HIT (' + fpMs + 'ms stat)');
    return cached.result;
  }
  var result = buildSessionTurnsForDateWithCollected(dateKey, collected.tagged);
  var totalMs = Date.now() - t0;
  var sessions = result && result.sessions ? result.sessions.length : 0;
  var turns = result && result.total_turns ? result.total_turns : 0;
  serviceLog.info('session-turns', 'date=' + dateKey + (noCache ? ' NO_CACHE REBUILD ' : ' REBUILD ') + collected.tagged.length + ' files → ' + sessions + ' sessions, ' + turns + ' turns (' + totalMs + 'ms, fp=' + fpMs + 'ms)');
  if (!noCache) _sessionTurnsCache[dateKey] = { result: result, fingerprint: fp };
  return result;
}

/** Single JSONL pass: union of (dateKey, prev, next) for every date in dateKeys. */
function pass1CollectSessionsForDayWindowFromFiles(dateKeys, files) {
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
  var allSessions = Object.create(null);
  for (var fi = 0; fi < files.length; fi++) {
    var file = files[fi];
    try {
      forEachJsonlLineSync(file.path, function (line) {
        if (!line) return;
        var rec;
        try { rec = JSON.parse(line); } catch (_e) { return; }
        if (rec.type !== 'assistant') return;
        if (rec.isSidechain) return;
        var ts = rec.timestamp;
        if (!ts || typeof ts !== 'string' || ts.length < 19) return;
        var turnDay = ts.slice(0, 10);
        if (!allowedDays[turnDay]) return;
        var msg = rec.message || {};
        var usage = msg.usage;
        if (!usage) return;
        var input = usage.input_tokens || 0;
        var output = usage.output_tokens || 0;
        var cacheRead = usage.cache_read_input_tokens || 0;
        var cacheCreation = usage.cache_creation_input_tokens || 0;
        if (input + output + cacheRead + cacheCreation === 0) return;
        var sid = rec.sessionId;
        if (!sid) return;
        if (!allSessions[sid]) allSessions[sid] = [];
        allSessions[sid].push({
          ts: ts,
          day: turnDay,
          input: input,
          output: output,
          cache_read: cacheRead,
          cache_creation: cacheCreation,
          model: (msg.model || 'unknown').replace(/-\d{8}$/, '')
        });
      });
    } catch (_e) { /* skip unreadable files */ }
  }
  return allSessions;
}

function finalizeSessionTurnsForDate(dateKey, allSessions) {
  var crypto = require('node:crypto');
  var sessions = Object.create(null);
  var totalParsed = 0;
  var sids = Object.keys(allSessions);
  for (var si = 0; si < sids.length; si++) {
    var sid = sids[si];
    var turns = allSessions[sid];
    var hasDateKey = false;
    for (var ti = 0; ti < turns.length; ti++) {
      if (turns[ti].day === dateKey) { hasDateKey = true; break; }
    }
    if (!hasDateKey) continue;
    sessions[sid] = turns;
    totalParsed += turns.length;
  }

  var result = [];
  var resultSids = Object.keys(sessions);
  for (var ri = 0; ri < resultSids.length; ri++) {
    var sid = resultSids[ri];
    var turns = sessions[sid];
    turns.sort(function (a, b) { return a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0; });

    var firstDay = turns[0].day;
    var lastDay = turns[turns.length - 1].day;
    var edgeStart = firstDay < dateKey;
    var edgeEnd = lastDay > dateKey;

    var mapped = [];
    for (var ti = 0; ti < turns.length; ti++) {
      mapped.push({
        index: ti,
        ts: turns[ti].ts,
        input: turns[ti].input,
        output: turns[ti].output,
        cache_read: turns[ti].cache_read,
        cache_creation: turns[ti].cache_creation,
        model: turns[ti].model
      });
    }
    var hash = crypto.createHash('sha256').update(sid).digest('hex').slice(0, 12);
    var entry = {
      session_id_hash: hash,
      turn_count: mapped.length,
      first_ts: turns[0].ts,
      last_ts: turns[turns.length - 1].ts,
      total_output: turns.reduce(function (s, t) { return s + t.output; }, 0),
      total_cache_read: turns.reduce(function (s, t) { return s + t.cache_read; }, 0),
      total_all: turns.reduce(function (s, t) { return s + t.input + t.output + t.cache_read + t.cache_creation; }, 0),
      turns: mapped
    };
    if (edgeStart) entry.edge_start = true;
    if (edgeEnd) entry.edge_end = true;
    result.push(entry);
  }
  result.sort(function (a, b) { return b.total_all - a.total_all; });
  return { date: dateKey, session_count: result.length, total_turns: totalParsed, sessions: result };
}

function buildSessionTurnsForDateWithCollected(dateKey, tagged) {
  var allSessions = pass1CollectSessionsForDayWindowFromFiles([dateKey], tagged);
  return finalizeSessionTurnsForDate(dateKey, allSessions);
}

/** One JSONL scan for multiple calendar days; fills _sessionTurnsCache (unless NO_CACHE). */
function populateSessionTurnsCacheForDates(dateKeys, collectedTagged, fp) {
  var noCache = process.env.CLAUDE_USAGE_NO_CACHE === '1' || process.env.CLAUDE_USAGE_NO_CACHE === 'true';
  var allSessions = pass1CollectSessionsForDayWindowFromFiles(dateKeys, collectedTagged);
  var stByDate = {};
  for (var i = 0; i < dateKeys.length; i++) {
    var dk = dateKeys[i];
    var result = finalizeSessionTurnsForDate(dk, allSessions);
    stByDate[dk] = result;
    if (!noCache) _sessionTurnsCache[dk] = { result: result, fingerprint: fp };
  }
  return stByDate;
}

/**
 * DEV_MODE=full: GET remote session-turns (public API first, then /api/debug if 404).
 * cb(err, statusCode, body, elapsedMs) — body string; err set on network/timeout.
 */
function devProxyFetchRemoteSessionTurns(remoteBase, dateStr, useDebugPath, timeoutMs, cb) {
  var pathPart = useDebugPath ? '/api/debug/session-turns?date=' : '/api/session-turns?date=';
  var stRemoteUrl = remoteBase.replace(/\/$/, '') + pathPart + encodeURIComponent(dateStr);
  var stT0r = Date.now();
  serviceLog.info('session-turns', 'REMOTE → ' + stRemoteUrl);
  var stProto = stRemoteUrl.startsWith('https') ? require('https') : require('http');
  var stReq = stProto.get(stRemoteUrl, { timeout: timeoutMs }, function (stResp) {
    var stBody = '';
    stResp.on('data', function (ch) { stBody += ch; });
    stResp.on('end', function () {
      cb(null, stResp.statusCode, stBody, Date.now() - stT0r);
    });
  });
  stReq.on('timeout', function () {
    stReq.destroy();
    cb(new Error('remote_session_turns_timeout'), 0, '', Date.now() - stT0r);
  });
  stReq.on('error', function (stErr) {
    cb(stErr, 0, '', Date.now() - stT0r);
  });
}

var server = http.createServer(function (req, res) {
  var pathname = dashboardHttp.requestPathname(req.url);
  if (
    pathname === '/api/usage' ||
    pathname === '/api/stream' ||
    pathname === '/api/extension-timeline' ||
    pathname === '/api/github-releases-refresh' ||
    pathname === '/api/marketplace-refresh' ||
    pathname === '/api/github-session-sync' ||
    pathname === '/api/claude-data-sync'
  ) {
    syncGithubTokenFromBrowserRequest(req);
  }
  if (dashboardHttp.tryServeDashboardAsset(DASHBOARD_SCRIPT_DIR, pathname, res)) return;

  if (pathname === '/api/usage') {
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      Pragma: 'no-cache'
    });
    res.end(JSON.stringify(cachedData));
  } else if (pathname === '/api/extension-timeline') {
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      Pragma: 'no-cache'
    });
    res.end(JSON.stringify(buildExtensionTimelineApiResponse()));
  } else if (pathname === '/api/i18n-bundles') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(buildI18nBundles()));
  } else if (pathname === '/api/github-session-sync' && req.method === 'GET') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' });
    res.end();
  } else if (pathname === '/api/stream') {
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
  } else if (pathname === '/api/github-releases-refresh') {
    var cors = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-GitHub-Token'
      });
      res.end();
      return;
    }
    if (req.method !== 'POST') {
      res.writeHead(405, Object.assign({ Allow: 'POST, OPTIONS' }, cors));
      res.end(JSON.stringify({ ok: false, error: 'method_not_allowed' }));
      return;
    }
    var adminTok = String(process.env.CLAUDE_USAGE_ADMIN_TOKEN || '').trim();
    if (adminTok) {
      var authH = String(req.headers.authorization || '');
      var okAuth = authH === 'Bearer ' + adminTok;
      if (!okAuth) {
        res.writeHead(401, cors);
        res.end(JSON.stringify({ ok: false, error: 'unauthorized' }));
        return;
      }
    }
    refreshReleasesCache();
    res.writeHead(200, cors);
    res.end(JSON.stringify({ ok: true, message: 'github_releases_refresh_started' }));
  } else if (pathname === '/api/marketplace-refresh') {
    var corsMp = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-GitHub-Token'
      });
      res.end();
      return;
    }
    if (req.method !== 'POST') {
      res.writeHead(405, Object.assign({ Allow: 'POST, OPTIONS' }, corsMp));
      res.end(JSON.stringify({ ok: false, error: 'method_not_allowed' }));
      return;
    }
    var adminTokMp = String(process.env.CLAUDE_USAGE_ADMIN_TOKEN || '').trim();
    if (adminTokMp) {
      var authMp = String(req.headers.authorization || '');
      if (authMp !== 'Bearer ' + adminTokMp) {
        res.writeHead(401, corsMp);
        res.end(JSON.stringify({ ok: false, error: 'unauthorized' }));
        return;
      }
    }
    refreshMarketplaceExtensionCache();
    res.writeHead(200, corsMp);
    res.end(JSON.stringify({ ok: true, message: 'marketplace_refresh_started' }));
  } else if (pathname === '/api/debug/proxy-logs' && process.env.DEBUG_API === '1') {
    // Debug: vollständiges usage + alle proxy-*.ndjson als { name, content }.
    // DEV_MODE=proxy (devFetchProxyLogs) braucht `files` — sonst bleibt das Zielverzeichnis leer und proxy_days passt nicht zu lokalen JSONL-Tagen.
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store'
    });
    var proxyNdjsonExport = [];
    var proxyPathsExport = collectProxyNdjsonFiles();
    for (var pxi = 0; pxi < proxyPathsExport.length; pxi++) { var proxyPath = proxyPathsExport[pxi];
      try {
        proxyNdjsonExport.push({
          name: path.basename(proxyPath),
          content: fs.readFileSync(proxyPath, 'utf8')
        });
      } catch (error) {
        serviceLog.warn(
          'proxy-parse',
          'debug proxy-logs read failed ' + proxyPath + ': ' + (error.message || error)
        );
      }
    }
    var collectedSt = collectTaggedJsonlFiles();
    var fpSt = buildTaggedJsonlFingerprintSync(collectedSt.tagged);
    var stDates = [];
    for (var stDi = 0; stDi < 7; stDi++) {
      stDates.push(new Date(Date.now() - stDi * 86400000).toISOString().slice(0, 10));
    }
    var stBatchT0 = Date.now();
    var stByDate = populateSessionTurnsCacheForDates(stDates, collectedSt.tagged, fpSt);
    serviceLog.info('session-turns', 'debug/proxy-logs batch 7d → ' + (Date.now() - stBatchT0) + 'ms');
    res.end(JSON.stringify({ usage: cachedData, files: proxyNdjsonExport, session_turns: stByDate }));
  } else if (pathname === '/api/debug/sync-proxy-logs' && __devMode && __devSource) {
    // Manual trigger: re-fetch data from remote
    var corsSync = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };
    if (__devMode === 'full') {
      devFetchRemoteUsage(function () {});
    } else {
      devFetchProxyLogs(function () {
        refreshProxyCache();
        if (__proxyCache.data && cachedData) { cachedData.proxy = __proxyCache.data; broadcastSse(); }
      });
    }
    res.writeHead(200, corsSync);
    res.end(JSON.stringify({ ok: true, message: 'sync_started', mode: __devMode }));
  } else if (pathname === '/api/debug/status') {
    // Debug status: expose dev mode info to the frontend
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({
      dev_mode: __devMode || null,
      dev_proxy_source: __devSource || null,
      refresh_sec: REFRESH_SEC,
      version: __appVersion,
      claude_data_sync_enabled: !!getClaudeUsageSyncToken()
    }));
  } else if (pathname === '/api/debug/cache-reset' && req.method === 'POST' && process.env.DEBUG_API === '1') {
    // Loescht Day-Cache + Today-Index und triggert Full-Rescan
    if (fs.existsSync(USAGE_DAY_CACHE_FILE)) fs.unlinkSync(USAGE_DAY_CACHE_FILE);
    if (fs.existsSync(JSONL_TODAY_INDEX_FILE)) fs.unlinkSync(JSONL_TODAY_INDEX_FILE);
    serviceLog.info('cache', 'cache-reset via /api/debug/cache-reset — full rescan triggered');
    runScanAndBroadcast();
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ ok: true, message: 'Day cache deleted, full rescan started' }));
  } else if (pathname === '/api/debug/session-turns' && process.env.DEBUG_API === '1') {
    var dstUrl = new URL(req.url, 'http://localhost');
    var dstDate = dstUrl.searchParams.get('date') || new Date().toISOString().slice(0, 10);
    var dstT0 = Date.now();
    var dstResult = getSessionTurnsCached(dstDate);
    var dstMs = Date.now() - dstT0;
    serviceLog.info('session-turns', 'GET /api/debug/session-turns?date=' + dstDate + ' → ' + dstMs + 'ms');
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(dstResult));
  } else if (pathname === '/api/proxy-usage') {
    if (!__proxyCache.data) refreshProxyCache();
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      Pragma: 'no-cache'
    });
    res.end(JSON.stringify(__proxyCache.data));
  } else if (pathname === '/api/claude-data-sync') {
    handleClaudeDataSyncRequest(req, res);
  } else if (pathname === '/api/quota-divisor') {
    // Per-request quota divisor analysis: correlates token costs with q5 deltas
    var qdUrl = new URL(req.url, 'http://localhost');
    var qdDate = qdUrl.searchParams.get('date'); // optional: single day
    var proxyData = __proxyCache.data || parseProxyNdjsonFiles();
    var pdays = proxyData.proxy_days || [];

    // Opus 4.6 published pricing ($/MTok)
    var PRICE = { cache_read: 1.50, cache_creation: 18.75, input: 15.0, output: 75.0 };

    var allSamples = [];
    var dailySummaries = [];

    for (var qi = 0; qi < pdays.length; qi++) {
      var qd = pdays[qi];
      if (qdDate && qd.date !== qdDate) continue;
      var qs = qd._q5_samples_raw || qd.q5_samples_raw;
      // Rebuild from cached proxy data — q5_samples are in-memory during parse
      // We need the raw samples; fall back to re-parsing if not available
    }

    // Re-parse proxy logs to get per-request q5 + full token data
    var proxyFiles = collectProxyNdjsonFiles();
    var requestPairs = []; // { date, ts, q5, q5_prev, delta, cost, tokens }

    for (var qfi = 0; qfi < proxyFiles.length; qfi++) {
      var qfDate = path.basename(proxyFiles[qfi]).replace('proxy-', '').replace('.ndjson', '');
      if (qdDate && qfDate !== qdDate) continue;
      var prevQ5 = null;
      try {
        forEachJsonlLineSync(proxyFiles[qfi], function(line) {
          if (!line.trim()) return;
          var rec;
          try { rec = JSON.parse(line); } catch (_e) { return; }
          if (!rec.usage) return;
          var rah = rec.response_anthropic_headers || {};
          var q5Str = rah['anthropic-ratelimit-unified-5h-utilization'];
          if (q5Str == null) return;
          var q5 = parseFloat(q5Str);
          if (isNaN(q5) || q5 < 0) return;

          var u = rec.usage;
          var cr = u.cache_read_input_tokens || 0;
          var cc = u.cache_creation_input_tokens || 0;
          var inp = u.input_tokens || 0;
          var out = u.output_tokens || 0;
          var cost = cr * PRICE.cache_read / 1e6 + cc * PRICE.cache_creation / 1e6 +
                     inp * PRICE.input / 1e6 + out * PRICE.output / 1e6;

          var delta = (prevQ5 !== null) ? q5 - prevQ5 : null;
          if (delta !== null && delta > 0 && cost > 0) {
            var impliedDivisor = cost / delta;
            requestPairs.push({
              date: qfDate,
              ts: rec.ts_end || rec.ts_start || '',
              q5_prev: prevQ5,
              q5: q5,
              delta: delta,
              cost: Math.round(cost * 100) / 100,
              implied_divisor: Math.round(impliedDivisor * 100) / 100,
              cache_read: cr,
              cache_creation: cc,
              input: inp,
              output: out,
              cache_pct: cr > 0 ? Math.round(cr / (cr + cc + inp + out) * 100) : 0
            });
          }
          prevQ5 = q5;
        });
      } catch (_e) { /* skip */ }
    }

    // Aggregate by date
    var byDate = {};
    for (var rp = 0; rp < requestPairs.length; rp++) {
      var pair = requestPairs[rp];
      if (!byDate[pair.date]) byDate[pair.date] = { pairs: [], divisors: [], costs: [], deltas: [] };
      byDate[pair.date].pairs.push(pair);
      byDate[pair.date].divisors.push(pair.implied_divisor);
      byDate[pair.date].costs.push(pair.cost);
      byDate[pair.date].deltas.push(pair.delta);
    }

    var dateSummaries = [];
    var dateKeys = Object.keys(byDate).sort();
    for (var dk = 0; dk < dateKeys.length; dk++) {
      var bd = byDate[dateKeys[dk]];
      var divs = bd.divisors.slice().sort(function(a, b) { return a - b; });
      var totalCost = bd.costs.reduce(function(s, c) { return s + c; }, 0);
      var totalDelta = bd.deltas.reduce(function(s, d) { return s + d; }, 0);
      dateSummaries.push({
        date: dateKeys[dk],
        request_pairs: bd.pairs.length,
        weighted_divisor: totalDelta > 0 ? Math.round(totalCost / totalDelta * 100) / 100 : null,
        median_divisor: divs.length > 0 ? divs[Math.floor(divs.length / 2)] : null,
        p10_divisor: divs.length >= 10 ? divs[Math.floor(divs.length * 0.1)] : divs[0] || null,
        p90_divisor: divs.length >= 10 ? divs[Math.floor(divs.length * 0.9)] : divs[divs.length - 1] || null,
        total_cost: Math.round(totalCost * 100) / 100,
        total_q5_delta: Math.round(totalDelta * 10000) / 10000
      });
    }

    var qdResult = {
      pricing: PRICE,
      note: 'implied_divisor = API_cost / q5_delta. If constant, quota is a simple linear mapping of cost.',
      requested_date: qdDate || null,
      no_proxy_logs: !!(qdDate && requestPairs.length === 0),
      date_summaries: dateSummaries,
      request_pairs: requestPairs.length > 2000 ? requestPairs.slice(0, 2000) : requestPairs,
      truncated: requestPairs.length > 2000
    };
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(qdResult));
  } else if (pathname === '/api/session-turns') {
    var stUrl = new URL(req.url, 'http://localhost');
    var stDate = stUrl.searchParams.get('date') || new Date().toISOString().slice(0, 10);
    if (__devMode === 'full' && __devSource) {
      var stCachedDev = _sessionTurnsCache[stDate];
      if (stCachedDev) {
        serviceLog.info('session-turns', 'DEV local cache HIT date=' + stDate + ' (0ms, fp=' + String(stCachedDev.fingerprint) + ')');
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(stCachedDev.result));
        return;
      }
      var stBaseDev = __devSource.replace(/\/$/, '');
      var stRetryDelayMs = 5000;
      var stMaxRetries = 2;
      function devSessionTurnsRespond(stCode, stBody, stErr) {
        if (stErr) {
          res.writeHead(502, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
          res.end(JSON.stringify({ error: 'remote_fetch_failed', message: stErr.message || String(stErr) }));
          return;
        }
        if (stCode === 200 && stBody) {
          try {
            var stParsedR = JSON.parse(stBody);
            _sessionTurnsCache[stDate] = { result: stParsedR, fingerprint: 'remote' };
            serviceLog.info('session-turns', 'DEV cached date=' + stDate + ' (' + (stParsedR.sessions ? stParsedR.sessions.length : 0) + ' sessions)');
          } catch (eR) { /* pass through body */ }
        }
        res.writeHead(stCode || 200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' });
        res.end(stBody || JSON.stringify({ error: 'remote_empty' }));
      }
      function runRemoteSessionTurns(useDebugPath, retryNum) {
        devProxyFetchRemoteSessionTurns(stBaseDev, stDate, useDebugPath, SESSION_TURNS_REMOTE_TIMEOUT_MS, function (stErr, stCode, stBody, stMs) {
          serviceLog.info(
            'session-turns',
            'REMOTE date=' + stDate + ' try=' + (retryNum + 1) + ' → ' + stMs + 'ms (' + (stErr ? (stErr.message || 'err') : String(stCode)) + ')' + (useDebugPath ? ' [debug]' : '')
          );
          if (!stErr && stCode === 404 && !useDebugPath) {
            runRemoteSessionTurns(true, 0);
            return;
          }
          var stRetryable = !!stErr || (stCode >= 500 && stCode < 600);
          if (stRetryable && retryNum < stMaxRetries) {
            serviceLog.warn('session-turns', 'REMOTE retry ' + (retryNum + 2) + '/' + (stMaxRetries + 1) + ' in ' + (stRetryDelayMs / 1000) + 's');
            setTimeout(function () { runRemoteSessionTurns(useDebugPath, retryNum + 1); }, stRetryDelayMs);
            return;
          }
          devSessionTurnsRespond(stCode, stBody, stErr);
        });
      }
      runRemoteSessionTurns(false, 0);
    } else {
      var stT0 = Date.now();
      var stResult = getSessionTurnsCached(stDate);
      var stMs = Date.now() - stT0;
      serviceLog.info('session-turns', 'GET /api/session-turns?date=' + stDate + ' → ' + stMs + 'ms');
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-store, no-cache, must-revalidate',
        Pragma: 'no-cache'
      });
      res.end(JSON.stringify(stResult));
    }
  } else {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(getDashboardHtml());
  }
});

function startupDevFull() {
  try { getDashboardHtml(); } catch (error) { serviceLog.warn('dev', 'template init: ' + (error.message || error)); }
  serviceLog.info('dev', 'DEV_MODE=full — all data from ' + __devSource);
  if (process.env.CLAUDE_USAGE_NO_CACHE === '1') {
    serviceLog.info('dev', '--no-cache: sending POST /api/debug/cache-reset to ' + __devSource);
    try {
      var resetUrl = new URL('/api/debug/cache-reset', __devSource);
      var resetMod = resetUrl.protocol === 'https:' ? https : http;
      var resetReq = resetMod.request(resetUrl, { method: 'POST', timeout: 10000 }, function(r) {
        var b = '';
        r.on('data', function(c) { b += c; });
        r.on('end', function() { serviceLog.info('dev', 'remote cache-reset response: ' + r.statusCode + ' ' + b.slice(0, 200)); });
      });
      resetReq.on('error', function(e) { serviceLog.warn('dev', 'remote cache-reset failed: ' + (e.message || e)); });
      resetReq.end();
    } catch (e) { serviceLog.warn('dev', 'remote cache-reset error: ' + (e.message || e)); }
  }
  devFetchRemoteUsage(function () { __devProxyPending = false; });
  setInterval(function () { devFetchRemoteUsage(function () {}); }, REFRESH_SEC * 1000);
}

function startupDevProxy() {
  serviceLog.info('dev', 'DEV_MODE=proxy — local JSONL + remote proxy from ' + __devSource);
  primeDashboardAndScheduleFirstScan();
  devFetchProxyLogs(function () {
    __devProxyPending = false;
    setTimeout(function () {
      refreshProxyCache();
      if (__proxyCache.data && cachedData) { cachedData.proxy = __proxyCache.data; broadcastSse(); }
    }, 3000);
  });
  setInterval(function () {
    devFetchProxyLogs(function () {
      refreshProxyCache();
      if (__proxyCache.data && cachedData) { cachedData.proxy = __proxyCache.data; broadcastSse(); }
    });
  }, REFRESH_SEC * 1000);
  setTimeout(refreshOutageCache, 400);
  setTimeout(maybeRefreshReleasesCacheOnStartup, 1400);
  setTimeout(refreshMarketplaceExtensionCache, 2400);
}

server.listen(PORT, function () {
  console.log('Claude Code Usage Dashboard running at http://localhost:' + PORT);
  console.log('Voller Scan alle ' + REFRESH_SEC + 's (--refresh=N, min 60; oder CLAUDE_USAGE_SCAN_INTERVAL_SEC)');
  console.log(
    'Erster Scan startet nach Dashboard-Vorlauf +' +
      PARSE_START_DELAY_MS +
      ' ms (CLAUDE_USAGE_PARSE_START_DELAY_MS); danach inkrementell per SSE.'
  );
  console.log('Press Ctrl+C to stop.');
  serviceLog.info(
    'server',
    'listen port=' +
      PORT +
      ' refresh_sec=' +
      REFRESH_SEC +
      ' parse_start_delay_ms=' +
      PARSE_START_DELAY_MS +
      ' log_level=' +
      (process.env.CLAUDE_USAGE_LOG_LEVEL || 'info') +
      (process.env.CLAUDE_USAGE_LOG_FILE ? ' log_file=' + process.env.CLAUDE_USAGE_LOG_FILE : '')
  );
  if (__devMode === 'full' && __devSource) {
    startupDevFull();
  } else if (__devMode === 'proxy' && __devSource) {
    startupDevProxy();
  } else {
    primeDashboardAndScheduleFirstScan();
    setTimeout(refreshOutageCache, 400);
    setTimeout(maybeRefreshReleasesCacheOnStartup, 1400);
    setTimeout(refreshMarketplaceExtensionCache, 2400);
  }
});

if (!__devMode) {
  setInterval(runScanAndBroadcast, REFRESH_SEC * 1000);
  setInterval(refreshProxyCache, REFRESH_SEC * 1000);
} else if (__devMode === 'proxy') {
  setInterval(runScanAndBroadcast, REFRESH_SEC * 1000);
}
setInterval(refreshOutageCache, OUTAGE_REFRESH_MS);
setInterval(refreshMarketplaceExtensionCache, 6 * 60 * 60 * 1000);
