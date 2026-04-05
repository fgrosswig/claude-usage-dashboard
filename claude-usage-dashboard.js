#!/usr/bin/env node
// Claude Code Token Usage Dashboard — standalone, zero dependencies
// Usage: node claude-usage-dashboard.js [--port=3333]
// Tages-Cache: ~/.claude/usage-dashboard-days.json (Vortage). Bei passender jsonl-Anzahl nur noch „heute“ aus JSONL.
// Vollscan erzwingen: CLAUDE_USAGE_NO_CACHE=1  oder  Cache-Datei löschen / neue .jsonl-Datei ändert die Anzahl.

var http = require('http');
var fs = require('fs');
var path = require('path');
var os = require('os');

var PORT = 3333;
var REFRESH_SEC = 30;
process.argv.forEach(function(a) {
  var m = a.match(/--port=(\d+)/);
  if (m) PORT = parseInt(m[1]);
  var r = a.match(/--refresh=(\d+)/);
  if (r) REFRESH_SEC = Math.max(5, parseInt(r[1]));
});

var HOME = process.env.USERPROFILE || process.env.HOME || os.homedir();
var BASE = path.join(HOME, '.claude', 'projects');
// Vor-Tage als ein JSON (unter ~/.claude); JSONL wird nur noch für den lokalen Kalendertag „heute“ voll geparst.
var USAGE_DAY_CACHE_VERSION = 1;
var USAGE_DAY_CACHE_FILE = path.join(HOME, '.claude', 'usage-dashboard-days.json');

// Session-/Rate-Limits werden von Anthropic (Claude API) bzw. Claude Code erzwungen;
// in den JSONL-Logs stehen primär erfolgreiche usage-Zeilen. Treffer für "Hit Limit"
// sind Zeilen, die typische Limit-/Fehler-Muster enthalten (siehe scanLineHitLimit).
// Kein absoluter Pfad / kein Benutzername in UI oder API-JSON (nur generische Quelle).
var LIMIT_SOURCE_NOTE = 'Datenquelle: ~/.claude/projects';

// ── JSONL Parser ────────────────────────────────────────────────────────

function isClaudeModel(model) {
  return typeof model === 'string' && /^claude-/i.test(model);
}

// Wie token_forensics.js (Tagesübersicht): sehr hoher Cache-Read → „?“
var CACHE_READ_FORENSIC_THRESH = 500000000;

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

// Interpretative Heuristik (kein API-Nachweis). Kein „90%“-Label: Claude-UI kann 90% oder 100% zeigen — unabhängig davon.
var FORENSIC_MIN_OUTPUT_FOR_PEAK_CMP = 60000;
var FORENSIC_PEAK_RATIO_MIN = 6;
var FORENSIC_PEAK_MIN_CALLS = 120;
var FORENSIC_PEAK_MIN_HOURS = 4;

function computeForensicForDay(dayKey, r, peakDate, peakTotal) {
  var total = r.input + r.output + r.cache_read + r.cache_creation;
  var activeH = Object.keys(r.hours).length;
  var implied90 = total > 0 ? Math.round(total / 0.9) : 0;
  var vs_peak = peakTotal > 0 && total > 0 ? Math.round(peakTotal / total) : 0;
  var code = '\u2014';
  var hint = 'Kein Forensic-Flag.';

  if (r.cache_read > CACHE_READ_FORENSIC_THRESH) {
    code = '?';
    hint =
      'Cache read \u2265500M (wie token_forensics.js) \u2014 starkes Session-/Cache-Signal m\u00f6glich.';
  } else if ((r.hit_limit || 0) > 0) {
    code = 'HIT';
    hint =
      'JSONL enth\u00e4lt diesen Tag Rate-/Limit-/429-\u00e4hnliche Zeilen \u2014 eher harter API-/Session-Stop. Unabh\u00e4ngig davon zeigt die Claude-UI oft 90% oder 100%; das sind verschiedene Signale.';
  } else if (
    peakTotal > 0 &&
    total > 0 &&
    dayKey !== peakDate &&
    peakTotal / total >= FORENSIC_PEAK_RATIO_MIN &&
    activeH >= FORENSIC_PEAK_MIN_HOURS &&
    r.calls >= FORENSIC_PEAK_MIN_CALLS &&
    r.output >= FORENSIC_MIN_OUTPUT_FOR_PEAK_CMP
  ) {
    code = '<<P';
    hint =
      'Viel weniger Gesamt-Tokens als am Peak-Tag (' +
      peakDate +
      '), aber mit sp\u00fcrbar viel Output und vielen Calls \u2014 fr\u00fcher grob als \u201e90%?\u201c bezeichnet. Trifft nicht zu, wenn du im 5h-Fenster kaum gearbeitet hast (dann eher Zufall/Subagent-Rauschen); UI-Prozentsatz kann trotzdem 100% sein.';
  }

  return {
    forensic_code: code,
    forensic_hint: hint,
    forensic_implied_cap_90: implied90,
    forensic_vs_peak: vs_peak
  };
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

// Pro Tick nur wenige Dateien, damit HTTP/SSE während des Scans antworten kann.
var SCAN_FILES_PER_TICK = 6;

function pad2(n) {
  return n < 10 ? '0' + n : String(n);
}

function localCalendarTodayStr() {
  var d = new Date();
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}

function emptyDailyBucket() {
  return {
    input: 0,
    output: 0,
    cache_read: 0,
    cache_creation: 0,
    calls: 0,
    sub_calls: 0,
    sub_cache: 0,
    sub_output: 0,
    hours: {},
    models: {},
    hit_limit: 0
  };
}

function rowToDailyEntry(row) {
  return {
    input: row.input || 0,
    output: row.output || 0,
    cache_read: row.cache_read || 0,
    cache_creation: row.cache_creation || 0,
    calls: row.calls || 0,
    sub_calls: row.sub_calls || 0,
    sub_cache: row.sub_cache || 0,
    sub_output: row.sub_output || 0,
    hours: row.hours && typeof row.hours === 'object' ? row.hours : {},
    models: row.models && typeof row.models === 'object' ? row.models : {},
    hit_limit: row.hit_limit || 0
  };
}

function readUsageDayCache() {
  try {
    return JSON.parse(fs.readFileSync(USAGE_DAY_CACHE_FILE, 'utf8'));
  } catch (e) {
    return null;
  }
}

function writeUsageDayCache(payload) {
  var dir = path.dirname(USAGE_DAY_CACHE_FILE);
  try {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  } catch (e) {}
  var tmp = USAGE_DAY_CACHE_FILE + '.tmp';
  var body = JSON.stringify(payload);
  fs.writeFileSync(tmp, body, 'utf8');
  try {
    fs.renameSync(tmp, USAGE_DAY_CACHE_FILE);
  } catch (e) {
    fs.writeFileSync(USAGE_DAY_CACHE_FILE, body, 'utf8');
  }
}

// onlyDate: wenn gesetzt (YYYY-MM-DD), nur Zeilen dieses Kalendertags aus JSONL übernehmen (Vortage kommen aus Datei-Cache).
function processJsonlFile(f, daily, onlyDate) {
  var isSub = f.indexOf('subagent') >= 0;
  try {
    var lines = fs.readFileSync(f, 'utf8').split('\n');
    for (var li = 0; li < lines.length; li++) {
      var line = lines[li];
      if (!line.trim()) continue;
      var rec;
      try {
        rec = JSON.parse(line);
      } catch (e) {
        continue;
      }
      var ts = rec.timestamp || '';
      if (ts.length >= 10 && scanLineHitLimit(line)) {
        var dayLimit = ts.slice(0, 10);
        if (onlyDate && dayLimit !== onlyDate) {
          /* skip */
        } else {
          if (!daily[dayLimit]) daily[dayLimit] = emptyDailyBucket();
          daily[dayLimit].hit_limit = (daily[dayLimit].hit_limit || 0) + 1;
        }
      }

      var u = rec.message && rec.message.usage;
      if (!u) continue;
      var modelRaw = (rec.message && rec.message.model) || 'unknown';
      if (!isClaudeModel(modelRaw)) continue;
      if (ts.length < 19) continue;
      var day = ts.slice(0, 10);
      if (onlyDate && day !== onlyDate) continue;
      var hour = parseInt(ts.slice(11, 13));
      if (!daily[day]) daily[day] = emptyDailyBucket();
      var dd = daily[day];
      dd.input += (u.input_tokens || 0);
      dd.output += (u.output_tokens || 0);
      dd.cache_read += (u.cache_read_input_tokens || 0);
      dd.cache_creation += (u.cache_creation_input_tokens || 0);
      dd.calls++;
      dd.hours[hour] = (dd.hours[hour] || 0) + 1;
      if (isSub) {
        dd.sub_calls++;
        dd.sub_cache += (u.cache_read_input_tokens || 0);
        dd.sub_output += (u.output_tokens || 0);
      }
      var model = modelRaw;
      if (!dd.models[model]) dd.models[model] = { calls: 0, output: 0, cache_read: 0 };
      dd.models[model].calls++;
      dd.models[model].output += (u.output_tokens || 0);
      dd.models[model].cache_read += (u.cache_read_input_tokens || 0);
    }
  } catch (e) {}
}

function buildUsageResult(daily, fileCount) {
  var days = Object.keys(daily).sort();
  var result = [];
  for (var di = 0; di < days.length; di++) {
    var key = days[di];
    var r = daily[key];
    var total = r.input + r.output + r.cache_read + r.cache_creation;
    var activeH = Object.keys(r.hours).length;
    result.push({
      date: key,
      input: r.input,
      output: r.output,
      cache_read: r.cache_read,
      cache_creation: r.cache_creation,
      total: total,
      calls: r.calls,
      active_hours: activeH,
      cache_output_ratio: r.output > 0 ? Math.round(r.cache_read / r.output) : 0,
      overhead: r.output > 0 ? Math.round(total / r.output) : 0,
      sub_calls: r.sub_calls,
      sub_pct: r.calls > 0 ? Math.round(r.sub_calls / r.calls * 100) : 0,
      sub_cache: r.sub_cache,
      sub_cache_pct: r.cache_read > 0 ? Math.round(r.sub_cache / r.cache_read * 100) : 0,
      output_per_hour: activeH > 0 ? Math.round(r.output / activeH) : 0,
      total_per_hour: activeH > 0 ? Math.round(total / activeH) : 0,
      hit_limit: r.hit_limit || 0,
      models: r.models,
      hours: r.hours,
      forensic_code: '\u2014',
      forensic_hint: '',
      forensic_implied_cap_90: 0,
      forensic_vs_peak: 0
    });
  }

  var peakDate = '';
  var peakTotal = 0;
  for (var pi = 0; pi < result.length; pi++) {
    if (result[pi].total > peakTotal) {
      peakTotal = result[pi].total;
      peakDate = result[pi].date;
    }
  }
  for (var qi = 0; qi < result.length; qi++) {
    var row = result[qi];
    var rr = daily[row.date];
    if (!rr) continue;
    var f = computeForensicForDay(row.date, rr, peakDate, peakTotal);
    row.forensic_code = f.forensic_code;
    row.forensic_hint = f.forensic_hint;
    row.forensic_implied_cap_90 = f.forensic_implied_cap_90;
    row.forensic_vs_peak = f.forensic_vs_peak;
  }

  return {
    days: result,
    parsed_files: fileCount,
    generated: new Date().toISOString(),
    limit_source_note: LIMIT_SOURCE_NOTE,
    scope: 'claude-models-only',
    forensic_peak_date: peakDate,
    forensic_peak_total: peakTotal,
    forensic_note:
      'Forensic: ? = Cache\u2265500M; HIT = Limit-Zeilen in JSONL; <<P = stark unter Peak bei hohem Output (nicht \u201e90%\u201c/100% der UI). Impl@90% = total/0.9 nur Rechenbeispiel. Alles heuristisch.'
  };
}

function parseAllUsage() {
  var allFiles = walkJsonl(BASE);
  var daily = {};
  for (var fi = 0; fi < allFiles.length; fi++) {
    processJsonlFile(allFiles[fi], daily);
  }
  return buildUsageResult(daily, allFiles.length);
}

// Inkrementell: setImmediate zwischen Batches. Mit gültigem Tages-Cache nur JSONL für localCalendarTodayStr().
function parseAllUsageIncremental(done) {
  var allFiles;
  try {
    allFiles = walkJsonl(BASE);
  } catch (e) {
    done(e, null);
    return;
  }
  var noDayCache =
    process.env.CLAUDE_USAGE_NO_CACHE === '1' || process.env.CLAUDE_USAGE_NO_CACHE === 'true';
  var todayStr = localCalendarTodayStr();
  var cache = !noDayCache ? readUsageDayCache() : null;
  var useTodayOnly = false;
  if (
    cache &&
    cache.version === USAGE_DAY_CACHE_VERSION &&
    cache.jsonl_file_count === allFiles.length &&
    Array.isArray(cache.days) &&
    cache.days.length > 0
  ) {
    useTodayOnly = true;
  }

  var daily = {};
  if (useTodayOnly) {
    for (var ci = 0; ci < cache.days.length; ci++) {
      if (cache.days[ci].date === todayStr) continue;
      daily[cache.days[ci].date] = rowToDailyEntry(cache.days[ci]);
    }
    daily[todayStr] = emptyDailyBucket();
  }

  var onlyArg = useTodayOnly ? todayStr : null;
  var fi = 0;
  function tick() {
    var n = SCAN_FILES_PER_TICK;
    while (n-- > 0 && fi < allFiles.length) {
      processJsonlFile(allFiles[fi], daily, onlyArg);
      fi++;
    }
    if (fi < allFiles.length) {
      setImmediate(tick);
    } else {
      try {
        var result = buildUsageResult(daily, allFiles.length);
        result.calendar_today = todayStr;
        result.day_cache_mode = useTodayOnly ? 'heute-jsonl+vortage-cache' : 'vollstaendiger-jsonl-scan';
        if (!noDayCache) {
          try {
            writeUsageDayCache({
              version: USAGE_DAY_CACHE_VERSION,
              jsonl_file_count: allFiles.length,
              days: result.days,
              saved: new Date().toISOString()
            });
          } catch (we) {
            console.error('usage-dashboard: Tages-Cache schreiben fehlgeschlagen:', we.message || we);
          }
        }
        done(null, result);
      } catch (err) {
        done(err, null);
      }
    }
  }
  setImmediate(tick);
}

// ── HTML Dashboard ──────────────────────────────────────────────────────

var DASHBOARD_HTML = '<!DOCTYPE html>\n\
<html lang="en">\n\
<head>\n\
<meta charset="utf-8">\n\
<meta name="viewport" content="width=device-width,initial-scale=1">\n\
<title>Claude Code Usage Dashboard</title>\n\
<script src="https://cdn.jsdelivr.net/npm/chart.js@4"></script>\n\
<style>\n\
*{margin:0;padding:0;box-sizing:border-box}\n\
body{font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;background:#0f172a;color:#e2e8f0;padding:20px}\n\
h1{font-size:1.5rem;margin-bottom:4px;color:#f8fafc}\n\
.subtitle{color:#94a3b8;font-size:.85rem;margin-bottom:20px}\n\
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px;margin-bottom:24px}\n\
.card{background:#1e293b;border-radius:10px;padding:16px;border:1px solid #334155}\n\
.card .label{font-size:.75rem;color:#94a3b8;text-transform:uppercase;letter-spacing:.5px}\n\
.card .value{font-size:1.8rem;font-weight:700;margin-top:4px;color:#f8fafc}\n\
.card .sub{font-size:.75rem;color:#64748b;margin-top:2px}\n\
.card.warn{border-color:#f59e0b}\n\
.card.danger{border-color:#ef4444}\n\
.card.ok{border-color:#22c55e}\n\
.charts{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:24px}\n\
.charts.full{grid-template-columns:1fr}\n\
.chart-box{background:#1e293b;border-radius:10px;padding:16px;border:1px solid #334155}\n\
.chart-box h3{font-size:.9rem;color:#94a3b8;margin-bottom:10px}\n\
canvas{width:100%!important}\n\
table{width:100%;border-collapse:collapse;font-size:.8rem}\n\
th{text-align:left;color:#94a3b8;font-weight:500;padding:8px 6px;border-bottom:1px solid #334155;position:sticky;top:0;background:#1e293b}\n\
td{padding:6px;border-bottom:1px solid #1e293b;color:#cbd5e1;font-variant-numeric:tabular-nums}\n\
tr:hover td{background:#334155}\n\
.num{text-align:right}\n\
.hi{color:#fbbf24;font-weight:600}\n\
.crit{color:#ef4444;font-weight:700}\n\
.ok-txt{color:#22c55e}\n\
.bar-wrap{height:6px;background:#334155;border-radius:3px;min-width:80px}\n\
.bar-fill{height:100%;border-radius:3px;background:linear-gradient(90deg,#3b82f6,#8b5cf6)}\n\
.bar-fill.warn{background:linear-gradient(90deg,#f59e0b,#ef4444)}\n\
.refresh{position:fixed;top:16px;right:20px;background:#334155;color:#e2e8f0;border:none;padding:8px 14px;border-radius:6px;cursor:pointer;font-size:.8rem}\n\
.refresh:hover{background:#475569}\n\
.forensic-details{margin-top:12px;margin-bottom:20px;background:#1e293b;border:1px solid #334155;border-radius:10px;overflow:hidden}\n\
.forensic-summary{cursor:pointer;padding:12px 16px 12px 20px;font-size:.85rem;color:#cbd5e1;line-height:1.4;list-style-position:outside}\n\
.forensic-summary:hover{color:#f8fafc}\n\
.forensic-inner{padding:0 16px 16px;border-top:1px solid #334155}\n\
.forensic-note-p{font-size:.8rem;color:#64748b;line-height:1.45;margin:12px 0}\n\
@media(max-width:900px){.charts{grid-template-columns:1fr}}\n\
.day-picker-row{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:14px}\n\
.day-picker-row label{color:#94a3b8;font-size:.85rem}\n\
.day-picker-row select{background:#1e293b;color:#e2e8f0;border:1px solid #334155;border-radius:6px;padding:8px 12px;font-size:.9rem;min-width:220px}\n\
.day-picker-hint{font-size:.75rem;color:#64748b;max-width:36rem;line-height:1.4}\n\
</style>\n\
</head>\n\
<body>\n\
<div class="refresh"><span id="live-dot" style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#22c55e;margin-right:6px;animation:pulse 2s infinite"></span><span id="live-label">Live</span></div>\n\
<style>@keyframes pulse{0%,100%{opacity:1}50%{opacity:.3}}</style>\n\
<h1>Claude Code Token Usage</h1>\n\
<div class="subtitle">Nur <strong>Claude</strong>-Modelle (<code>claude-*</code>) — keine <code>&lt;synthetic&gt;</code>-Zeilen.</div>\n\
<div class="subtitle" id="meta"></div>\n\
<div class="subtitle" id="limit-source" style="margin-top:8px;line-height:1.45"></div>\n\
<details class="forensic-details" id="forensic-collapse">\n\
<summary class="forensic-summary" id="forensic-summary-line">Forensic (token_forensics)</summary>\n\
<div class="forensic-inner">\n\
<p class="forensic-note-p" id="forensic-note"></p>\n\
<div class="grid" id="forensic-cards"></div>\n\
<div class="chart-box" style="margin-top:16px;margin-bottom:0">\n\
<h3>Forensic &amp; Hit Limit pro Tag</h3>\n\
<p style="font-size:.75rem;color:#94a3b8;margin:6px 0 10px;line-height:1.45"><strong style="color:#ef4444">Rot (Balken)</strong> = Z\u00e4hler Hit-Limit-Zeilen in JSONL. <strong style="color:#f59e0b">Linie</strong> = Score 3=? · 2=HIT · 1=&lt;&lt;P (Peak-Vergleich, nicht Claude-UI 90%/100%).</p>\n\
<canvas id="c-forensic"></canvas>\n\
</div>\n\
</div>\n\
</details>\n\
<div class="day-picker-row" id="day-picker-row">\n\
<label for="day-picker">Karten &amp; Tabelle (Tag w\u00e4hlen)</label>\n\
<select id="day-picker" aria-label="Tag f\u00fcr Karten und Tagesdetail"></select>\n\
<span class="day-picker-hint" id="day-picker-hint"></span>\n\
</div>\n\
<div class="grid" id="cards"></div>\n\
<div class="charts" id="charts"></div>\n\
<div class="charts" id="charts2"></div>\n\
<div class="chart-box" style="margin-bottom:24px"><h3 id="daily-detail-heading">Tagesdetail</h3><div style="overflow-x:auto"><table id="tbl"><thead><tr></tr></thead><tbody></tbody></table></div></div>\n\
<script>\n\
var defined_colors = {\n\
  blue: "#3b82f6", purple: "#8b5cf6", green: "#22c55e", amber: "#f59e0b",\n\
  red: "#ef4444", cyan: "#06b6d4", slate: "#64748b", pink: "#ec4899"\n\
};\n\
function fmt(n) {\n\
  if (n >= 1e9) return (n/1e9).toFixed(1)+"B";\n\
  if (n >= 1e6) return (n/1e6).toFixed(1)+"M";\n\
  if (n >= 1e3) return (n/1e3).toFixed(1)+"K";\n\
  return String(n);\n\
}\n\
function pct(a,b){return b>0?(a/b*100).toFixed(1)+"%":"-";}\n\
function escHtml(s){return String(s==null?"":s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/\"/g,"&quot;");}\n\
\n\
var _charts = {};\n\
var __lastUsageData = null;\n\
function renderDashboard(data) {\n\
  __lastUsageData = data;\n\
  var days = data.days;\n\
  if(!days.length){\n\
    var meta0=document.getElementById("meta");\n\
    var ls0=document.getElementById("limit-source");\n\
    if(ls0&&data.limit_source_note)ls0.textContent=data.limit_source_note;\n\
    if(data.scanning){\n\
      var dps=document.getElementById("day-picker-row");if(dps)dps.style.display="none";\n\
      meta0.textContent="Scanne ~/.claude/projects im Hintergrund… Inhalt folgt per Live-Update (SSE). Dateien werden in kleinen Batches gelesen.";\n\
      var sumS=document.getElementById("forensic-summary-line");if(sumS)sumS.textContent="Forensic — Scan läuft…";\n\
      var fnS=document.getElementById("forensic-note");if(fnS)fnS.textContent="Erster Lauf nach Serverstart; danach alle "+(data.refresh_sec||30)+"s im Hintergrund.";\n\
      document.getElementById("cards").innerHTML="";\n\
      var fcS=document.getElementById("forensic-cards");if(fcS)fcS.innerHTML="";\n\
      if(_charts.cForensic){try{_charts.cForensic.destroy();}catch(e){}_charts.cForensic=null;}\n\
      document.getElementById("live-label").textContent="Live — warte auf Daten…";\n\
      return;\n\
    }\n\
    var dpe=document.getElementById("day-picker-row");if(dpe)dpe.style.display="none";\n\
    if(data.scan_error)meta0.textContent="Scan-Fehler: "+data.scan_error;\n\
    else if((data.parsed_files||0)===0)meta0.textContent="Keine Daten: 0 .jsonl-Dateien unter ~/.claude/projects gefunden. Ohne Claude-Code-Projektlogs bleiben Karten und Tabellen leer.";\n\
    else meta0.textContent="Keine Tageswerte: "+(data.parsed_files||0)+" Datei(en) gelesen, aber keine usage-Zeilen mit Modell claude-*.";\n\
    var sum0=document.getElementById("forensic-summary-line");if(sum0)sum0.textContent="Forensic (token_forensics) — keine Daten";\n\
    var fn0=document.getElementById("forensic-note");if(fn0)fn0.textContent="";\n\
    var fc0=document.getElementById("forensic-cards");if(fc0)fc0.innerHTML="";\n\
    document.getElementById("cards").innerHTML="";\n\
    if(_charts.cForensic){try{_charts.cForensic.destroy();}catch(e){}_charts.cForensic=null;}\n\
    var dpr=document.getElementById("day-picker-row");if(dpr)dpr.style.display="none";\n\
    return;\n\
  }\n\
  var dpr0=document.getElementById("day-picker-row");if(dpr0)dpr0.style.display="";\n\
  \n\
  var calToday = data.calendar_today || "";\n\
  var metaLine = "Parsed "+data.parsed_files+" log files | Last update: "+new Date(data.generated).toLocaleString()+" | Auto-refresh every "+(data.refresh_sec||30)+"s";\n\
  if (data.day_cache_mode) metaLine += " | "+data.day_cache_mode;\n\
  metaLine += " | Karten: gew\u00e4hlter Tag (Dropdown), Diagramme: alle Tage.";\n\
  document.getElementById("meta").textContent = metaLine;\n\
  \n\
  var selEl = document.getElementById("day-picker");\n\
  var prevSel = selEl && selEl.value ? selEl.value : "";\n\
  if (!prevSel) {\n\
    try { prevSel = sessionStorage.getItem("usageDashboardDay") || ""; } catch (e) {}\n\
  }\n\
  var valid = {};\n\
  for (var vi = 0; vi < days.length; vi++) valid[days[vi].date] = true;\n\
  selEl.innerHTML = "";\n\
  for (var di = days.length - 1; di >= 0; di--) {\n\
    var o = document.createElement("option");\n\
    o.value = days[di].date;\n\
    var lab = days[di].date;\n\
    if (days[di].date === calToday) lab += " \u2014 Kalender heute";\n\
    if ((days[di].total || 0) === 0) lab += " (0 in Logs)";\n\
    o.textContent = lab;\n\
    selEl.appendChild(o);\n\
  }\n\
  var pick = prevSel;\n\
  if (!pick || !valid[pick]) {\n\
    pick = (calToday && valid[calToday]) ? calToday : days[days.length - 1].date;\n\
  }\n\
  selEl.value = pick;\n\
  if (!selEl.dataset.bound) {\n\
    selEl.dataset.bound = "1";\n\
    selEl.addEventListener("change", function () {\n\
      try { sessionStorage.setItem("usageDashboardDay", this.value); } catch (e) {}\n\
      if (__lastUsageData) renderDashboard(__lastUsageData);\n\
    });\n\
  }\n\
  var selDay = null;\n\
  for (var sj = 0; sj < days.length; sj++) {\n\
    if (days[sj].date === pick) { selDay = days[sj]; break; }\n\
  }\n\
  if (!selDay) selDay = days[days.length - 1];\n\
  var hintEl = document.getElementById("day-picker-hint");\n\
  if (hintEl) {\n\
    hintEl.textContent = (pick === calToday && (selDay.total || 0) === 0)\n\
      ? "Kalender-heute: 0 Tokens in den Logs \u2014 \u00e4lteren Tag mit Nutzung w\u00e4hlen."\n\
      : "";\n\
  }\n\
  var ddh = document.getElementById("daily-detail-heading");\n\
  if (ddh) ddh.textContent = "Tagesdetail \u2014 " + pick;\n\
  var ls = document.getElementById("limit-source");\n\
  ls.textContent = data.limit_source_note || "";\n\
  ls.title = "Session- und Rate-Limits setzt Anthropic/Claude Code; JSONL enthält meist nur erfolgreiche API-Nutzung (usage). Hit Limit zählt Zeilen mit typischen Limit-/Fehlertexten.";\n\
  var fn = document.getElementById("forensic-note");\n\
  if(fn) fn.textContent = data.forensic_note || "";\n\
  document.getElementById("live-label").textContent = "Live ("+new Date().toLocaleTimeString()+")";\n\
  \n\
  // --- Summary cards (gewählter Tag im Dropdown) ---\n\
  var totalOut = days.reduce(function(s,d){return s+d.output},0);\n\
  var totalCache = days.reduce(function(s,d){return s+d.cache_read},0);\n\
  var totalAll = days.reduce(function(s,d){return s+d.total},0);\n\
  \n\
  // Find peak day\n\
  var peak = days.reduce(function(a,b){return a.total>b.total?a:b});\n\
  var budgetRatio = peak.total > 0 && selDay.total > 0 ? Math.round(peak.total / (selDay.total / 0.9)) : 0;\n\
  var hitSel = selDay.hit_limit || 0;\n\
  var hitAll = days.reduce(function(s,d){return s+(d.hit_limit||0)},0);\n\
  var fc = selDay.forensic_code || "\u2014";\n\
  var fwarn = fc === "?" || fc === "HIT" || fc === "<<P";\n\
  var impl90 = selDay.forensic_implied_cap_90 || 0;\n\
  var sumEl = document.getElementById("forensic-summary-line");\n\
  if (sumEl) {\n\
    sumEl.textContent = "Forensic \u2014 " + pick + ": " + fc + " | Impl@90%: " + (impl90 > 0 ? fmt(impl90) : "\u2014") + " | Budget ~" + budgetRatio + "\u00d7 | Peak " + peak.date;\n\
  }\n\
  \n\
  var cards = [\n\
    {label:"Tag Output",value:fmt(selDay.output),sub:selDay.date,cls:""},\n\
    {label:"Tag Cache Read",value:fmt(selDay.cache_read),sub:"Cache:Out "+selDay.cache_output_ratio+"x",cls:selDay.cache_output_ratio>500?"warn":""},\n\
    {label:"Tag Total",value:fmt(selDay.total),sub:selDay.calls+" calls, "+selDay.active_hours+"h active",cls:""},\n\
    {label:"Hit Limit (Tag)",value:String(hitSel),sub:"JSONL-Zeilen Limit/429 an diesem Tag",cls:hitSel>0?"warn":"ok"},\n\
    {label:"Hit Limit (alle Tage)",value:String(hitAll),sub:"Summe über alle Tage",cls:hitAll>0?"warn":""},\n\
    {label:"Tag Overhead",value:selDay.overhead+"x",sub:"tokens pro Output-Token",cls:selDay.overhead>1000?"danger":""},\n\
    {label:"Peak Day Total",value:fmt(peak.total),sub:peak.date+" (höchste Claude-Nutzung im Log)",cls:"ok"},\n\
    {label:"All-Time Output",value:fmt(totalOut),sub:days.length+" days active",cls:""},\n\
    {label:"All-Time Cache",value:fmt(totalCache),sub:pct(totalCache,totalAll)+" of total",cls:""}\n\
  ];\n\
  var fcards = [\n\
    {label:"Forensic (gew. Tag)",value:fc,sub:selDay.forensic_hint||"",cls:fwarn?"warn":""},\n\
    {label:"Impl. cap @90%",value:impl90>0?fmt(impl90):"\u2014",sub:"total/0.9 (Rechenbeispiel, nicht UI-90%/100%)",cls:""},\n\
    {label:"Budget Reduction",value:"~"+budgetRatio+"x",sub:"peak / (today/0.9) wie Fazit token_forensics.js",cls:budgetRatio>10?"danger":"warn"}\n\
  ];\n\
  var chtml="";\n\
  cards.forEach(function(c){chtml+="<div class=\\"card "+c.cls+"\\"><div class=\\"label\\">"+escHtml(c.label)+"</div><div class=\\"value\\">"+escHtml(c.value)+"</div><div class=\\"sub\\">"+escHtml(c.sub)+"</div></div>";});\n\
  document.getElementById("cards").innerHTML=chtml;\n\
  var fch="";\n\
  fcards.forEach(function(c){fch+="<div class=\\"card "+c.cls+"\\"><div class=\\"label\\">"+escHtml(c.label)+"</div><div class=\\"value\\">"+escHtml(c.value)+"</div><div class=\\"sub\\">"+escHtml(c.sub)+"</div></div>";});\n\
  var fcg=document.getElementById("forensic-cards");if(fcg)fcg.innerHTML=fch;\n\
  \n\
  // --- Charts ---\n\
  var labels = days.map(function(d){return d.date.slice(5)});\n\
  \n\
  // Create chart containers only once\n\
  if (!document.getElementById("c1")) {\n\
    var ch1 = document.createElement("div");ch1.className="chart-box";\n\
    ch1.innerHTML="<h3>Daily Token Consumption</h3><canvas id=\\"c1\\"></canvas>";\n\
    var ch2 = document.createElement("div");ch2.className="chart-box";\n\
    ch2.innerHTML="<h3>Cache:Output Ratio (lower = more efficient)</h3><canvas id=\\"c2\\"></canvas>";\n\
    document.getElementById("charts").appendChild(ch1);\n\
    document.getElementById("charts").appendChild(ch2);\n\
  }\n\
  \n\
  // Destroy old charts before recreating\n\
  if (_charts.c1) { _charts.c1.destroy(); }\n\
  if (_charts.c2) { _charts.c2.destroy(); }\n\
  \n\
  _charts.c1 = new Chart(document.getElementById("c1"),{\n\
    type:"bar",\n\
    data:{labels:labels,datasets:[\n\
      {label:"Cache Read",data:days.map(function(d){return d.cache_read}),backgroundColor:"rgba(139,92,246,0.7)",stack:"s"},\n\
      {label:"Output",data:days.map(function(d){return d.output}),backgroundColor:"rgba(59,130,246,0.9)",stack:"s"},\n\
      {label:"Cache Create",data:days.map(function(d){return d.cache_creation}),backgroundColor:"rgba(6,182,212,0.5)",stack:"s"}\n\
    ]},\n\
    options:{responsive:true,scales:{y:{stacked:true,ticks:{callback:function(v){return fmt(v)}}},x:{stacked:true}},plugins:{tooltip:{callbacks:{label:function(c){return c.dataset.label+": "+fmt(c.raw)}}}}}\n\
  });\n\
  \n\
  _charts.c2 = new Chart(document.getElementById("c2"),{\n\
    type:"line",\n\
    data:{labels:labels,datasets:[{\n\
      label:"Cache:Output",data:days.map(function(d){return d.cache_output_ratio}),\n\
      borderColor:"#f59e0b",backgroundColor:"rgba(245,158,11,0.1)",fill:true,tension:0.3\n\
    }]},\n\
    options:{responsive:true,scales:{y:{beginAtZero:true}},plugins:{tooltip:{callbacks:{label:function(c){return c.raw+"x"}}}}}\n\
  });\n\
  \n\
  // Chart 3: Output per hour + Overhead\n\
  if (!document.getElementById("c3")) {\n\
    var ch3 = document.createElement("div");ch3.className="chart-box";\n\
    ch3.innerHTML="<h3>Output per Active Hour</h3><canvas id=\\"c3\\"></canvas>";\n\
    var ch4 = document.createElement("div");ch4.className="chart-box";\n\
    ch4.innerHTML="<h3>Subagent Cache % of Total Cache</h3><canvas id=\\"c4\\"></canvas>";\n\
    document.getElementById("charts2").appendChild(ch3);\n\
    document.getElementById("charts2").appendChild(ch4);\n\
  }\n\
  \n\
  if (_charts.c3) { _charts.c3.destroy(); }\n\
  if (_charts.c4) { _charts.c4.destroy(); }\n\
  \n\
  _charts.c3 = new Chart(document.getElementById("c3"),{\n\
    type:"bar",\n\
    data:{labels:labels,datasets:[{\n\
      label:"Output/hour",data:days.map(function(d){return d.output_per_hour}),\n\
      backgroundColor:"rgba(34,197,94,0.7)"\n\
    }]},\n\
    options:{responsive:true,scales:{y:{ticks:{callback:function(v){return fmt(v)}}}},plugins:{tooltip:{callbacks:{label:function(c){return fmt(c.raw)+"/h"}}}}}\n\
  });\n\
  \n\
  _charts.c4 = new Chart(document.getElementById("c4"),{\n\
    type:"bar",\n\
    data:{labels:labels,datasets:[{\n\
      label:"Subagent Cache %",data:days.map(function(d){return d.sub_cache_pct}),\n\
      backgroundColor:days.map(function(d){return d.sub_cache_pct>50?"rgba(239,68,68,0.7)":"rgba(100,116,139,0.5)"})\n\
    }]},\n\
    options:{responsive:true,scales:{y:{max:100,ticks:{callback:function(v){return v+"%"}}}},plugins:{tooltip:{callbacks:{label:function(c){return c.raw+"%"}}}}}\n\
  });\n\
  \n\
  // --- Table ---\n\
  var cols=["Date","Output","Cache Read","C:O Ratio","Overhead","Total","Calls","Hours","Hit Limit","Sub%","Sub Cache%","Out/h"];\n\
  var thead=document.querySelector("#tbl thead tr");\n\
  thead.innerHTML="";\n\
  cols.forEach(function(c){var th=document.createElement("th");th.textContent=c;if(c!=="Date")th.className="num";thead.appendChild(th);});\n\
  \n\
  var tbody=document.querySelector("#tbl tbody");\n\
  tbody.innerHTML="";\n\
  var tableRows=[selDay];\n\
  for(var i=0;i<tableRows.length;i++){\n\
    var d=tableRows[i];\n\
    var tr=document.createElement("tr");\n\
    var hl=d.hit_limit||0;\n\
    var vals=[d.date,fmt(d.output),fmt(d.cache_read),d.cache_output_ratio+"x",d.overhead+"x",fmt(d.total),d.calls,d.active_hours,String(hl),d.sub_pct+"%",d.sub_cache_pct+"%",fmt(d.output_per_hour)];\n\
    vals.forEach(function(v,j){\n\
      var td=document.createElement("td");\n\
      td.textContent=v;\n\
      if(j>0)td.className="num";\n\
      if(j===3&&d.cache_output_ratio>1000)td.classList.add("hi");\n\
      if(j===3&&d.cache_output_ratio>2000)td.classList.add("crit");\n\
      if(j===4&&d.overhead>1500)td.classList.add("hi");\n\
      if(j===8&&hl>0)td.classList.add("hi");\n\
      tr.appendChild(td);\n\
    });\n\
    tbody.appendChild(tr);\n\
  }\n\
  \n\
  function forensicScoreDay(d){\n\
    var c=d.forensic_code||"\u2014";\n\
    if(c==="?")return 3;\n\
    if(c==="HIT")return 2;\n\
    if(c==="<<P")return 1;\n\
    return 0;\n\
  }\n\
  var elF=document.getElementById("c-forensic");\n\
  if(elF){\n\
    if(_charts.cForensic){try{_charts.cForensic.destroy();}catch(e){}}\n\
    _charts.cForensic=new Chart(elF,{\n\
      data:{\n\
        labels:labels,\n\
        datasets:[\n\
          {\n\
            type:"bar",\n\
            label:"Hit Limit (JSONL-Zeilen)",\n\
            data:days.map(function(d){return d.hit_limit||0}),\n\
            backgroundColor:days.map(function(d){return (d.hit_limit||0)>0?"rgba(239,68,68,0.92)":"rgba(71,85,105,0.35)"}),\n\
            borderColor:days.map(function(d){return (d.hit_limit||0)>0?"#dc2626":"transparent"}),\n\
            borderWidth:1,\n\
            yAxisID:"y"\n\
          },\n\
          {\n\
            type:"line",\n\
            label:"Forensic-Score (3=? · 2=HIT · 1=<<P)",\n\
            data:days.map(forensicScoreDay),\n\
            borderColor:"#f59e0b",\n\
            backgroundColor:"rgba(245,158,11,0.12)",\n\
            pointBackgroundColor:"#fbbf24",\n\
            pointRadius:4,\n\
            tension:0.25,\n\
            yAxisID:"y1",\n\
            borderWidth:2\n\
          }\n\
        ]\n\
      },\n\
      options:{\n\
        responsive:true,\n\
        maintainAspectRatio:true,\n\
        aspectRatio:2.4,\n\
        interaction:{mode:"index",intersect:false},\n\
        scales:{\n\
          x:{grid:{color:"rgba(51,65,85,0.5)"}},\n\
          y:{\n\
            position:"left",\n\
            beginAtZero:true,\n\
            title:{display:true,text:"Hit Limit (rot)",color:"#f87171"},\n\
            ticks:{color:"#94a3b8",precision:0},\n\
            grid:{color:"rgba(51,65,85,0.5)"}\n\
          },\n\
          y1:{\n\
            position:"right",\n\
            min:0,\n\
            max:3.5,\n\
            title:{display:true,text:"Forensic",color:"#fbbf24"},\n\
            ticks:{stepSize:1,color:"#94a3b8"},\n\
            grid:{drawOnChartArea:false}\n\
          }\n\
        },\n\
        plugins:{\n\
          legend:{labels:{color:"#cbd5e1"}},\n\
          tooltip:{\n\
            callbacks:{\n\
              title:function(items){return items.length?days[items[0].dataIndex].date:"";},\n\
              afterBody:function(items){\n\
                if(!items.length)return"";\n\
                var di=items[0].dataIndex;\n\
                var x=days[di];\n\
                var lines=[];\n\
                lines.push("vs Peak: "+(x.forensic_vs_peak>0?x.forensic_vs_peak+"\u00d7":"\u2014"));\n\
                lines.push("Impl@90%: "+(x.forensic_implied_cap_90>0?fmt(x.forensic_implied_cap_90):"\u2014"));\n\
                if(x.forensic_hint)lines.push(x.forensic_hint);\n\
                return lines;\n\
              }\n\
            }\n\
          }\n\
        }\n\
      }\n\
    });\n\
  }\n\
}\n\
\n\
// Sofort aktuellen Cache holen (nicht nur auf erstes SSE warten)\n\
fetch("/api/usage").then(function(r){return r.json();}).then(function(d){try{renderDashboard(d);}catch(e){console.error(e);}}).catch(function(){});\n\
\n\
// SSE: auto-update from server push\n\
var evtSource = new EventSource("/api/stream");\n\
evtSource.onmessage = function(e) {\n\
  try { renderDashboard(JSON.parse(e.data)); } catch(err) { console.error(err); }\n\
};\n\
evtSource.onerror = function() {\n\
  document.getElementById("live-dot").style.background = "#ef4444";\n\
  document.getElementById("live-label").textContent = "Disconnected — retrying...";\n\
};\n\
</script>\n\
</body>\n\
</html>';

// ── Live Data Cache + SSE ────────────────────────────────────────────────

function makeStubCachedData() {
  return {
    days: [],
    parsed_files: 0,
    generated: new Date().toISOString(),
    refresh_sec: REFRESH_SEC,
    limit_source_note: LIMIT_SOURCE_NOTE,
    scope: 'claude-models-only',
    forensic_peak_date: '',
    forensic_peak_total: 0,
    forensic_note: '',
    scanning: true,
    calendar_today: localCalendarTodayStr(),
    day_cache_mode: ''
  };
}

var cachedData = makeStubCachedData();
var sseClients = [];
var scanInProgress = false;
var scanQueued = false;

function broadcastSse() {
  if (!cachedData) return;
  var json = JSON.stringify(cachedData);
  for (var i = sseClients.length - 1; i >= 0; i--) {
    try {
      sseClients[i].write('data: ' + json + '\n\n');
    } catch (e) {
      sseClients.splice(i, 1);
    }
  }
}

// Scan läuft inkrementell (setImmediate zwischen Datei-Batches): Server startet sofort, HTTP bleibt bedienbar.
function runScanAndBroadcast() {
  if (scanInProgress) {
    scanQueued = true;
    return;
  }
  scanInProgress = true;
  parseAllUsageIncremental(function (err, data) {
    try {
      if (err) throw err;
      data.refresh_sec = REFRESH_SEC;
      data.scanning = false;
      if (data.scan_error) delete data.scan_error;
      cachedData = data;
    } catch (e) {
      console.error('parseAllUsageIncremental:', e);
      var msg = e && e.message ? e.message : String(e);
      if (!cachedData || !cachedData.days || cachedData.days.length === 0) {
        cachedData = makeStubCachedData();
      }
      cachedData.scanning = false;
      cachedData.scan_error = msg;
    } finally {
      scanInProgress = false;
      broadcastSse();
      if (scanQueued) {
        scanQueued = false;
        runScanAndBroadcast();
      }
    }
  });
}

// ── HTTP Server ─────────────────────────────────────────────────────────

var server = http.createServer(function (req, res) {
  if (req.url === '/api/usage') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(cachedData));
  } else if (req.url === '/api/stream') {
    // SSE endpoint
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*'
    });
    res.write('data: ' + JSON.stringify(cachedData) + '\n\n');
    sseClients.push(res);
    req.on('close', function () {
      var idx = sseClients.indexOf(res);
      if (idx >= 0) sseClients.splice(idx, 1);
    });
  } else {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(DASHBOARD_HTML);
  }
});

server.listen(PORT, function () {
  console.log('Claude Code Usage Dashboard running at http://localhost:' + PORT);
  console.log('Auto-refresh every ' + REFRESH_SEC + 's (--refresh=N to change)');
  console.log('Erster Scan ~/.claude/projects läuft im Hintergrund (Seite sofort nutzbar).');
  console.log('Press Ctrl+C to stop.');
  runScanAndBroadcast();
});

setInterval(runScanAndBroadcast, REFRESH_SEC * 1000);
