#!/usr/bin/env node
'use strict';
/**
 * CLI-Alias → scripts/token-forensics.js (Forensik wie das Usage-Dashboard, gleiche Scan-Wurzeln).
 */
var path = require('path');
var cp = require('child_process');
var child = cp.spawnSync(
  process.execPath,
  [path.join(__dirname, 'scripts', 'token-forensics.js')].concat(process.argv.slice(2)),
  { stdio: 'inherit' }
);
process.exit(child.status != null ? child.status : child.error ? 1 : 0);
