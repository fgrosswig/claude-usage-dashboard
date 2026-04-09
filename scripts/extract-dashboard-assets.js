#!/usr/bin/env node
/** Split DASHBOARD_HTML string literal from scripts/dashboard-server.js (legacy inline HTML) into tpl + public */
var fs = require('fs');
var path = require('path');

/**
 * Raw interior of a JS single-quoted literal (as in source file), with line continuation
 * backslash + LineTerminator removed per ECMAScript.
 */
function parseSingleQuotedLiteralSource(rawInner) {
  var out = '';
  for (var i = 0; i < rawInner.length; i++) {
    var c = rawInner[i];
    if (c !== '\\') {
      out += c;
      continue;
    }
    i++;
    if (i >= rawInner.length) break;
    var d = rawInner[i];
    if (d === '\r') {
      if (rawInner[i + 1] === '\n') i++;
      continue;
    }
    if (d === '\n') continue;
    if (d === 'n') {
      out += '\n';
      continue;
    }
    if (d === 'r') {
      out += '\r';
      continue;
    }
    if (d === 't') {
      out += '\t';
      continue;
    }
    if (d === 'u' && i + 4 < rawInner.length) {
      var hex = rawInner.slice(i + 1, i + 5);
      if (/^[0-9a-fA-F]{4}$/.test(hex)) {
        out += String.fromCharCode(parseInt(hex, 16));
        i += 4;
        continue;
      }
    }
    out += d;
  }
  return out;
}

var root = path.join(__dirname, '..');
var srcPath = path.join(root, 'scripts', 'dashboard-server.js');
var s = fs.readFileSync(srcPath, 'utf8');

var startMark = "var DASHBOARD_HTML = '";
var endMark = "';\n\n// ── Live Data Cache";
var a = s.indexOf(startMark);
var b = s.indexOf(endMark);
if (a < 0 || b < 0) throw new Error('DASHBOARD_HTML markers not found');
var rawInner = s.slice(a + startMark.length, b);
var html = parseSingleQuotedLiteralSource(rawInner);

var styleStart = html.indexOf('<style>');
var styleEnd = html.indexOf('</style>', styleStart);
var css = html.slice(styleStart + '<style>'.length, styleEnd).trim();

var pulseStart = html.indexOf('<style>@keyframes pulse', styleEnd);
var pulseEnd = html.indexOf('</style>', pulseStart);
var pulseCss = pulseStart >= 0 ? html.slice(pulseStart + '<style>'.length, pulseEnd).trim() : '';

var headEnd = html.indexOf('</head>');
var bodyBlock = html.slice(headEnd + '</head>'.length);

var i18nMark = '<script>globalThis.__I18N_BUNDLES=__I18N_PLACEHOLDER__;</script>';
var i18nIdx = bodyBlock.indexOf(i18nMark);
if (i18nIdx < 0) throw new Error('i18n script not found');

var bodyBeforeI18n = bodyBlock.slice(0, i18nIdx).trim();
// remove orphan pulse style from body (moved to CSS)
bodyBeforeI18n = bodyBeforeI18n.replace(/\n<style>@keyframes pulse[\s\S]*?<\/style>\n?/i, '\n');

var rest = bodyBlock.slice(i18nIdx + i18nMark.length);

var bigScriptStart = rest.indexOf('<script>');
var bigScriptEnd = rest.lastIndexOf('</script>');
if (bigScriptStart < 0 || bigScriptEnd < 0) throw new Error('client script not found');

var clientJs = rest.slice(bigScriptStart + '<script>'.length, bigScriptEnd);
var bodyAfterScripts = rest.slice(bigScriptEnd + '</script>'.length).trim();

var htmlShell =
  '<!DOCTYPE html>\n' +
  '<html lang="en">\n' +
  '<head>\n' +
  '<meta charset="utf-8">\n' +
  '<meta name="viewport" content="width=device-width,initial-scale=1">\n' +
  '<title>Claude Code Usage Dashboard</title>\n' +
  '<script src="https://cdn.jsdelivr.net/npm/chart.js@4"></script>\n' +
  '<link rel="stylesheet" href="/assets/dashboard.css">\n' +
  '</head>\n' +
  bodyBeforeI18n +
  '\n' +
  i18nMark +
  '\n' +
  '<script src="/assets/dashboard.client.js"></script>\n' +
  bodyAfterScripts +
  '\n';

var cssPath = path.join(root, 'public', 'css', 'dashboard.css');
var jsPath = path.join(root, 'public', 'js', 'dashboard.client.js');
var htmlPath = path.join(root, 'tpl', 'dashboard.html');

fs.mkdirSync(path.dirname(cssPath), { recursive: true });
fs.mkdirSync(path.dirname(jsPath), { recursive: true });

fs.writeFileSync(cssPath, css + '\n\n/* pulse (from original inline block) */\n' + pulseCss + '\n', 'utf8');
fs.writeFileSync(jsPath, clientJs.replace(/^\n/, ''), 'utf8');
fs.writeFileSync(htmlPath, htmlShell, 'utf8');

console.log('OK', htmlPath);
