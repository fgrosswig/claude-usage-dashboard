const fs = require('fs');
const path = require('path');
const homeDir = process.env.USERPROFILE || process.env.HOME;
const baseDir = path.join(homeDir, '.claude', 'projects');

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

var allFiles = walkJsonl(baseDir);
var messages = [];

for (var fi = 0; fi < allFiles.length; fi++) {
  var f = allFiles[fi];
  var isSubagent = f.indexOf('subagent') >= 0;
  try {
    var lines = fs.readFileSync(f, 'utf8').split('\n');
    for (var li = 0; li < lines.length; li++) {
      var line = lines[li];
      if (line.indexOf('"usage"') < 0) continue;
      try {
        var d = JSON.parse(line);
        var u = d.message && d.message.usage;
        if (!u) continue;
        var ts = d.timestamp || '';
        if (!ts || ts.length < 19) continue;
        messages.push({
          ts: ts,
          day: ts.slice(0, 10),
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

// Aggregate daily
var daily = {};
for (var i = 0; i < messages.length; i++) {
  var m = messages[i];
  if (!daily[m.day])
    daily[m.day] = {
      input: 0,
      output: 0,
      cache_read: 0,
      cache_creation: 0,
      calls: 0,
      subagent_calls: 0,
      subagent_cache: 0,
      subagent_output: 0,
      hours: {},
    };
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
}

var days = Object.keys(daily).sort();

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

console.log('');
console.log('='.repeat(90));
console.log('  TOKEN USAGE FORENSIK  —  Warum 90% Limit nach 1h Arbeit?');
console.log('='.repeat(90));

// ─── 1. TAGESÜBERSICHT ───
console.log('');
console.log('--- 1. TAGESÜBERSICHT: Cache-to-Output Ratio ---');
console.log('');
console.log(
  '  Je hoeher Cache:Output, desto mehr Token werden pro nuetzlichem Output verbrannt.',
);
console.log('');
console.log(
  '  Datum      | Output    | Cache Read | Cache:Out | Calls | Akt.h | Limit?',
);
console.log(
  '  -----------|-----------|------------|-----------|-------|-------|-------',
);

for (var di = 0; di < days.length; di++) {
  var d = days[di];
  var r = daily[d];
  var activeH = Object.keys(r.hours).length;
  var cacheRatio = r.output > 0 ? Math.round(r.cache_read / r.output) : 0;
  var limit = '';
  if (d === '2026-04-05') limit = '90%!';
  else if (d >= '2026-04-01' && r.cache_read > 500e6) limit = '?';
  else limit = 'nein';

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
      limit,
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
  var total = r.input + r.output + r.cache_read + r.cache_creation;
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

// ─── 4. HEUTE STÜNDLICH ───
console.log('');
console.log('--- 4. HEUTE (05.04) STUENDLICH ---');
console.log('');

var todayMsgs = messages.filter(function (m) {
  return m.day === '2026-04-05';
});
var hourly = {};
for (var i = 0; i < todayMsgs.length; i++) {
  var m = todayMsgs[i];
  if (!hourly[m.hour])
    hourly[m.hour] = {
      input: 0,
      output: 0,
      cache_read: 0,
      cache_creation: 0,
      calls: 0,
      sub: 0,
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

// ─── 5. FAZIT ───
console.log('');
console.log('='.repeat(90));
console.log('  FAZIT: VERGLEICH SPITZENTAG vs. HEUTE');
console.log('='.repeat(90));
console.log('');

var mar26 = daily['2026-03-26'];
var apr05 = daily['2026-04-05'];

if (mar26 && apr05) {
  var t26 =
    mar26.input + mar26.output + mar26.cache_read + mar26.cache_creation;
  var t05 =
    apr05.input + apr05.output + apr05.cache_read + apr05.cache_creation;
  var h26 = Object.keys(mar26.hours).length;
  var h05 = Object.keys(apr05.hours).length;

  console.log('                          26.03.2026          05.04.2026');
  console.log('                          (kein Limit)        (90% Limit!)');
  console.log('  ─────────────────────────────────────────────────────────');
  console.log(
    '  Output-Tokens:          ' +
      pad(fmt(mar26.output), 12) +
      '          ' +
      pad(fmt(apr05.output), 12),
  );
  console.log(
    '  Cache-Read:             ' +
      pad(fmt(mar26.cache_read), 12) +
      '          ' +
      pad(fmt(apr05.cache_read), 12),
  );
  console.log(
    '  Gesamtverbrauch:        ' +
      pad(fmt(t26), 12) +
      '          ' +
      pad(fmt(t05), 12),
  );
  console.log(
    '  Aktive Stunden:         ' + pad(h26, 12) + '          ' + pad(h05, 12),
  );
  console.log(
    '  API-Calls:              ' +
      pad(mar26.calls, 12) +
      '          ' +
      pad(apr05.calls, 12),
  );
  console.log(
    '  Cache:Output Ratio:     ' +
      pad(Math.round(mar26.cache_read / mar26.output) + 'x', 12) +
      '          ' +
      pad(Math.round(apr05.cache_read / apr05.output) + 'x', 12),
  );
  console.log(
    '  Overhead (Total:Out):   ' +
      pad(Math.round(t26 / mar26.output) + 'x', 12) +
      '          ' +
      pad(Math.round(t05 / apr05.output) + 'x', 12),
  );
  console.log('');

  var outputDrop = Math.round(mar26.output / apr05.output);
  var totalDrop = Math.round(t26 / t05);
  var budgetImplied26 = t26;
  var budgetImplied05 = Math.round(t05 / 0.9);
  var budgetDrop = Math.round(budgetImplied26 / budgetImplied05);

  console.log('  ERGEBNIS:');
  console.log('  =========');
  console.log('');
  console.log(
    '  Output heute:          ' + outputDrop + 'x WENIGER als am 26.03',
  );
  console.log(
    '  Gesamtverbrauch heute: ' + totalDrop + 'x WENIGER als am 26.03',
  );
  console.log('  Trotzdem:              90% SESSION-LIMIT ERREICHT');
  console.log('');
  console.log('  Impliziertes 5h-Budget:');
  console.log('    26.03: >' + fmt(budgetImplied26) + ' (nicht ausgeschoepft)');
  console.log('    05.04: ~' + fmt(budgetImplied05) + ' (bei 90% erreicht)');
  console.log('');
  console.log('  >>> EFFEKTIVE BUDGET-REDUKTION: ~' + budgetDrop + 'x <<<');
  console.log('');
  console.log(
    '  Das bedeutet: Das Session-Budget wurde um Faktor ~' + budgetDrop,
  );
  console.log('  reduziert, ODER die Token-Gewichtung hat sich geaendert.');
  console.log('  Bei gleicher Arbeitsintensitaet wie am 26.03 waere das');
  console.log(
    '  Limit heute nach ~' +
      Math.round((h26 * 60) / budgetDrop) +
      ' Minuten erreicht.',
  );
}

// ─── 6. VISUELLE DARSTELLUNG ───
console.log('');
console.log('='.repeat(90));
console.log('  VISUELL: Session-Verbrauch pro Tag (skaliert auf Balken)');
console.log('='.repeat(90));
console.log('');

var maxTotal = 0;
for (var di = 0; di < days.length; di++) {
  var r = daily[days[di]];
  var t = r.input + r.output + r.cache_read + r.cache_creation;
  if (t > maxTotal) maxTotal = t;
}

for (var di = 0; di < days.length; di++) {
  var d = days[di];
  var r = daily[d];
  var t = r.input + r.output + r.cache_read + r.cache_creation;
  var barLen = Math.round((t / maxTotal) * 60);
  var bar = '';
  // Cache-Read portion vs rest
  var cachePortion = Math.round((r.cache_read / maxTotal) * 60);
  var restPortion = barLen - cachePortion;
  for (var bi = 0; bi < cachePortion; bi++) bar += '░';
  for (var bi = 0; bi < restPortion; bi++) bar += '█';

  var label = d === '2026-04-05' ? ' ← 90% LIMIT!' : '';
  console.log('  ' + d.slice(5) + ' ' + bar + ' ' + fmt(t) + label);
}
console.log('');
console.log(
  '  ░ = Cache Read (Overhead)   █ = Output + Input + Cache Create (Arbeit)',
);
console.log('');
