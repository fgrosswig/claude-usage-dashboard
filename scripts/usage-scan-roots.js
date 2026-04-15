'use strict';
/**
 * Gemeinsame Logik: Scan-Wurzeln (~/.claude/projects + CLAUDE_USAGE_EXTRA_BASES),
 * JSONL-Sammeln. Von dashboard-server und token-forensics genutzt.
 */
var fs = require('node:fs');
var path = require('node:path');
var os = require('node:os');
var StringDecoder = require('node:string_decoder').StringDecoder;

var HOME = process.env.USERPROFILE || process.env.HOME || os.homedir();
var BASE = path.join(HOME, '.claude', 'projects');

function expandUserPath(p) {
  if (typeof p !== 'string') return '';
  p = p.trim();
  if (!p) return '';
  if (p === '~') return HOME;
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(HOME, p.slice(2));
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
    for (var entry of entries) {
      if (!entry.isDirectory()) continue;
      var name = entry.name;
      if (!/^HOST-/i.test(name)) continue;
      out.push({ path: path.join(absParent, name), label: name });
    }
  } catch (error) { /* intentional */ }
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

/** Auto-detect Claude Desktop App sessions directory (Windows UWP / macOS / Linux). */
function getDesktopAppSessionsDir() {
  var platform = process.platform;
  if (platform === 'win32') {
    // Windows UWP (Microsoft Store) path
    var localAppData = process.env.LOCALAPPDATA || path.join(HOME, 'AppData', 'Local');
    var packagesDir = path.join(localAppData, 'Packages');
    try {
      var entries = fs.readdirSync(packagesDir, { withFileTypes: true });
      for (var entry of entries) {
        if (entry.isDirectory() && entry.name.startsWith('Claude_')) {
          var sessDir = path.join(packagesDir, entry.name, 'LocalCache', 'Roaming', 'Claude', 'local-agent-mode-sessions');
          if (fs.existsSync(sessDir)) return sessDir;
        }
      }
    } catch (error) { /* intentional */ }
    // Non-UWP install path
    var roaming = process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming');
    var nonUwp = path.join(roaming, 'Claude', 'local-agent-mode-sessions');
    if (fs.existsSync(nonUwp)) return nonUwp;
  } else if (platform === 'darwin') {
    var macDir = path.join(HOME, 'Library', 'Application Support', 'Claude', 'local-agent-mode-sessions');
    if (fs.existsSync(macDir)) return macDir;
  } else {
    // Linux: XDG_CONFIG_HOME or ~/.config
    var configDir = process.env.XDG_CONFIG_HOME || path.join(HOME, '.config');
    var linuxDir = path.join(configDir, 'Claude', 'local-agent-mode-sessions');
    if (fs.existsSync(linuxDir)) return linuxDir;
  }
  return null;
}

function getScanRoots() {
  var roots = [{ path: BASE, label: 'local' }];
  // Auto-discover Claude Desktop App sessions
  var desktopDir = getDesktopAppSessionsDir();
  if (desktopDir) {
    roots.push({ path: desktopDir, label: 'desktop-app' });
  }
  var raw = process.env.CLAUDE_USAGE_EXTRA_BASES || '';
  if (!raw.trim()) return roots;
  if (isExtraBasesAutoMode(raw)) {
    var rootRaw = (process.env.CLAUDE_USAGE_EXTRA_BASES_ROOT || '').trim();
    var autoRoot = rootRaw ? expandUserPath(rootRaw) : process.cwd();
    if (autoRoot) {
      var discovered = discoverHostImportDirs(autoRoot);
      for (var disc of discovered) {
        roots.push(disc);
      }
    }
    return roots;
  }
  var parts = raw.split(';');
  for (var chunk of parts) {
    var trimChunk = chunk.trim();
    if (!trimChunk) continue;
    var abs = expandUserPath(trimChunk);
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
  for (var root of roots) {
    try {
      paths.push(path.resolve(root.path));
    } catch (e) {
      paths.push(String(root.path));
    }
  }
  paths.sort(function (a, b) {
    return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: "base" });
  });
  return paths.join('|');
}

function walkJsonl(dir) {
  var files = [];
  try {
    var entries = fs.readdirSync(dir, { withFileTypes: true });
    for (var entry of entries) {
      var fp = path.join(dir, entry.name);
      if (entry.isDirectory()) files = files.concat(walkJsonl(fp));
      else if (entry.name.endsWith('.jsonl')) files.push(fp);
    }
  } catch (error) { /* intentional */ }
  return files;
}

/** Pro Tick maximal so viele readdirSync-Aufrufe — sonst blockiert die komplette Projektwandlung lange den Event-Loop (Server wirkt „eingefroren“). */
var WALK_JSONL_READDIRS_PER_SLICE = 40;
(function () {
  var e = process.env.CLAUDE_USAGE_WALK_SLICE;
  if (!e) return;
  var n = Number.parseInt(e, 10);
  if (!Number.isNaN(n) && n >= 5 && n <= 500) WALK_JSONL_READDIRS_PER_SLICE = n;
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
      } catch (error) { /* intentional */ }
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
  for (var R of roots) {
    var list;
    try {
      list = walkJsonl(R.path);
    } catch (e) {
      list = [];
    }
    for (var lf of list) {
      var fp = path.resolve(lf);
      if (seen[fp]) continue;
      seen[fp] = true;
      tagged.push({ path: fp, label: R.label, rootPath: R.path });
    }
  }
  return { tagged: tagged, roots: roots };
}

/** mtimeMs + size aller JSONL (sortiert); gleicher String wie dashboard-server früher — für Disk-Cache / session-turns-warm-cache.py. */
function buildTaggedJsonlFingerprintSync(tagged) {
  var parts = [];
  for (var ref of tagged) {
    var p = typeof ref === 'string' ? ref : ref.path;
    var abs = path.resolve(p);
    try {
      var st = fs.statSync(abs);
      parts.push(abs + ':' + st.mtimeMs + ':' + st.size);
    } catch (eSt) {
      parts.push(abs + ':err');
    }
  }
  parts.sort(function (a, b) {
    return a.localeCompare(b);
  });
  return parts.join('\n');
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
      for (var lf of list) {
        var fp = path.resolve(lf);
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
  buildTaggedJsonlFingerprintSync: buildTaggedJsonlFingerprintSync,
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
    for (var entry of entries) {
      if (entry.isFile() && entry.name.endsWith('.ndjson')) {
        files.push(path.join(logDir, entry.name));
      }
    }
  } catch (error) { /* intentional */ }
  files.sort(function (a, b) {
    return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: "base" });
  });
  return files;
}
