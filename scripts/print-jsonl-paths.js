'use strict';
/**
 * stdout: one JSON object { paths: string[], fingerprint: string }
 * — same discovery + mtime fingerprint as dashboard-server (usage-scan-roots).
 */
var r = require('./usage-scan-roots');
var c = r.collectTaggedJsonlFiles();
process.stdout.write(
  JSON.stringify({
    paths: c.tagged.map(function (t) {
      return t.path;
    }),
    fingerprint: r.buildTaggedJsonlFingerprintSync(c.tagged)
  })
);
