const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');
const homeDir = process.env.USERPROFILE || process.env.HOME || os.homedir();
const baseDir = path.join(homeDir, '.claude', 'projects');

// ─── Outage-Daten (Disk-Cache vom Dashboard oder frisch fetchen) ───
var OUTAGE_DISK_CACHE = path.join(homeDir, '.claude', 'usage-dashboard-outages.json');

function loadOutageDaysMap() {
  var incidents = [];
  // Disk-Cache lesen (Dashboard schreibt diesen)
  try {
    var disk = JSON.parse(fs.readFileSync(OUTAGE_DISK_CACHE, 'utf8'));
    if (Array.isArray(disk.incidents)) incidents = disk.incidents;
  } catch (e) {}
  return buildOutageDaysMap(incidents);
}

function buildOutageDaysMap(incidents) {
  var map = {};
  for (var i = 0; i < incidents.length; i++) {
    var inc = incidents[i];
    if (!inc.created_at) continue;
    var start = new Date(inc.created_at);
    var end = inc.resolved_at ? new Date(inc.resolved_at) : new Date();
    if (isNaN(start.getTime())) continue;
    if (isNaN(end.getTime()) || end <= start) end = new Date(start.getTime() + 3600000);
    var cur = new Date(start);
    while (cur < end) {
      var dayStr = cur.toISOString().slice(0, 10);
      var dayStart = new Date(dayStr + 'T00:00:00Z');
      var dayEnd = new Date(dayStart.getTime() + 86400000);
      var segStart = cur > dayStart ? cur : dayStart;
      var segEnd = end < dayEnd ? end : dayEnd;
      var hours = (segEnd - segStart) / 3600000;
      if (!map[dayStr]) map[dayStr] = { outage_hours: 0, incidents: [] };
      map[dayStr].outage_hours += hours;
      var found = false;
      for (var fi = 0; fi < map[dayStr].incidents.length; fi++) {
        if (map[dayStr].incidents[fi].name === inc.name) { found = true; break; }
      }
      if (!found) map[dayStr].incidents.push({ name: inc.name || '', impact: inc.impact || 'none' });
      cur = dayEnd;
    }
  }
  var keys = Object.keys(map);
  for (var k = 0; k < keys.length; k++) map[keys[k]].outage_hours = Math.round(map[keys[k]].outage_hours * 10) / 10;
  return map;
}

var outageDays = loadOutageDaysMap();

// ─── Day-Cache (identisch mit claude-usage-dashboard.js) ───
var USAGE_DAY_CACHE_VERSION = 3;
var USAGE_DAY_CACHE_FILE = path.join(homeDir, '.claude', 'usage-dashboard-days.json');
var noCache = process.env.CLAUDE_USAGE_NO_CACHE === '1' || process.env.CLAUDE_USAGE_NO_CACHE === 'true';

function readUsageDayCache() {
  try { return JSON.parse(fs.readFileSync(USAGE_DAY_CACHE_FILE, 'utf8')); }
  catch (e) { return null; }
}

// ─── Limit-Erkennung (gleiche Heuristik wie claude-usage-dashboard.js) ───
var CACHE_READ_FORENSIC_THRESH = 500000000;   // 500M

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

function walkJsonl(dir) {
  var files = [];
  try {
    var entries = fs.readdirSync(dir, { withFileTypes: true });
    for (var i = 0; i < entries.length; i++) {
      var fp = path.join(dir, entries[i].name);
      if (entries[i].isDirectory()) files = files.concat(walkJsonl(fp));
      else if (entries[i].name.endsWith('.jsonl')) files.push(fp);
    }
  } catch (err) {}
  return files;
}

function emptyDailyBucket() {
  return {
    input: 0, output: 0, cache_read: 0, cache_creation: 0,
    calls: 0, subagent_calls: 0, subagent_cache: 0, subagent_output: 0,
    hours: {}, hit_limit: 0, models: {},
  };
}

// ─── Cache-Eintrag in internes daily-Format konvertieren ───
function cacheDayToDailyBucket(cd) {
  return {
    input: cd.input || 0,
    output: cd.output || 0,
    cache_read: cd.cache_read || 0,
    cache_creation: cd.cache_creation || 0,
    calls: cd.calls || 0,
    subagent_calls: cd.sub_calls || 0,
    subagent_cache: cd.sub_cache || 0,
    subagent_output: cd.sub_output || 0,
    hours: cd.hours || {},
    hit_limit: cd.hit_limit || 0,
    models: cd.models || {},
  };
}

// ─── Daten laden: Cache fuer Vortage, JSONL nur fuer heute ───
var allFiles = walkJsonl(baseDir);
var todayStr = new Date().toISOString().slice(0, 10);
var daily = {};
var messages = [];  // nur fuer stuendliche Analyse (heute)
var usedCache = false;

var cache = !noCache ? readUsageDayCache() : null;
if (
  cache &&
  cache.version === USAGE_DAY_CACHE_VERSION &&
  Array.isArray(cache.days) &&
  cache.days.length > 0
) {
  // Vortage aus Cache laden
  usedCache = true;
  for (var ci = 0; ci < cache.days.length; ci++) {
    var cd = cache.days[ci];
    if (cd.date === todayStr) continue;  // heute wird frisch geparst
    daily[cd.date] = cacheDayToDailyBucket(cd);
  }
  console.error('  [Cache] ' + cache.days.length + ' Vortage aus ' + USAGE_DAY_CACHE_FILE);
  console.error('  [Cache] Nur ' + todayStr + ' wird aus JSONL gelesen (' + allFiles.length + ' Dateien)');
}

// JSONL lesen: nur heute (bei Cache) oder alles (bei Vollscan)
var onlyToday = usedCache ? todayStr : null;

for (var fi = 0; fi < allFiles.length; fi++) {
  var f = allFiles[fi];
  var isSubagent = f.indexOf('subagent') >= 0;
  try {
    var lines = fs.readFileSync(f, 'utf8').split('\n');
    for (var li = 0; li < lines.length; li++) {
      var line = lines[li];
      // Limit-Zeilen erkennen (unabhaengig von usage)
      if (line.length > 10 && scanLineHitLimit(line)) {
        try {
          var parsed = JSON.parse(line);
          var lts = parsed.timestamp || '';
          if (lts.length >= 10) {
            var lday = lts.slice(0, 10);
            if (onlyToday && lday !== onlyToday) continue;
            if (!daily[lday]) daily[lday] = emptyDailyBucket();
            daily[lday].hit_limit++;
          }
        } catch (e) {}
      }
      if (line.indexOf('"usage"') < 0) continue;
      try {
        var d = JSON.parse(line);
        var u = d.message && d.message.usage;
        if (!u) continue;
        var ts = d.timestamp || '';
        if (!ts || ts.length < 19) continue;
        var msgDay = ts.slice(0, 10);
        if (onlyToday && msgDay !== onlyToday) continue;
        messages.push({
          ts: ts,
          day: msgDay,
          hour: parseInt(ts.slice(11, 13)),
          model: d.message.model || 'unknown',
          input: u.input_tokens || 0,
          output: u.output_tokens || 0,
          cache_read: u.cache_read_input_tokens || 0,
          cache_creation: u.cache_creation_input_tokens || 0,
          isSubagent: isSubagent,
        });
      } catch (e) {}
    }
  } catch (e) {}
}

messages.sort(function (a, b) {
  return a.ts < b.ts ? -1 : 1;
});

// Aggregate daily (nur die frisch gelesenen messages)
for (var i = 0; i < messages.length; i++) {
  var m = messages[i];
  if (!daily[m.day]) daily[m.day] = emptyDailyBucket();
  var dd = daily[m.day];
  dd.input += m.input;
  dd.output += m.output;
  dd.cache_read += m.cache_read;
  dd.cache_creation += m.cache_creation;
  dd.calls++;
  if (!dd.hours[m.hour]) dd.hours[m.hour] = true;
  if (m.isSubagent) {
    dd.subagent_calls++;
    dd.subagent_cache += m.cache_read;
    dd.subagent_output += m.output;
  }
  if (m.model && /^claude-/i.test(m.model)) {
    if (!dd.models[m.model]) dd.models[m.model] = 0;
    dd.models[m.model]++;
  }
}

// ─── Model-Change-Detection ───
function detectModelChanges(daily, days) {
  var changes = {};
  var prevSet = null;
  for (var i = 0; i < days.length; i++) {
    var curSet = Object.keys(daily[days[i]].models || {}).sort();
    if (prevSet) {
      var added = [], removed = [];
      for (var c = 0; c < curSet.length; c++) {
        if (prevSet.indexOf(curSet[c]) < 0) added.push(curSet[c]);
      }
      for (var p = 0; p < prevSet.length; p++) {
        if (curSet.indexOf(prevSet[p]) < 0) removed.push(prevSet[p]);
      }
      if (added.length || removed.length) changes[days[i]] = { added: added, removed: removed };
    }
    prevSet = curSet;
  }
  return changes;
}

// ─── Automatische Peak- und Limit-Erkennung ───
function dayTotal(r) {
  return r.input + r.output + r.cache_read + r.cache_creation;
}

function detectPeakDay(daily, days) {
  var peakDay = null, peakVal = 0;
  for (var i = 0; i < days.length; i++) {
    var t = dayTotal(daily[days[i]]);
    if (t > peakVal) { peakVal = t; peakDay = days[i]; }
  }
  return peakDay;
}

function detectLimitDays(daily, days) {
  // Ein Tag gilt als Limit-Tag wenn:
  //   (a) hit_limit >= HIT_MIN_THRESHOLD (filtert False Positives), ODER
  //   (b) Cache-Read >= 500M (starkes Session-/Cache-Signal)
  // Schwache Signale (wenige HITs, wenig Aktivitaet) werden separat markiert.
  var HIT_MIN_THRESHOLD = 50;   // unter 50 HITs = wahrscheinlich False Positive
  var result = [];
  for (var i = 0; i < days.length; i++) {
    var r = daily[days[i]];
    var flags = [];
    if (r.hit_limit >= HIT_MIN_THRESHOLD) flags.push('HIT(' + r.hit_limit + ')');
    if (r.cache_read >= CACHE_READ_FORENSIC_THRESH) flags.push('CACHE>=500M');
    if (flags.length > 0) result.push({ day: days[i], flags: flags });
  }
  return result;
}

// Fuer den Fazit-Vergleich: Limit-Tag mit genuegend Aktivitaet (aussagekraeftig)
var FAZIT_MIN_CALLS = 50;
var FAZIT_MIN_HOURS = 2;
function findBestLimitDayForComparison(limitDays, daily) {
  // Letzter Limit-Tag mit signifikanter Aktivitaet
  for (var i = limitDays.length - 1; i >= 0; i--) {
    var r = daily[limitDays[i].day];
    if (r.calls >= FAZIT_MIN_CALLS && Object.keys(r.hours).length >= FAZIT_MIN_HOURS) {
      return limitDays[i].day;
    }
  }
  // Fallback: letzter Limit-Tag ueberhaupt
  return limitDays.length > 0 ? limitDays[limitDays.length - 1].day : null;
}

var days = Object.keys(daily).sort();
var peakDay = detectPeakDay(daily, days);
var limitDays = detectLimitDays(daily, days);
var modelChanges = detectModelChanges(daily, days);
var limitDaySet = {};
for (var li = 0; li < limitDays.length; li++) limitDaySet[limitDays[li].day] = limitDays[li].flags;
var today = new Date().toISOString().slice(0, 10);

function fmt(n) {
  if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(n);
}

function pad(s, w) {
  s = String(s);
  while (s.length < w) s = ' ' + s;
  return s;
}

function limitLabel(d) {
  var base = limitDaySet[d] ? limitDaySet[d].join(',') : 'nein';
  if (limitDaySet[d] && outageDays[d]) base += ' [OUT ' + outageDays[d].outage_hours + 'h]';
  else if (outageDays[d]) base += ' (OUT ' + outageDays[d].outage_hours + 'h)';
  if (modelChanges[d]) base += ' \u25c7MOD';
  return base;
}

console.log('');
console.log('='.repeat(90));
console.log('  TOKEN USAGE FORENSIK  —  Automatische Peak- & Limit-Erkennung');
console.log('='.repeat(90));
console.log('');
console.log('  Peak-Tag (hoechster Verbrauch): ' + (peakDay || '(keine Daten)'));
var outageCount = Object.keys(outageDays).length;
console.log('  Outage-Tage (status.claude.com): ' + (outageCount > 0 ? outageCount : 'keine / Cache nicht vorhanden'));
var mcKeys = Object.keys(modelChanges);
if (mcKeys.length > 0) {
  console.log('  Model-Wechsel (' + mcKeys.length + ' Tage):');
  for (var mci = 0; mci < mcKeys.length; mci++) {
    var mc = modelChanges[mcKeys[mci]];
    var parts = [];
    if (mc.added.length) parts.push('+' + mc.added.join(', +'));
    if (mc.removed.length) parts.push('-' + mc.removed.join(', -'));
    console.log('    ' + mcKeys[mci] + '  ' + parts.join('  '));
  }
} else {
  console.log('  Model-Wechsel: keine erkannt');
}
if (limitDays.length > 0) {
  console.log('  Limit-Tage (automatisch erkannt):');
  for (var li = 0; li < limitDays.length; li++) {
    console.log('    ' + limitDays[li].day + '  [' + limitDays[li].flags.join(', ') + ']');
  }
} else {
  console.log('  Limit-Tage: keine erkannt');
}

// ─── 1. TAGESÜBERSICHT ───
console.log('');
console.log('--- 1. TAGESUEBERSICHT: Cache-to-Output Ratio ---');
console.log('');
console.log(
  '  Je hoeher Cache:Output, desto mehr Token werden pro nuetzlichem Output verbrannt.',
);
console.log('');
console.log(
  '  Datum      | Output    | Cache Read | Cache:Out | Calls | Akt.h | Limit?',
);
console.log(
  '  -----------|-----------|------------|-----------|-------|-------|----------------',
);

for (var di = 0; di < days.length; di++) {
  var d = days[di];
  var r = daily[d];
  var activeH = Object.keys(r.hours).length;
  var cacheRatio = r.output > 0 ? Math.round(r.cache_read / r.output) : 0;

  console.log(
    '  ' +
      d +
      ' | ' +
      pad(fmt(r.output), 9) +
      ' | ' +
      pad(fmt(r.cache_read), 10) +
      ' | ' +
      pad(cacheRatio + 'x', 9) +
      ' | ' +
      pad(r.calls, 5) +
      ' | ' +
      pad(activeH, 5) +
      ' | ' +
      limitLabel(d),
  );
}

// ─── 2. EFFIZIENZ-KOLLAPS ───
console.log('');
console.log('--- 2. EFFIZIENZ-KOLLAPS: Token pro nuetzlichem Output ---');
console.log('');
console.log(
  '  "Overhead" = wie viele Token das System insgesamt verbraucht pro 1 Output-Token.',
);
console.log('   Niedrig = effizient. Hoch = Verschwendung.');
console.log('');
console.log('  Datum      | Overhead | Output/h  | Total/h    | Subagent%');
console.log('  -----------|----------|-----------|------------|----------');

for (var di = 0; di < days.length; di++) {
  var d = days[di];
  var r = daily[d];
  var total = dayTotal(r);
  var activeH = Math.max(1, Object.keys(r.hours).length);
  var overhead = r.output > 0 ? (total / r.output).toFixed(0) : '-';
  var subPct =
    r.calls > 0 ? ((r.subagent_calls / r.calls) * 100).toFixed(0) + '%' : '0%';

  console.log(
    '  ' +
      d +
      ' | ' +
      pad(overhead + 'x', 8) +
      ' | ' +
      pad(fmt(Math.round(r.output / activeH)), 9) +
      ' | ' +
      pad(fmt(Math.round(total / activeH)), 10) +
      ' | ' +
      pad(subPct, 9),
  );
}

// ─── 3. SUBAGENT IMPACT ───
console.log('');
console.log('--- 3. SUBAGENT-ANALYSE: Der Cache-Multiplikator ---');
console.log('');
console.log(
  '  Jeder Subagent bekommt den VOLLEN Kontext kopiert = massiver Cache-Read.',
);
console.log('  Subagent-Cache als Anteil am Gesamt-Cache-Read:');
console.log('');
console.log(
  '  Datum      | Main     | Subagent | Sub-Cache     | Sub-Cache%  | Sub-Out',
);
console.log(
  '  -----------|----------|----------|---------------|-------------|--------',
);

for (var di = 0; di < days.length; di++) {
  var d = days[di];
  var r = daily[d];
  var mainCalls = r.calls - r.subagent_calls;
  var subCachePct =
    r.cache_read > 0
      ? ((r.subagent_cache / r.cache_read) * 100).toFixed(0) + '%'
      : '-';

  console.log(
    '  ' +
      d +
      ' | ' +
      pad(mainCalls, 8) +
      ' | ' +
      pad(r.subagent_calls, 8) +
      ' | ' +
      pad(fmt(r.subagent_cache), 13) +
      ' | ' +
      pad(subCachePct, 11) +
      ' | ' +
      pad(fmt(r.subagent_output), 6),
  );
}

// ─── 4. BUDGET-SCHÄTZUNG: Wo liegt das Limit? ───
console.log('');
console.log('--- 4. BUDGET-SCHAETZUNG: Impliziertes Cap pro Limit-Tag ---');
console.log('');
console.log(
  '  Fuer jeden Limit-Tag: Total / 0.9 = geschaetztes Budget (wenn ~90% erreicht).',
);
console.log(
  '  "vs Peak" = Faktor, um den das Budget kleiner wirkt als der Peak-Verbrauch.',
);
console.log(
  '  Trend zeigt, ob sich das Budget ueber die Zeit veraendert.',
);
console.log('');

if (limitDays.length > 0 && peakDay) {
  var peakTotal = dayTotal(daily[peakDay]);

  console.log(
    '  Datum      | Total      | Impl@90%   | vs Peak | Akt.h | Out/h     | Outage  | Signal',
  );
  console.log(
    '  -----------|------------|------------|---------|-------|-----------|---------|----------------',
  );

  var prevImpl = 0;
  var cleanLimitDays = [];
  var outageLimitDays = [];
  for (var li = 0; li < limitDays.length; li++) {
    var ld = limitDays[li].day;
    var lr = daily[ld];
    var lt = dayTotal(lr);
    var impl90 = Math.round(lt / 0.9);
    var vsPeak = peakTotal > 0 ? (peakTotal / impl90).toFixed(1) + 'x' : '-';
    var lActiveH = Math.max(1, Object.keys(lr.hours).length);
    var outPerH = fmt(Math.round(lr.output / lActiveH));
    var trend = '';
    if (prevImpl > 0) {
      var change = Math.round(((impl90 - prevImpl) / prevImpl) * 100);
      if (change > 5) trend = ' \u2191' + change + '%';
      else if (change < -5) trend = ' \u2193' + Math.abs(change) + '%';
      else trend = ' \u2192';
    }
    prevImpl = impl90;

    var outInfo = outageDays[ld] ? outageDays[ld].outage_hours + 'h' : '-';
    var isOutage = !!outageDays[ld];
    if (isOutage) outageLimitDays.push(limitDays[li]);
    else cleanLimitDays.push(limitDays[li]);

    console.log(
      '  ' + ld +
      ' | ' + pad(fmt(lt), 10) +
      ' | ' + pad(fmt(impl90), 10) +
      ' | ' + pad(vsPeak, 7) +
      ' | ' + pad(Object.keys(lr.hours).length, 5) +
      ' | ' + pad(outPerH, 9) +
      ' | ' + pad(outInfo, 7) +
      ' | ' + limitDays[li].flags.join(',') + (isOutage ? ' *OUT*' : '') + trend,
    );
  }

  if (outageLimitDays.length > 0) {
    console.log('');
    console.log('  * OUT = Anthropic-Ausfall an diesem Tag (status.claude.com)');
    console.log('    ' + outageLimitDays.length + ' von ' + limitDays.length + ' Limit-Tagen hatten Ausfaelle.');
    console.log('    Budget-Schaetzung unten nutzt nur ' + cleanLimitDays.length + ' saubere Limit-Tage.');
  }

  // Zusammenfassung: Median und Bereich (nur saubere Limit-Tage)
  var implValues = [];
  var sourceForMedian = cleanLimitDays.length > 0 ? cleanLimitDays : limitDays;
  for (var li = 0; li < sourceForMedian.length; li++) {
    var lr2 = daily[sourceForMedian[li].day];
    // Nur Tage mit signifikanter Aktivitaet fuer Median
    if (lr2.calls >= FAZIT_MIN_CALLS && Object.keys(lr2.hours).length >= FAZIT_MIN_HOURS) {
      implValues.push(Math.round(dayTotal(lr2) / 0.9));
    }
  }
  if (implValues.length >= 2) {
    implValues.sort(function (a, b) { return a - b; });
    var median = implValues[Math.floor(implValues.length / 2)];
    var minImpl = implValues[0];
    var maxImpl = implValues[implValues.length - 1];
    console.log('');
    console.log('  Zusammenfassung (' + implValues.length + ' aussagekraeftige Limit-Tage):');
    console.log('    Median Impl@90%:  ~' + fmt(median));
    console.log('    Bereich:          ' + fmt(minImpl) + ' .. ' + fmt(maxImpl));
    console.log('    Peak-Verbrauch:   ' + fmt(peakTotal) + ' (' + peakDay + ')');
    if (median > 0) {
      console.log('    Peak / Median:    ' + (peakTotal / median).toFixed(1) + 'x');
    }
  }
} else {
  console.log('  Keine Limit-Tage erkannt — Budget-Schaetzung nicht moeglich.');
}

// ─── 5. STÜNDLICHE ANALYSE (aussagekraeftigster Limit-Tag oder heute) ───
var hourlyDay = today;
var hourlyLabel = 'HEUTE (' + today + ')';
if (limitDays.length > 0) {
  // Aussagekraeftigsten Limit-Tag nehmen
  hourlyDay = findBestLimitDayForComparison(limitDays, daily);
  if (hourlyDay === today) {
    hourlyLabel = 'HEUTE (' + today + ') [LIMIT-TAG: ' + limitDaySet[hourlyDay].join(',') + ']';
  } else {
    hourlyLabel = 'LIMIT-TAG ' + hourlyDay + ' [' + limitDaySet[hourlyDay].join(',') + ']';
  }
}

console.log('');
console.log('--- 5. STUENDLICH: ' + hourlyLabel + ' ---');
console.log('');

var todayMsgs = messages.filter(function (m) {
  return m.day === hourlyDay;
});
var hourly = {};
for (var i = 0; i < todayMsgs.length; i++) {
  var m = todayMsgs[i];
  if (!hourly[m.hour])
    hourly[m.hour] = {
      input: 0, output: 0, cache_read: 0, cache_creation: 0, calls: 0, sub: 0,
    };
  var h = hourly[m.hour];
  h.input += m.input;
  h.output += m.output;
  h.cache_read += m.cache_read;
  h.cache_creation += m.cache_creation;
  h.calls++;
  if (m.isSubagent) h.sub++;
}

console.log(
  '  Stunde | Output   | Cache Read | Cache:Out | Calls | Sub | Kumuliert',
);
console.log(
  '  -------|----------|------------|-----------|-------|-----|----------',
);

var cumTotal = 0;
var hours = Object.keys(hourly).sort(function (a, b) {
  return a - b;
});
for (var hi = 0; hi < hours.length; hi++) {
  var hh = hours[hi];
  var r = hourly[hh];
  var total = r.input + r.output + r.cache_read + r.cache_creation;
  cumTotal += total;
  var cr = r.output > 0 ? Math.round(r.cache_read / r.output) : 0;
  console.log(
    '  ' +
      pad(hh + ':00', 5) +
      '  | ' +
      pad(fmt(r.output), 8) +
      ' | ' +
      pad(fmt(r.cache_read), 10) +
      ' | ' +
      pad(cr + 'x', 9) +
      ' | ' +
      pad(r.calls, 5) +
      ' | ' +
      pad(r.sub, 3) +
      ' | ' +
      pad(fmt(cumTotal), 8),
  );
}

// ─── 6. FAZIT: Peak vs. letzter Limit-Tag ───
console.log('');
console.log('='.repeat(90));

if (peakDay && limitDays.length > 0) {
  var lastLimit = findBestLimitDayForComparison(limitDays, daily);
  // Peak und Limit-Tag koennten identisch sein — dann kein Vergleich
  if (peakDay === lastLimit) {
    console.log('  FAZIT: Peak-Tag = Limit-Tag (' + peakDay + ')');
    console.log('='.repeat(90));
    console.log('');
    var rp = daily[peakDay];
    var tp = dayTotal(rp);
    var hp = Object.keys(rp.hours).length;
    var implied = Math.round(tp / 0.9);
    console.log('  Der Tag mit dem hoechsten Verbrauch war zugleich ein Limit-Tag.');
    console.log('  Gesamtverbrauch:   ' + fmt(tp));
    console.log('  Aktive Stunden:    ' + hp);
    console.log('  Impl. Budget@90%:  ~' + fmt(implied));
    console.log('  Limit-Signal:      [' + limitDaySet[peakDay].join(', ') + ']');
  } else {
    console.log('  FAZIT: VERGLEICH PEAK-TAG vs. LETZTER LIMIT-TAG');
    console.log('='.repeat(90));
    console.log('');

    var rPeak = daily[peakDay];
    var rLimit = daily[lastLimit];
    var tPeak = dayTotal(rPeak);
    var tLimit = dayTotal(rLimit);
    var hPeak = Object.keys(rPeak.hours).length;
    var hLimit = Object.keys(rLimit.hours).length;

    var col1 = peakDay;
    var col2 = lastLimit;
    var w = Math.max(col1.length, col2.length, 12);

    console.log('                          ' + pad(col1, w) + '          ' + pad(col2, w));
    console.log('                          ' + pad('(Peak)', w) + '          ' + pad('[' + limitDaySet[lastLimit].join(',') + ']', w));
    console.log('  ' + '\u2500'.repeat(26 + w + 10 + w));
    console.log(
      '  Output-Tokens:          ' + pad(fmt(rPeak.output), w) + '          ' + pad(fmt(rLimit.output), w),
    );
    console.log(
      '  Cache-Read:             ' + pad(fmt(rPeak.cache_read), w) + '          ' + pad(fmt(rLimit.cache_read), w),
    );
    console.log(
      '  Gesamtverbrauch:        ' + pad(fmt(tPeak), w) + '          ' + pad(fmt(tLimit), w),
    );
    console.log(
      '  Aktive Stunden:         ' + pad(hPeak, w) + '          ' + pad(hLimit, w),
    );
    console.log(
      '  API-Calls:              ' + pad(rPeak.calls, w) + '          ' + pad(rLimit.calls, w),
    );
    console.log(
      '  Cache:Output Ratio:     ' +
        pad(Math.round(rPeak.cache_read / Math.max(1, rPeak.output)) + 'x', w) +
        '          ' +
        pad(Math.round(rLimit.cache_read / Math.max(1, rLimit.output)) + 'x', w),
    );
    console.log(
      '  Overhead (Total:Out):   ' +
        pad(Math.round(tPeak / Math.max(1, rPeak.output)) + 'x', w) +
        '          ' +
        pad(Math.round(tLimit / Math.max(1, rLimit.output)) + 'x', w),
    );
    console.log('');

    var outputDrop = rLimit.output > 0 ? Math.round(rPeak.output / rLimit.output) : 0;
    var totalDrop = tLimit > 0 ? Math.round(tPeak / tLimit) : 0;
    var budgetImpliedPeak = tPeak;
    var budgetImpliedLimit = Math.round(tLimit / 0.9);
    var budgetDrop = budgetImpliedLimit > 0 ? Math.round(budgetImpliedPeak / budgetImpliedLimit) : 0;

    console.log('  ERGEBNIS:');
    console.log('  =========');
    console.log('');
    if (outputDrop > 1) {
      console.log('  Output am Limit-Tag:     ' + outputDrop + 'x WENIGER als am Peak');
    }
    if (totalDrop > 1) {
      console.log('  Gesamtverbrauch:         ' + totalDrop + 'x WENIGER als am Peak');
      console.log('  Trotzdem:                Limit-Signal erkannt!');
    }
    console.log('');
    console.log('  Impliziertes Budget (heuristisch):');
    console.log('    ' + peakDay + ': >' + fmt(budgetImpliedPeak) + ' (nicht ausgeschoepft)');
    console.log('    ' + lastLimit + ': ~' + fmt(budgetImpliedLimit) + ' (bei ~90% geschaetzt)');
    if (budgetDrop > 1) {
      console.log('');
      console.log('  >>> EFFEKTIVE BUDGET-REDUKTION: ~' + budgetDrop + 'x <<<');
      console.log('');
      console.log('  Das bedeutet: Das Session-Budget wurde um Faktor ~' + budgetDrop);
      console.log('  reduziert, ODER die Token-Gewichtung hat sich geaendert.');
      if (hPeak > 0 && budgetDrop > 0) {
        console.log('  Bei gleicher Arbeitsintensitaet wie am ' + peakDay + ' waere das');
        console.log('  Limit nach ~' + Math.round((hPeak * 60) / budgetDrop) + ' Minuten erreicht.');
      }
    }
  }
} else if (peakDay) {
  console.log('  FAZIT: Kein Limit-Tag erkannt');
  console.log('='.repeat(90));
  console.log('');
  console.log('  Peak-Tag: ' + peakDay + ' (' + fmt(dayTotal(daily[peakDay])) + ' gesamt)');
  console.log('  Kein Tag mit Rate-Limit oder Cache>=500M gefunden.');
  console.log('  Das Limit wurde bisher nicht (erkennbar) erreicht.');
} else {
  console.log('  FAZIT: Keine Daten vorhanden');
  console.log('='.repeat(90));
}

// ─── 7. VISUELLE DARSTELLUNG ───
console.log('');
console.log('='.repeat(90));
console.log('  VISUELL: Session-Verbrauch pro Tag (skaliert auf Balken)');
console.log('='.repeat(90));
console.log('');

var maxTotal = 0;
for (var di = 0; di < days.length; di++) {
  var t = dayTotal(daily[days[di]]);
  if (t > maxTotal) maxTotal = t;
}

for (var di = 0; di < days.length; di++) {
  var d = days[di];
  var r = daily[d];
  var t = dayTotal(r);
  var barLen = Math.round((t / maxTotal) * 60);
  var bar = '';
  var cachePortion = Math.round((r.cache_read / maxTotal) * 60);
  var restPortion = barLen - cachePortion;
  for (var bi = 0; bi < cachePortion; bi++) bar += '\u2591';
  for (var bi = 0; bi < restPortion; bi++) bar += '\u2588';

  var label = '';
  if (d === peakDay) label += ' \u2190 PEAK';
  if (limitDaySet[d]) label += ' \u2190 LIMIT [' + limitDaySet[d].join(',') + ']';
  console.log('  ' + d.slice(5) + ' ' + bar + ' ' + fmt(t) + label);
}
console.log('');
console.log(
  '  \u2591 = Cache Read (Overhead)   \u2588 = Output + Input + Cache Create (Arbeit)',
);
console.log('');
