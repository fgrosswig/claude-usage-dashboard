'use strict';
/**
 * Empfängt ein .tar.gz (POSIX tar) und schreibt erlaubte Pfade unter claudeRoot (typisch ~/.claude).
 * Nur Unterbäume projects/ und anthropic-proxy-logs/ (keine Pfade mit ..).
 * Extraktion via System-tar (Busybox/GNU tar.exe); keine npm-Abhängigkeit.
 */
var fs = require('fs');
var path = require('path');
var os = require('os');
var cp = require('child_process');

function normalizeSlashes(s) {
  return String(s || '')
    .split('\\')
    .join('/')
    .replace(/^\/+/, '');
}

function stripLeadingDotClaude(rel) {
  var r = normalizeSlashes(rel);
  if (r.indexOf('.claude/') === 0) return r.slice('.claude/'.length);
  return r;
}

function mapStagingRelToTargetRel(stagingRel) {
  var r = stripLeadingDotClaude(stagingRel);
  r = normalizeSlashes(r);
  if (r.indexOf('projects/') === 0 || r.indexOf('anthropic-proxy-logs/') === 0) return r;
  return null;
}

function mkdirpSync(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
  }
}

function walkFilesSync(rootDir) {
  var out = [];
  function walk(d) {
    var list;
    try {
      list = fs.readdirSync(d, { withFileTypes: true });
    } catch (e) {
      return;
    }
    for (var i = 0; i < list.length; i++) {
      var ent = list[i];
      var full = path.join(d, ent.name);
      if (ent.isDirectory()) walk(full);
      else if (ent.isFile()) out.push(full);
    }
  }
  walk(rootDir);
  return out;
}

/**
 * @param {string} tarGzPath absolute path to uploaded archive
 * @param {string} claudeRoot e.g. ~/.claude
 * @param {function(Error|null, { filesWritten: number })} cb
 */
function extractTarGzIntoClaudeRoot(tarGzPath, claudeRoot, cb) {
  var staging;
  try {
    staging = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-ingest-'));
  } catch (e) {
    cb(e, null);
    return;
  }

  var tarBin = process.env.CLAUDE_USAGE_SYNC_TAR || 'tar';
  var child = cp.spawn(tarBin, ['-xzf', tarGzPath, '-C', staging], {
    stdio: 'ignore',
    windowsHide: true
  });
  child.on('error', function (err) {
    try {
      fs.rmSync(staging, { recursive: true, force: true });
    } catch (e2) {}
    cb(err, null);
  });
  child.on('close', function (code) {
    if (code !== 0) {
      try {
        fs.rmSync(staging, { recursive: true, force: true });
      } catch (e2) {}
      cb(new Error('tar exited ' + code), null);
      return;
    }
    var written = 0;
    try {
      var absRoot = path.resolve(claudeRoot);
      var files = walkFilesSync(staging);
      for (var fi = 0; fi < files.length; fi++) {
        var absFile = files[fi];
        var rel = path.relative(staging, absFile);
        var targetRel = mapStagingRelToTargetRel(rel);
        if (!targetRel || targetRel.indexOf('..') >= 0) continue;
        var dest = path.join(absRoot, targetRel.split('/').join(path.sep));
        var resolved = path.resolve(dest);
        if (resolved !== absRoot && !resolved.startsWith(absRoot + path.sep)) continue;
        mkdirpSync(path.dirname(resolved));
        fs.copyFileSync(absFile, resolved);
        written++;
      }
    } catch (e3) {
      try {
        fs.rmSync(staging, { recursive: true, force: true });
      } catch (e4) {}
      cb(e3, null);
      return;
    }
    try {
      fs.rmSync(staging, { recursive: true, force: true });
    } catch (e5) {}
    cb(null, { filesWritten: written });
  });
}

module.exports = {
  extractTarGzIntoClaudeRoot: extractTarGzIntoClaudeRoot
};
