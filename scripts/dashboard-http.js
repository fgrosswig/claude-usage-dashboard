'use strict';
/**
 * HTTP helpers for the usage dashboard: static assets under /assets/ (served from ./public).
 * Paths are whitelisted; no directory traversal.
 */
var fs = require('fs');
var path = require('path');

var MIME = {
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8'
};

/** pathname -> path segments relative to script root (must stay under public/) */
var ASSET_ROUTES = {
  '/assets/dashboard.css': ['public', 'css', 'dashboard.css'],
  '/assets/cache-files-explorer.js': ['public', 'js', 'cache-files-explorer.js'],
  '/assets/widget-registry.js': ['public', 'js', 'widget-registry.js'],
  '/assets/widget-dispatcher.js': ['public', 'js', 'widget-dispatcher.js'],
  '/assets/dashboard-sections.js': ['public', 'js', 'dashboard-sections.js'],
  '/assets/metrics-engine.js': ['public', 'js', 'metrics-engine.js'],
  '/assets/dashboard.client.js': ['public', 'js', 'dashboard.client.js']
};

function isPathInsideDir(filePath, dir) {
  var d = path.resolve(dir);
  var f = path.resolve(filePath);
  if (f === d) return false;
  return f.startsWith(d + path.sep);
}

function resolveWhitelistedAsset(scriptDir, pathname) {
  var segs = ASSET_ROUTES[pathname];
  if (!segs) return null;
  var full = path.normalize(path.join.apply(path, [scriptDir].concat(segs)));
  var pubRoot = path.join(scriptDir, 'public');
  if (!isPathInsideDir(full, pubRoot)) return null;
  try {
    if (!fs.statSync(full).isFile()) return null;
  } catch (e) {
    return null;
  }
  return full;
}

/**
 * If pathname matches a dashboard asset, sends the file and returns true (caller must not handle further).
 * Otherwise returns false.
 */
function tryServeDashboardAsset(scriptDir, pathname, res) {
  var filePath = resolveWhitelistedAsset(scriptDir, pathname);
  if (!filePath) return false;
  fs.readFile(filePath, function (err, buf) {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
      return;
    }
    var ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream; charset=utf-8',
      'Cache-Control': 'no-cache'
    });
    res.end(buf);
  });
  return true;
}

/** Path only (wie req.url); Basis nur für WHATWG-URL, wird nicht an Clients ausgegeben. */
function requestPathname(reqUrl) {
  var raw = typeof reqUrl === 'string' && reqUrl.length ? reqUrl : '/';
  if (raw[0] !== '/') raw = '/' + raw;
  var p = '/';
  try {
    p = new URL(raw, 'https://dashboard.local').pathname || '/';
  } catch (e) {
    p = '/';
  }
  p = (p || '/').replace(/\/+/g, '/');
  if (!p || p[0] !== '/') p = '/';
  return p;
}

module.exports = {
  ASSET_ROUTES: ASSET_ROUTES,
  tryServeDashboardAsset: tryServeDashboardAsset,
  requestPathname: requestPathname,
  resolveWhitelistedAsset: resolveWhitelistedAsset
};
