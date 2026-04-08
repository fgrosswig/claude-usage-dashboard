'use strict';
/**
 * Gemeinsame Logik: Scan-Wurzeln (~/.claude/projects + CLAUDE_USAGE_EXTRA_BASES),
 * JSONL-Sammeln. Von dashboard-server und token-forensics genutzt.
 */
var fs = require('fs');
var path = require('path');
var os = require('os');
var StringDecoder = require('string_decoder').StringDecoder;

var HOME = process.env.USERPROFILE || process.env.HOME || os.homedir();
var BASE = path.join(HOME, '.claude', 'projects');

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
    var baseName = path.basename(abs.replace(/[/\\]$/, ''));
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

/** Pro Tick maximal so viele readdirSync-Aufrufe — sonst blockiert die komplette Projektwandlung lange den Event-Loop (Server wirkt „eingefroren“). */
var WALK_JSONL_READDIRS_PER_SLICE = 40;
(function () {
  var e = process.env.CLAUDE_USAGE_WALK_SLICE;
  if (!e) return;
  var n = parseInt(e, 10);
  if (!isNaN(n) && n >= 5 && n <= 500) WALK_JSONL_READDIRS_PER_SLICE = n;
})();

/**
 * Alle *.jsonl unter startDir (rekursiv). Gibt den Event-Loop zwischen readdir-Batches frei —
 * wichtig für schnellen HTTP/SSE direkt nach server.listen.
 */
function walkJsonlYielding(startDir, cb) {
  var files = [];
  var stack = [];
  try {
    stack.push(path.resolve(startDir));
  } catch (e) {
    process.nextTick(function () {
      cb(files);
    });
    return;
  }
  function pump() {
    var budget = WALK_JSONL_READDIRS_PER_SLICE;
    while (budget-- > 0 && stack.length) {
      var d = stack.pop();
      try {
        var entries = fs.readdirSync(d, { withFileTypes: true });
        for (var i = entries.length - 1; i >= 0; i--) {
          var fp = path.join(d, entries[i].name);
          if (entries[i].isDirectory()) stack.push(fp);
          else if (entries[i].name.endsWith('.jsonl')) files.push(fp);
        }
      } catch (e2) {}
    }
    if (stack.length) setImmediate(pump);
    else cb(files);
  }
  setImmediate(pump);
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

/** Wie collectTaggedJsonlFiles, aber zwischen Wurzeln und readdir-Slices mit setImmediate — Server bleibt beim Start bedienbar. */
function collectTaggedJsonlFilesAsync(cb) {
  var roots = getScanRoots();
  var seen = Object.create(null);
  var tagged = [];
  var ri = 0;
  function nextRoot() {
    if (ri >= roots.length) {
      cb(null, { tagged: tagged, roots: roots });
      return;
    }
    var R = roots[ri++];
    walkJsonlYielding(R.path, function (list) {
      for (var fi = 0; fi < list.length; fi++) {
        var fp = path.resolve(list[fi]);
        if (seen[fp]) continue;
        seen[fp] = true;
        tagged.push({ path: fp, label: R.label, rootPath: R.path });
      }
      setImmediate(nextRoot);
    });
  }
  setImmediate(nextRoot);
}

/**
 * Zeilenweises Lesen ohne fs.readFileSync(utf8) — sonst bei sehr großen JSONL
 * V8: „Cannot create a string longer than 0x1fffffe8 characters“.
 * UTF-8-sicher über StringDecoder (Mehrbyte-Zeichen an Chunk-Grenzen).
 */
function forEachJsonlLineSync(filePath, onLine) {
  var fd = fs.openSync(filePath, 'r');
  var buf = Buffer.alloc(1024 * 1024);
  var decoder = new StringDecoder('utf8');
  var leftover = '';
  try {
    while (true) {
      var nread = fs.readSync(fd, buf, 0, buf.length, null);
      if (nread === 0) break;
      leftover += decoder.write(buf.subarray(0, nread));
      var start = 0;
      while (true) {
        var nl = leftover.indexOf('\n', start);
        if (nl < 0) break;
        var line = leftover.slice(start, nl).replace(/\r$/, '');
        start = nl + 1;
        onLine(line);
      }
      leftover = leftover.slice(start);
    }
    leftover += decoder.end();
    if (leftover.length) onLine(leftover.replace(/\r$/, ''));
  } finally {
    fs.closeSync(fd);
  }
}

module.exports = {
  HOME: HOME,
  BASE: BASE,
  expandUserPath: expandUserPath,
  discoverHostImportDirs: discoverHostImportDirs,
  isExtraBasesAutoMode: isExtraBasesAutoMode,
  getScanRoots: getScanRoots,
  scanRootsCacheKey: scanRootsCacheKey,
  walkJsonl: walkJsonl,
  walkJsonlYielding: walkJsonlYielding,
  collectTaggedJsonlFiles: collectTaggedJsonlFiles,
  collectTaggedJsonlFilesAsync: collectTaggedJsonlFilesAsync,
  forEachJsonlLineSync: forEachJsonlLineSync,
  getProxyLogDir: getProxyLogDir,
  collectProxyNdjsonFiles: collectProxyNdjsonFiles
};

// ── Proxy NDJSON log discovery ────────────────────────────────────────────

var PROXY_LOG_DIR_NAME = 'anthropic-proxy-logs';

function getProxyLogDir() {
  return process.env.ANTHROPIC_PROXY_LOG_DIR ||
    path.join(HOME, '.claude', PROXY_LOG_DIR_NAME);
}

/** Collect all proxy-*.ndjson files from the proxy log directory. */
function collectProxyNdjsonFiles() {
  var logDir = getProxyLogDir();
  var files = [];
  try {
    var entries = fs.readdirSync(logDir, { withFileTypes: true });
    for (var i = 0; i < entries.length; i++) {
      if (entries[i].isFile() && entries[i].name.endsWith('.ndjson')) {
        files.push(path.join(logDir, entries[i].name));
      }
    }
  } catch (e) {}
  files.sort();
  return files;
}
