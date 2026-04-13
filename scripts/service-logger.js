'use strict';
/**
 * Strukturiertes Server-Logging (stderr + optional Datei).
 * CLAUDE_USAGE_LOG_LEVEL=error|warn|info|debug|none (Standard: info)
 * CLAUDE_USAGE_LOG_FILE=Pfad — Append, eine Zeile pro Eintrag (UTF-8)
 */
var fs = require('node:fs');
var path = require('node:path');

var RANK = { error: 0, warn: 1, info: 2, debug: 3 };
var maxRank = RANK.info;
var logFilePath = '';

function refreshFromEnv() {
  var l = String(process.env.CLAUDE_USAGE_LOG_LEVEL || 'info')
    .trim()
    .toLowerCase();
  if (l === 'none' || l === 'off' || l === 'silent' || l === '0' || l === 'false') {
    maxRank = -1;
  } else if (l === 'error') {
    maxRank = RANK.error;
  } else if (l === 'warn') {
    maxRank = RANK.warn;
  } else if (l === 'debug' || l === 'verbose') {
    maxRank = RANK.debug;
  } else {
    maxRank = RANK.info;
  }
  logFilePath = String(process.env.CLAUDE_USAGE_LOG_FILE || '').trim();
}

function pad2(n) {
  return n < 10 ? '0' + n : String(n);
}

function isoLocal() {
  var d = new Date();
  return (
    d.getFullYear() +
    '-' +
    pad2(d.getMonth() + 1) +
    '-' +
    pad2(d.getDate()) +
    'T' +
    pad2(d.getHours()) +
    ':' +
    pad2(d.getMinutes()) +
    ':' +
    pad2(d.getSeconds()) +
    '.' +
    (function (x) {
      x = String(x);
      while (x.length < 3) x = '0' + x;
      return x;
    })(d.getMilliseconds())
  );
}

function emit(level, topic, message) {
  var r = RANK[level];
  if (r === undefined) r = RANK.info;
  if (maxRank < 0 || r > maxRank) return;
  var line =
    '[' +
    isoLocal() +
    '] [' +
    String(level).toUpperCase() +
    '] [' +
    String(topic || '-') +
    '] ' +
    String(message || '') +
    '\n';
  try {
    process.stderr.write(line);
  } catch (_ignored) {}
  if (logFilePath) {
    try {
      var dir = path.dirname(logFilePath);
      if (dir && dir !== '.') fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(logFilePath, line, 'utf8');
    } catch (_ignored) {}
  }
}

function logError(topic, message) {
  emit('error', topic, message);
}
function logWarn(topic, message) {
  emit('warn', topic, message);
}
function logInfo(topic, message) {
  emit('info', topic, message);
}
function logDebug(topic, message) {
  emit('debug', topic, message);
}

refreshFromEnv();

module.exports = {
  refreshFromEnv: refreshFromEnv,
  error: logError,
  warn: logWarn,
  info: logInfo,
  debug: logDebug,
  emit: emit
};
