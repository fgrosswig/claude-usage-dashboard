#!/usr/bin/env node
// Claude Code Token Usage Dashboard — standalone, zero dependencies
// Usage: node claude-usage-dashboard.js [--port=3333]

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

// ── JSONL Parser ────────────────────────────────────────────────────────

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

function parseAllUsage() {
  var allFiles = walkJsonl(BASE);
  var daily = {};

  for (var fi = 0; fi < allFiles.length; fi++) {
    var f = allFiles[fi];
    var isSub = f.indexOf('subagent') >= 0;
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
          if (ts.length < 19) continue;
          var day = ts.slice(0, 10);
          var hour = parseInt(ts.slice(11, 13));
          if (!daily[day]) daily[day] = {
            input: 0, output: 0, cache_read: 0, cache_creation: 0,
            calls: 0, sub_calls: 0, sub_cache: 0, sub_output: 0,
            hours: {}, models: {}
          };
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
          var model = d.message.model || 'unknown';
          if (!dd.models[model]) dd.models[model] = { calls: 0, output: 0, cache_read: 0 };
          dd.models[model].calls++;
          dd.models[model].output += (u.output_tokens || 0);
          dd.models[model].cache_read += (u.cache_read_input_tokens || 0);
        } catch (e) {}
      }
    } catch (e) {}
  }

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
      models: r.models,
      hours: r.hours
    });
  }
  return { days: result, parsed_files: allFiles.length, generated: new Date().toISOString() };
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
@media(max-width:900px){.charts{grid-template-columns:1fr}}\n\
</style>\n\
</head>\n\
<body>\n\
<div class="refresh"><span id="live-dot" style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#22c55e;margin-right:6px;animation:pulse 2s infinite"></span><span id="live-label">Live</span></div>\n\
<style>@keyframes pulse{0%,100%{opacity:1}50%{opacity:.3}}</style>\n\
<h1>Claude Code Token Usage</h1>\n\
<div class="subtitle" id="meta"></div>\n\
<div class="grid" id="cards"></div>\n\
<div class="charts" id="charts"></div>\n\
<div class="charts" id="charts2"></div>\n\
<div class="chart-box" style="margin-bottom:24px"><h3>Daily Detail</h3><div style="overflow-x:auto"><table id="tbl"><thead><tr></tr></thead><tbody></tbody></table></div></div>\n\
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
\n\
var _charts = {};\n\
function renderDashboard(data) {\n\
  var days = data.days;\n\
  if(!days.length){document.getElementById("meta").textContent="No data found.";return;}\n\
  \n\
  document.getElementById("meta").textContent = "Parsed "+data.parsed_files+" log files | Last update: "+new Date(data.generated).toLocaleString()+" | Auto-refresh every "+(data.refresh_sec||30)+"s";\n\
  document.getElementById("live-label").textContent = "Live ("+new Date().toLocaleTimeString()+")";\n\
  \n\
  // --- Summary cards ---\n\
  var today = days[days.length-1];\n\
  var totalOut = days.reduce(function(s,d){return s+d.output},0);\n\
  var totalCache = days.reduce(function(s,d){return s+d.cache_read},0);\n\
  var totalAll = days.reduce(function(s,d){return s+d.total},0);\n\
  var avgOverhead = days.filter(function(d){return d.output>50000}).reduce(function(s,d){return s+d.overhead},0) / Math.max(1,days.filter(function(d){return d.output>50000}).length);\n\
  \n\
  // Find peak day\n\
  var peak = days.reduce(function(a,b){return a.total>b.total?a:b});\n\
  var budgetRatio = peak.total > 0 && today.total > 0 ? Math.round(peak.total / (today.total / 0.9)) : 0;\n\
  \n\
  var cards = [\n\
    {label:"Today Output",value:fmt(today.output),sub:today.date,cls:""},\n\
    {label:"Today Cache Read",value:fmt(today.cache_read),sub:"Cache:Out "+today.cache_output_ratio+"x",cls:today.cache_output_ratio>500?"warn":""},\n\
    {label:"Today Total",value:fmt(today.total),sub:today.calls+" calls, "+today.active_hours+"h active",cls:""},\n\
    {label:"Today Overhead",value:today.overhead+"x",sub:"tokens per output token",cls:today.overhead>1000?"danger":""},\n\
    {label:"Peak Day Total",value:fmt(peak.total),sub:peak.date+" (no limit)",cls:"ok"},\n\
    {label:"Budget Reduction",value:"~"+budgetRatio+"x",sub:"peak vs today implied budget",cls:budgetRatio>10?"danger":"warn"},\n\
    {label:"All-Time Output",value:fmt(totalOut),sub:days.length+" days active",cls:""},\n\
    {label:"All-Time Cache",value:fmt(totalCache),sub:pct(totalCache,totalAll)+" of total",cls:""}\n\
  ];\n\
  var chtml="";\n\
  cards.forEach(function(c){chtml+="<div class=\\"card "+c.cls+"\\"><div class=\\"label\\">"+c.label+"</div><div class=\\"value\\">"+c.value+"</div><div class=\\"sub\\">"+c.sub+"</div></div>";});\n\
  document.getElementById("cards").innerHTML=chtml;\n\
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
  var cols=["Date","Output","Cache Read","C:O Ratio","Overhead","Total","Calls","Hours","Sub%","Sub Cache%","Out/h"];\n\
  var thead=document.querySelector("#tbl thead tr");\n\
  cols.forEach(function(c){var th=document.createElement("th");th.textContent=c;if(c!=="Date")th.className="num";thead.appendChild(th);});\n\
  \n\
  var tbody=document.querySelector("#tbl tbody");\n\
  for(var i=days.length-1;i>=0;i--){\n\
    var d=days[i];\n\
    var tr=document.createElement("tr");\n\
    var vals=[d.date,fmt(d.output),fmt(d.cache_read),d.cache_output_ratio+"x",d.overhead+"x",fmt(d.total),d.calls,d.active_hours,d.sub_pct+"%",d.sub_cache_pct+"%",fmt(d.output_per_hour)];\n\
    vals.forEach(function(v,j){\n\
      var td=document.createElement("td");\n\
      td.textContent=v;\n\
      if(j>0)td.className="num";\n\
      if(j===3&&d.cache_output_ratio>1000)td.classList.add("hi");\n\
      if(j===3&&d.cache_output_ratio>2000)td.classList.add("crit");\n\
      if(j===4&&d.overhead>1500)td.classList.add("hi");\n\
      tr.appendChild(td);\n\
    });\n\
    tbody.appendChild(tr);\n\
  }\n\
}\n\
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

var cachedData = null;
var sseClients = [];

function refreshData() {
  cachedData = parseAllUsage();
  cachedData.refresh_sec = REFRESH_SEC;
  var json = JSON.stringify(cachedData);
  // Push to all SSE clients
  for (var i = sseClients.length - 1; i >= 0; i--) {
    try {
      sseClients[i].write('data: ' + json + '\n\n');
    } catch (e) {
      sseClients.splice(i, 1);
    }
  }
  return cachedData;
}

// Initial load + periodic refresh
refreshData();
setInterval(refreshData, REFRESH_SEC * 1000);

// ── HTTP Server ─────────────────────────────────────────────────────────

var server = http.createServer(function (req, res) {
  if (req.url === '/api/usage') {
    if (!cachedData) refreshData();
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
  console.log('Scanning: ' + BASE);
  console.log('Press Ctrl+C to stop.');
});
