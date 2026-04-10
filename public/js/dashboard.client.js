var defined_colors = {
  blue: "#3b82f6", purple: "#8b5cf6", green: "#22c55e", amber: "#f59e0b",
  red: "#ef4444", cyan: "#06b6d4", slate: "#64748b", pink: "#ec4899"
};
function fmt(n) {
  if (n >= 1e9) return (n/1e9).toFixed(1)+"B";
  if (n >= 1e6) return (n/1e6).toFixed(1)+"M";
  if (n >= 1e3) return (n/1e3).toFixed(1)+"K";
  return String(n);
}
function pct(a,b){return b>0?(a/b*100).toFixed(1)+"%":"-";}
function escHtml(s){return String(s==null?"":s).replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll("\"","&quot;");}
/** Stunden mit Arbeit (tokens) ∪ Stunden mit JSONL-Session-Signalen, nach Log-Zeitstempel. */
function unionWorkHourKeys(sd) {
  var m = {};
  var k;
  var ho = sd.hours || {};
  var hs = sd.hour_signals || {};
  for (k in ho) if (Object.hasOwn(ho, k)) m[k] = true;
  for (k in hs) if (Object.hasOwn(hs, k)) m[k] = true;
  return Object.keys(m).map(function (x) { return Number.parseInt(x, 10); }).filter(function (n) { return !Number.isNaN(n) && n >= 0 && n <= 23; });
}
function hourSignalsAt(sd, wh) {
  var hs = sd.hour_signals || {};
  return hs[String(wh)] || hs[wh] || {};
}
function hourHasTokenUsage(sd, wh) {
  var ho = sd.hours || {};
  return (ho[String(wh)] || ho[wh] || 0) > 0;
}
function outageSpanHitsAtHour(spans, wh) {
  var hitSrv = false;
  var hitCli = false;
  for (const span of spans) {
    if (wh >= Math.floor(span.from) && wh < Math.ceil(span.to)) {
      if (span.kind === "server") hitSrv = true;
      else hitCli = true;
    }
  }
  return { hitSrv: hitSrv, hitCli: hitCli };
}
/** Balken: nur Stunden mit echtem Token-Output zählen als betroffen/sauber (kein Aufblasen durch reine Session-Signale). */
function classifyWorkHour(sd, spans, wh) {
  var hasW = hourHasTokenUsage(sd, wh);
  var hit = outageSpanHitsAtHour(spans, wh);
  var sig = hourSignalsAt(sd, wh);
  var ryH = sig.retry || 0;
  var riH = sig.interrupt || 0;
  if (hit.hitSrv && hasW) return "srv";
  if (hit.hitCli && hasW) return "cli";
  if (!hit.hitSrv && !hit.hitCli) {
    if (hasW && ryH > 0) return "srv";
    if (hasW && riH > 0) return "cli";
    if (hasW) return "clean";
  }
  return "none";
}
function sumServiceImpactForDay(sd) {
  var wHrs = unionWorkHourKeys(sd);
  wHrs.sort(function (a, b) { return a - b; });
  var spans = sd.outage_spans || [];
  var affSrv = 0;
  var affCli = 0;
  var cleanCount = 0;
  for (const wh of wHrs) {
    var cls = classifyWorkHour(sd, spans, wh);
    if (cls === "srv") affSrv++;
    else if (cls === "cli") affCli++;
    else if (cls === "clean") cleanCount++;
  }
  var outTotal = 0;
  for (const span of spans) outTotal += span.to - span.from;
  var outOnly = Math.max(0, Math.round((outTotal - affSrv - affCli) * 10) / 10);
  return { cleanWork: cleanCount, affSrv: affSrv, affCli: affCli, outOnly: outOnly };
}
/** Pro Kalendertag: session_signals, outage_hours, cache_read (API) — für Korrelation Interrupt/Outage vs. Cache.
 *  Ausfallstunden als Balken: Höhe skaliert (Stunden vs. JSONL-Zähler), Tooltip zeigt echte h. Reihenfolge im Stack
 *  unten→oben = continue, resume, retry, interrupt, Ausfall (oben), damit Ausfall nicht unter großen Interrupt-Anteilen liegt.
 *  @param {string} [hostLabel] — wenn gesetzt: Signale + Cache Read nur aus days[].hosts[hostLabel]; outage_hours weiter Kalendertag (Anthropic). */
function extractDaySignals(d, hostKey) {
  if (hostKey) {
    var H = d?.hosts?.[hostKey];
    if (H) {
      var sH = H.session_signals || {};
      return { cont: sH.continue || 0, res: sH.resume || 0, retry: sH.retry || 0, intr: sH.interrupt || 0, cacheRead: H.cache_read == null ? 0 : Number(H.cache_read) || 0 };
    }
    return { cont: 0, res: 0, retry: 0, intr: 0, cacheRead: 0 };
  }
  var s = d?.session_signals || {};
  return { cont: s.continue || 0, res: s.resume || 0, retry: s.retry || 0, intr: s.interrupt || 0, cacheRead: d?.cache_read == null ? 0 : Number(d.cache_read) || 0 };
}
function buildSessionSignalsStackedByDay(days, hostLabel) {
  var hostKey = hostLabel && String(hostLabel).trim() ? String(hostLabel).trim() : "";
  var cont = [];
  var res = [];
  var retry = [];
  var intr = [];
  var outageH = [];
  var cacheRead = [];
  for (const d of days) {
    var oh = d?.outage_hours;
    outageH.push(oh != null && !Number.isNaN(Number(oh)) ? Number(oh) : 0);
    var sig = extractDaySignals(d, hostKey);
    cont.push(sig.cont);
    res.push(sig.res);
    retry.push(sig.retry);
    intr.push(sig.intr);
    cacheRead.push(sig.cacheRead);
  }
  var maxSig = 0;
  for (var si = 0; si < cont.length; si++) {
    var rowSum = cont[si] + res[si] + retry[si] + intr[si];
    if (rowSum > maxSig) maxSig = rowSum;
  }
  var maxOut = 0;
  for (var oi = 0; oi < outageH.length; oi++) {
    if (outageH[oi] > maxOut) maxOut = outageH[oi];
  }
  var OUTAGE_VIS_FRAC = 0.22;
  var maxSigEff = maxSig > 0 ? maxSig : maxOut > 1e-9 ? 100 : 1;
  var outageScale = maxOut > 1e-9 ? (OUTAGE_VIS_FRAC * maxSigEff) / maxOut : 1;
  var outageBar = [];
  for (var bi = 0; bi < outageH.length; bi++) {
    outageBar.push(Math.round(outageH[bi] * outageScale * 100) / 100);
  }
  return {
    cont: cont,
    res: res,
    retry: retry,
    intr: intr,
    outageH: outageH,
    outageBar: outageBar,
    outageStackScale: outageScale,
    cacheRead: cacheRead
  };
}

var I18N = (typeof globalThis.__I18N_BUNDLES === "object" && globalThis.__I18N_BUNDLES && globalThis.__I18N_BUNDLES.de && globalThis.__I18N_BUNDLES.en)
  ? globalThis.__I18N_BUNDLES
  : { de: {}, en: {}, ko: {} };
function detectLang() {
  try {
    var sv = localStorage.getItem("usageDashboardLang");
    if (sv === "de" || sv === "en" || sv === "ko") return sv;
  } catch (e0) {}
  var langs = navigator.languages;
  if (langs && langs.length) {
    for (var li = 0; li < langs.length; li++) {
      var x = String(langs[li] || "").toLowerCase();
      if (x.startsWith("ko")) return "ko";
      if (x.startsWith("de")) return "de";
    }
  }
  var nav = String(navigator.language || "").toLowerCase();
  if (nav.startsWith("ko")) return "ko";
  if (nav.startsWith("de")) return "de";
  return "en";
}
var __lang = detectLang();
function getLang() { return __lang; }
function setLang(code) {
  if (code !== "de" && code !== "en" && code !== "ko") return;
  __lang = code;
  try { localStorage.setItem("usageDashboardLang", code); } catch (e1) {}
  document.documentElement.lang = code;
  updateLangButtons();
  applyStaticChrome();
  if (typeof __lastUsageData !== "undefined" && __lastUsageData) renderDashboard(__lastUsageData, true);
}
function t(k) {
  var o = I18N[__lang] || I18N.en;
  if (o[k] !== undefined && o[k] !== "") return o[k];
  return I18N.en[k] !== undefined ? I18N.en[k] : k;
}
function tr(k, m) {
  var s = t(k);
  if (!m) return s;
  for (var x in m) {
    if (Object.prototype.hasOwnProperty.call(m, x)) s = s.split("{" + x + "}").join(String(m[x]));
  }
  return s;
}
/** Gleiche Schwellen wie scripts/dashboard-server.js computeForensicForDay — für Host-Filter clientseitig. */
var __FR_CACHE_READ_THRESH = 500000000;
var __FR_MIN_OUT = 60000;
var __FR_PEAK_RATIO = 6;
var __FR_PEAK_CALLS = 120;
var __FR_PEAK_HOURS = 4;
function hostApiToForensicRow(h) {
  if (!h || typeof h !== "object") {
    h = {};
  }
  return {
    input: h.input || 0,
    output: h.output || 0,
    cache_read: h.cache_read || 0,
    cache_creation: h.cache_creation || 0,
    hit_limit: h.hit_limit || 0,
    calls: h.calls || 0,
    hours: h.hours && typeof h.hours === "object" ? h.hours : {}
  };
}
function activeHourKeysCount(hours) {
  if (!hours || typeof hours !== "object") return 0;
  var n = 0;
  for (var k in hours) {
    if (Object.prototype.hasOwnProperty.call(hours, k)) n++;
  }
  return n;
}
function findHostPeakAcrossDays(daysArr, hostKey) {
  var bestD = "";
  var bestT = -1;
  for (var i = 0; i < daysArr.length; i++) {
    var d = daysArr[i];
    var hh = d.hosts && d.hosts[hostKey];
    if (!hh) continue;
    var tot = (hh.input || 0) + (hh.output || 0) + (hh.cache_read || 0) + (hh.cache_creation || 0);
    if (tot > bestT) {
      bestT = tot;
      bestD = d.date || "";
    }
  }
  return { date: bestT > 0 ? bestD : "", total: bestT > 0 ? bestT : 0 };
}
function computeForensicForDayClient(dayKey, r, peakDate, peakTotal) {
  var total = (r.input || 0) + (r.output || 0) + (r.cache_read || 0) + (r.cache_creation || 0);
  var activeH = activeHourKeysCount(r.hours);
  var implied90 = total > 0 ? Math.round(total / 0.9) : 0;
  var vs_peak = peakTotal > 0 && total > 0 ? Math.round(peakTotal / total) : 0;
  var code = "\u2014";
  var hint = t("forensicClientHintNone");
  if (r.cache_read > __FR_CACHE_READ_THRESH) {
    code = "?";
    hint = t("forensicClientHintCache");
  } else if ((r.hit_limit || 0) > 0) {
    code = "HIT";
    hint = t("forensicClientHintHit");
  } else if (
    peakTotal > 0 &&
    total > 0 &&
    dayKey !== peakDate &&
    peakTotal / total >= __FR_PEAK_RATIO &&
    activeH >= __FR_PEAK_HOURS &&
    r.calls >= __FR_PEAK_CALLS &&
    r.output >= __FR_MIN_OUT
  ) {
    code = "<<P";
    hint = tr("forensicClientHintPeak", { peak: peakDate || "\u2014" });
  }
  return {
    forensic_code: code,
    forensic_hint: hint,
    forensic_implied_cap_90: implied90,
    forensic_vs_peak: vs_peak
  };
}
/** Ordnet forensic_code der Forensic-Chart-Y-Achse zu — wie Legende / forensicDS_score: 3=? · 2=HIT · 1=<<P · 0=— */
function forensicCodeToScore(code) {
  if (!code || code === "\u2014") return 0;
  if (code === "<<P") return 1;
  if (code === "HIT") return 2;
  if (code === "?") return 3;
  return 0;
}
function forensicScoreForChartDay(day, daysArr, hostFilter) {
  var code;
  if (hostFilter) {
    var H = day.hosts?.[hostFilter];
    if (H) {
      var peak = findHostPeakAcrossDays(daysArr, hostFilter);
      var row = hostApiToForensicRow(H);
      code = computeForensicForDayClient(day.date, row, peak.date, peak.total).forensic_code;
    } else {
      code = "\u2014";
    }
  } else {
    code = day.forensic_code;
  }
  return forensicCodeToScore(code);
}
function sumHostNumericField(daysArr, hostK, field) {
  var s = 0;
  for (var i = 0; i < daysArr.length; i++) {
    var hh = daysArr[i].hosts && daysArr[i].hosts[hostK];
    s += hh ? hh[field] || 0 : 0;
  }
  return s;
}
function initForensicSummaryToolbarOnce() {
  var act = document.getElementById("forensic-summary-actions");
  if (!act || act.dataset.stopPropBound) return;
  act.dataset.stopPropBound = "1";
  act.addEventListener("click", function (ev) {
    ev.stopPropagation();
  });
}
function getMainChartsScope() {
  try {
    var s = sessionStorage.getItem("usageMainChartsScope");
    if (s === "hourly" || s === "timeline") return s;
  } catch (eSc) {}
  return "timeline";
}
function setMainChartsScope(val) {
  try {
    sessionStorage.setItem("usageMainChartsScope", val === "hourly" ? "hourly" : "timeline");
  } catch (eS2) {}
}
function padHour2(n) {
  return n < 10 ? "0" + n : String(n);
}
function buildHourlyAxisLabels() {
  var a = [];
  for (var h = 0; h < 24; h++) a.push(padHour2(h) + ":00");
  return a;
}
function hourBucketCount(hoursObj, h) {
  if (!hoursObj || typeof hoursObj !== "object") return 0;
  var v = hoursObj[String(h)];
  if (v == null) v = hoursObj[h];
  return Number(v) || 0;
}
function dayHourCallWeights(day) {
  var ho = day.hours || {};
  var w = [];
  var sum = 0;
  for (var hi = 0; hi < 24; hi++) {
    var v = hourBucketCount(ho, hi);
    w.push(v);
    sum += v;
  }
  var denom = sum > 0 ? sum : day.calls || 0;
  if (!(denom > 0)) denom = 1;
  return { w: w, denom: denom };
}
function estimatedFieldPerHour(day, field) {
  var hw = dayHourCallWeights(day);
  var total = Number(day[field]) || 0;
  var out = [];
  for (var hj = 0; hj < 24; hj++) {
    out.push(Math.round(total * (hw.w[hj] / hw.denom)));
  }
  return out;
}
function hourlyCacheOutRatioEst(day) {
  var o = estimatedFieldPerHour(day, "output");
  var c = estimatedFieldPerHour(day, "cache_read");
  var r = [];
  for (var hk = 0; hk < 24; hk++) {
    r.push(o[hk] > 0 ? Math.round(c[hk] / o[hk]) : 0);
  }
  return r;
}
/** Hauptcharts: Tagesfeld Gesamt oder gewählte Scan-Quelle (Forensic-Host-Filter). */
function dayNumericForMainCharts(d, hostKey, field) {
  if (!hostKey) return d[field] != null ? Number(d[field]) || 0 : 0;
  var H = d.hosts && d.hosts[hostKey];
  return H && H[field] != null ? Number(H[field]) || 0 : 0;
}
function dayRatioCacheOutForMainCharts(d, hostKey) {
  if (!hostKey) return d.cache_output_ratio || 0;
  var H = d.hosts?.[hostKey];
  return H?.cache_output_ratio ?? 0;
}
function dayOutputPerHourForMainCharts(d, hostKey) {
  if (!hostKey) return d.output_per_hour || 0;
  var H = d.hosts?.[hostKey];
  return H?.output_per_hour ?? 0;
}
function subCachePctForDayMainCharts(d, hostKey) {
  if (!hostKey) return d.sub_cache_pct != null ? d.sub_cache_pct : 0;
  var H = d.hosts && d.hosts[hostKey];
  if (!H) return 0;
  if (H.sub_cache_pct != null) return H.sub_cache_pct;
  var cr = d.cache_read || 0;
  if (cr <= 0) return 0;
  return Math.round(((H.sub_cache || 0) / cr) * 100);
}
function estimatedFieldPerHourHost(day, hostKey, field) {
  if (!hostKey) return estimatedFieldPerHour(day, field);
  var H = day.hosts && day.hosts[hostKey];
  if (!H) {
    var z = [];
    for (var zi = 0; zi < 24; zi++) z.push(0);
    return z;
  }
  var pseudoDay = {
    hours: H.hours && typeof H.hours === "object" ? H.hours : {},
    calls: H.calls != null ? H.calls : day.calls || 0
  };
  var hw = dayHourCallWeights(pseudoDay);
  var total = Number(H[field]) || 0;
  var out = [];
  for (var hj = 0; hj < 24; hj++) {
    out.push(Math.round(total * (hw.w[hj] / hw.denom)));
  }
  return out;
}
function hourlyCacheOutRatioEstHost(day, hostKey) {
  var o = estimatedFieldPerHourHost(day, hostKey, "output");
  var c = estimatedFieldPerHourHost(day, hostKey, "cache_read");
  var r = [];
  for (var hk = 0; hk < 24; hk++) {
    r.push(o[hk] > 0 ? Math.round(c[hk] / o[hk]) : 0);
  }
  return r;
}
function hourSignalsArrayForHost(day, hostKey, key) {
  if (!hostKey) return hourSignalsArrayFor(day, key);
  var H = day.hosts && day.hosts[hostKey];
  var hs = (H && H.hour_signals && typeof H.hour_signals === "object") ? H.hour_signals : {};
  var a = [];
  for (var hh = 0; hh < 24; hh++) {
    var b = hs[String(hh)] || hs[hh] || {};
    a.push(b[key] || 0);
  }
  return a;
}
function hourSignalKey(day, hour, key) {
  var hs = day.hour_signals || {};
  var b = hs[String(hour)] || hs[hour] || {};
  return b[key] || 0;
}
function hourSignalsArrayFor(day, key) {
  var a = [];
  for (var hh = 0; hh < 24; hh++) a.push(hourSignalKey(day, hh, key));
  return a;
}
function destroyMainChartIfScopeMismatch(mainScope, chartKey) {
  var ch = _charts[chartKey];
  if (ch && ch._dashScope !== mainScope) {
    try {
      ch.destroy();
    } catch (eD) {}
    _charts[chartKey] = null;
  }
}
function syncMainChartsScopeUi() {
  var wrap = document.getElementById("main-charts-scope-wrap");
  var chips = document.getElementById("main-charts-scope-chips");
  if (!wrap || !chips) return;
  var cur = getMainChartsScope();
  if (!chips.dataset.scopeBound) {
    chips.dataset.scopeBound = "1";
    chips.addEventListener("click", function (ev) {
      var b = ev.target.closest(".main-charts-scope-chip");
      if (!b || !b.dataset.scope) return;
      setMainChartsScope(b.dataset.scope === "hourly" ? "hourly" : "timeline");
      syncMainChartsScopeUi();
      if (typeof __lastUsageData !== "undefined" && __lastUsageData) renderDashboard(__lastUsageData, true);
    });
  }
  if (!chips.querySelector(".main-charts-scope-chip")) {
    function mkChip(scope, text) {
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "main-charts-scope-chip";
      btn.dataset.scope = scope;
      btn.textContent = text;
      chips.appendChild(btn);
    }
    mkChip("timeline", t("mainChartsScopeTimeline"));
    mkChip("hourly", t("mainChartsScopeHourly"));
  } else {
    var b0 = chips.querySelector('.main-charts-scope-chip[data-scope="timeline"]');
    var b1 = chips.querySelector('.main-charts-scope-chip[data-scope="hourly"]');
    if (b0) b0.textContent = t("mainChartsScopeTimeline");
    if (b1) b1.textContent = t("mainChartsScopeHourly");
  }
  var lbl = document.getElementById("main-charts-scope-label");
  if (lbl) lbl.textContent = t("mainChartsScopeLabel");
  wrap.setAttribute("aria-label", t("mainChartsScopeAria"));
  var nodes = chips.querySelectorAll(".main-charts-scope-chip");
  for (var ni = 0; ni < nodes.length; ni++) {
    var nb = nodes[ni];
    var on = nb.dataset.scope === cur;
    nb.classList.toggle("active", on);
    nb.setAttribute("aria-pressed", on ? "true" : "false");
  }
}
function updateLangButtons() {
  var bde = document.getElementById("lang-de");
  var ben = document.getElementById("lang-en");
  var bko = document.getElementById("lang-ko");
  if (bde) {
    bde.classList.toggle("active", __lang === "de");
    bde.setAttribute("aria-pressed", __lang === "de" ? "true" : "false");
  }
  if (ben) {
    ben.classList.toggle("active", __lang === "en");
    ben.setAttribute("aria-pressed", __lang === "en" ? "true" : "false");
  }
  if (bko) {
    bko.classList.toggle("active", __lang === "ko");
    bko.setAttribute("aria-pressed", __lang === "ko" ? "true" : "false");
  }
}
function apiNote(data, deKey, enKey) {
  if (getLang() === "en" && data[enKey]) return data[enKey];
  return data[deKey] || "";
}

var GITHUB_TOKEN_SESSION_KEY = "usageDashboardGithubToken";
var usageStreamAbort = null;
/** Zuletzt von GET /api/extension-timeline (Marketplace+GitHub); wird in renderDashboard auf days gelegt. */
var __extensionTimelinePayload = null;

function cloneVersionChangeForMerge(vc) {
  if (!vc) return null;
  var o = {
    added: vc.added ? vc.added.slice() : [],
    from: vc.from != null ? vc.from : null,
    highlights: vc.highlights ? vc.highlights.slice() : [],
    release_when: vc.release_when || "",
    release_utc_ymd: vc.release_utc_ymd || "",
    release_local_ymd: vc.release_local_ymd || ""
  };
  if (vc.github_release_links && vc.github_release_links.length) {
    o.github_release_links = vc.github_release_links.map(function (gl) {
      return { version: gl.version, tag: gl.tag, url: gl.url };
    });
  }
  return o;
}

function mergeExtensionTimelineIntoUsage(data) {
  var p = __extensionTimelinePayload;
  if (!data || !data.days || !p || !p.by_date) return;
  var bd = p.by_date;
  for (var i = 0; i < data.days.length; i++) {
    var d = data.days[i];
    var dt = d.date;
    if (!dt || !bd[dt]) continue;
    d.version_change = cloneVersionChangeForMerge(bd[dt]);
  }
}

var __extensionTimelineCoalesceTimer = null;
var __extensionTimelineInFlight = false;

function scheduleFetchExtensionTimeline(delayMs) {
  var d = typeof delayMs === "number" ? delayMs : 500;
  clearTimeout(__extensionTimelineCoalesceTimer);
  __extensionTimelineCoalesceTimer = setTimeout(function () {
    __extensionTimelineCoalesceTimer = null;
    fetchExtensionTimelineOnceInternal();
  }, d);
}

function fetchExtensionTimelineOnce() {
  scheduleFetchExtensionTimeline(80);
}

function fetchExtensionTimelineOnceInternal() {
  if (__extensionTimelineInFlight) {
    scheduleFetchExtensionTimeline(350);
    return;
  }
  __extensionTimelineInFlight = true;
  fetch("/api/extension-timeline", { headers: apiGithubTokenHeader() })
    .then(function (r) {
      return r.json();
    })
    .then(function (payload) {
      __extensionTimelinePayload = payload && typeof payload === "object" ? payload : null;
      if (typeof __lastUsageData !== "undefined" && __lastUsageData) {
        mergeExtensionTimelineIntoUsage(__lastUsageData);
        renderDashboard(__lastUsageData, true);
      }
    })
    .catch(function () {})
    .then(function () {
      __extensionTimelineInFlight = false;
    });
}

function getSessionGithubToken() {
  try {
    return sessionStorage.getItem(GITHUB_TOKEN_SESSION_KEY) || "";
  } catch (eGt) {
    return "";
  }
}

function setSessionGithubToken(val) {
  try {
    if (val && String(val).trim()) {
      sessionStorage.setItem(GITHUB_TOKEN_SESSION_KEY, String(val).trim());
    } else {
      sessionStorage.removeItem(GITHUB_TOKEN_SESSION_KEY);
    }
  } catch (eSt) {}
}

function apiGithubTokenHeader() {
  return { "X-GitHub-Token": getSessionGithubToken() };
}

function updateGithubTokenPanelMode() {
  var edit = document.getElementById("github-token-edit-block");
  var saved = document.getElementById("github-token-saved-block");
  var savedLabel = document.getElementById("github-token-saved-label");
  if (!edit || !saved) return;
  if (getSessionGithubToken()) {
    edit.style.display = "none";
    saved.style.display = "block";
    if (savedLabel) savedLabel.textContent = t("githubTokenSavedLine");
  } else {
    saved.style.display = "none";
    edit.style.display = "block";
    if (savedLabel) savedLabel.textContent = "";
  }
}

/** Nach sessionStorage + display-Wechsel: ein zuverlässiges Repaint (ohne F5), v. a. in geschlossenem <details>. */
function scheduleGithubTokenUiRefresh() {
  if (typeof requestAnimationFrame === "function") {
    requestAnimationFrame(function () {
      requestAnimationFrame(updateGithubTokenPanelMode);
    });
  } else {
    setTimeout(updateGithubTokenPanelMode, 0);
  }
}

/** Platzhalter-Gitter (#main-charts-skeleton) bis echte Chart-DOM aus renderDashboardCore kommt. */
function showMainChartsSkeleton(show) {
  var sk = document.getElementById("main-charts-skeleton");
  var wrap = document.getElementById("main-charts-wrap");
  if (sk) {
    sk.classList.toggle("main-charts-skeleton--off", !show);
    sk.setAttribute("aria-busy", show ? "true" : "false");
  }
  if (wrap) wrap.classList.toggle("main-charts-loading", !!show);
}

function chartShellSetLoading(canvasId, loading) {
  var cv = typeof canvasId === "string" ? document.getElementById(canvasId) : canvasId;
  if (!cv) return;
  var shell = cv.closest(".chart-shell");
  if (!shell) return;
  if (loading) {
    shell.classList.add("is-loading");
    shell.classList.remove("is-ready");
  } else {
    shell.classList.remove("is-loading");
    shell.classList.add("is-ready");
  }
}

/** Sofort sichtbare Shell-Texte/DOM-Hüllen — unabhängig von Scan oder Day-Cache. */
function fillInitialShellText() {
  var coldStart = !__lastUsageData;
  var meta = document.getElementById("meta");
  if (meta && (coldStart || !String(meta.textContent || "").replace(/\s/g, ""))) meta.textContent = t("metaShellReady");
  var msum = document.getElementById("meta-details-summary");
  if (msum && (coldStart || !String(msum.textContent || "").replace(/\s/g, ""))) msum.textContent = t("metaDetailsSummaryDefault");
  var chartPairs = [
    ["c1", "chartDailyToken"],
    ["c2", "chartCacheRatio"],
    ["c3", "chartOutPerHour"],
    ["c4", "chartSubCachePct"]
  ];
  for (var ci = 0; ci < chartPairs.length; ci++) {
    var cv = document.getElementById(chartPairs[ci][0]);
    if (!cv) continue;
    var hx = cv.previousElementSibling;
    if (hx && hx.tagName === "H3" && (coldStart || !String(hx.textContent || "").replace(/\s/g, "")))
      hx.textContent = t(chartPairs[ci][1]);
  }
}

function applyStaticChrome() {
  document.title = t("pageTitle");
  var lsw = document.getElementById("lang-switch-wrap");
  if (lsw) lsw.setAttribute("aria-label", t("ariaLangGroup"));
  var lsl = document.getElementById("lang-switch-label");
  if (lsl) lsl.textContent = t("langLabel");
  var mh = document.getElementById("main-heading");
  if (mh) mh.textContent = t("heading");
  var sm = document.getElementById("sub-models");
  if (sm) sm.innerHTML = t("subModelsHtml");
  var lp = document.getElementById("lbl-day-picker");
  if (lp) lp.textContent = t("dayPickerLabel");
  var selp = document.getElementById("day-picker");
  if (selp) selp.setAttribute("aria-label", t("dayPickerAria"));
  var lfp = document.getElementById("live-files-panel");
  if (lfp) lfp.setAttribute("aria-label", t("livePanelAria"));
  var fh = document.getElementById("forensic-chart-h3");
  if (fh) fh.textContent = t("forensicChartTitle");
  var fb = document.getElementById("forensic-chart-blurb");
  if (fb) fb.innerHTML = t("forensicChartBlurbHtml");
  var fsh = document.getElementById("forensic-signals-chart-h3");
  if (fsh) fsh.textContent = t("forensicSignalsChartTitle");
  var fsb = document.getElementById("forensic-signals-blurb");
  if (fsb) fsb.innerHTML = t("forensicSignalsBlurbHtml");
  var rbl = document.getElementById("report-btn-label");
  if (rbl) rbl.textContent = t("reportBtn");
  var rbt = document.getElementById("forensic-report-btn");
  if (rbt) rbt.setAttribute("title", t("reportBtnTitle"));
  var sh3 = document.getElementById("service-chart-h3");
  if (sh3) sh3.textContent = t("serviceChartTitle");
  var sbl = document.getElementById("service-chart-blurb");
  if (sbl) sbl.innerHTML = t("serviceBlurb");
  var tn = document.getElementById("thinking-note");
  if (tn) tn.textContent = t("thinkingNote");
  var lf = document.getElementById("live-files-hint");
  if (lf) lf.textContent = t("liveFilesHint");
  document.documentElement.lang = __lang === "de" ? "de" : "en";
  var usc = document.getElementById("update-sl-close");
  if (usc) usc.setAttribute("aria-label", t("updateSlideoutClose"));
  var gtl = document.getElementById("github-token-label");
  if (gtl) gtl.textContent = t("githubTokenLabel");
  var gts = document.getElementById("github-token-save");
  if (gts) gts.textContent = t("githubTokenSave");
  var gtc = document.getElementById("github-token-clear");
  if (gtc) gtc.textContent = t("githubTokenClear");
  var gtr = document.getElementById("github-releases-refresh");
  if (gtr) gtr.textContent = t("githubTokenRefreshReleases");
  var mpRef = document.getElementById("marketplace-extension-refresh");
  if (mpRef) mpRef.textContent = t("marketplaceRefreshLabel");
  var gth = document.getElementById("github-token-hint");
  if (gth) gth.textContent = t("githubTokenHint");
  var mskh = document.getElementById("main-charts-skel-hint");
  if (mskh) mskh.textContent = t("mainChartsSkelHint");
  syncMainChartsScopeUi();
  var fhLab = document.getElementById("forensic-host-filter-label");
  if (fhLab) fhLab.textContent = t("forensicHostFilterLabel");
  var fhWrap2 = document.getElementById("forensic-host-filter-wrap");
  if (fhWrap2 && !fhWrap2.hasAttribute("hidden")) fhWrap2.setAttribute("aria-label", t("forensicHostFilterAria"));
  var fhChips = document.getElementById("forensic-host-filter-chips");
  if (fhChips) {
    var f0 = fhChips.querySelector(".forensic-host-chip[data-host-filter=\"__ALL__\"]");
    if (f0) f0.textContent = t("forensicHostFilterAll");
  }
  var fhHint2 = document.getElementById("forensic-host-filter-hint");
  if (fhHint2 && fhHint2.style.display !== "none" && __forensicHostFilterSig) {
    fhHint2.textContent = tr("forensicHostFilterHint", { host: __forensicHostFilterSig });
  }
  fillInitialShellText();
  updateGithubTokenPanelMode();
  scheduleGithubTokenUiRefresh();
}

var _charts = {};
var __lastUsageData = null;
/** Stream-Events entkoppeln: voller Core-Lauf max. ~alle N ms (verhindert Chart-Flimmern). User-Aktionen: urgent=true. */
var DASH_CORE_COALESCE_MS = 400;
var __dashRenderCoreCoalesce = null;

function chartXLabelsMatch(ch, newLabels) {
  if (!ch || !ch.data || !ch.data.labels || !newLabels) return false;
  var L = ch.data.labels;
  if (L.length !== newLabels.length) return false;
  for (var i = 0; i < L.length; i++) if (L[i] !== newLabels[i]) return false;
  return true;
}

/** Bestehende Chart-X-Achse ist Anfang von newLabels (z. B. SSE-Scan hängt Tage hinten an). Sonst destroy → Flackern. */
function chartLabelsPrefixMatch(ch, newLabels) {
  if (!ch || !ch.data || !ch.data.labels || !newLabels) return false;
  var L = ch.data.labels;
  if (!L.length || newLabels.length < L.length) return false;
  for (var i = 0; i < L.length; i++) {
    if (L[i] !== newLabels[i]) return false;
  }
  return true;
}

var __mainChartTransitions = {
  active: { animation: { duration: 0 } },
  resize: { animation: { duration: 0 } },
  show: { animation: { duration: 0 } },
  hide: { animation: { duration: 0 } }
};
/** Eine feste Referenz — nicht bei jedem renderDashboardCore neu erzeugen (sonst kann Chart.js bei options.transitions jedes Mal neu layouten / „zappeln“). */
var __chartTransitionsOff = {
  active: { animation: { duration: 0 } },
  resize: { animation: { duration: 0 } },
  show: { animation: { duration: 0 } },
  hide: { animation: { duration: 0 } }
};
function freezeChartNoAnim(ch) {
  if (!ch || !ch.options) return;
  ch.options.animation = false;
  ch.options.transitions = __chartTransitionsOff;
}

/** Chart.resize nur wenn Canvas noch im DOM — vermeidet ownerDocument-null nach Modal/DOM-Zug. */
function __safeChartResize(ch) {
  if (!ch || typeof ch.resize !== "function") return;
  try {
    var c = ch.canvas;
    if (!c?.isConnected) return;
    ch.resize();
  } catch {
    // canvas may have detached between isConnected check and resize()
  }
}

var __anthropicHealthResizeT = null;
function __scheduleAnthropicHealthChartsResize() {
  if (__anthropicHealthResizeT) clearTimeout(__anthropicHealthResizeT);
  __anthropicHealthResizeT = setTimeout(function () {
    __anthropicHealthResizeT = null;
    __safeChartResize(_proxyCharts.uptimeChart);
    __safeChartResize(_proxyCharts.incidentHistory);
    __safeChartResize(_proxyCharts.outageTimeline);
  }, 80);
}

function __bumpAnthropicHealthCharts() {
  __safeChartResize(_proxyCharts.uptimeChart);
  __safeChartResize(_proxyCharts.incidentHistory);
  __safeChartResize(_proxyCharts.outageTimeline);
}

function fetchUsageJsonOnce() {
  return fetch("/api/usage", { headers: apiGithubTokenHeader() })
    .then(function (r) {
      return r.json();
    })
    .then(function (d) {
      try {
      renderDashboard(d, true);
      } catch (e) {
        console.error(e);
      }
    })
    .catch(function () {});
}

function showGithubTokenStatus(msg, isWarn) {
  var el = document.getElementById("github-token-status");
  if (!el) return;
  el.style.display = msg ? "block" : "none";
  el.textContent = msg || "";
  el.classList.toggle("is-warn", !!isWarn);
}

/** Nur Token-Header an den Server übertragen — kein /api/usage, kein voller Dashboard-Repaint. */
function syncGithubSessionThenReconnectStream() {
  fetch("/api/github-session-sync", {
    method: "GET",
    headers: apiGithubTokenHeader()
  }).finally(function () {
    connectUsageStream();
  });
}

function connectUsageStream() {
  if (typeof fetch === "function" && typeof AbortController !== "undefined") {
    if (usageStreamAbort) usageStreamAbort.abort();
    usageStreamAbort = new AbortController();
    var sig = usageStreamAbort.signal;
    fetch("/api/stream", {
      signal: sig,
      headers: Object.assign({ Accept: "text/event-stream" }, apiGithubTokenHeader())
    })
      .then(function (res) {
        if (!res.ok || !res.body || typeof res.body.getReader !== "function") throw new Error("stream");
        var reader = res.body.getReader();
        var dec = new TextDecoder();
        var buf = "";
        var dot = document.getElementById("live-dot");
        if (dot) dot.style.background = "#22c55e";
        function pump() {
          return reader.read().then(function (part) {
            if (part.done) throw new Error("stream_end");
            buf += dec.decode(part.value, { stream: true });
            for (;;) {
              var ix = buf.indexOf("\n\n");
              if (ix < 0) break;
              var block = buf.slice(0, ix);
              buf = buf.slice(ix + 2);
              var lines = block.split("\n");
              for (var li = 0; li < lines.length; li++) {
                if (lines[li].indexOf("data: ") === 0) {
                  try {
                    renderDashboard(JSON.parse(lines[li].slice(6)), false);
                  } catch (err) {
                    console.error(err);
                  }
                }
              }
            }
            return pump();
          });
        }
        return pump();
      })
      .catch(function () {
        if (sig.aborted) return;
        var dot2 = document.getElementById("live-dot");
        var lab2 = document.getElementById("live-label");
        if (dot2) dot2.style.background = "#ef4444";
        if (lab2) lab2.textContent = t("sseDisconnected");
        setTimeout(connectUsageStream, 3000);
      });
    return;
  }
  var evtSource = new EventSource("/api/stream");
  evtSource.onmessage = function (e) {
    try {
      renderDashboard(JSON.parse(e.data), false);
    } catch (err) {
      console.error(err);
    }
  };
  evtSource.onerror = function () {
    document.getElementById("live-dot").style.background = "#ef4444";
    document.getElementById("live-label").textContent = t("sseDisconnected");
  };
}

function initGithubTokenPanel() {
  var edit = document.getElementById("github-token-edit-block");
  var saved = document.getElementById("github-token-saved-block");
  var inp = document.getElementById("github-token-input");
  var save = document.getElementById("github-token-save");
  var clear = document.getElementById("github-token-clear");
  var refBtn = document.getElementById("github-releases-refresh");
  if (!inp || !save || !clear || !edit || !saved) return;
  if (!save.dataset.boundGithubSv) {
    save.dataset.boundGithubSv = "1";
    save.addEventListener("click", function () {
      var v = String(inp.value || "").trim();
      if (v) {
        setSessionGithubToken(v);
        inp.value = "";
        updateGithubTokenPanelMode();
        scheduleGithubTokenUiRefresh();
        showGithubTokenStatus(t("githubTokenSaved"), false);
      } else if (getSessionGithubToken()) {
        updateGithubTokenPanelMode();
        scheduleGithubTokenUiRefresh();
        showGithubTokenStatus(t("githubTokenSaved"), false);
      } else {
        showGithubTokenStatus("", false);
      }
      syncGithubSessionThenReconnectStream();
    });
  }
  if (!clear.dataset.boundGithubCl) {
    clear.dataset.boundGithubCl = "1";
    clear.addEventListener("click", function () {
      setSessionGithubToken("");
      inp.value = "";
      updateGithubTokenPanelMode();
      scheduleGithubTokenUiRefresh();
      showGithubTokenStatus(t("githubTokenCleared"), false);
      syncGithubSessionThenReconnectStream();
      try {
        inp.focus();
      } catch (eF2) {}
    });
  }
  if (refBtn && !refBtn.dataset.boundGithubRf) {
    refBtn.dataset.boundGithubRf = "1";
    refBtn.addEventListener("click", function () {
      fetch("/api/github-releases-refresh", {
        method: "POST",
        headers: Object.assign({ "Content-Type": "application/json" }, apiGithubTokenHeader())
      })
        .then(function (r) {
          if (!r.ok) throw new Error("bad");
          return r.json();
        })
        .then(function () {
          showGithubTokenStatus(t("githubReleasesRefreshOk"), false);
          // refreshReleasesCache läuft asynchron weiter; Timeline sonst oft noch alter Cache.
          setTimeout(function () {
            fetchExtensionTimelineOnce();
          }, 2500);
        })
        .catch(function () {
          showGithubTokenStatus(t("githubReleasesRefreshFail"), true);
        });
    });
  }
  updateGithubTokenPanelMode();
  scheduleGithubTokenUiRefresh();
}

function initMarketplaceRefreshButton() {
  var btn = document.getElementById("marketplace-extension-refresh");
  if (!btn || btn.dataset.boundMpRf) return;
  btn.dataset.boundMpRf = "1";
  btn.addEventListener("click", function () {
    fetch("/api/marketplace-refresh", {
      method: "POST",
      headers: Object.assign({ "Content-Type": "application/json" }, apiGithubTokenHeader())
    })
      .then(function (r) {
        if (!r.ok) throw new Error("bad");
        return r.json();
      })
      .then(function () {
        showGithubTokenStatus(t("marketplaceRefreshOk"), false);
        setTimeout(function () {
          fetchExtensionTimelineOnce();
        }, 1800);
      })
      .catch(function () {
        showGithubTokenStatus(t("marketplaceRefreshFail"), true);
      });
  });
}

function updateStatePathsRow(data) {
  var el = document.getElementById("state-cache-paths");
  if (!el) return;
  var sp = data && data.state_paths;
  if (!sp) {
    el.textContent = "";
    return;
  }
  el.textContent =
    t("statePathsTitle") +
    "\n" +
    t("statePathDay") +
    sp.day_cache +
    "\n" +
    t("statePathTodayIndex") +
    (sp.jsonl_today_index || "\u2014") +
    "\n" +
    t("statePathReleases") +
    sp.releases +
    "\n" +
    t("statePathMarketplace") +
    sp.marketplace +
    "\n" +
    t("statePathOutage") +
    sp.outage;
}
function updateScanSourcesRow(data) {
  var el = document.getElementById("scan-sources");
  if (!el) return;
  var srcs = data && data.scan_sources;
  if (srcs && srcs.length > 1) {
    var parts = [];
    for (var si = 0; si < srcs.length; si++) {
      parts.push(srcs[si].label + " (" + (srcs[si].jsonl_files || 0) + " .jsonl)");
    }
    el.textContent = t("scanSourcesPrefix") + parts.join(" · ");
    el.title = srcs.map(function (s) { return s.label + ": " + (s.path_hint || ""); }).join("\n");
    el.style.display = "";
  } else {
    el.textContent = "";
    el.title = "";
    el.style.display = "none";
  }
}
function updateLiveFilesPanel(data) {
  var ul = document.getElementById("live-files-list");
  var head = document.getElementById("live-files-head");
  var trig = document.getElementById("live-trigger");
  if (!ul) return;
  ul.innerHTML = "";
  var files = (data && data.scanned_files) ? data.scanned_files : [];
  var n = files.length;
  if (head) head.textContent = n ? tr("liveFilesHeadN", { n: n }) : t("liveFilesHead0");
  if (data && data.scanning && n === 0) {
    ul.innerHTML = "<li>" + escHtml(t("scanStill")) + "</li>";
    if (trig) trig.setAttribute("title", t("liveTriggerScanning"));
    return;
  }
  if (n === 0) {
    ul.innerHTML = "<li>" + escHtml(t("noJsonlList")) + "</li>";
    if (trig) trig.setAttribute("title", t("liveTriggerZero"));
    return;
  }
  for (var lf = 0; lf < n; lf++) {
    var li = document.createElement("li");
    li.textContent = files[lf];
    ul.appendChild(li);
  }
  if (trig) trig.setAttribute("title", tr("liveTriggerMany", { n: n }));
}
function liveExtOneLiner(d) {
  var vc = d.version_change;
  if (!vc) return d.date;
  var verStr = vc.added && vc.added.length ? vc.added.join(", ") : "";
  if (vc.from) verStr = vc.from + " \u2192 " + verStr;
  return d.date + ": " + verStr;
}
function updateLiveOutageAndExtensionSections(data) {
  var oh = document.getElementById("live-outage-head");
  var ol = document.getElementById("live-outage-list");
  var oe = document.getElementById("live-outage-empty");
  var eh = document.getElementById("live-ext-head");
  var el = document.getElementById("live-ext-list");
  var ee = document.getElementById("live-ext-empty");
  if (!oh || !ol || !oe || !eh || !el || !ee) return;
  oh.textContent = t("liveOutageHead");
  eh.textContent = t("liveExtHead");
  var days = (data && data.days) ? data.days : [];
  ol.innerHTML = "";
  var hasOut = false;
  for (var di = 0; di < days.length; di++) {
    var d = days[di];
    var incs = d.outage_incidents || [];
    if (!incs.length) continue;
    hasOut = true;
    var seen = {};
    for (var oi = 0; oi < incs.length; oi++) {
      var inc = incs[oi];
      var key = (inc.name || "") + "|" + String(inc.created_at || "") + "|" + String(inc.resolved_at || "");
      if (seen[key]) continue;
      seen[key] = true;
      var li = document.createElement("li");
      var imp = String(inc.impact || "none").toUpperCase();
      var kind = inc.kind ? " (" + inc.kind + ")" : "";
      li.textContent = d.date + " \u00b7 [" + imp + "] " + (inc.name || "") + kind;
      ol.appendChild(li);
    }
  }
  if (hasOut) {
    oe.style.display = "none";
    ol.style.display = "";
  } else {
    oe.style.display = "";
    oe.textContent = t("liveOutageEmpty");
    ol.style.display = "none";
  }
  el.innerHTML = "";
  var hasExt = false;
  for (var ei = 0; ei < days.length; ei++) {
    var dx = days[ei];
    if (!dx.version_change) continue;
    hasExt = true;
    var lix = document.createElement("li");
    var b = document.createElement("button");
    b.type = "button";
    b.className = "live-ext-open";
    b.dataset.dayIndex = String(ei);
    b.textContent = liveExtOneLiner(dx);
    b.setAttribute("aria-label", t("liveExtOpenAria") + " " + dx.date);
    lix.appendChild(b);
    el.appendChild(lix);
  }
  if (hasExt) {
    ee.style.display = "none";
    el.style.display = "";
  } else {
    ee.style.display = "";
    ee.textContent = t("liveExtEmpty");
    el.style.display = "none";
  }
}
function updateLiveSidePanel(data) {
  updateLiveFilesPanel(data);
  updateLiveOutageAndExtensionSections(data);
}
function updateMetaDetailsSummary(data) {
  var sumEl = document.getElementById("meta-details-summary");
  if (!sumEl) return;
  var sp = data && data.scan_progress;
  if (sp && sp.total > 0 && data.scanning && sp.done < sp.total) {
    sumEl.textContent = tr("metaDetailsScanProgress", { done: sp.done, total: sp.total, sec: data.refresh_sec || 180 });
    return;
  }
  var days = data && data.days;
  if (!days || !days.length) {
    if (data && data.scanning) sumEl.textContent = t("metaSummaryScanning");
    else if (data && data.scan_error) sumEl.textContent = tr("metaScanError", { msg: String(data.scan_error).slice(0, 120) });
    else if (data && (data.parsed_files || 0) === 0) sumEl.textContent = t("metaSummaryNoFiles");
    else sumEl.textContent = tr("metaSummaryNoUsage", { files: data.parsed_files || 0 });
    return;
  }
  sumEl.textContent = tr("metaDetailsSummaryLine", { files: data.parsed_files || 0, sec: data.refresh_sec || 180 });
}
function initMetaDetailsPanel() {
  var det = document.getElementById("meta-details");
  if (!det || det.dataset.boundMeta) return;
  det.dataset.boundMeta = "1";
  try {
    if (sessionStorage.getItem("usageMetaDetailsOpen") === "1") det.setAttribute("open", "");
  } catch (e) {}
  det.addEventListener("toggle", function () {
    updateGithubTokenPanelMode();
    scheduleGithubTokenUiRefresh();
    try {
      sessionStorage.setItem("usageMetaDetailsOpen", det.open ? "1" : "0");
    } catch (e2) {}
  });
}
var USAGE_EXT_VLINE_END_OFFSET = 22;
// Global: disable ALL Chart.js animations to prevent flickering
if (typeof Chart !== "undefined") {
  Chart.defaults.animation = false;
  Chart.defaults.transitions = {
    active: { animation: { duration: 0 } },
    resize: { animation: { duration: 0 } },
    show: { animation: { duration: 0 } },
    hide: { animation: { duration: 0 } }
  };
  Chart.defaults.responsive = true;
  Chart.defaults.resizeDelay = 300;
  // Native DPR only: forcing min 2 (old workaround) oversizes the backing store on 1x / zoomed
  // views → browser downscales the bitmap and charts look blurry. Flicker is handled by
  // animation:false and the stable __chartTransitionsOff object on updates.
  Chart.defaults.devicePixelRatio = window.devicePixelRatio || 1;

}
var __usageUpdatePluginRegistered = false;
function registerUsageUpdateVLinePlugin() {
  if (__usageUpdatePluginRegistered || typeof Chart === "undefined") return;
  __usageUpdatePluginRegistered = true;
  Chart.register({
    id: "usageUpdateVerticalLines",
    beforeDatasetsDraw: function (chart) {
      var cid = chart.canvas && chart.canvas.id;
      if (cid !== "c-service") return;
      var idxs = window.__usageVersionDayIndices;
      if (!idxs || !idxs.length) return;
      var xScale = chart.scales.x;
      if (!xScale || typeof xScale.getPixelForTick !== "function") return;
      var ca = chart.chartArea;
      if (!ca) return;
      var n = chart.data.labels ? chart.data.labels.length : 0;
      if (!n) return;
      var ctx = chart.ctx;
      var yEnd = ca.top + USAGE_EXT_VLINE_END_OFFSET;
      var bot = ca.bottom;
      if (yEnd >= bot) return;
      ctx.save();
      ctx.setLineDash([3, 4]);
      ctx.strokeStyle = "rgba(74, 222, 128, 0.38)";
      ctx.lineWidth = 1;
      for (var k = 0; k < idxs.length; k++) {
        var di = idxs[k];
        if (di < 0 || di >= n) continue;
        var x = xScale.getPixelForTick(di);
        if (x == null || isNaN(x)) continue;
        ctx.beginPath();
        ctx.moveTo(x, bot);
        ctx.lineTo(x, yEnd);
        ctx.stroke();
      }
      ctx.restore();
    }
  });
}
registerUsageUpdateVLinePlugin();
function chartTickXToParentLeft(chart, hostEl, tickIndex) {
  if (!chart || !chart.scales || !chart.scales.x || !chart.canvas || !hostEl) return null;
  var xScale = chart.scales.x;
  if (typeof xScale.getPixelForTick !== "function") return null;
  var x = xScale.getPixelForTick(tickIndex);
  if (x == null || isNaN(x)) return null;
  var cw = chart.width;
  var ch = chart.height;
  if (!cw || !ch) return null;
  var canvas = chart.canvas;
  var cr = canvas.getBoundingClientRect();
  var hr = hostEl.getBoundingClientRect();
  var xCss = (x / cw) * cr.width;
  return cr.left - hr.left + xCss;
}
function chartAreaTopInParent(chart, hostEl) {
  if (!chart || !chart.canvas || !hostEl) return 0;
  var cr = chart.canvas.getBoundingClientRect();
  var hr = hostEl.getBoundingClientRect();
  var t = chart.chartArea ? chart.chartArea.top : 0;
  return cr.top - hr.top + (t / chart.height) * cr.height;
}
function chartAreaBottomInParent(chart, hostEl) {
  if (!chart || !chart.canvas || !hostEl) return 0;
  var cr = chart.canvas.getBoundingClientRect();
  var hr = hostEl.getBoundingClientRect();
  var b = chart.chartArea ? chart.chartArea.bottom : chart.height;
  return cr.top - hr.top + (b / chart.height) * cr.height;
}
/** Y-Koordinate (px von hostEl-Oberkante) für einen Canvas-Y-Wert (von Canvas-Oberkante). */
function chartYInParent(chart, hostEl, yCanvas) {
  if (!chart || !chart.canvas || !hostEl) return 0;
  var cr = chart.canvas.getBoundingClientRect();
  var hr = hostEl.getBoundingClientRect();
  var ch = chart.height;
  if (!ch || yCanvas == null || isNaN(yCanvas)) return cr.top - hr.top;
  return cr.top - hr.top + (yCanvas / ch) * cr.height;
}
function layoutFsUpdateOverlay() {
  var wrap = document.getElementById("service-chart-canvas-wrap");
  var overlay = document.getElementById("fs-update-overlay");
  if (!wrap || !overlay || !_charts.cService || !_charts.cService.chartArea) return;
  overlay.innerHTML = "";
  var ch = _charts.cService;
  var n = ch.data.labels ? ch.data.labels.length : 0;
  var daysArr = (__lastUsageData && __lastUsageData.days) || [];
  var triTop = chartYInParent(ch, wrap, ch.chartArea.top + 4);
  for (var di = 0; di < n; di++) {
    var d = daysArr[di];
    if (!d) continue;
    var leftAbs = chartTickXToParentLeft(ch, wrap, di);
    if (leftAbs == null) continue;
    var hasV = !!d.version_change;
    var hasM = !!d.model_change;
    if (!hasV && !hasM) continue;
    if (hasV) {
      var mark = document.createElement("button");
      mark.type = "button";
      mark.className = "fs-update-mark";
      mark.textContent = "\u25b2";
      mark.style.left = (leftAbs + (hasM ? -10 : 0)) + "px";
      mark.style.top = triTop + "px";
      mark.setAttribute("aria-label", t("updateDotAria"));
      mark.dataset.dayIndex = String(di);
      overlay.appendChild(mark);
    }
    if (hasM) {
      var mmark = document.createElement("button");
      mmark.type = "button";
      mmark.className = "fs-model-mark";
      mmark.textContent = "\u25c7";
      mmark.style.left = (leftAbs + (hasV ? 10 : 0)) + "px";
      mmark.style.top = triTop + "px";
      mmark.setAttribute("aria-label", t("modelDotAria"));
      mmark.dataset.dayIndex = String(di);
      overlay.appendChild(mmark);
    }
  }
}
/** Extension-Update-Marker nur im Service-Impact-Chart (c-service), nicht in den Haupt-Charts. */
function layoutMainChartsUpdateOverlay() {
  var overlay = document.getElementById("main-charts-update-overlay");
  if (overlay) overlay.innerHTML = "";
}
function layoutUpdateGuideOverlays() {
  layoutFsUpdateOverlay();
  layoutMainChartsUpdateOverlay();
}
/** Stunden 0–24 als HH:MM (UTC-Tag wie serverseitige outage_spans). */
function fmtUtcHmFromDayHour(h) {
  if (h == null || isNaN(h)) return "?";
  var hi = Math.floor(h);
  var mi = Math.round((h - hi) * 60);
  while (mi >= 60) {
    hi++;
    mi -= 60;
  }
  while (mi < 0) {
    hi--;
    mi += 60;
  }
  if (hi < 0) hi = 0;
  if (hi > 24) hi = 24;
  function p2(n) {
    return n < 10 ? "0" + n : String(n);
  }
  return p2(hi) + ":" + p2(mi);
}
/** Anthropic-Outage + Forensic-Kontext nur im Slideout (nicht im Chart-Tooltip). */
function appendDayDiagnosticSlideoutSection(bodyEl, d) {
  if (!bodyEl || !d) return;
  var incs = d.outage_incidents || [];
  var spans = d.outage_spans || [];
  var showOut =
    (d.outage_hours || 0) > 0 ||
    incs.length > 0 ||
    spans.length > 0 ||
    !!d.outage_likely;
  var showForensic = d.forensic_hint && String(d.forensic_hint).trim().length > 0;
  if (!showOut && !showForensic) return;
  var wrap = document.createElement("div");
  wrap.className = "upd-slide-diagnostics";
  wrap.style.marginTop = "16px";
  wrap.style.paddingTop = "14px";
  wrap.style.borderTop = "1px solid #334155";
  if (showOut) {
    var hOut = document.createElement("div");
    hOut.style.fontWeight = "600";
    hOut.style.color = "#94a3b8";
    hOut.style.marginBottom = "8px";
    hOut.textContent = t("updateSlideoutStatusHeading");
    wrap.appendChild(hOut);
    var srv = typeof d.outage_server_hours === "number" ? d.outage_server_hours : 0;
    var cli = typeof d.outage_client_hours === "number" ? d.outage_client_hours : 0;
    var tot = d.outage_hours || 0;
    if (tot > 0 || srv > 0 || cli > 0) {
      var pH = document.createElement("p");
      pH.className = "upd-meta";
      pH.style.marginBottom = "8px";
      pH.textContent = tr("updateSlideoutOutageHoursLine", {
        total: String(tot),
        srv: String(srv),
        cli: String(cli)
      });
      wrap.appendChild(pH);
    }
    if (d.outage_likely && (d.hit_limit || 0) > 0) {
      var pL = document.createElement("p");
      pL.className = "upd-meta";
      pL.style.color = "#fbbf24";
      pL.style.marginBottom = "8px";
      pL.textContent = t("updateSlideoutLikelyHit");
      wrap.appendChild(pL);
    }
    if (incs.length > 0) {
      var hI = document.createElement("div");
      hI.style.fontWeight = "600";
      hI.style.fontSize = "0.72rem";
      hI.style.color = "#cbd5e1";
      hI.style.marginBottom = "4px";
      hI.textContent = t("updateSlideoutOutageIncidents");
      wrap.appendChild(hI);
      var ulI = document.createElement("ul");
      ulI.style.margin = "0 0 10px 0";
      ulI.style.paddingLeft = "1.2em";
      ulI.style.fontSize = "0.72rem";
      ulI.style.lineHeight = "1.45";
      ulI.style.color = "#e2e8f0";
      for (var ii = 0; ii < incs.length; ii++) {
        var inc = incs[ii];
        var li = document.createElement("li");
        var imp = String(inc.impact || "none").toUpperCase();
        var k = inc.kind ? " (" + inc.kind + ")" : "";
        var parts = ["[" + imp + "] " + (inc.name || "") + k];
        if (inc.created_at) {
          try {
            parts.push(t("updateSlideoutIncidentStart") + " " + new Date(inc.created_at).toLocaleString());
          } catch (e1) {}
        }
        if (inc.resolved_at) {
          try {
            parts.push(t("updateSlideoutIncidentResolved") + " " + new Date(inc.resolved_at).toLocaleString());
          } catch (e2) {}
        } else if (inc.created_at) {
          parts.push(t("updateSlideoutIncidentOngoing"));
        }
        li.textContent = parts.join(" \u00b7 ");
        ulI.appendChild(li);
      }
      wrap.appendChild(ulI);
    }
    if (spans.length > 0) {
      var hS = document.createElement("div");
      hS.style.fontWeight = "600";
      hS.style.fontSize = "0.72rem";
      hS.style.color = "#cbd5e1";
      hS.style.marginBottom = "4px";
      hS.textContent = t("updateSlideoutOutageSpans");
      wrap.appendChild(hS);
      var ulS = document.createElement("ul");
      ulS.style.margin = "0 0 0 0";
      ulS.style.paddingLeft = "1.2em";
      ulS.style.fontSize = "0.68rem";
      ulS.style.lineHeight = "1.45";
      ulS.style.color = "#94a3b8";
      for (var sj = 0; sj < spans.length; sj++) {
        var sp = spans[sj];
        var liS = document.createElement("li");
        var impS = String(sp.impact || "none").toUpperCase();
        var kS = sp.kind ? " (" + sp.kind + ")" : "";
        liS.textContent =
          fmtUtcHmFromDayHour(sp.from) +
          "\u2013" +
          fmtUtcHmFromDayHour(sp.to) +
          " UTC \u00b7 [" +
          impS +
          "] " +
          (sp.name || "") +
          kS;
        ulS.appendChild(liS);
      }
      wrap.appendChild(ulS);
    }
  }
  if (showForensic) {
    var hF = document.createElement("div");
    hF.style.fontWeight = "600";
    hF.style.color = "#94a3b8";
    hF.style.marginTop = showOut ? "12px" : "0";
    hF.style.marginBottom = "6px";
    hF.textContent = t("updateSlideoutForensicHeading");
    wrap.appendChild(hF);
    var pC = document.createElement("p");
    pC.className = "upd-ver";
    pC.style.fontSize = "0.8rem";
    pC.textContent = (d.forensic_code || "\u2014") + (d.date ? " \u00b7 " + d.date : "");
    wrap.appendChild(pC);
    var pHint = document.createElement("p");
    pHint.className = "upd-meta";
    pHint.style.lineHeight = "1.45";
    pHint.textContent = String(d.forensic_hint);
    wrap.appendChild(pHint);
  }
  bodyEl.appendChild(wrap);
}
function openUpdateSlideout(dayIndex) {
  var data = __lastUsageData;
  if (!data || !data.days || data.days[dayIndex] == null) return;
  var d = data.days[dayIndex];
  var vc = d.version_change;
  var titleEl = document.getElementById("update-sl-title");
  var bodyEl = document.getElementById("update-sl-body");
  var panel = document.getElementById("update-slideout");
  var back = document.getElementById("update-slideout-backdrop");
  if (!titleEl || !bodyEl || !panel || !back) return;
  titleEl.textContent = d.date + " — " + t("updateSlideoutHeading");
  bodyEl.textContent = "";
  if (!vc) {
    bodyEl.appendChild(document.createTextNode(t("updateSlideoutNoDetail")));
  } else {
    var pVer = document.createElement("p");
    pVer.className = "upd-ver";
    var verStr = vc.added && vc.added.length ? vc.added.join(", ") : "";
    if (vc.from) verStr = vc.from + " \u2192 " + verStr;
    pVer.textContent = verStr;
    bodyEl.appendChild(pVer);
    var meta = document.createElement("p");
    meta.className = "upd-meta";
    var metaParts = [];
    if (vc.release_when) metaParts.push(String(vc.release_when));
    if (vc.release_utc_ymd) metaParts.push("UTC: " + vc.release_utc_ymd);
    if (vc.release_local_ymd && vc.release_local_ymd !== vc.release_utc_ymd) metaParts.push("local: " + vc.release_local_ymd);
    meta.textContent = metaParts.join(" \u00b7 ");
    if (meta.textContent) bodyEl.appendChild(meta);
    var hl = vc.highlights || [];
    var gl = vc.github_release_links || [];
    if (hl.length) {
      var h3 = document.createElement("div");
      h3.style.fontWeight = "600";
      h3.style.color = "#94a3b8";
      h3.style.marginTop = "10px";
      h3.textContent = t("updateSlideoutHighlights");
      bodyEl.appendChild(h3);
      var ul = document.createElement("ul");
      for (var hi = 0; hi < Math.min(8, hl.length); hi++) {
        var li = document.createElement("li");
        li.textContent = String(hl[hi]).slice(0, 400);
        ul.appendChild(li);
      }
      bodyEl.appendChild(ul);
    } else if (gl.length) {
      var pNote = document.createElement("p");
      pNote.className = "upd-meta";
      pNote.style.marginTop = "10px";
      pNote.textContent = t("updateSlideoutHighlightsEmpty");
      bodyEl.appendChild(pNote);
    }
    if (gl.length) {
      var ghH = document.createElement("div");
      ghH.style.fontWeight = "600";
      ghH.style.color = "#94a3b8";
      ghH.style.marginTop = "10px";
      ghH.textContent = t("updateSlideoutGithubReleases");
      bodyEl.appendChild(ghH);
      var ulg = document.createElement("ul");
      ulg.style.marginTop = "6px";
      ulg.style.paddingLeft = "1.2em";
      for (var gi = 0; gi < gl.length; gi++) {
        var gli = document.createElement("li");
        var a = document.createElement("a");
        a.href = gl[gi].url;
        a.textContent = "v" + gl[gi].version;
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        a.style.color = "#93c5fd";
        gli.appendChild(a);
        ulg.appendChild(gli);
      }
      bodyEl.appendChild(ulg);
    }
  }
  appendDayDiagnosticSlideoutSection(bodyEl, d);
  panel.classList.add("open");
  back.classList.add("open");
  panel.setAttribute("aria-hidden", "false");
}
function openModelChangeSlideout(dayIndex) {
  var data = __lastUsageData;
  if (!data || !data.days || data.days[dayIndex] == null) return;
  var d = data.days[dayIndex];
  var mc = d.model_change;
  var titleEl = document.getElementById("update-sl-title");
  var bodyEl = document.getElementById("update-sl-body");
  var panel = document.getElementById("update-slideout");
  var back = document.getElementById("update-slideout-backdrop");
  if (!titleEl || !bodyEl || !panel || !back) return;
  titleEl.textContent = d.date + " — " + t("modelSlideoutHeading");
  bodyEl.textContent = "";
  if (!mc) {
    bodyEl.appendChild(document.createTextNode(t("modelSlideoutNoDetail")));
  } else {
    if (mc.added && mc.added.length) {
      var pAdd = document.createElement("p");
      pAdd.className = "upd-ver";
      pAdd.style.color = "#67e8f9";
      pAdd.textContent = t("tooltipModelAdded") + mc.added.join(", ");
      bodyEl.appendChild(pAdd);
    }
    if (mc.removed && mc.removed.length) {
      var pRem = document.createElement("p");
      pRem.className = "upd-meta";
      pRem.textContent = t("tooltipModelRemoved") + mc.removed.join(", ");
      bodyEl.appendChild(pRem);
    }
    if (!bodyEl.children.length) {
      bodyEl.appendChild(document.createTextNode(t("modelSlideoutNoDetail")));
    }
  }
  appendDayDiagnosticSlideoutSection(bodyEl, d);
  panel.classList.add("open");
  back.classList.add("open");
  panel.setAttribute("aria-hidden", "false");
}
function closeUpdateSlideout() {
  var panel = document.getElementById("update-slideout");
  var back = document.getElementById("update-slideout-backdrop");
  if (panel) {
    panel.classList.remove("open");
    panel.setAttribute("aria-hidden", "true");
  }
  if (back) back.classList.remove("open");
}
var __updateSlideoutUiBound = false;
function initUpdateSlideoutOnce() {
  if (__updateSlideoutUiBound) return;
  __updateSlideoutUiBound = true;
  document.body.addEventListener("click", function (ev) {
    var mDot = ev.target.closest(".fs-model-mark");
    if (mDot && mDot.dataset.dayIndex != null) {
      ev.preventDefault();
      openModelChangeSlideout(parseInt(mDot.dataset.dayIndex, 10));
      return;
    }
    var uDot = ev.target.closest(".fs-update-mark");
    if (uDot && uDot.dataset.dayIndex != null) {
      ev.preventDefault();
      openUpdateSlideout(parseInt(uDot.dataset.dayIndex, 10));
    }
  });
  var back = document.getElementById("update-slideout-backdrop");
  if (back) back.addEventListener("click", closeUpdateSlideout);
  var cls = document.getElementById("update-sl-close");
  if (cls) cls.addEventListener("click", closeUpdateSlideout);
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") closeUpdateSlideout();
  });
}
var __layoutOvTimer = null;
/** Overlay-Marker erst nach stabilem Chart-Layout; entkoppelt von Resize/SSE, vermeidet Resize-Feedback. */
function scheduleLayoutUpdateGuideOverlays() {
  clearTimeout(window.__dashLayoutAfterCore);
  window.__dashLayoutAfterCore = setTimeout(function () {
    window.__dashLayoutAfterCore = null;
    requestAnimationFrame(function () {
      requestAnimationFrame(layoutUpdateGuideOverlays);
    });
  }, 140);
}
window.addEventListener("resize", function () {
  clearTimeout(__layoutOvTimer);
  __layoutOvTimer = setTimeout(scheduleLayoutUpdateGuideOverlays, 200);
});

// ── Date Range + Host Filter ──────────────────────────────────────────────
function getFilteredDays(days) {
  if (!days || !days.length) return days;
  var startEl = document.getElementById("filter-date-start");
  var endEl = document.getElementById("filter-date-end");
  var startVal = startEl ? startEl.value : "";
  var endVal = endEl ? endEl.value : "";
  if (!startVal && !endVal) return days;
  var filtered = [];
  for (var i = 0; i < days.length; i++) {
    var d = days[i].date;
    if (startVal && d < startVal) continue;
    if (endVal && d > endVal) continue;
    filtered.push(days[i]);
  }
  return filtered.length ? filtered : days;
}

function getFilterHost() {
  var container = document.getElementById("filter-host-container");
  if (!container) return "";
  var sel = container.querySelector("select");
  if (sel) {
    var opts = sel.selectedOptions;
    if (!opts || !opts.length) return "";
    var vals = [];
    for (var i = 0; i < opts.length; i++) vals.push(opts[i].value);
    if (vals.indexOf("") >= 0) return "";
    return vals.join(",");
  }
  var active = container.querySelector(".filter-chip.active");
  if (!active) return "";
  return active.dataset.host || "";
}

function renderDashboard(data, urgent) {
  if (urgent) clearTimeout(__dashRenderCoreCoalesce);
  __lastUsageData = data;
  updateGithubTokenPanelMode();
  updateLiveSidePanel(data);
  updateScanSourcesRow(data);
  updateStatePathsRow(data);
  updateStatusLamp(data);
  renderHealthScore(data);
  updateAnthropicPopup(data);
  initFilterBar(data);
  renderKeyFindings(data);
  var days = getFilteredDays(data.days);
  var sp = data.scan_progress;
  var scanInc = data.scanning && sp && sp.total > 0 && sp.done < sp.total;
  if (!days || !days.length) {
    if (data.scanning) showMainChartsSkeleton(true);
    else showMainChartsSkeleton(false);
  } else if (scanInc) {
    showMainChartsSkeleton(true);
  }
  if (scanInc && days && days.length > 0) {
    updateMetaDetailsSummary(data);
    clearTimeout(window.__dashRenderDebounce);
    var deferMs = urgent ? 0 : 1000;
    window.__dashRenderDebounce = setTimeout(function () {
      window.__dashRenderDebounce = null;
      renderDashboardCore(__lastUsageData);
    }, deferMs);
    if (!window.__dashRenderScanMaxWait) {
      window.__dashRenderScanMaxWait = setTimeout(function () {
        window.__dashRenderScanMaxWait = null;
        var d = __lastUsageData;
        if (!d || !d.scanning) return;
        clearTimeout(window.__dashRenderDebounce);
        window.__dashRenderDebounce = null;
        renderDashboardCore(d);
      }, 3200);
    }
    return;
  }
  if (window.__dashRenderDebounce) {
    clearTimeout(window.__dashRenderDebounce);
    window.__dashRenderDebounce = null;
  }
  if (window.__dashRenderScanMaxWait) {
    clearTimeout(window.__dashRenderScanMaxWait);
    window.__dashRenderScanMaxWait = null;
  }
  function runCoreNow() {
    clearTimeout(__dashRenderCoreCoalesce);
    __dashRenderCoreCoalesce = null;
    renderDashboardCore(__lastUsageData);
  }
  if (urgent) {
    runCoreNow();
    return;
  }
  clearTimeout(__dashRenderCoreCoalesce);
  __dashRenderCoreCoalesce = setTimeout(function () {
    __dashRenderCoreCoalesce = null;
    renderDashboardCore(__lastUsageData);
  }, DASH_CORE_COALESCE_MS);
}
var __forensicHostFilterSig = "";
function getForensicHostFilterForCharts() {
  return __forensicHostFilterSig || "";
}
/** Multi-Host: Chip-Leiste über den Forensic-Charts; Signale/Hit-Limit/Cache pro Scan-Quelle, Ausfall weiter Tageswert. */
function syncForensicHostFilterBar(data) {
  var wrap = document.getElementById("forensic-host-filter-wrap");
  var chipsHost = document.getElementById("forensic-host-filter-chips");
  var hint = document.getElementById("forensic-host-filter-hint");
  if (!wrap || !chipsHost) return;
  var hLabs = (data && data.host_labels) || [];
  if (hLabs.length <= 1) {
    wrap.setAttribute("hidden", "");
    __forensicHostFilterSig = "";
    try {
      sessionStorage.removeItem("usageForensicHostFilter");
    } catch (e0) {}
    if (hint) {
      hint.style.display = "none";
      hint.textContent = "";
    }
    return;
  }
  wrap.removeAttribute("hidden");
  var stored = "";
  try {
    stored = sessionStorage.getItem("usageForensicHostFilter") || "";
  } catch (e1) {}
  if (stored && hLabs.indexOf(stored) < 0) stored = "";
  __forensicHostFilterSig = stored;
  var hostSig = hLabs.join("\u0000");
  var lbl = document.getElementById("forensic-host-filter-label");
  if (lbl) lbl.textContent = t("forensicHostFilterLabel");
  wrap.setAttribute("aria-label", t("forensicHostFilterAria"));
  if (!wrap.dataset.filterClickBound) {
    wrap.dataset.filterClickBound = "1";
    chipsHost.addEventListener("click", function (ev) {
      var btn = ev.target.closest(".forensic-host-chip");
      if (!btn) return;
      var raw = btn.dataset.hostFilter != null ? String(btn.dataset.hostFilter) : "__ALL__";
      var val = raw === "__ALL__" ? "" : raw;
      __forensicHostFilterSig = val;
      try {
        if (val) sessionStorage.setItem("usageForensicHostFilter", val);
        else sessionStorage.removeItem("usageForensicHostFilter");
      } catch (e2) {}
      var nodes = chipsHost.querySelectorAll(".forensic-host-chip");
      for (var ni = 0; ni < nodes.length; ni++) {
        var b = nodes[ni];
        var rv = b.dataset.hostFilter != null ? String(b.dataset.hostFilter) : "__ALL__";
        var nv = rv === "__ALL__" ? "" : rv;
        var on = nv === __forensicHostFilterSig;
        b.classList.toggle("active", on);
        b.setAttribute("aria-pressed", on ? "true" : "false");
      }
      if (hint) {
        if (__forensicHostFilterSig) {
          hint.style.display = "";
          hint.textContent = tr("forensicHostFilterHint", { host: __forensicHostFilterSig });
        } else {
          hint.style.display = "none";
          hint.textContent = "";
        }
      }
      if (typeof __lastUsageData !== "undefined" && __lastUsageData) renderDashboard(__lastUsageData, true);
    });
  }
  if (wrap.dataset.lastHostSig !== hostSig) {
    wrap.dataset.lastHostSig = hostSig;
    chipsHost.innerHTML = "";
    function addChip(value, text) {
      var b = document.createElement("button");
      b.type = "button";
      b.className = "forensic-host-chip";
      b.textContent = text;
      b.dataset.hostFilter = value === "" ? "__ALL__" : value;
      chipsHost.appendChild(b);
    }
    addChip("", t("forensicHostFilterAll"));
    for (var hi = 0; hi < hLabs.length; hi++) {
      addChip(hLabs[hi], hLabs[hi]);
    }
  }
  var btns = chipsHost.querySelectorAll(".forensic-host-chip");
  for (var bi = 0; bi < btns.length; bi++) {
    var bb = btns[bi];
    var rv2 = bb.dataset.hostFilter != null ? String(bb.dataset.hostFilter) : "__ALL__";
    var nv2 = rv2 === "__ALL__" ? "" : rv2;
    var active = nv2 === __forensicHostFilterSig;
    bb.classList.toggle("active", active);
    bb.setAttribute("aria-pressed", active ? "true" : "false");
  }
  if (hint) {
    if (__forensicHostFilterSig) {
      hint.style.display = "";
      hint.textContent = tr("forensicHostFilterHint", { host: __forensicHostFilterSig });
    } else {
      hint.style.display = "none";
      hint.textContent = "";
    }
  }
}
function renderDashboardCore(data) {
  // Update dev overlay with last sync info
  var devSync = document.getElementById("dev-last-sync");
  if (devSync && data.generated) {
    var ts = new Date(data.generated);
    devSync.textContent = "Last: " + ts.toLocaleTimeString() + (data.dev_source ? " · " + (data.days || []).length + "d" : "");
  }
  renderProxyAnalysis(data);
  renderBudgetEfficiency(data);
  renderEconomicSection(data);
  __releaseStabilityData = data.release_stability || null;
  renderUserProfileCharts(getFilteredDays(data.days));
  updateMetaDetailsSummary(data);
  var days = getFilteredDays(data.days);
  if(!days.length){
    window.__usageVersionDayIndices = [];
    var fsO = document.getElementById("fs-update-overlay");
    var mO = document.getElementById("main-charts-update-overlay");
    if (fsO) fsO.innerHTML = "";
    if (mO) mO.innerHTML = "";
    var meta0=document.getElementById("meta");
    var ls0=document.getElementById("limit-source");
    if(ls0) ls0.textContent = apiNote(data, "limit_source_note", "limit_source_note_en");
    if(data.scanning){
      
      var selScan=document.getElementById("day-picker");
      if(selScan){
        selScan.innerHTML="<option value=\"\">"+escHtml(t("dayPickerScanning"))+"</option>";
        selScan.disabled=true;
      }
      var sp0 = data.scan_progress;
      if (sp0 && sp0.total > 0) meta0.textContent = tr("metaScanningExpanded", { done: sp0.done, total: sp0.total, sec: data.refresh_sec || 180 });
      else meta0.textContent=t("metaScanning");
      var sumS=document.getElementById("forensic-summary-line");if(sumS)sumS.textContent=t("metaForensicScanning");
      var fnS=document.getElementById("forensic-note");if(fnS)fnS.textContent=tr("metaForensicNoteFirst",{sec:data.refresh_sec||180});
      document.getElementById("cards").innerHTML="";
      var fcS=document.getElementById("forensic-cards");if(fcS)fcS.innerHTML="";
      if(_charts.cForensic){try{_charts.cForensic.destroy();}catch(e){}_charts.cForensic=null;}
      if(_charts.cForensicSignals){try{_charts.cForensicSignals.destroy();}catch(e){}_charts.cForensicSignals=null;}
      if(_charts.cService){try{_charts.cService.destroy();}catch(e){}_charts.cService=null;}
      chartShellSetLoading("c-forensic", true);
      chartShellSetLoading("c-forensic-signals", true);
      chartShellSetLoading("c-service", true);
      document.getElementById("live-label").textContent=t("liveWaitData");
      return;
    }
    
    var selNd=document.getElementById("day-picker");
    if(selNd){
      selNd.innerHTML="<option value=\"\">"+escHtml(t("dayPickerNoData"))+"</option>";
      selNd.disabled=true;
    }
    if(data.scan_error)meta0.textContent=tr("metaScanError",{msg:String(data.scan_error)});
    else if((data.parsed_files||0)===0)meta0.textContent=t("metaNoFiles");
    else meta0.textContent=tr("metaNoUsage",{files:data.parsed_files||0});
    var sum0=document.getElementById("forensic-summary-line");if(sum0)sum0.textContent=t("forensicSummaryNoData");
    var fn0=document.getElementById("forensic-note");if(fn0)fn0.textContent="";
    var fc0=document.getElementById("forensic-cards");if(fc0)fc0.innerHTML="";
    document.getElementById("cards").innerHTML="";
    if(_charts.cForensic){try{_charts.cForensic.destroy();}catch(e){}_charts.cForensic=null;}
    if(_charts.cForensicSignals){try{_charts.cForensicSignals.destroy();}catch(e){}_charts.cForensicSignals=null;}
    if(_charts.cService){try{_charts.cService.destroy();}catch(e){}_charts.cService=null;}
    chartShellSetLoading("c-forensic", false);
    chartShellSetLoading("c-forensic-signals", false);
    chartShellSetLoading("c-service", false);
    return;
  }
  
  showMainChartsSkeleton(false);
  
  var calToday = data.calendar_today || "";
  var spM = data.scan_progress;
  var metaLine =
    data.scanning && spM && spM.total > 0 && spM.done < spM.total
      ? tr("metaParsedInProgress", {
          done: spM.done,
          total: spM.total,
          time: new Date(data.generated).toLocaleString(),
          sec: data.refresh_sec || 180
        })
      : tr("metaParsed", { files: data.parsed_files, time: new Date(data.generated).toLocaleString(), sec: data.refresh_sec || 180 });
  var dcm = apiNote(data,"day_cache_mode","day_cache_mode_en");
  if (dcm) metaLine += " | " + dcm;
  metaLine += " " + t("metaChartsHint");
  if (getMainChartsScope() === "hourly") metaLine += " " + t("metaChartsHintHourly");
  document.getElementById("meta").textContent = metaLine;
  
  var selEl = document.getElementById("day-picker");
  var prevSel = selEl && selEl.value ? selEl.value : "";
  if (!prevSel) {
    try { prevSel = sessionStorage.getItem("usageDashboardDay") || ""; } catch (e) {}
  }
  var valid = {};
  for (var vi = 0; vi < days.length; vi++) valid[days[vi].date] = true;
  var pick = prevSel;
  if (selEl) {
    selEl.innerHTML = "";
    selEl.disabled = false;
    for (var di = days.length - 1; di >= 0; di--) {
      var o = document.createElement("option");
      o.value = days[di].date;
      var lab = days[di].date;
      if (days[di].date === calToday) lab += t("calTodaySuffix");
      if ((days[di].total || 0) === 0) lab += t("zeroLogsSuffix");
      o.textContent = lab;
      selEl.appendChild(o);
    }
    if (!pick || !valid[pick]) {
      pick = (calToday && valid[calToday]) ? calToday : days[days.length - 1].date;
      // In dev mode: skip today if it has no data, pick last day with output
      if (pick === calToday && data.dev_source) {
        for (var dp = days.length - 1; dp >= 0; dp--) {
          if ((days[dp].output || 0) > 0) { pick = days[dp].date; break; }
        }
      }
    }
    selEl.value = pick;
    if (!selEl.dataset.bound) {
      selEl.dataset.bound = "1";
      selEl.addEventListener("change", function () {
        try { sessionStorage.setItem("usageDashboardDay", this.value); } catch (e) {}
        if (__lastUsageData) renderDashboard(__lastUsageData, true);
      });
    }
  } else {
    if (!pick || !valid[pick]) {
      pick = (calToday && valid[calToday]) ? calToday : days[days.length - 1].date;
      if (pick === calToday && data.dev_source) {
        for (var dp2 = days.length - 1; dp2 >= 0; dp2--) {
          if ((days[dp2].output || 0) > 0) { pick = days[dp2].date; break; }
        }
      }
    }
  }
  var selDay = null;
  for (var sj = 0; sj < days.length; sj++) {
    if (days[sj].date === pick) { selDay = days[sj]; break; }
  }
  if (!selDay) selDay = days[days.length - 1];
  var hLabs = data.host_labels || [];
  var multiHost = hLabs.length > 1;
  syncForensicHostFilterBar(data);
  syncMainChartsScopeUi();
  var prevDPick = window.__usageDetailDayPick;
  window.__usageDetailDayPick = pick;
  if (typeof prevDPick !== "undefined" && prevDPick !== pick) window.__usageDetailHost = null;
  if (window.__usageDetailHost && (!multiHost || !selDay.hosts || !selDay.hosts[window.__usageDetailHost])) window.__usageDetailHost = null;
  var hintEl = document.getElementById("day-picker-hint");
  if (hintEl) {
    hintEl.textContent = (pick === calToday && (selDay.total || 0) === 0) ? t("dayPickerHintZero") : "";
  }
  var ddh = document.getElementById("daily-detail-heading");
  if (ddh) {
    if (!ddh.querySelector("#daily-detail-title")) {
      ddh.innerHTML = "<span id=\"daily-detail-title\"></span><button type=\"button\" id=\"daily-detail-clear-host\" style=\"display:none;margin-left:10px;padding:2px 8px;border-radius:4px;border:1px solid #475569;background:#1e293b;color:#94a3b8;font-size:.72rem;cursor:pointer\"></button>";
    }
    var ddt = document.getElementById("daily-detail-title");
    var ddc = document.getElementById("daily-detail-clear-host");
    if (ddt) ddt.textContent = t("dailyDetailPrefix") + pick + (window.__usageDetailHost ? " — " + window.__usageDetailHost : "");
    if (ddc) {
      if (window.__usageDetailHost && multiHost) {
        ddc.style.display = "";
        ddc.textContent = t("dailyDetailClearHost");
        if (!ddc.dataset.bound) {
          ddc.dataset.bound = "1";
          ddc.addEventListener("click", function () {
            window.__usageDetailHost = null;
            if (__lastUsageData) renderDashboard(__lastUsageData, true);
          });
        }
      } else ddc.style.display = "none";
    }
  }
  var ls = document.getElementById("limit-source");
  ls.textContent = apiNote(data, "limit_source_note", "limit_source_note_en");
  ls.title = t("limitSourceTooltip");
  var fn = document.getElementById("forensic-note");
  if(fn) fn.textContent = apiNote(data, "forensic_note", "forensic_note_en");
  document.getElementById("live-label").textContent = tr("liveConnected",{time:new Date().toLocaleTimeString()});
  
  // --- Summary cards (gewählter Tag im Dropdown); Host-Filter steuert Tages-/Peak-/Forensic-Kennzahlen ---
  var fhCard = getForensicHostFilterForCharts();
  var hSlicePick = fhCard && selDay.hosts && selDay.hosts[fhCard] ? selDay.hosts[fhCard] : null;
  var emptyHostDay = {
    output: 0,
    cache_read: 0,
    total: 0,
    calls: 0,
    active_hours: 0,
    cache_output_ratio: 0,
    overhead: 0,
    hit_limit: 0,
    session_signals: { continue: 0, resume: 0, retry: 0, interrupt: 0 }
  };
  var cardBase = fhCard ? hSlicePick || emptyHostDay : selDay;
  var totalOut = fhCard ? sumHostNumericField(days, fhCard, "output") : days.reduce(function (s, d) { return s + d.output; }, 0);
  var totalCache = fhCard ? sumHostNumericField(days, fhCard, "cache_read") : days.reduce(function (s, d) { return s + d.cache_read; }, 0);
  var totalAll = fhCard
    ? days.reduce(function (s, d) {
        var hh = d.hosts && d.hosts[fhCard];
        return s + (hh ? hh.total || 0 : 0);
      }, 0)
    : days.reduce(function (s, d) { return s + d.total; }, 0);
  var peak = fhCard
    ? (function () {
        var hp = findHostPeakAcrossDays(days, fhCard);
        return { date: hp.date, total: hp.total };
      })()
    : days.reduce(function (a, b) { return a.total > b.total ? a : b; });
  var selTotalForBudget = cardBase.total || 0;
  var budgetRatio =
    peak.total > 0 && selTotalForBudget > 0 ? Math.round(peak.total / (selTotalForBudget / 0.9)) : 0;
  var hitSel = fhCard ? (hSlicePick ? hSlicePick.hit_limit || 0 : 0) : selDay.hit_limit || 0;
  var hitAll = fhCard
    ? days.reduce(function (s, d) {
        var hh = d.hosts && d.hosts[fhCard];
        return s + (hh ? hh.hit_limit || 0 : 0);
      }, 0)
    : days.reduce(function (s, d) { return s + (d.hit_limit || 0); }, 0);
  var fc;
  var fwarn;
  var impl90;
  var forensicHintF;
  if (fhCard) {
    var rHost = hostApiToForensicRow(hSlicePick);
    var hpK = findHostPeakAcrossDays(days, fhCard);
    var fHost = computeForensicForDayClient(pick, rHost, hpK.date, hpK.total);
    fc = fHost.forensic_code;
    forensicHintF = fHost.forensic_hint;
    impl90 = fHost.forensic_implied_cap_90;
    fwarn = fc === "?" || fc === "HIT" || fc === "<<P";
  } else {
    fc = selDay.forensic_code || "\u2014";
    forensicHintF = selDay.forensic_hint || "";
    fwarn = fc === "?" || fc === "HIT" || fc === "<<P";
    impl90 = selDay.forensic_implied_cap_90 || 0;
  }
  var sumEl = document.getElementById("forensic-summary-line");
  if (sumEl) {
    var sumLine = tr("forensicSummaryLine", {
      pick: pick,
      fc: fc,
      impl: impl90 > 0 ? fmt(impl90) : "\u2014",
      bud: String(budgetRatio),
      peak: peak.date || "\u2014"
    });
    if (fhCard) sumLine += tr("forensicSummaryHostSuffix", { host: fhCard });
    sumEl.textContent = sumLine;
  }
  var cards = [
    { label: t("cardDayOutput"), value: fmt(cardBase.output || 0), sub: selDay.date, cls: "" },
    {
      label: t("cardDayCacheRead"),
      value: fmt(cardBase.cache_read || 0),
      sub: tr("cardCacheOutSub", { ratio: cardBase.cache_output_ratio || 0 }),
      cls: (cardBase.cache_output_ratio || 0) > 500 ? "warn" : ""
    },
    {
      label: t("cardDayTotal"),
      value: fmt(cardBase.total || 0),
      sub: tr("cardCallsActiveSub", { calls: cardBase.calls || 0, hours: cardBase.active_hours || 0 }),
      cls: ""
    },
    { label: t("cardHitDay"), value: String(hitSel), sub: t("cardHitDaySub"), cls: hitSel > 0 ? "warn" : "ok" },
    { label: t("cardHitAll"), value: String(hitAll), sub: t("cardHitAllSub"), cls: hitAll > 0 ? "warn" : "" },
    {
      label: t("cardOverhead"),
      value: (cardBase.overhead || 0) + "x",
      sub: t("cardOverheadSub"),
      cls: (cardBase.overhead || 0) > 1000 ? "danger" : ""
    },
    { label: t("cardPeak"), value: fmt(peak.total || 0), sub: tr("cardPeakSub", { date: peak.date || "\u2014" }), cls: "ok" },
    { label: t("cardAllOut"), value: fmt(totalOut), sub: tr("cardAllOutSub", { days: days.length }), cls: "" },
    { label: t("cardAllCache"), value: fmt(totalCache), sub: tr("cardAllCacheSub", { pct: pct(totalCache, totalAll) }), cls: "" }
  ];
  var ssSel = cardBase.session_signals || {};
  var ssc = ssSel.continue || 0;
  var ssr = ssSel.resume || 0;
  var ssy = ssSel.retry || 0;
  var ssi = ssSel.interrupt || 0;
  cards.push({
    label: t("cardSessionSignals"),
    value: String(ssc + ssr + ssy + ssi),
    sub: tr("cardSessionSignalsSub", { c: String(ssc), r: String(ssr), y: String(ssy), i: String(ssi) }),
    cls: ssy + ssi > 0 ? "warn" : ""
  });
  if (multiHost && selDay.hosts) {
    for (var hci = 0; hci < hLabs.length; hci++) {
      var hlbl = hLabs[hci];
      var hday = selDay.hosts[hlbl];
      if (!hday) continue;
      var hhit = hday.hit_limit || 0;
      cards.push({
        label: hlbl + t("cardHostParen"),
        value: fmt(hday.total),
        sub: tr("cardHostSub", { out: fmt(hday.output), calls: hday.calls, hit: String(hhit) }),
        cls: hhit > 0 ? "warn" : ""
      });
    }
  }
  var fcards = [
    { label: t("fcForensicDay"), value: fc, sub: forensicHintF, cls: fwarn ? "warn" : "" },
    { label: t("fcImpl"), value: impl90 > 0 ? fmt(impl90) : "\u2014", sub: t("fcImplSub"), cls: "" },
    { label: t("fcBudget"), value: "~" + budgetRatio + "x", sub: t("fcBudgetSub"), cls: budgetRatio > 10 ? "danger" : "warn" }
  ];
  var chtml="";
  cards.forEach(function(c){chtml+="<div class=\"card "+c.cls+"\"><div class=\"label\">"+escHtml(c.label)+"</div><div class=\"value\">"+escHtml(c.value)+"</div><div class=\"sub\">"+escHtml(c.sub)+"</div></div>";});
  var _ce=document.getElementById("cards");if(_ce&&_ce.innerHTML!==chtml)_ce.innerHTML=chtml;
  var tsSum=document.getElementById("token-stats-summary-line");
  if(tsSum) tsSum.textContent=tr("tokenStatsSummary",{date:selDay.date||"",out:fmt(cardBase.output||0),cache:fmt(cardBase.cache_read||0),overhead:(cardBase.overhead||0)+"x"});
  var fch="";
  fcards.forEach(function(c){fch+="<div class=\"card "+c.cls+"\"><div class=\"label\">"+escHtml(c.label)+"</div><div class=\"value\">"+escHtml(c.value)+"</div><div class=\"sub\">"+escHtml(c.sub)+"</div></div>";});
  var fcg=document.getElementById("forensic-cards");if(fcg&&fcg.innerHTML!==fch)fcg.innerHTML=fch;
  
  // --- Charts ---
  var labels = days.map(function(d){return d.date.slice(5)});
  var mainScope = getMainChartsScope();
  var hourlyMode = mainScope === "hourly";
  var hourLabs = buildHourlyAxisLabels();
  var dayForHourly = selDay;
  var fhForMainCharts = getForensicHostFilterForCharts();
  var mainHostKey =
    multiHost && fhForMainCharts && hLabs.indexOf(fhForMainCharts) >= 0 ? fhForMainCharts : "";
  var c4TimelineHostStack = multiHost && !mainHostKey;
  destroyMainChartIfScopeMismatch(mainScope, "c1");
  destroyMainChartIfScopeMismatch(mainScope, "c2");
  destroyMainChartIfScopeMismatch(mainScope, "c3");
  destroyMainChartIfScopeMismatch(mainScope, "c4");
  if (_charts.c1hosts && _charts.c1hosts._dashScope !== mainScope) {
    try {
      _charts.c1hosts.destroy();
    } catch (eHs) {}
    _charts.c1hosts = null;
  }
  window.__usageVersionDayIndices = [];
  for (var uxi = 0; uxi < days.length; uxi++) {
    if (days[uxi].version_change) window.__usageVersionDayIndices.push(uxi);
  }

  // Haupt-Chart-Boxen stehen in tpl/dashboard.html (c1–c4); nur Host-Box ggf. einfügen.
  (function reorderChartBoxes(){
    var cr = document.getElementById("charts");
    var pair = document.getElementById("charts-host-sub");
    if (!cr || !pair) return;
    var c1b = document.getElementById("c1") && document.getElementById("c1").closest(".chart-box");
    var c2b = document.getElementById("c2") && document.getElementById("c2").closest(".chart-box");
    var c3b = document.getElementById("c3") && document.getElementById("c3").closest(".chart-box");
    var hb = document.getElementById("chart-host-wrap");
    var c4b = document.getElementById("c4") && document.getElementById("c4").closest(".chart-box");
    if (c1b) cr.appendChild(c1b);
    if (c2b) cr.appendChild(c2b);
    if (hb) pair.appendChild(hb);
    if (c3b) pair.appendChild(c3b);
    if (c4b) pair.appendChild(c4b);
  })();
  
  var elc1 = document.getElementById("c1");
  if (elc1 && elc1.previousElementSibling && elc1.previousElementSibling.tagName === "H3") {
    elc1.previousElementSibling.textContent = hourlyMode
      ? t("chartDailyTokenHourly") + " (" + pick + ")"
      : t("chartDailyToken");
  }
  var elc2 = document.getElementById("c2");
  if (elc2 && elc2.previousElementSibling && elc2.previousElementSibling.tagName === "H3") {
    elc2.previousElementSibling.textContent = hourlyMode ? t("chartCacheRatioHourly") : t("chartCacheRatio");
  }

  var c1Reuse = false;
  if (hourlyMode) {
    c1Reuse =
      _charts.c1 &&
      _charts.c1.data.datasets.length === 3 &&
      _charts.c1.data.datasets[0].label === t("chartDS_cacheRead") &&
      chartXLabelsMatch(_charts.c1, hourLabs);
    if (c1Reuse) {
      _charts.c1.options.transitions = __mainChartTransitions;
      _charts.c1.options.resizeDelay = 200;
      _charts.c1.data.labels = hourLabs.slice();
      var c1dh = _charts.c1.data.datasets;
      c1dh[0].data = estimatedFieldPerHourHost(dayForHourly, mainHostKey, "cache_read");
      c1dh[1].data = estimatedFieldPerHourHost(dayForHourly, mainHostKey, "output");
      c1dh[2].data = estimatedFieldPerHourHost(dayForHourly, mainHostKey, "cache_creation");
      _charts.c1.update("none");
    } else {
      if (_charts.c1) {
        try {
          _charts.c1.destroy();
        } catch (eC1h) {}
        _charts.c1 = null;
      }
      _charts.c1 = new Chart(elc1, {
        type: "bar",
        data: {
          labels: hourLabs,
          datasets: [
            {
              label: t("chartDS_cacheRead"),
              data: estimatedFieldPerHourHost(dayForHourly, mainHostKey, "cache_read"),
              backgroundColor: "rgba(139,92,246,0.7)",
              stack: "tok",
              yAxisID: "y"
            },
            {
              label: t("chartDS_output"),
              data: estimatedFieldPerHourHost(dayForHourly, mainHostKey, "output"),
              backgroundColor: "rgba(59,130,246,0.9)",
              stack: "tok",
              yAxisID: "y"
            },
            {
              label: t("chartDS_cacheCreate"),
              data: estimatedFieldPerHourHost(dayForHourly, mainHostKey, "cache_creation"),
              backgroundColor: "rgba(6,182,212,0.5)",
              stack: "tok",
              yAxisID: "y"
            }
          ]
        },
        options: {
          responsive: true,
          resizeDelay: 200,
          animation: false,
          transitions: __mainChartTransitions,
          interaction: { mode: "index", intersect: false },
          scales: {
            x: { stacked: true, grid: { color: "rgba(51,65,85,0.5)" } },
            y: {
              stacked: true,
              position: "left",
              ticks: { callback: function (v) { return fmt(v); } },
              grid: { color: "rgba(51,65,85,0.5)" },
              title: { display: true, text: t("unifiedAxisTokens"), color: "#94a3b8" }
            }
          },
          plugins: {
            legend: { labels: { color: "#cbd5e1" } },
            tooltip: {
              callbacks: {
                label: function (c) { return c.dataset.label + ": " + fmt(c.raw); },
                footer: function () {
                  return (
                    t("chartTooltipHourlyTokenEst") +
                    " | C:O " +
                    String(dayForHourly.cache_output_ratio || 0) +
                    "x (" +
                    dayForHourly.date +
                    ")"
                  );
                }
              }
            }
          }
        }
      });
    }
  } else {
    c1Reuse =
      _charts.c1 &&
      _charts.c1.data.datasets.length === 3 &&
      _charts.c1.data.datasets[0].label === t("chartDS_cacheRead") &&
      (chartXLabelsMatch(_charts.c1, labels) || chartLabelsPrefixMatch(_charts.c1, labels));
    if (c1Reuse) {
      _charts.c1.options.transitions = __mainChartTransitions;
      _charts.c1.options.resizeDelay = 200;
      _charts.c1.data.labels = labels.slice();
      var c1d = _charts.c1.data.datasets;
      c1d[0].data = days.map(function (d) { return dayNumericForMainCharts(d, mainHostKey, "cache_read"); });
      c1d[1].data = days.map(function (d) { return dayNumericForMainCharts(d, mainHostKey, "output"); });
      c1d[2].data = days.map(function (d) { return dayNumericForMainCharts(d, mainHostKey, "cache_creation"); });
      _charts.c1.update("none");
    } else {
      if (_charts.c1) {
        try {
          _charts.c1.destroy();
        } catch (eC1) {}
        _charts.c1 = null;
      }
      _charts.c1 = new Chart(elc1, {
        type: "bar",
        data: {
          labels: labels,
          datasets: [
            {
              label: t("chartDS_cacheRead"),
              data: days.map(function (d) { return dayNumericForMainCharts(d, mainHostKey, "cache_read"); }),
              backgroundColor: "rgba(139,92,246,0.7)",
              stack: "tok",
              yAxisID: "y"
            },
            {
              label: t("chartDS_output"),
              data: days.map(function (d) { return dayNumericForMainCharts(d, mainHostKey, "output"); }),
              backgroundColor: "rgba(59,130,246,0.9)",
              stack: "tok",
              yAxisID: "y"
            },
            {
              label: t("chartDS_cacheCreate"),
              data: days.map(function (d) { return dayNumericForMainCharts(d, mainHostKey, "cache_creation"); }),
              backgroundColor: "rgba(6,182,212,0.5)",
              stack: "tok",
              yAxisID: "y"
            }
          ]
        },
        options: {
          responsive: true,
          resizeDelay: 200,
          animation: false,
          transitions: __mainChartTransitions,
          interaction: { mode: "index", intersect: false },
          scales: {
            x: { stacked: true, grid: { color: "rgba(51,65,85,0.5)" } },
            y: { stacked: true, position: "left", ticks: { callback: function (v) { return fmt(v); } }, grid: { color: "rgba(51,65,85,0.5)" }, title: { display: true, text: t("unifiedAxisTokens"), color: "#94a3b8" } }
          },
          plugins: {
            legend: { labels: { color: "#cbd5e1" } },
            tooltip: {
              callbacks: {
                label: function (c) { return c.dataset.label + ": " + fmt(c.raw); },
                footer: function (items) {
                  if (!items.length) return "";
                  var di = items[0].dataIndex;
                  return tr("chartTooltipCoDay", { ratio: String(dayRatioCacheOutForMainCharts(days[di], mainHostKey)) });
                }
              }
            }
          }
        }
      });
    }
  }
  if (_charts.c1) _charts.c1._dashScope = mainScope;

  var hostBarColors = ["rgba(59,130,246,0.88)","rgba(167,139,250,0.88)","rgba(52,211,153,0.88)","rgba(251,191,36,0.88)","rgba(249,115,22,0.88)","rgba(236,72,153,0.88)"];
  if (multiHost && !hourlyMode && !mainHostKey) {
    if (!document.getElementById("c1-hosts")) {
      var ch1h = document.createElement("div");
      ch1h.className = "chart-box";
      ch1h.id = "chart-host-wrap";
      ch1h.innerHTML = "<h3></h3><p style=\"font-size:.72rem;color:#94a3b8;margin:4px 0 10px;line-height:1.4\"></p><canvas id=\"c1-hosts\"></canvas>";
      var pairIns = document.getElementById("charts-host-sub");
      if (pairIns) {
        if (pairIns.firstChild) pairIns.insertBefore(ch1h, pairIns.firstChild);
        else pairIns.appendChild(ch1h);
      }
    }
    var pairBar = document.getElementById("charts-host-sub");
    if (pairBar) pairBar.classList.remove("no-host-chart");
    var chw = document.getElementById("chart-host-wrap");
    if (chw) {
      chw.style.display = "";
      var h3h = chw.querySelector("h3");
      var ph = chw.querySelector("p");
      if (h3h) h3h.textContent = t("chartHostTitle");
      if (ph) ph.textContent = t("chartHostBlurb");
    }
    var dsH = [];
    for (var hli = 0; hli < hLabs.length; hli++) {
      var lb0 = hLabs[hli];
      dsH.push({label: lb0,data: days.map(function(d){ var x = d.hosts && d.hosts[lb0]; return x ? (x.total || 0) : 0;}),backgroundColor: hostBarColors[hli % hostBarColors.length],stack: "h"});
    }
    var c1hReuse =
      _charts.c1hosts &&
      _charts.c1hosts.data.datasets.length === hLabs.length &&
      (chartXLabelsMatch(_charts.c1hosts, labels) || chartLabelsPrefixMatch(_charts.c1hosts, labels));
    if (c1hReuse) {
      for (var hci = 0; hci < hLabs.length; hci++) {
        if (_charts.c1hosts.data.datasets[hci].label !== hLabs[hci]) {
          c1hReuse = false;
          break;
        }
      }
    }
    if (c1hReuse) {
      _charts.c1hosts.options.transitions = __mainChartTransitions;
      _charts.c1hosts.options.resizeDelay = 200;
      _charts.c1hosts.data.labels = labels.slice();
      for (var hliU = 0; hliU < hLabs.length; hliU++) {
        var lbU = hLabs[hliU];
        _charts.c1hosts.data.datasets[hliU].data = days.map(function (d) {
          var x = d.hosts && d.hosts[lbU];
          return x ? (x.total || 0) : 0;
        });
      }
      _charts.c1hosts.update("none");
    } else {
      if (_charts.c1hosts) {
        try { _charts.c1hosts.destroy(); } catch (e1h) {}
        _charts.c1hosts = null;
      }
      _charts.c1hosts = new Chart(document.getElementById("c1-hosts"), {
        type: "bar",
        data: { labels: labels, datasets: dsH },
        options: {
          responsive: true,
          resizeDelay: 200,
          animation: false,
          transitions: __mainChartTransitions,
          scales: {
            x: { stacked: true, grid: { color: "rgba(51,65,85,0.5)" } },
            y: { stacked: true, ticks: { callback: function (v) { return fmt(v); } }, grid: { color: "rgba(51,65,85,0.5)" } }
          },
          plugins: {
            legend: { labels: { color: "#cbd5e1" } },
            tooltip: {
              callbacks: {
                label: function (c) { return c.dataset.label + ": " + fmt(c.parsed.y); },
                footer: function (tipItems) {
                  if (!tipItems.length) return "";
                  var di = tipItems[0].dataIndex;
                  var segs = [];
                  for (var ci = 0; ci < tipItems.length; ci++) {
                    var L = tipItems[ci].dataset.label;
                    var hh = days[di].hosts && days[di].hosts[L];
                    if (hh) segs.push(tr("chartTooltipCoHostLine", { host: L, ratio: String(hh.cache_output_ratio) }));
                  }
                  var s = 0;
                  for (var fi = 0; fi < tipItems.length; fi++) s += tipItems[fi].parsed.y || 0;
                  return (segs.length ? segs.join(" · ") + " | " : "") + t("hostStackFooter") + fmt(s);
                }
              }
            }
          }
        }
      });
    }
    if (_charts.c1hosts) _charts.c1hosts._dashScope = mainScope;
  } else {
    if (_charts.c1hosts) {
      try { _charts.c1hosts.destroy(); } catch (eH0) {}
      _charts.c1hosts = null;
    }
    var chw2 = document.getElementById("chart-host-wrap");
    if (chw2) chw2.style.display = "none";
    var pairBar2 = document.getElementById("charts-host-sub");
    if (pairBar2) pairBar2.classList.add("no-host-chart");
  }

  var c2Reuse = false;
  if (hourlyMode) {
    c2Reuse =
      _charts.c2 &&
      _charts.c2.data.datasets.length === 1 &&
      _charts.c2.data.datasets[0].label === t("chartLineCacheOut") &&
      chartXLabelsMatch(_charts.c2, hourLabs);
    if (c2Reuse) {
      _charts.c2.options.transitions = __mainChartTransitions;
      _charts.c2.options.resizeDelay = 200;
      _charts.c2.data.labels = hourLabs.slice();
      _charts.c2.data.datasets[0].data = hourlyCacheOutRatioEstHost(dayForHourly, mainHostKey);
      _charts.c2.update("none");
    } else {
      if (_charts.c2) {
        try {
          _charts.c2.destroy();
        } catch (eC2h) {}
        _charts.c2 = null;
      }
      _charts.c2 = new Chart(elc2, {
        type: "line",
        data: {
          labels: hourLabs,
          datasets: [
            {
              label: t("chartLineCacheOut"),
              data: hourlyCacheOutRatioEstHost(dayForHourly, mainHostKey),
              borderColor: "#f59e0b",
              backgroundColor: "rgba(245,158,11,0.1)",
              fill: true,
              tension: 0.3
            }
          ]
        },
        options: {
          responsive: true,
          resizeDelay: 200,
          animation: false,
          transitions: __mainChartTransitions,
          scales: { y: { beginAtZero: true } },
          plugins: {
            tooltip: {
              callbacks: {
                label: function (c) { return c.raw + "x"; },
                footer: function () {
                  return t("chartTooltipHourlyTokenEst");
                }
              }
            }
          }
        }
      });
    }
  } else {
    c2Reuse =
      _charts.c2 &&
      _charts.c2.data.datasets.length === 1 &&
      _charts.c2.data.datasets[0].label === t("chartLineCacheOut") &&
      (chartXLabelsMatch(_charts.c2, labels) || chartLabelsPrefixMatch(_charts.c2, labels));
    if (c2Reuse) {
      _charts.c2.options.transitions = __mainChartTransitions;
      _charts.c2.options.resizeDelay = 200;
      _charts.c2.data.labels = labels.slice();
      _charts.c2.data.datasets[0].data = days.map(function (d) { return dayRatioCacheOutForMainCharts(d, mainHostKey); });
      _charts.c2.update("none");
    } else {
      if (_charts.c2) {
        try {
          _charts.c2.destroy();
        } catch (eC2) {}
        _charts.c2 = null;
      }
      _charts.c2 = new Chart(elc2, {
        type: "line",
        data: {
          labels: labels,
          datasets: [
            {
              label: t("chartLineCacheOut"),
              data: days.map(function (d) { return dayRatioCacheOutForMainCharts(d, mainHostKey); }),
              borderColor: "#f59e0b",
              backgroundColor: "rgba(245,158,11,0.1)",
              fill: true,
              tension: 0.3
            }
          ]
        },
        options: {
          responsive: true,
          resizeDelay: 200,
          animation: false,
          transitions: __mainChartTransitions,
          scales: { y: { beginAtZero: true } },
          plugins: {
            tooltip: {
              callbacks: {
                label: function (c) { return c.raw + "x"; },
                footer: function (items) {
                  if (!items.length) return "";
                  var di = items[0].dataIndex;
                  var d = days[di];
                  if (mainHostKey && d.hosts && d.hosts[mainHostKey]) {
                    var hh = d.hosts[mainHostKey];
                    return tr("chartTooltipOutCacheDay", { out: fmt(hh.output), cache: fmt(hh.cache_read) });
                  }
                  return tr("chartTooltipOutCacheDay", { out: fmt(d.output), cache: fmt(d.cache_read) });
                }
              }
            }
          }
        }
      });
    }
  }
  if (_charts.c2) _charts.c2._dashScope = mainScope;

  var elc3 = document.getElementById("c3");
  if (elc3 && elc3.previousElementSibling && elc3.previousElementSibling.tagName === "H3") {
    elc3.previousElementSibling.textContent = hourlyMode ? t("chartOutPerHourHourly") : t("chartOutPerHour");
  }
  var elc4 = document.getElementById("c4");
  if (elc4 && elc4.previousElementSibling && elc4.previousElementSibling.tagName === "H3") {
    elc4.previousElementSibling.textContent = hourlyMode ? t("chartSubCachePctHourly") : t("chartSubCachePct");
  }

  var c3Reuse = false;
  if (hourlyMode) {
    var hwC = mainHostKey
      ? dayHourCallWeights({
          hours:
            (dayForHourly.hosts &&
              dayForHourly.hosts[mainHostKey] &&
              dayForHourly.hosts[mainHostKey].hours) ||
            {},
          calls:
            dayForHourly.hosts &&
            dayForHourly.hosts[mainHostKey] &&
            dayForHourly.hosts[mainHostKey].calls != null
              ? dayForHourly.hosts[mainHostKey].calls
              : dayForHourly.calls || 0
        })
      : dayHourCallWeights(dayForHourly);
    c3Reuse =
      _charts.c3 &&
      _charts.c3.data.datasets.length === 1 &&
      _charts.c3.data.datasets[0].label === t("chartHourlyApiEventsLabel") &&
      chartXLabelsMatch(_charts.c3, hourLabs);
    if (c3Reuse) {
      _charts.c3.options.transitions = __mainChartTransitions;
      _charts.c3.options.resizeDelay = 200;
      _charts.c3.data.labels = hourLabs.slice();
      _charts.c3.data.datasets[0].data = hwC.w.slice();
      _charts.c3.update("none");
    } else {
      if (_charts.c3) {
        try {
          _charts.c3.destroy();
        } catch (eC3h) {}
        _charts.c3 = null;
      }
      _charts.c3 = new Chart(elc3, {
        type: "bar",
        data: {
          labels: hourLabs,
          datasets: [
            {
              label: t("chartHourlyApiEventsLabel"),
              data: hwC.w.slice(),
              backgroundColor: "rgba(34,197,94,0.7)"
            }
          ]
        },
        options: {
          responsive: true,
          resizeDelay: 200,
          animation: false,
          transitions: __mainChartTransitions,
          scales: {
            y: { beginAtZero: true, ticks: { callback: function (v) { return fmt(v); } } }
          },
          plugins: { tooltip: { callbacks: { label: function (c) { return fmt(c.raw) + "/h"; } } } }
        }
      });
    }
  } else {
    c3Reuse =
      _charts.c3 &&
      _charts.c3.data.datasets.length === 1 &&
      _charts.c3.data.datasets[0].label === t("chartOutPerHLabel") &&
      (chartXLabelsMatch(_charts.c3, labels) || chartLabelsPrefixMatch(_charts.c3, labels));
    if (c3Reuse) {
      _charts.c3.options.transitions = __mainChartTransitions;
      _charts.c3.options.resizeDelay = 200;
      _charts.c3.data.labels = labels.slice();
      _charts.c3.data.datasets[0].data = days.map(function (d) { return dayOutputPerHourForMainCharts(d, mainHostKey); });
      _charts.c3.update("none");
    } else {
      if (_charts.c3) {
        try {
          _charts.c3.destroy();
        } catch (eC3) {}
        _charts.c3 = null;
      }
      _charts.c3 = new Chart(elc3, {
        type: "bar",
        data: {
          labels: labels,
          datasets: [
            {
              label: t("chartOutPerHLabel"),
              data: days.map(function (d) { return dayOutputPerHourForMainCharts(d, mainHostKey); }),
              backgroundColor: "rgba(34,197,94,0.7)"
            }
          ]
        },
        options: {
          responsive: true,
          resizeDelay: 200,
          animation: false,
          transitions: __mainChartTransitions,
          scales: { y: { ticks: { callback: function (v) { return fmt(v); } } } },
          plugins: { tooltip: { callbacks: { label: function (c) { return fmt(c.raw) + "/h"; } } } }
        }
      });
    }
  }
  if (_charts.c3) _charts.c3._dashScope = mainScope;

  if (hourlyMode) {
    var c4Rh =
      _charts.c4 &&
      _charts.c4.data.datasets.length === 4 &&
      _charts.c4.data.datasets[0].label === t("forensicDS_continueStack") &&
      chartXLabelsMatch(_charts.c4, hourLabs);
    if (c4Rh) {
      _charts.c4.options.transitions = __mainChartTransitions;
      _charts.c4.options.resizeDelay = 200;
      _charts.c4.data.labels = hourLabs.slice();
      var d4h = _charts.c4.data.datasets;
      d4h[0].data = hourSignalsArrayForHost(dayForHourly, mainHostKey, "continue");
      d4h[1].data = hourSignalsArrayForHost(dayForHourly, mainHostKey, "resume");
      d4h[2].data = hourSignalsArrayForHost(dayForHourly, mainHostKey, "retry");
      d4h[3].data = hourSignalsArrayForHost(dayForHourly, mainHostKey, "interrupt");
      _charts.c4.update("none");
    } else {
      if (_charts.c4) {
        try {
          _charts.c4.destroy();
        } catch (eC4h) {}
        _charts.c4 = null;
      }
      _charts.c4 = new Chart(elc4, {
        type: "bar",
        data: {
          labels: hourLabs,
          datasets: [
            {
              label: t("forensicDS_continueStack"),
              data: hourSignalsArrayForHost(dayForHourly, mainHostKey, "continue"),
              backgroundColor: "rgba(59,130,246,0.75)",
              stack: "hsig"
            },
            {
              label: t("forensicDS_resumeStack"),
              data: hourSignalsArrayForHost(dayForHourly, mainHostKey, "resume"),
              backgroundColor: "rgba(6,182,212,0.7)",
              stack: "hsig"
            },
            {
              label: t("forensicDS_retryStack"),
              data: hourSignalsArrayForHost(dayForHourly, mainHostKey, "retry"),
              backgroundColor: "rgba(239,68,68,0.65)",
              stack: "hsig"
            },
            {
              label: t("forensicDS_interruptStack"),
              data: hourSignalsArrayForHost(dayForHourly, mainHostKey, "interrupt"),
              backgroundColor: "rgba(251,191,36,0.55)",
              stack: "hsig"
            }
          ]
        },
        options: {
          responsive: true,
          resizeDelay: 200,
          animation: false,
          transitions: __mainChartTransitions,
          scales: {
            x: { stacked: true, grid: { color: "rgba(51,65,85,0.5)" } },
            y: { stacked: true, beginAtZero: true, ticks: { precision: 0 }, grid: { color: "rgba(51,65,85,0.5)" } }
          },
          plugins: {
            legend: { labels: { color: "#cbd5e1", boxWidth: 12 } },
            tooltip: {
              callbacks: {
                label: function (c) {
                  return c.dataset.label + ": " + c.raw;
                }
              }
            }
          }
        }
      });
    }
    if (_charts.c4) _charts.c4._dashScope = mainScope;
  } else {
    var c4Reuse = false;
    if (c4TimelineHostStack) {
      c4Reuse =
        _charts.c4 &&
        _charts.c4.data.datasets.length === hLabs.length &&
        _charts.c4.data.datasets[0] &&
        _charts.c4.data.datasets[0].stack === "subcache" &&
        (chartXLabelsMatch(_charts.c4, labels) || chartLabelsPrefixMatch(_charts.c4, labels));
      if (c4Reuse) {
        for (var c4j = 0; c4j < hLabs.length; c4j++) {
          if (_charts.c4.data.datasets[c4j].label !== hLabs[c4j]) {
            c4Reuse = false;
            break;
          }
        }
      }
    } else {
      c4Reuse =
        _charts.c4 &&
        _charts.c4.data.datasets.length === 1 &&
        _charts.c4.data.datasets[0].label === t("chartSubCachePct") &&
        !_charts.c4.data.datasets[0].stack &&
        (chartXLabelsMatch(_charts.c4, labels) || chartLabelsPrefixMatch(_charts.c4, labels));
    }

    if (c4Reuse) {
      _charts.c4.options.transitions = __mainChartTransitions;
      _charts.c4.options.resizeDelay = 200;
      _charts.c4.data.labels = labels.slice();
      if (c4TimelineHostStack) {
        for (var c4k = 0; c4k < hLabs.length; c4k++) {
          var lbC = hLabs[c4k];
          _charts.c4.data.datasets[c4k].data = days.map(function (d) {
            var cr = d.cache_read || 0;
            var x = d.hosts && d.hosts[lbC];
            if (!x || cr <= 0) return 0;
            return Math.round(((x.sub_cache || 0) / cr) * 100);
          });
        }
      } else {
        var dsC0 = _charts.c4.data.datasets[0];
        dsC0.data = days.map(function (d) { return subCachePctForDayMainCharts(d, mainHostKey); });
        dsC0.backgroundColor = days.map(function (d) {
          var p = subCachePctForDayMainCharts(d, mainHostKey);
          return p > 50 ? "rgba(239,68,68,0.7)" : "rgba(100,116,139,0.5)";
        });
      }
      _charts.c4.update("none");
    } else {
      if (_charts.c4) {
        try { _charts.c4.destroy(); } catch (eC4) {}
        _charts.c4 = null;
      }
      var c4Data;
      var c4Opts;
      if (c4TimelineHostStack) {
      var ds4 = [];
      for (var c4i = 0; c4i < hLabs.length; c4i++) {
        var lb4 = hLabs[c4i];
        ds4.push({
          label: lb4,
          stack: "subcache",
          data: days.map(function (d) {
            var cr = d.cache_read || 0;
            var x = d.hosts && d.hosts[lb4];
            if (!x || cr <= 0) return 0;
            return Math.round(((x.sub_cache || 0) / cr) * 100);
          }),
          backgroundColor: hostBarColors[c4i % hostBarColors.length]
        });
      }
      c4Data = { labels: labels, datasets: ds4 };
      c4Opts = {
        responsive: true,
        resizeDelay: 200,
        animation: false,
        transitions: __mainChartTransitions,
        scales: {
          x: { stacked: true, grid: { color: "rgba(51,65,85,0.5)" } },
          y: { max: 100, stacked: true, ticks: { callback: function (v) { return v + "%"; } }, grid: { color: "rgba(51,65,85,0.5)" } }
        },
        plugins: {
          legend: { labels: { color: "#cbd5e1" } },
          tooltip: {
            callbacks: {
              label: function (c) {
                return c.dataset.label + ": " + c.raw + "% " + t("chartTooltipSubCacheOfDay");
              },
              footer: function (items) {
                if (!items.length) return "";
                var di = items[0].dataIndex;
                return tr("chartTooltipSubCacheStackTotal", { pct: String(days[di].sub_cache_pct) });
              }
            }
          }
        }
      };
    } else {
      c4Data = {
        labels: labels,
        datasets: [
          {
            label: t("chartSubCachePct"),
            data: days.map(function (d) { return subCachePctForDayMainCharts(d, mainHostKey); }),
            backgroundColor: days.map(function (d) {
              var p = subCachePctForDayMainCharts(d, mainHostKey);
              return p > 50 ? "rgba(239,68,68,0.7)" : "rgba(100,116,139,0.5)";
            })
          }
        ]
      };
      c4Opts = {
        responsive: true,
        resizeDelay: 200,
        animation: false,
        transitions: __mainChartTransitions,
        scales: { y: { max: 100, ticks: { callback: function (v) { return v + "%"; } } } },
        plugins: { tooltip: { callbacks: { label: function (c) { return c.raw + "%"; } } } }
      };
      }
      _charts.c4 = new Chart(elc4, { type: "bar", data: c4Data, options: c4Opts });
    }
    if (_charts.c4) _charts.c4._dashScope = mainScope;
  }
  var crSig = document.getElementById("charts");
  if (crSig) crSig.classList.remove("has-session-row");
  
  var tblDeleg = document.getElementById("tbl");
  if (tblDeleg && !tblDeleg.dataset.hostDetailDeleg) {
    tblDeleg.dataset.hostDetailDeleg = "1";
    tblDeleg.addEventListener("click", function (ev) {
      var tr = ev.target.closest("tr");
      if (!tr || !tr.dataset.detailRow) return;
      if (tr.dataset.detailRow === "host" && tr.dataset.hostLabel) {
        window.__usageDetailHost = tr.dataset.hostLabel;
        if (__lastUsageData) renderDashboard(__lastUsageData, true);
      } else if (tr.dataset.detailRow === "filtered") {
        window.__usageDetailHost = null;
        if (__lastUsageData) renderDashboard(__lastUsageData, true);
      }
    });
  }
  
  // --- Table ---
  var cols=t("tableCols").split("|");
  var thead=document.querySelector("#tbl thead tr");
  thead.innerHTML="";
  cols.forEach(function(c,ci){var th=document.createElement("th");th.textContent=c;if(ci>0)th.className="num";thead.appendChild(th);});
  
  var tbody=document.querySelector("#tbl tbody");
  tbody.innerHTML="";
  var filteredHost = window.__usageDetailHost;
  var fhDay = filteredHost && selDay.hosts && selDay.hosts[filteredHost] ? selDay.hosts[filteredHost] : null;
  var tableRows = fhDay
    ? [{
        date: pick,
        output: fhDay.output,
        cache_read: fhDay.cache_read,
        cache_output_ratio: fhDay.cache_output_ratio,
        overhead: fhDay.overhead,
        total: fhDay.total,
        calls: fhDay.calls,
        active_hours: fhDay.active_hours,
        hit_limit: fhDay.hit_limit || 0,
        sub_pct: fhDay.sub_pct,
        sub_cache_pct: fhDay.sub_cache_pct,
        output_per_hour: fhDay.output_per_hour
      }]
    : [selDay];
  for(var i=0;i<tableRows.length;i++){
    var d=tableRows[i];
    var trEl=document.createElement("tr");
    if (fhDay) {
      trEl.dataset.detailRow = "filtered";
      trEl.style.cursor = "pointer";
      trEl.title = t("dailyDetailFilteredRowTitle");
    }
    var hl=d.hit_limit||0;
    var vals=[d.date,fmt(d.output),fmt(d.cache_read),d.cache_output_ratio+"x",d.overhead+"x",fmt(d.total),d.calls,d.active_hours,String(hl),d.sub_pct+"%",d.sub_cache_pct+"%",fmt(d.output_per_hour)];
    vals.forEach(function(v,j){
      var td=document.createElement("td");
      td.textContent=v;
      if(j>0)td.className="num";
      if(j===3&&d.cache_output_ratio>1000)td.classList.add("hi");
      if(j===3&&d.cache_output_ratio>2000)td.classList.add("crit");
      if(j===4&&d.overhead>1500)td.classList.add("hi");
      if(j===8&&hl>0)td.classList.add("hi");
      trEl.appendChild(td);
    });
    tbody.appendChild(trEl);
    if (!fhDay && multiHost && selDay.hosts) {
      for (var ti = 0; ti < hLabs.length; ti++) {
        var tlab = hLabs[ti];
        var hd = selDay.hosts[tlab];
        if (!hd) continue;
        var trh = document.createElement("tr");
        trh.style.color = "#94a3b8";
        trh.style.cursor = "pointer";
        trh.title = t("dailyDetailHostRowTitle");
        trh.dataset.detailRow = "host";
        trh.dataset.hostLabel = tlab;
        var hhl = hd.hit_limit || 0;
        var hvals = ["  └ " + tlab, fmt(hd.output), fmt(hd.cache_read), hd.cache_output_ratio + "x", hd.overhead + "x", fmt(hd.total), hd.calls, hd.active_hours, String(hhl), hd.sub_pct + "%", hd.sub_cache_pct + "%", fmt(hd.output_per_hour)];
        for (var hj = 0; hj < hvals.length; hj++) {
          var tdh = document.createElement("td");
          tdh.textContent = hvals[hj];
          if (hj > 0) tdh.className = "num";
          if (hj === 8 && hhl > 0) tdh.classList.add("hi");
          trh.appendChild(tdh);
        }
        tbody.appendChild(trh);
      }
    }
  }
  
  /** Während Scan: SSE feuert oft → Chart.update flimmert. Pro Chart separat drosseln (Service nicht an Forensic koppeln). */
  var spForensic = data.scan_progress;
  var scanInProgForensic =
    data.scanning && spForensic && spForensic.total > 0 && spForensic.done < spForensic.total;
  var nowForensic = Date.now();
  var fsUntilMs = window.__dashForensicSvcPaintUntilMs || 0;
  var inFsThrottleWindow = scanInProgForensic && nowForensic < fsUntilMs;
  var skipForensicPaint = inFsThrottleWindow && !!_charts.cForensic && !!_charts.cForensicSignals;
  var skipServicePaint = inFsThrottleWindow && !!_charts.cService;
  if (!skipForensicPaint || !skipServicePaint) {
    if (scanInProgForensic) window.__dashForensicSvcPaintUntilMs = nowForensic + 3500;
    else window.__dashForensicSvcPaintUntilMs = 0;
  }

  // ─── Forensic Chart (Original: Hit-Limit Bars + Score Line) ───
  var fhForensic = getForensicHostFilterForCharts();
  function hitLimitBarForChart(d) {
    if (!fhForensic) return d.hit_limit || 0;
    var H = d.hosts && d.hosts[fhForensic];
    return H ? H.hit_limit || 0 : 0;
  }
  function forensicScoreDay(d) {
    return forensicScoreForChartDay(d, days, fhForensic);
  }
  var elF=document.getElementById("c-forensic");
  if(elF){
    try {
    if (!skipForensicPaint) {
    var forensicReuse =
      _charts.cForensic &&
      _charts.cForensic.data.datasets.length === 2 &&
      (chartXLabelsMatch(_charts.cForensic, labels) || chartLabelsPrefixMatch(_charts.cForensic, labels));
    if (forensicReuse) {
      freezeChartNoAnim(_charts.cForensic);
      _charts.cForensic.data.labels = labels.slice();
      var fh0 = _charts.cForensic.data.datasets[0];
      fh0.data = days.map(hitLimitBarForChart);
      fh0.backgroundColor = days.map(function (d) {
        return hitLimitBarForChart(d) > 0 ? "rgba(248,113,113,0.55)" : "rgba(71,85,105,0.35)";
      });
      fh0.borderColor = days.map(function (d) {
        return hitLimitBarForChart(d) > 0 ? "#f87171" : "transparent";
      });
      _charts.cForensic.data.datasets[1].data = days.map(forensicScoreDay);
      _charts.cForensic.data.datasets[1].hidden = !!fhForensic;
      if (_charts.cForensic.options.scales && _charts.cForensic.options.scales.y1) {
        _charts.cForensic.options.scales.y1.display = !fhForensic;
      }
      _charts.cForensic.update("none");
    } else {
      if (_charts.cForensic) {
        try {
          _charts.cForensic.destroy();
        } catch (e) {}
      }
      _charts.cForensic = new Chart(elF, {
      data:{
        labels:labels,
        datasets:[
          {
            type:"bar",
            stack:"hitlim",
            yAxisID:"y",
            label:t("forensicDS_hitLimit"),
            data:days.map(hitLimitBarForChart),
            backgroundColor:days.map(function(d){return hitLimitBarForChart(d)>0?"rgba(248,113,113,0.55)":"rgba(71,85,105,0.35)"}),
            borderColor:days.map(function(d){return hitLimitBarForChart(d)>0?"#f87171":"transparent"}),
            borderWidth:1
          },
          {
            type:"line",
            label:t("forensicDS_score"),
            hidden:!!fhForensic,
            data:days.map(forensicScoreDay),
            borderColor:"#f59e0b",
            backgroundColor:"rgba(245,158,11,0.12)",
            pointBackgroundColor:"#fbbf24",
            pointRadius:4,
            tension:0.25,
            yAxisID:"y1",
            borderWidth:2
          }
        ]
      },
      options:{
        responsive:true,
        resizeDelay:120,
        animation:false,
        transitions: __chartTransitionsOff,
        maintainAspectRatio:true,
        aspectRatio:2.4,
        interaction:{mode:"index",intersect:false},
        scales:{
          x:{stacked:true,grid:{color:"rgba(51,65,85,0.5)"}},
          y:{
            stacked:true,
            position:"left",
            beginAtZero:true,
            title:{display:true,text:t("forensicAxisCounts"),color:"#94a3b8"},
            ticks:{color:"#94a3b8",precision:0},
            grid:{color:"rgba(51,65,85,0.5)"}
          },
          y1:{
            display:!fhForensic,
            position:"right",
            min:0,max:3.5,
            title:{display:true,text:t("forensicAxisForensic"),color:"#fbbf24"},
            ticks:{stepSize:1,color:"#94a3b8"},
            grid:{drawOnChartArea:false}
          }
        },
        plugins:{
          legend:{labels:{color:"#cbd5e1"}},
          tooltip:{
            callbacks:{
              title:function(items){
                var dArr = (__lastUsageData && __lastUsageData.days) || [];
                return items.length && dArr[items[0].dataIndex] ? dArr[items[0].dataIndex].date : "";
              },
              afterBody:function(items){
                if(!items.length)return"";
                var di=items[0].dataIndex;
                var dArr = (__lastUsageData && __lastUsageData.days) || [];
                var x = dArr[di];
                if (!x) return "";
                var fh = getForensicHostFilterForCharts();
                var lines=[];
                if (fh) lines.push(tr("forensicTooltipHostHitScope",{host:fh}));
                lines.push(t("tooltipVsPeak")+(x.forensic_vs_peak>0?x.forensic_vs_peak+"×":"—"));
                lines.push(t("tooltipImpl90")+(x.forensic_implied_cap_90>0?fmt(x.forensic_implied_cap_90):"—"));
                if(x.forensic_hint)lines.push(x.forensic_hint);
                return lines;
              }
            }
          }
        }
      }
    });
    }
    }
    } finally {
      chartShellSetLoading("c-forensic", false);
    }
  }

  // ─── Forensic: Session-Signale gestapelt (Ausfall oben im Stack) + Cache Read (Linie, rechts) ───
  var elSig = document.getElementById("c-forensic-signals");
  if (elSig) {
    try {
      if (!skipForensicPaint) {
        var sigStack = buildSessionSignalsStackedByDay(days, fhForensic);
        var sigReuse =
          _charts.cForensicSignals &&
          _charts.cForensicSignals.data.datasets.length === 6 &&
          _charts.cForensicSignals.data.datasets[0].type === "bar" &&
          _charts.cForensicSignals.data.datasets[4].type === "bar" &&
          _charts.cForensicSignals.data.datasets[5].type === "line" &&
          (chartXLabelsMatch(_charts.cForensicSignals, labels) || chartLabelsPrefixMatch(_charts.cForensicSignals, labels));
        if (sigReuse) {
          freezeChartNoAnim(_charts.cForensicSignals);
          _charts.cForensicSignals.data.labels = labels.slice();
          _charts.cForensicSignals.data.datasets[0].data = sigStack.cont;
          _charts.cForensicSignals.data.datasets[1].data = sigStack.res;
          _charts.cForensicSignals.data.datasets[2].data = sigStack.retry;
          _charts.cForensicSignals.data.datasets[3].data = sigStack.intr;
          _charts.cForensicSignals.data.datasets[4].data = sigStack.outageBar;
          _charts.cForensicSignals.data.datasets[4].outageHoursPerDay = sigStack.outageH;
          _charts.cForensicSignals.data.datasets[5].data = sigStack.cacheRead;
          _charts.cForensicSignals.update("none");
        } else {
          if (_charts.cForensicSignals) {
            try {
              _charts.cForensicSignals.destroy();
            } catch (eFs) {}
          }
          _charts.cForensicSignals = new Chart(elSig, {
            data: {
              labels: labels.slice(),
              datasets: [
                {
                  type: "bar",
                  label: t("forensicDS_continueStack"),
                  stack: "sig",
                  yAxisID: "y",
                  order: 2,
                  data: sigStack.cont,
                  backgroundColor: "rgba(59,130,246,0.75)",
                  borderColor: "rgba(59,130,246,0.95)",
                  borderWidth: 1
                },
                {
                  type: "bar",
                  label: t("forensicDS_resumeStack"),
                  stack: "sig",
                  yAxisID: "y",
                  order: 2,
                  data: sigStack.res,
                  backgroundColor: "rgba(6,182,212,0.7)",
                  borderColor: "rgba(6,182,212,0.95)",
                  borderWidth: 1
                },
                {
                  type: "bar",
                  label: t("forensicDS_retryStack"),
                  stack: "sig",
                  yAxisID: "y",
                  order: 2,
                  data: sigStack.retry,
                  backgroundColor: "rgba(239,68,68,0.65)",
                  borderColor: "rgba(239,68,68,0.9)",
                  borderWidth: 1
                },
                {
                  type: "bar",
                  label: t("forensicDS_interruptStack"),
                  stack: "sig",
                  yAxisID: "y",
                  order: 2,
                  data: sigStack.intr,
                  backgroundColor: "rgba(251,191,36,0.55)",
                  borderColor: "rgba(251,191,36,0.9)",
                  borderWidth: 1
                },
                {
                  type: "bar",
                  label: t("forensicDS_outageHoursDay"),
                  stack: "sig",
                  yAxisID: "y",
                  order: 2,
                  data: sigStack.outageBar,
                  outageHoursPerDay: sigStack.outageH,
                  backgroundColor: "rgba(107,114,128,0.35)",
                  borderColor: "rgba(107,114,128,0.5)",
                  borderWidth: 1
                },
                {
                  type: "line",
                  label: t("chartDS_cacheRead"),
                  yAxisID: "y2",
                  order: 1,
                  data: sigStack.cacheRead,
                  borderColor: "rgba(139,92,246,0.95)",
                  backgroundColor: "rgba(139,92,246,0.06)",
                  pointBackgroundColor: "#8b5cf6",
                  pointRadius: 3,
                  tension: 0.2,
                  borderWidth: 2,
                  fill: false
                }
              ]
            },
            options: {
              responsive: true,
              resizeDelay: 280,
              animation: false,
              transitions: __chartTransitionsOff,
              maintainAspectRatio: true,
              aspectRatio: 2.4,
              interaction: { mode: "index", intersect: false },
              scales: {
                x: {
                  stacked: true,
                  grid: { color: "rgba(51,65,85,0.45)" },
                  ticks: { color: "#94a3b8", maxRotation: 45, autoSkip: true }
                },
                y: {
                  stacked: true,
                  position: "left",
                  beginAtZero: true,
                  title: { display: true, text: t("forensicSignalsAxisLines"), color: "#94a3b8" },
                  ticks: { color: "#94a3b8", precision: 0 },
                  grid: { color: "rgba(51,65,85,0.5)" }
                },
                y2: {
                  type: "linear",
                  position: "right",
                  beginAtZero: true,
                  title: { display: true, text: t("forensicSignalsAxisCacheRead"), color: "#a78bfa" },
                  ticks: {
                    color: "#a78bfa",
                    callback: function (value) {
                      return fmt(value);
                    }
                  },
                  grid: { drawOnChartArea: false }
                }
              },
              plugins: {
                legend: { labels: { color: "#cbd5e1", boxWidth: 12 } },
                tooltip: {
                  callbacks: {
                    title: function (items) {
                      var dArr = (__lastUsageData && __lastUsageData.days) || [];
                      var di = items.length ? items[0].dataIndex : -1;
                      return di >= 0 && dArr[di] ? dArr[di].date : "";
                    },
                    label: function (ctx) {
                      var v = ctx.parsed.y;
                      if (ctx.dataset.outageHoursPerDay && ctx.dataIndex != null) {
                        var oh = ctx.dataset.outageHoursPerDay[ctx.dataIndex];
                        var h = oh != null ? Math.round(Number(oh) * 10) / 10 : 0;
                        return ctx.dataset.label + ": " + h + " h";
                      }
                      if (ctx.dataset.yAxisID === "y2") {
                        return ctx.dataset.label + ": " + fmt(v);
                      }
                      return ctx.dataset.label + ": " + v;
                    },
                    afterBody: function (items) {
                      var lines = [t("forensicSignalsTooltipStackFooter")];
                      if (items && items.length) {
                        var di = items[0].dataIndex;
                        var dArr = (__lastUsageData && __lastUsageData.days) || [];
                        var row = di >= 0 ? dArr[di] : null;
                        var fhx = getForensicHostFilterForCharts();
                        if (fhx && row && row.hosts && row.hosts[fhx]) {
                          var hrow = row.hosts[fhx];
                          lines.push(
                            tr("chartTooltipOutCacheDay", {
                              out: fmt(hrow.output || 0),
                              cache: fmt(hrow.cache_read || 0)
                            })
                          );
                          lines.push(tr("chartTooltipCoDay", { ratio: hrow.cache_output_ratio || 0 }));
                        } else if (row && row.cache_output_ratio != null) {
                          lines.push(
                            tr("chartTooltipOutCacheDay", {
                              out: fmt(row.output || 0),
                              cache: fmt(row.cache_read || 0)
                            })
                          );
                          lines.push(tr("chartTooltipCoDay", { ratio: row.cache_output_ratio }));
                        }
                        if (fhx) lines.push(t("forensicSignalsTooltipOutageDayScope"));
                      }
                      return lines;
                    }
                  }
                }
              }
            }
          });
        }
      }
    } finally {
      chartShellSetLoading("c-forensic-signals", false);
    }
  }

  // ─── Service Impact Chart (Arbeitszeit vs Ausfall + Cache-Read-Kosten) ───
  var elS=document.getElementById("c-service");
  if(elS){
    try {
    if (!skipServicePaint) {
    // Berechne pro Tag: saubere Arbeitsstunden, betroffene Stunden, Ausfall ausserhalb Arbeit
    var sClean=[],sAffServer=[],sAffClient=[],sOutOnly=[],sCacheRead=[];
    for(var si=0;si<days.length;si++){
      var sd=days[si];
      var imp=sumServiceImpactForDay(sd);
      sClean.push(imp.cleanWork);
      sAffServer.push(imp.affSrv);
      sAffClient.push(imp.affCli);
      sOutOnly.push(imp.outOnly);
      sCacheRead.push(sd.cache_read||0);
    }
    window.__svcTip = { sClean: sClean, sAffServer: sAffServer, sAffClient: sAffClient, sOutOnly: sOutOnly, labels: labels };
    var svcReuse =
      _charts.cService &&
      _charts.cService.data.datasets.length === 5 &&
      _charts.cService.data.datasets[0].label === t("serviceDS_cleanWork") &&
      (chartXLabelsMatch(_charts.cService, labels) || chartLabelsPrefixMatch(_charts.cService, labels));
    if (svcReuse) {
      freezeChartNoAnim(_charts.cService);
      _charts.cService.options.resizeDelay = 280;
      _charts.cService.data.labels = labels.slice();
      var dss = _charts.cService.data.datasets;
      dss[0].data = sClean;
      dss[1].data = sAffServer;
      dss[2].data = sAffClient;
      dss[3].data = sOutOnly;
      dss[4].data = sCacheRead;
      _charts.cService.update("none");
    } else {
      if (_charts.cService) {
        try {
          _charts.cService.destroy();
        } catch (e) {}
      }
      _charts.cService = new Chart(elS, {
      data:{
        labels:labels,
        datasets:[
          {
            type:"bar",label:t("serviceDS_cleanWork"),
            order:2,
            data:sClean,
            backgroundColor:"rgba(59,130,246,0.7)",borderColor:"rgba(59,130,246,0.9)",borderWidth:1,
            stack:"hours",yAxisID:"y"
          },
          {
            type:"bar",label:t("serviceDS_affectedServer"),
            order:2,
            data:sAffServer,
            backgroundColor:"rgba(239,68,68,0.7)",borderColor:"rgba(239,68,68,0.9)",borderWidth:1,
            stack:"hours",yAxisID:"y"
          },
          {
            type:"bar",label:t("serviceDS_affectedClient"),
            order:2,
            data:sAffClient,
            backgroundColor:"rgba(251,191,36,0.6)",borderColor:"rgba(251,191,36,0.9)",borderWidth:1,
            stack:"hours",yAxisID:"y"
          },
          {
            type:"bar",label:t("serviceDS_outageOnly"),
            order:2,
            data:sOutOnly,
            backgroundColor:"rgba(107,114,128,0.35)",borderColor:"rgba(107,114,128,0.5)",borderWidth:1,
            stack:"hours",yAxisID:"y"
          },
          {
            type:"line",label:t("chartDS_cacheRead"),
            order:1,
            data:sCacheRead,
            borderColor:"rgba(139,92,246,0.8)",backgroundColor:"rgba(139,92,246,0.08)",
            pointBackgroundColor:"#8b5cf6",pointRadius:3,tension:0.25,borderWidth:2,
            yAxisID:"yCR",fill:true
          }
        ]
      },
      options:{
        responsive:true,animation:false,transitions:__chartTransitionsOff,maintainAspectRatio:true,aspectRatio:2.4,
        interaction:{mode:"index",intersect:false},
        scales:{
          x:{type:"category",stacked:true,grid:{color:"rgba(51,65,85,0.5)"}},
          y:{stacked:true,position:"left",beginAtZero:true,
            title:{display:true,text:t("serviceAxisHours"),color:"#94a3b8"},
            ticks:{color:"#94a3b8",stepSize:4,callback:function(v){return v+"h";}},
            grid:{color:"rgba(51,65,85,0.5)"}},
          yCR:{position:"right",beginAtZero:true,
            title:{display:true,text:t("chartDS_cacheRead"),color:"#8b5cf6"},
            ticks:{color:"#8b5cf6",callback:function(v){return fmt(v);}},
            grid:{drawOnChartArea:false}}
        },
        plugins:{
          legend:{labels:{color:"#cbd5e1"}},
          tooltip:{
            callbacks:{
              label:function(tooltipItem){
                var ds=tooltipItem.dataset;
                var di=tooltipItem.dataIndex;
                if(ds.type==="line")return ds.label+": "+fmt(tooltipItem.raw);
                return ds.label+": "+tooltipItem.parsed.y+"h";
              },
              title:function(items){
                if(!items.length)return"";
                var daysArr=(__lastUsageData&&__lastUsageData.days)||[];
                var snap=window.__svcTip||{};
                var lab=snap.labels;
                var rawT=items[0].raw;
                var diT=items[0].dataIndex;
                if(rawT&&typeof rawT==="object"&&typeof rawT.x==="string"){var ixT=lab?lab.indexOf(rawT.x):-1;if(ixT>=0)diT=ixT;}
                return daysArr[diT]?daysArr[diT].date:"";
              },
              afterBody:function(items){
                if(!items.length)return"";
                var daysArr=(__lastUsageData&&__lastUsageData.days)||[];
                var snap=window.__svcTip||{};
                var lab=snap.labels;
                var rawB=items[0].raw;
                var di=items[0].dataIndex;
                if(rawB&&typeof rawB==="object"&&typeof rawB.x==="string"){var ixB=lab?lab.indexOf(rawB.x):-1;if(ixB>=0)di=ixB;}
                var d=daysArr[di];
                if(!d)return"";
                var lines=[];
                lines.push(t("serviceDS_cleanWork")+": "+(snap.sClean&&snap.sClean[di]!=null?snap.sClean[di]:0)+"h");
                if((snap.sAffServer&&snap.sAffServer[di])>0)lines.push(t("serviceDS_affectedServer")+": "+snap.sAffServer[di]+"h");
                if((snap.sAffClient&&snap.sAffClient[di])>0)lines.push(t("serviceDS_affectedClient")+": "+snap.sAffClient[di]+"h");
                if((snap.sOutOnly&&snap.sOutOnly[di])>0)lines.push(t("serviceDS_outageOnly")+": "+snap.sOutOnly[di].toFixed(1)+"h");
                var ssX=d.session_signals||{};
                var sc=ssX.continue||0,sr=ssX.resume||0,sy=ssX.retry||0,si=ssX.interrupt||0;
                if(sc+sr+sy+si>0){
                  lines.push(t("serviceTooltipSessionSig")+": "+sc+" / "+sr+" / "+sy+" / "+si);
                  lines.push(t("serviceTooltipSessionSigHourNote"));
                }
                lines.push("Cache Read: "+fmt(d.cache_read||0)+" (C:O "+(d.cache_output_ratio||0)+"x)");
                lines.push(t("serviceTooltipSlideoutHint"));
                return lines;
              }
            }
          }
        }
      }
    });
    }
    }
    } finally {
      chartShellSetLoading("c-service", false);
    }
  }
  initUpdateSlideoutOnce();
  /** Overlay leert DOM → sichtbares Flackern; nur nach echtem Service-Chart-Repaint (nicht während Drossel). */
  if (!skipServicePaint) scheduleLayoutUpdateGuideOverlays();
}

// (renderTimelineChart entfernt)
// ─── Anthropic Status Lamp ───
function updateStatusLamp(data) {
  var dot = document.getElementById("anthropic-dot");
  var label = document.getElementById("anthropic-label");
  if (!dot || !label) return;
  var st = data.outage_status || "pending";
  if (st === "error" || st === "pending") {
    dot.style.background = "#475569";
    label.textContent = "Anthropic";
    dot.parentElement.title = t("statusPendingTip");
    return;
  }
  // Prüfe aktuellste Incidents: gibt es unresolved oder recent?
  var days = data.days || [];
  var today = data.calendar_today || new Date().toISOString().slice(0,10);
  var todayData = null;
  for (var i = days.length - 1; i >= 0; i--) { if (days[i].date === today) { todayData = days[i]; break; } }
  var hasActiveOutage = false;
  var hasRecentIncident = false;
  if (todayData && todayData.outage_incidents) {
    for (var ii = 0; ii < todayData.outage_incidents.length; ii++) {
      var inc = todayData.outage_incidents[ii];
      if (!inc.resolved_at) { hasActiveOutage = true; break; }
      hasRecentIncident = true;
    }
  }
  if (hasActiveOutage) {
    dot.style.background = "#ef4444";
    label.textContent = "Anthropic";
    dot.parentElement.title = t("statusOutageTip");
  } else if (hasRecentIncident) {
    dot.style.background = "#f59e0b";
    label.textContent = "Anthropic";
    dot.parentElement.title = t("statusIncidentTip");
  } else {
    dot.style.background = "#22c55e";
    label.textContent = "Anthropic";
    dot.parentElement.title = t("statusOkTip");
  }
}

// ─── Forensic Report Generator ───
function __rptDayTotal(d){return (d.input||0)+(d.output||0)+(d.cache_read||0)+(d.cache_creation||0);}
function __rptSigCell(d){var s=d.session_signals||{};return (s.continue||0)+"/"+(s.resume||0)+"/"+(s.retry||0)+"/"+(s.interrupt||0);}
function generateForensicReportMd(data) {
  var days = data.days || [];
  if (!days.length) return t("reportNoData");
  var isDE = __lang === "de";
  var CACHE_THRESH = 500000000;
  var HIT_MIN = 50;
  var md = [];
  var now = new Date().toISOString().replace("T"," ").slice(0,19);

  // Detect peak + limit days
  var peakDay = null, peakVal = 0;
  for (const dy of days) {
    var tt = __rptDayTotal(dy);
    if (tt > peakVal) {
      peakVal = tt;
      peakDay = dy;
    }
  }
  var limitDays = [];
  for (const dy of days) {
    var fl = [];
    if ((dy.hit_limit || 0) >= HIT_MIN) fl.push("HIT(" + dy.hit_limit + ")");
    if ((dy.cache_read || 0) >= CACHE_THRESH) fl.push("CACHE\u2265500M");
    if (fl.length) limitDays.push({ d: dy, flags: fl });
  }

  md.push(
    "# Forensic Report \u2014 Claude Code Token Usage",
    "",
    (isDE ? "Erstellt: " : "Generated: ") + now,
    (isDE ? "Peak-Tag: " : "Peak day: ") + (peakDay ? peakDay.date + " (" + fmt(peakVal) + ")" : "\u2014"),
    (isDE ? "Limit-Tage: " : "Limit days: ") + limitDays.length,
    "",
    "## 1. " + (isDE ? "Tages\u00fcbersicht" : "Daily Overview"),
    "",
    "| " + (isDE ? "Datum" : "Date") + " | Output | Cache Read | C:O | Calls | " + (isDE ? "Std." : "Hours") + " | Sig c/r/y/i | Limit |",
    "|------------|----------|------------|--------|-------|-------|-------------|--------|"
  );

  for (const dy of days) {
    var cr = dy.output > 0 ? Math.round(dy.cache_read / dy.output) : 0;
    var lim = "\u2014";
    if ((dy.hit_limit || 0) >= HIT_MIN) lim = "HIT(" + dy.hit_limit + ")";
    if ((dy.cache_read || 0) >= CACHE_THRESH) {
      lim = lim === "\u2014" ? "CACHE\u2265500M" : lim + ", CACHE\u2265500M";
    }
    md.push("| " + dy.date + " | " + fmt(dy.output) + " | " + fmt(dy.cache_read) + " | " + cr + "x | " + dy.calls + " | " + (dy.active_hours || 0) + " | " + __rptSigCell(dy) + " | " + lim + " |");
  }
  md.push("");

  md.push(
    "## 2. " + (isDE ? "Effizienz" : "Efficiency"),
    "",
    "| " + (isDE ? "Datum" : "Date") + " | Overhead | Output/h | Total/h | Subagent% |",
    "|------------|----------|----------|---------|-----------|"
  );
  for (const dy of days) {
    var tot2 = __rptDayTotal(dy);
    var ah = Math.max(1, dy.active_hours || 1);
    var oh = dy.output > 0 ? (tot2 / dy.output).toFixed(0) + "x" : "\u2014";
    var sp = (dy.sub_pct || 0) + "%";
    md.push("| " + dy.date + " | " + oh + " | " + fmt(Math.round(dy.output / ah)) + " | " + fmt(Math.round(tot2 / ah)) + " | " + sp + " |");
  }

  // 3. Subagent
  md.push(
    "",
    "## 3. "+(isDE?"Subagent-Analyse":"Subagent Analysis"),
    "",
    "| "+(isDE?"Datum":"Date")+" | "+(isDE?"Aufrufe":"Calls")+" | Sub | Sub-Cache | Sub-Cache% |",
    "|------------|--------|------|-----------|------------|"
  );
  for(const dy of days){var sc=dy.sub_cache||0;var scp=(dy.sub_cache_pct||0)+"%";md.push("| "+dy.date+" | "+dy.calls+" | "+(dy.sub_calls||0)+" | "+fmt(sc)+" | "+scp+" |");}
  md.push("");

  // 4. Budget estimate
  if(limitDays.length>0 && peakDay){
    md.push(
      "## 4. "+(isDE?"Budget-Sch\u00e4tzung":"Budget Estimate"),
      "",
      (isDE?"Impl@90% = Total / 0.9 (gesch\u00e4tztes Budget wenn ~90% erreicht).":"Impl@90% = total / 0.9 (estimated budget if ~90% was reached)."),
      "",
      "| "+(isDE?"Datum":"Date")+" | Total | Impl@90% | vs Peak | "+(isDE?"Std.":"Hours")+" | Signal |",
      "|------------|---------|----------|---------|-------|--------|"
    );
    var prevI = 0;
    for (const ld of limitDays) {
      var tot4 = __rptDayTotal(ld.d);
      var impl = Math.round(tot4 / 0.9);
      var vsp = peakVal > 0 ? (peakVal / impl).toFixed(1) + "x" : "\u2014";
      var trend = "";
      if (prevI > 0) {
        var ch = Math.round(((impl - prevI) / prevI) * 100);
        if (ch > 5) trend = " \u2191" + ch + "%";
        else if (ch < -5) trend = " \u2193" + Math.abs(ch) + "%";
        else trend = " \u2192";
      }
      prevI = impl;
      md.push("| " + ld.d.date + " | " + fmt(tot4) + " | " + fmt(impl) + " | " + vsp + " | " + (ld.d.active_hours || 0) + " | " + ld.flags.join(", ") + trend + " |");
    }

    // Median
    var ivs=[];
    for(const ld of limitDays){if(ld.d.calls>=50&&(ld.d.active_hours||0)>=2)ivs.push(Math.round(__rptDayTotal(ld.d)/0.9));}
    if(ivs.length>=2){
      ivs.sort(function(a,b){return a-b;});
      var med=ivs[Math.floor(ivs.length/2)];
      md.push(
        "",
        (isDE?"**Zusammenfassung** (":"**Summary** (")+ivs.length+(isDE?" aussagekr\u00e4ftige Limit-Tage):":" meaningful limit days):"),
        "- Median Impl@90%: ~"+fmt(med),
        "- "+(isDE?"Bereich: ":"Range: ")+fmt(ivs[0])+" .. "+fmt(ivs.at(-1)),
        "- Peak: "+fmt(peakVal)+" ("+peakDay.date+")"
      );
      if(med>0)md.push("- Peak / Median: "+(peakVal/med).toFixed(1)+"x");
    }
    md.push("");
  }

  // 5. Peak vs Limit comparison
  if(peakDay && limitDays.length>0){
    var bestLim=null;
    for(var li5=limitDays.length-1;li5>=0;li5--){var ld5=limitDays[li5];if(ld5.d.calls>=50&&(ld5.d.active_hours||0)>=2){bestLim=ld5;break;}}
    if(!bestLim)bestLim=limitDays[limitDays.length-1];
    if(bestLim && bestLim.d.date!==peakDay.date){
      var tP=__rptDayTotal(peakDay),tL=__rptDayTotal(bestLim.d);
      var crP=peakDay.output>0?Math.round(peakDay.cache_read/peakDay.output):0;
      var crL=bestLim.d.output>0?Math.round(bestLim.d.cache_read/bestLim.d.output):0;
      md.push(
        "## "+(isDE?"Fazit: Peak vs. Limit-Tag":"Conclusion: Peak vs. Limit Day"),
        "",
        "| | "+peakDay.date+" (Peak) | "+bestLim.d.date+" (Limit) |",
        "|---|---|---|",
        "| Output | "+fmt(peakDay.output)+" | "+fmt(bestLim.d.output)+" |",
        "| Cache Read | "+fmt(peakDay.cache_read)+" | "+fmt(bestLim.d.cache_read)+" |",
        "| Total | "+fmt(tP)+" | "+fmt(tL)+" |",
        "| "+(isDE?"Stunden":"Hours")+" | "+(peakDay.active_hours||0)+" | "+(bestLim.d.active_hours||0)+" |",
        "| Calls | "+peakDay.calls+" | "+bestLim.d.calls+" |",
        "| C:O Ratio | "+crP+"x | "+crL+"x |",
        ""
      );
      var impl5=Math.round(tL/0.9);
      var drop=impl5>0?Math.round(tP/impl5):0;
      if(drop>1){
        md.push("**"+(isDE?"Effektive Budget-Reduktion: ~":"Effective budget reduction: ~")+drop+"x**");
        md.push("");
      }
    }
  }

  // ─── Service Impact: Work vs Outage mit ASCII-Bars ───
  var hasAnyOutage = false;
  for (const dayOut of days) {
    if ((dayOut.outage_hours || 0) > 0) { hasAnyOutage = true; break; }
  }
  if (hasAnyOutage) {
    md.push(
      "## " + (isDE ? "Service Impact: Arbeitszeit vs. Ausfall" : "Service Impact: Work vs. Outage"),
      "",
      (isDE ? "Legende: " : "Legend: ") + "\u2588 = " + (isDE ? "saubere Arbeit" : "clean work") + " | \u2593 = " + (isDE ? "Arbeit bei Ausfall" : "work during outage") + " | \u2591 = " + (isDE ? "Ausfall (keine Arbeit)" : "outage (no work)"),
      ""
    );
    var maxH = 0;
    var svcRows = [];
    for (const sd of days) {
      var wHrs = Object.keys(sd.hours || {}).map(function (h) { return Number.parseInt(h, 10); });
      var spans = sd.outage_spans || [];
      var affected = 0;
      for (const hour of wHrs) {
        var hitSpan = false;
        for (const span of spans) {
          if (hour >= Math.floor(span.from) && hour < Math.ceil(span.to)) { hitSpan = true; break; }
        }
        if (hitSpan) affected++;
      }
      var outTotal = 0;
      for (const span2 of spans) outTotal += span2.to - span2.from;
      var clean = wHrs.length - affected;
      var outOnly = Math.max(0, Math.round((outTotal - affected) * 10) / 10);
      var totalHRow = clean + affected + outOnly;
      if (totalHRow > maxH) maxH = totalHRow;
      svcRows.push({ date: sd.date, clean: clean, affected: affected, outOnly: outOnly, cr: sd.cache_read || 0, co: sd.cache_output_ratio || 0, outageH: sd.outage_hours || 0, mc: sd.model_change });
    }
    var barW = 40;
    md.push("```");
    for (const r of svcRows) {
      var totalH = r.clean + r.affected + r.outOnly;
      if (totalH === 0 && r.outageH === 0) continue;
      var scale = maxH > 0 ? barW / maxH : 1;
      var bClean = Math.round(r.clean * scale);
      var bAff = Math.round(r.affected * scale);
      var bOut = Math.round(r.outOnly * scale);
      var barSeg = "\u2588".repeat(bClean) + "\u2593".repeat(bAff) + "\u2591".repeat(bOut);
      var label = r.date.slice(5) + " " + barSeg + " ";
      if (r.affected > 0) label += r.clean + "h+" + (isDE ? r.affected + "h Ausfall" : r.affected + "h outage");
      else label += r.clean + "h";
      if (r.outOnly > 0) label += " (+" + r.outOnly.toFixed(0) + "h " + (isDE ? "nur Ausfall" : "outage only") + ")";
      if (r.cr > 0) label += " | C:" + fmt(r.cr) + " (" + r.co + "x)";
      if (r.mc) {
        if (r.mc.added && r.mc.added.length) label += " \u25c7+" + r.mc.added.join(",");
        if (r.mc.removed && r.mc.removed.length) label += " \u25c7-" + r.mc.removed.join(",");
      }
      md.push(label);
    }
    md.push("```", "");
    var totClean = 0, totAff = 0, totOutOnly = 0;
    for (const rowSum of svcRows) {
      totClean += rowSum.clean;
      totAff += rowSum.affected;
      totOutOnly += rowSum.outOnly;
    }
    md.push((isDE ? "**Gesamt:** " : "**Total:** ") + totClean + "h " + (isDE ? "saubere Arbeit" : "clean work") + " | " + totAff + "h " + (isDE ? "Arbeit bei Ausfall" : "work during outage") + " | " + Math.round(totOutOnly) + "h " + (isDE ? "Ausfall ohne Arbeit" : "outage without work"));
    if (totAff > 0 && (totClean + totAff) > 0) {
      var pctAff = Math.round(totAff / (totClean + totAff) * 100);
      md.push((isDE ? "**Betroffene Arbeitszeit: " : "**Affected work time: ") + pctAff + "%**");
    }
    md.push("");
  }

  // ─── Extension-Versionen & Releases ───
  var hasVerChange = false;
  for (const dvc of days) {
    if (dvc.version_change) { hasVerChange = true; break; }
  }
  if (hasVerChange) {
    md.push(
      "## " + (isDE ? "Extension-Updates (Claude Code)" : "Extension Updates (Claude Code)"),
      "",
      "| " + (isDE ? "Datum" : "Date") + " | Version | Highlights |",
      "|------------|---------|------------|"
    );
    for (const dVer of days) {
      var vc = dVer.version_change;
      if (!vc) continue;
      var ver = vc.added.join(", ");
      if (vc.from) ver = vc.from + " \u2192 " + ver;
      var hl = (vc.highlights || []).slice(0, 3).join("; ");
      if (hl.length > 120) hl = hl.slice(0, 117) + "...";
      md.push("| " + dVer.date + " | " + ver + " | " + hl + " |");
    }
    md.push("");
  }

  // ─── Budget Efficiency ───
  var proxy = data.proxy || {};
  var pdays = proxy.proxy_days || [];
  var lastPd = pdays.length > 0 ? pdays[pdays.length - 1] : null;
  if (lastPd) {
    md.push("## " + (isDE ? "Budget-Effizienz" : "Budget Efficiency"), "");
    var rl = lastPd.rate_limit || {};
    var q5r = rl["anthropic-ratelimit-unified-5h-utilization"];
    var q7r = rl["anthropic-ratelimit-unified-7d-utilization"];
    var fbr = rl["anthropic-ratelimit-unified-fallback-percentage"];
    var ovr = rl["anthropic-ratelimit-unified-overage-status"];
    var ovrR = rl["anthropic-ratelimit-unified-overage-disabled-reason"];
    var clm = rl["anthropic-ratelimit-unified-representative-claim"];

    md.push(
      "| " + (isDE ? "Metrik" : "Metric") + " | " + (isDE ? "Wert" : "Value") + " | " + (isDE ? "Bewertung" : "Assessment") + " |",
      "|--------|-------|------------|"
    );
    if (q5r !== undefined && q5r !== null) {
      var q5v = Math.round(Number.parseFloat(q5r) * 1000) / 10;
      var assess5h = "\u2705 OK";
      if (q5v > 80) assess5h = "\u26a0 HIGH";
      else if (q5v > 50) assess5h = "\u26a0 MODERATE";
      md.push("| 5h Quota | " + q5v + "% | " + assess5h + " |");
    }
    if (q7r !== undefined && q7r !== null) {
      var q7v = Math.round(Number.parseFloat(q7r) * 1000) / 10;
      var assess7d = q7v > 80 ? "\u26a0 HIGH" : "\u2705 OK";
      md.push("| 7d Quota | " + q7v + "% | " + assess7d + " |");
    }
    if (fbr !== undefined && fbr !== null) {
      var fbv = Math.round(Number.parseFloat(fbr) * 100);
      var fbAssess = fbv < 100 ? "\u274c REDUCED \u2014 effective budget is " + fbv + "% of maximum" : "\u2705 FULL";
      md.push("| Fallback % | " + fbv + "% | " + fbAssess + " |");
    }
    if (ovr) {
      var ovrAssess = ovr === "rejected" ? "\u274c Hard cutoff \u2014 no buffer" : "\u2705 " + ovr;
      md.push("| Overage | " + ovr + " | " + ovrAssess + " |");
    }
    if (ovrR) md.push("| Overage Reason | " + ovrR + " | |");
    if (clm) {
      var clmNote = clm === "five_hour" ? "5h window is active constraint" : clm;
      md.push("| Binding Limit | " + clm.replaceAll("_", " ") + " | " + clmNote + " |");
    }

    var planLabel = typeof getSelectedPlanLabel === "function" ? getSelectedPlanLabel() : "?";
    md.push("| Plan | " + planLabel + " | " + (isDE ? "manuell gew\u00e4hlt" : "manually selected") + " |");

    if (lastPd.visible_tokens_per_pct) {
      md.push("| Tokens/1% | " + fmt(lastPd.visible_tokens_per_pct) + " | " + (isDE ? "sichtbare Tokens pro 1% Quota" : "visible tokens per 1% quota") + " |");
    }
    md.push("");

    var totOut = 0, totAll = 0, totCr = 0, totCc = 0, totRetries = 0, totInterrupts = 0, totTrunc = 0, totOutageH = 0;
    for (const bd of days) {
      totOut += bd.output || 0;
      totAll += bd.total || 0;
      totCr += bd.cache_read || 0;
      totCc += bd.cache_creation || 0;
      var bss = bd.session_signals || {};
      totRetries += bss.retry || 0;
      totInterrupts += bss.interrupt || 0;
      totTrunc += bss.truncated || 0;
      totOutageH += bd.outage_hours || 0;
    }
    var bOverhead = totOut > 0 ? (totAll / totOut).toFixed(1) : "?";
    var bOutputPct = totAll > 0 ? Math.round(totOut / totAll * 100) : 0;
    var bCmr = (totCc + totCr) > 0 ? Math.round(totCc / (totCc + totCr) * 100) : 0;

    md.push(
      "| " + (isDE ? "Metrik" : "Metric") + " | " + (isDE ? "Wert" : "Value") + " |",
      "|--------|-------|",
      "| Effective Output | " + bOutputPct + "% |",
      "| Overhead Factor | " + bOverhead + "x |",
      "| Cache Miss Rate | " + bCmr + "% |",
      "| Retries | " + totRetries + " |",
      "| Interrupts | " + totInterrupts + " |",
      "| Tool Bloat (truncated) | " + totTrunc + " |",
      "| Outage Loss | " + totOutageH.toFixed(1) + "h |",
      ""
    );
  }

  // ─── Release Stability ───
  if (data.release_stability?.summary) {
    var rs = data.release_stability.summary;
    md.push(
      "## " + (isDE ? "Release-Stabilit\u00e4t" : "Release Stability"),
      "",
      "| " + (isDE ? "Metrik" : "Metric") + " | " + (isDE ? "Wert" : "Value") + " |",
      "|--------|-------|",
      "| Releases | " + rs.total + " (" + rs.daysSpan + (isDE ? " Tage" : " days") + ") |",
      "| " + (isDE ? "Kadenz" : "Cadence") + " | ~" + rs.cadenceDays + (isDE ? " Tage" : " days") + " |",
      "| " + (isDE ? "\u00dcbersprungen" : "Skipped") + " | " + rs.totalSkipped + " |",
      "| Hotfixes | " + rs.hotfixCount + " |",
      "| Regressions | " + rs.regressionCount + " |",
      ""
    );
  }

  // ─── Thinking-Token Hinweis ───
  md.push("> "+(isDE?"\u26a0 **Hinweis:** Thinking-Tokens (internes Reasoning) erscheinen nicht in der API-Antwort und werden nicht gez\u00e4hlt. Sie belasten wahrscheinlich das Session-Budget.":"\u26a0 **Note:** Thinking tokens (internal reasoning) do not appear in the API response and are not counted here. They likely count against the session budget."));
  md.push("");

  md.push("---");
  md.push((isDE?"*Alle Werte heuristisch \u2014 kein offizieller API-Nachweis. Generiert vom Claude Usage Dashboard.*":"*All values are heuristic \u2014 not official API proof. Generated by Claude Usage Dashboard.*"));
  md.push("");
  return md.join("\n");
}

function __reportModalWrapH2Sections(el) {
  var h2s = el.querySelectorAll("h2");
  for (var sxi = h2s.length - 1; sxi >= 0; sxi--) {
    var h2 = h2s[sxi];
    var details = document.createElement("details");
    details.className = "report-section";
    details.id = "rpt-s" + (sxi + 1);
    var summary = document.createElement("summary");
    summary.className = "report-section-head";
    summary.innerHTML = h2.innerHTML;
    details.appendChild(summary);
    var next = h2.nextElementSibling;
    while (next && next.tagName !== "H2" && next.tagName !== "H1" && !next.classList.contains("report-section")) {
      var move = next;
      next = next.nextElementSibling;
      details.appendChild(move);
    }
    h2.parentNode.replaceChild(details, h2);
  }
}

function __reportModalBuildNavIndex(el) {
  var secs = el.querySelectorAll(".report-section");
  if (!secs.length) return;
  var nav = document.createElement("nav");
  nav.className = "report-index";
  nav.innerHTML = "<strong>Contents</strong>";
  var ol = document.createElement("ol");
  for (var nix = 0; nix < secs.length; nix++) {
    var li = document.createElement("li");
    var a = document.createElement("a");
    a.href = "#";
    var secHead = secs[nix].querySelector(".report-section-head");
    a.textContent = secHead ? secHead.textContent.replace(/^\d+\.\s*/, "") : "";
    a.dataset.rptIdx = String(nix);
    li.appendChild(a);
    ol.appendChild(li);
  }
  nav.appendChild(ol);
  el.insertBefore(nav, el.firstChild);
  ol.addEventListener("click", function(e) {
    var link = e.target.tagName === "A" ? e.target : e.target.closest("a");
    if (!link) link = e.target.parentElement;
    if (link?.dataset?.rptIdx == null) return;
    e.preventDefault();
    e.stopPropagation();
    var idx = Number.parseInt(link.dataset.rptIdx, 10);
    var allSecs = document.getElementById("report-content").querySelectorAll(".report-section");
    if (allSecs[idx]) {
      var wasOpen = allSecs[idx].open;
      allSecs[idx].open = !wasOpen;
      if (!wasOpen) setTimeout(function() { allSecs[idx].scrollIntoView({ block: "nearest" }); }, 50);
    }
  });
}

var __lastReportMd = "";
function openReportModal(){
  if (!__lastUsageData?.days?.length) return;
  __lastReportMd=generateForensicReportMd(__lastUsageData);
  var el=document.getElementById("report-content");
  if (globalThis.marked?.parse) {
    el.innerHTML = globalThis.marked.parse(__lastReportMd);
    __reportModalWrapH2Sections(el);
    __reportModalBuildNavIndex(el);
  } else {
    el.textContent=__lastReportMd;
  }
  document.getElementById("report-modal-title").textContent=t("reportTitle");
  document.getElementById("report-copy-btn").textContent=t("reportCopy");
  document.getElementById("report-download-btn").textContent=t("reportDownload");
  document.getElementById("report-modal-overlay").classList.add("open");
}
function closeReportModal(){
  document.getElementById("report-modal-overlay").classList.remove("open");
}
function downloadReport(){
  var text=__lastReportMd;
  var blob=new Blob([text],{type:"text/markdown;charset=utf-8"});
  var url=URL.createObjectURL(blob);
  var a=document.createElement("a");
  a.href=url;a.download="forensic-report-"+new Date().toISOString().slice(0,10)+".md";
  document.body.appendChild(a);a.click();document.body.removeChild(a);URL.revokeObjectURL(url);
}
function copyReport(){
  var text=__lastReportMd;
  navigator.clipboard.writeText(text).then(function(){
    var btn=document.getElementById("report-copy-btn");
    var orig=btn.textContent;btn.textContent=t("reportCopied");
    setTimeout(function(){btn.textContent=orig;},1500);
  });
}

// Sofort aktuellen Cache holen (nicht nur auf erstes SSE warten)
(function(){
  var bde=document.getElementById("lang-de");
  var ben=document.getElementById("lang-en");
  var bko=document.getElementById("lang-ko");
  if(bde) bde.addEventListener("click",function(){ setLang("de"); });
  if(ben) ben.addEventListener("click",function(){ setLang("en"); });
  if(bko) bko.addEventListener("click",function(){ setLang("ko"); });
  document.addEventListener("visibilitychange", function () {
    if (document.hidden) return;
    updateGithubTokenPanelMode();
    scheduleGithubTokenUiRefresh();
  });
  window.addEventListener("pageshow", function (ev) {
    if (!ev.persisted) return;
    updateGithubTokenPanelMode();
    scheduleGithubTokenUiRefresh();
  });
  applyStaticChrome();
  initForensicSummaryToolbarOnce();
  initMetaDetailsPanel();
  initGithubTokenPanel();
  initMarketplaceRefreshButton();
  var lp=document.getElementById("live-pop");
  var tr=document.getElementById("live-trigger");
  if(lp&&tr){
    function setLivePanelOpen(open) {
      if (open) lp.classList.add("live-files-open");
      else lp.classList.remove("live-files-open");
      tr.setAttribute("aria-expanded", open ? "true" : "false");
    }
    tr.setAttribute("aria-expanded", "false");
    tr.addEventListener("click", function (e) {
      e.stopPropagation();
      setLivePanelOpen(!lp.classList.contains("live-files-open"));
    });
    tr.addEventListener("keydown", function (e) {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        e.stopPropagation();
        setLivePanelOpen(!lp.classList.contains("live-files-open"));
      }
    });
    document.addEventListener("click", function () {
      setLivePanelOpen(false);
    });
    lp.addEventListener("click", function (e) {
      e.stopPropagation();
    });
    var lfpanel = document.getElementById("live-files-panel");
    if (lfpanel && !lfpanel.dataset.extOpenBound) {
      lfpanel.dataset.extOpenBound = "1";
      lfpanel.addEventListener("click", function (ev) {
        var btn = ev.target.closest(".live-ext-open");
        if (!btn || btn.dataset.dayIndex == null) return;
        ev.preventDefault();
        ev.stopPropagation();
        initUpdateSlideoutOnce();
        openUpdateSlideout(Number.parseInt(btn.dataset.dayIndex, 10));
      });
    }
  }
  var rbtn=document.getElementById("forensic-report-btn");
  if(rbtn){rbtn.addEventListener("click",openReportModal);}
  var rcl=document.getElementById("report-close-btn");
  if(rcl){rcl.addEventListener("click",closeReportModal);}
  var rdl=document.getElementById("report-download-btn");
  if(rdl){rdl.addEventListener("click",downloadReport);}
  var rcp=document.getElementById("report-copy-btn");
  if(rcp){rcp.addEventListener("click",copyReport);}
  var rea=document.getElementById("report-expand-all");
  if(rea){rea.addEventListener("click",function(){document.querySelectorAll("#report-content .report-section").forEach(function(s){s.open=true;});});}
  var rca=document.getElementById("report-collapse-all");
  if(rca){rca.addEventListener("click",function(){document.querySelectorAll("#report-content .report-section").forEach(function(s){s.open=false;});});}
  var rov=document.getElementById("report-modal-overlay");
  if(rov){rov.addEventListener("click",function(e){if(e.target===rov)closeReportModal();});}
})();

// ── User Profile Charts ──────────────────────────────────────────────────
var _userCharts = { versions: null, entrypoints: null, releaseStability: null };
var __releaseStabilityData = null;
var __userVersionSort = "anomalies"; // anomalies | newest | calls
var __userVersionFilter = null; // null = all, [] = none selected

var __userProfileColors = [
  "rgba(59,130,246,0.8)",   // blue
  "rgba(139,92,246,0.8)",   // violet
  "rgba(34,197,94,0.8)",    // green
  "rgba(245,158,11,0.8)",   // amber
  "rgba(236,72,153,0.8)",   // pink
  "rgba(6,182,212,0.8)",    // cyan
  "rgba(249,115,22,0.8)",   // orange
  "rgba(168,85,247,0.8)"    // purple
];

var __versionHealthMetrics = [
  { key: "hit_limit",  label: "userDSHitLimit",  color: "rgba(248,113,113,0.85)" },
  { key: "retry",      label: "userDSRetry",     color: "rgba(251,146,60,0.85)" },
  { key: "interrupt",  label: "userDSInterrupt",  color: "rgba(250,204,21,0.85)" },
  { key: "truncated",  label: "userDSTruncated",  color: "rgba(34,211,238,0.85)" },
  { key: "api_error",  label: "userDSApiError",   color: "rgba(236,72,153,0.85)" }
];

/** Max. Zeilensumme über alle Datasets (ein gemeinsamer Stack) — verhindert x-Skala < gestapelte Summe (Balken laufen aus). */
function __stackedHBarXMax(datasets) {
  if (!datasets?.length) return undefined;
  var len = 0;
  for (const ds of datasets) {
    var d = ds.data;
    if (d && d.length > len) len = d.length;
  }
  if (!len) return undefined;
  var sums = new Array(len).fill(0);
  for (const ds of datasets) {
    var row = ds.data || [];
    for (var j = 0; j < len; j++) sums[j] += Number(row[j]) || 0;
  }
  var mx = 0;
  for (var k = 0; k < len; k++) {
    if (sums[k] > mx) mx = sums[k];
  }
  if (mx <= 0) return 1;
  return Math.ceil(mx * 1.15);
}

function semverCmpDesc(a, b) {
  var pa = a.split(".").map(Number);
  var pb = b.split(".").map(Number);
  for (const i of [0, 1, 2]) {
    var da = pa[i] || 0, db = pb[i] || 0;
    if (da !== db) return db - da;
  }
  return 0;
}

function mergeVersionEntry(tgt, src) {
  for (const fk of Object.keys(src)) {
    if (fk === 'entrypoints') {
      for (const ek of Object.keys(src.entrypoints || {})) {
        tgt.entrypoints[ek] = (tgt.entrypoints[ek] || 0) + (src.entrypoints[ek] || 0);
      }
    } else {
      tgt[fk] = (tgt[fk] || 0) + (src[fk] || 0);
    }
  }
}

function aggregateVersionStats(days) {
  var merged = {};
  for (const day of days) {
    var vs = day.version_stats || {};
    for (const ver of Object.keys(vs)) {
      if (!merged[ver]) merged[ver] = { calls: 0, output: 0, cache_read: 0, hit_limit: 0, retry: 0, interrupt: 0, continue: 0, resume: 0, truncated: 0, api_error: 0, entrypoints: {} };
      mergeVersionEntry(merged[ver], vs[ver]);
    }
  }
  return merged;
}

function versionAnomalyTotal(s) {
  if (!s) return 0;
  return (s.hit_limit || 0) + (s.retry || 0) + (s.interrupt || 0) + (s.truncated || 0) + (s.api_error || 0);
}

function sortVersionKeys(keys, stats, mode) {
  var arr = keys.slice();
  if (mode === "newest") {
    arr.sort(semverCmpDesc);
  } else if (mode === "calls") {
    arr.sort(function(a, b) { return (stats[b]?.calls || 0) - (stats[a]?.calls || 0); });
  } else {
    arr.sort(function(a, b) { return versionAnomalyTotal(stats[b]) - versionAnomalyTotal(stats[a]); });
  }
  return arr;
}

var __userFilterDdOpen = false;

function initVersionSortDropdown(days) {
  var sortEl = document.getElementById("user-version-sort");
  if (!sortEl || sortEl.options.length) return;
  var opts = [
    { val: "anomalies", lbl: t("userSortAnomalies") },
    { val: "newest", lbl: t("userSortNewest") },
    { val: "calls", lbl: t("userSortCalls") }
  ];
  for (const opt of opts) {
    var o = document.createElement("option");
    o.value = opt.val;
    o.textContent = opt.lbl;
    if (opt.val === __userVersionSort) o.selected = true;
    sortEl.appendChild(o);
  }
  sortEl.addEventListener("change", function() {
    __userVersionSort = sortEl.value;
    renderUserProfileCharts(days);
  });
}

function buildFilterCheckboxHtml(allVers, stats) {
  var html = "";
  for (const v of allVers) {
    var checked = !__userVersionFilter || __userVersionFilter.includes(v);
    var anomalies = versionAnomalyTotal(stats[v]);
    var calls = stats[v]?.calls || 0;
    var badge = "";
    if (anomalies > 0) badge = " (" + anomalies + "!)";
    else if (calls > 0) badge = " (" + calls + ")";
    html += '<label><input type="checkbox" value="' + v + '"' + (checked ? ' checked' : '') + '>' + v + '<span style="color:#64748b;font-size:.65rem">' + badge + '</span></label>';
  }
  html += '<div class="user-filter-actions"><button id="user-ver-all">Alle</button><button id="user-ver-none">Keine</button></div>';
  return html;
}

function initUserVersionControls(stats, days) {
  initVersionSortDropdown(days);

  var btn = document.getElementById("user-version-filter-btn");
  var dd = document.getElementById("user-version-filter-dd");
  var countEl = document.getElementById("user-version-filter-count");
  if (!btn || !dd) return;

  var allVers = Object.keys(stats).sort(semverCmpDesc);

  function updateCount() {
    var n = __userVersionFilter ? __userVersionFilter.length : 0;
    if (countEl) countEl.textContent = n ? "(" + n + "/" + allVers.length + ")" : "(" + allVers.length + ")";
  }

  dd.innerHTML = buildFilterCheckboxHtml(allVers, stats);
  updateCount();

  btn.onclick = function(e) {
    e.stopPropagation();
    __userFilterDdOpen = !__userFilterDdOpen;
    dd.classList.toggle("open", __userFilterDdOpen);
  };

  document.addEventListener("click", function(e) {
    if (__userFilterDdOpen && !dd.contains(e.target) && e.target !== btn) {
      __userFilterDdOpen = false;
      dd.classList.remove("open");
    }
  });

  var cbs = dd.querySelectorAll('input[type=checkbox]');
  function applyFilter() {
    var sel = [];
    for (const cb of cbs) {
      if (cb.checked) sel.push(cb.value);
    }
    __userVersionFilter = sel.length === allVers.length ? null : sel;
    updateCount();
    renderUserProfileCharts(days);
  }
  for (const cb of cbs) {
    cb.addEventListener("change", applyFilter);
  }

  var allBtn = document.getElementById("user-ver-all");
  var noneBtn = document.getElementById("user-ver-none");
  if (allBtn) allBtn.onclick = function() {
    for (const cb of cbs) cb.checked = true;
    applyFilter();
  };
  if (noneBtn) noneBtn.onclick = function() {
    for (const cb of cbs) cb.checked = false;
    applyFilter();
  };
}

function collectAllVersionKeys(stats, days) {
  var allVers = Object.keys(stats);
  if (allVers.length) return allVers;
  return collectFallbackVersionKeys(days);
}

function collectFallbackVersionKeys(days) {
  var fallbackVers = {};
  for (const day of days) {
    for (const fk of Object.keys(day.versions || {})) fallbackVers[fk] = true;
  }
  return Object.keys(fallbackVers);
}

function maxKeyByValue(obj) {
  var best = "", bestVal = 0;
  for (const k of Object.keys(obj)) {
    if (obj[k] > bestVal) { best = k; bestVal = obj[k]; }
  }
  return best;
}

/**
 * Pick the highest semver version with calls on the most recent active day.
 * Uses newest-semver (not max-count) so a fresh upgrade is reflected
 * immediately, even if older versions still dominate the day's volume.
 * Entrypoint stays on max-count because there's no natural ordering.
 */
function findLatestDayTopEntries(days) {
  for (var ldi = days.length - 1; ldi >= 0; ldi--) {
    var ldv = days[ldi].versions || {};
    var keys = Object.keys(ldv).filter(function (k) { return (ldv[k] || 0) > 0; });
    if (keys.length) {
      keys.sort(semverCmpDesc);
      return { topVersion: keys[0], topEntrypoint: maxKeyByValue(days[ldi].entrypoints || {}) };
    }
  }
  return { topVersion: "", topEntrypoint: "" };
}

function computeAnomalyStats(allVers, stats) {
  var totalCalls = 0;
  var totalAnomalies = 0;
  var worstVer = "";
  var worstAnomaly = 0;
  for (const ver of allVers) {
    var sv = stats[ver];
    if (sv) {
      totalCalls += sv.calls || 0;
      totalAnomalies += versionAnomalyTotal(sv);
      var wa = versionAnomalyTotal(sv);
      if (wa > worstAnomaly) { worstAnomaly = wa; worstVer = ver; }
    }
  }
  var anomalyRate = totalCalls > 0 ? Math.round(totalAnomalies / totalCalls * 100) : 0;
  return { totalCalls: totalCalls, totalAnomalies: totalAnomalies, anomalyRate: anomalyRate, worstVer: worstVer, worstAnomaly: worstAnomaly };
}

function renderUserProfileCharts(days) {
  var sumEl = document.getElementById("user-profile-summary-line");
  if (!sumEl) return;

  if (!days?.length) {
    sumEl.textContent = t("userProfileNoData");
    return;
  }

  var stats = aggregateVersionStats(days);
  var allVers = collectAllVersionKeys(stats, days);

  var top = findLatestDayTopEntries(days);
  var anom = computeAnomalyStats(allVers, stats);

  sumEl.textContent = t("userProfileSummary")
    .replace("{version}", top.topVersion || "?")
    .replace("{entrypoint}", top.topEntrypoint || "?")
    .replace("{verCount}", String(allVers.length))
    .replace("{rate}", String(anom.anomalyRate))
    .replace("{anomalies}", String(anom.totalAnomalies))
    .replace("{calls}", String(anom.totalCalls))
    .replace("{worst}", anom.worstVer || "-")
    .replace("{worstCount}", String(anom.worstAnomaly));

  // Init sort/filter controls
  initUserVersionControls(stats, days);

  // Sort + filter (declared here so it's available for both charts)
  var filteredVers = __userVersionFilter
    ? allVers.filter(function(v) { return __userVersionFilter.includes(v); })
    : allVers;
  var sortedVers = sortVersionKeys(filteredVers, stats, __userVersionSort);

  // Nur der Canvas-Host bekommt die Plot-Höhe — nicht die ganze .chart-box (sonst stimmt Chart.js-Layout vs. h3+Blurb nicht).
  var barPitch = 30;
  var chartCanvasH = Math.max(240, sortedVers.length * barPitch + 56);
  var hosts = document.querySelectorAll("#user-profile-charts .user-chart-canvas-host");
  for (const hEl of hosts) {
    hEl.style.height = chartCanvasH + "px";
    hEl.style.minHeight = chartCanvasH + "px";
  }
  for (const bx of document.querySelectorAll("#user-profile-charts .chart-box")) {
    bx.style.height = "";
  }

  renderVersionHealthChart(sortedVers, stats, allVers);
  renderEntrypointsChart(sortedVers, stats);
  renderReleaseStabilityChart(sortedVers, __releaseStabilityData);
}

function renderVersionHealthChart(sortedVers, stats, allVers) {
  var elV = document.getElementById("c-user-versions");
  var h3V = document.getElementById("user-version-h3");
  if (h3V) h3V.textContent = t("userVersionHealthTitle");
  var blurbV = document.getElementById("user-version-blurb");
  if (blurbV) blurbV.textContent = t("userVersionHealthBlurb");
  if (!elV || !allVers.length || !sortedVers.length) {
    if (_userCharts.versions) { _userCharts.versions.destroy(); _userCharts.versions = null; }
    return;
  }
  if (_userCharts.versions) { _userCharts.versions.destroy(); _userCharts.versions = null; }

  var datasets = [];
  for (const m of __versionHealthMetrics) {
    var mData = sortedVers.map(function(sv) { return stats[sv] ? (stats[sv][m.key] || 0) : 0; });
    datasets.push({ label: t(m.label), data: mData, backgroundColor: m.color, stack: "vh" });
  }

  var vhXMax = __stackedHBarXMax(datasets);
  _userCharts.versions = new Chart(elV, {
    type: "bar",
    data: { labels: sortedVers, datasets: datasets },
    options: {
      indexAxis: "y",
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      transitions: __chartTransitionsOff,
      layout: { padding: { left: 2, right: 10, top: 4, bottom: 10 } },
      interaction: { mode: "index", intersect: false },
      datasets: {
        bar: { categoryPercentage: 0.88, barPercentage: 0.92 }
      },
      scales: {
        x: {
          stacked: true,
          min: 0,
          max: vhXMax,
          grid: { color: "rgba(51,65,85,0.5)" },
          ticks: { color: "#94a3b8", precision: 0 }
        },
        y: {
          stacked: false,
          offset: true,
          grid: { color: "rgba(51,65,85,0.3)" },
          ticks: { color: "#e2e8f0", font: { family: "monospace" }, autoSkip: false }
        }
      },
      plugins: {
        legend: { labels: { color: "#cbd5e1" } },
        tooltip: {
          callbacks: {
            afterBody: function(items) {
              if (!items.length) return "";
              var ver = sortedVers[items[0].dataIndex];
              var s = stats[ver];
              if (!s) return "";
              return t("userProfileCardVersion") + ": " + ver + " | Calls: " + (s.calls || 0) + " | Output: " + (s.output || 0);
            }
          }
        }
      }
    }
  });
}

function renderEntrypointsChart(sortedVers, stats) {
  var elE = document.getElementById("c-user-entrypoints");
  var h3E = document.getElementById("user-entrypoint-h3");
  if (h3E) h3E.textContent = t("userEntrypointChartTitle");
  var blurbE = document.getElementById("user-entrypoint-blurb");
  if (blurbE) blurbE.textContent = t("userEntrypointBlurb");
  if (!elE || !sortedVers.length) {
    if (_userCharts.entrypoints) { _userCharts.entrypoints.destroy(); _userCharts.entrypoints = null; }
    return;
  }
  if (_userCharts.entrypoints) { _userCharts.entrypoints.destroy(); _userCharts.entrypoints = null; }

  var allEp = {};
  for (const sv of sortedVers) {
    if (stats[sv]?.entrypoints) {
      for (const epk of Object.keys(stats[sv].entrypoints)) allEp[epk] = true;
    }
  }
  var epKeys = Object.keys(allEp).sort(function(a, b) { return a.localeCompare(b); });

  var epColors = {
    "claude-vscode": "rgba(59,130,246,0.8)",
    "cli": "rgba(34,197,94,0.8)",
    "claude-jetbrains": "rgba(245,158,11,0.8)"
  };
  var epDatasets = [];
  for (var edi = 0; edi < epKeys.length; edi++) {
    var eKey = epKeys[edi];
    var eData = sortedVers.map(function(sv) { return stats[sv]?.entrypoints ? (stats[sv].entrypoints[eKey] || 0) : 0; });
    epDatasets.push({
      label: eKey,
      data: eData,
      backgroundColor: epColors[eKey] || __userProfileColors[edi % __userProfileColors.length],
      stack: "ep"
    });
  }
  var epXMax = __stackedHBarXMax(epDatasets);
  _userCharts.entrypoints = new Chart(elE, {
    type: "bar",
    data: { labels: sortedVers, datasets: epDatasets },
    options: {
      indexAxis: "y",
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      transitions: __chartTransitionsOff,
      layout: { padding: { left: 2, right: 10, top: 4, bottom: 10 } },
      interaction: { mode: "index", intersect: false },
      datasets: {
        bar: { categoryPercentage: 0.88, barPercentage: 0.92 }
      },
      scales: {
        x: {
          stacked: true,
          min: 0,
          max: epXMax,
          grid: { color: "rgba(51,65,85,0.5)" },
          ticks: { color: "#94a3b8", precision: 0 }
        },
        y: {
          stacked: false,
          offset: true,
          grid: { color: "rgba(51,65,85,0.3)" },
          ticks: { color: "#e2e8f0", font: { family: "monospace" }, autoSkip: false }
        }
      },
      plugins: {
        legend: { labels: { color: "#cbd5e1" } },
        tooltip: { callbacks: { label: function(c) { return c.dataset.label + ": " + c.raw; } } }
      }
    }
  });
}

// ── Release Stability Chart ──────────────────────────────────────────────
function __countReleaseStabilityBlurb(sortedVers, lookup) {
  var matched = 0, stableN = 0, regN = 0, hotN = 0, unknownN = 0;
  for (const ver of sortedVers) {
    var info = lookup[ver];
    if (info) {
      matched++;
      if (info.stability === "hotfix") hotN++;
      else if (info.stability === "regression") regN++;
      else stableN++;
    } else {
      unknownN++;
    }
  }
  return { matched: matched, stableN: stableN, regN: regN, hotN: hotN, unknownN: unknownN };
}

function __buildReleaseStabilitySeries(sortedVers, lookup) {
  var stableData = [];
  var regressionData = [];
  var hotfixData = [];
  var unknownData = [];
  var meta = [];
  for (const ver of sortedVers) {
    var r = lookup[ver];
    if (!r) {
      stableData.push(0);
      regressionData.push(0);
      hotfixData.push(0);
      unknownData.push(1);
      meta.push({ tag: ver, stability: "unknown", daysActive: 0, skippedPatches: 0, matchedKeywords: [] });
      continue;
    }
    var d = Math.max(r.daysActive || 0, 0.3);
    unknownData.push(0);
    if (r.stability === "hotfix") {
      stableData.push(0); regressionData.push(0); hotfixData.push(d);
    } else if (r.stability === "regression") {
      stableData.push(0); regressionData.push(d); hotfixData.push(0);
    } else {
      stableData.push(d); regressionData.push(0); hotfixData.push(0);
    }
    meta.push(r);
  }
  return { stableData: stableData, regressionData: regressionData, hotfixData: hotfixData, unknownData: unknownData, meta: meta };
}

function __releaseStabilityTooltipAfterBody(meta, items, t) {
  if (!items.length) return "";
  var idx = items[0].dataIndex;
  var m = meta[idx];
  if (!m) return "";
  if (m.stability === "unknown") return t("releaseStabilityNoRelease");
  var lines = [];
  lines.push((m.date || "") + " \u00B7 " + (m.daysActive || 0) + "d active \u00B7 " + m.stability);
  if (m.skippedPatches > 0) lines.push(t("releaseStabilitySkipped") + ": " + m.skippedPatches);
  if (m.matchedKeywords?.length) lines.push("Keywords: " + m.matchedKeywords.join(", "));
  return lines.join("\n");
}

// Build a lookup: version string (without "v" prefix) → release info
function __buildReleaseLookup(releaseData) {
  var map = {};
  if (!releaseData?.releases) return map;
  for (const r of releaseData.releases) {
    var key = (r.tag || "").replace(/^v/, "");
    map[key] = r;
  }
  return map;
}

function renderReleaseStabilityChart(sortedVers, releaseData) {
  var el = document.getElementById("c-user-release-stability");
  var h3 = document.getElementById("user-release-stability-h3");
  if (h3) h3.textContent = t("releaseStabilityTitle");
  var blurb = document.getElementById("user-release-stability-blurb");
  if (!el) return;
  if (_userCharts.releaseStability) { _userCharts.releaseStability.destroy(); _userCharts.releaseStability = null; }
  if (!sortedVers?.length || !releaseData) {
    if (blurb) blurb.textContent = t("releaseStabilityNoData");
    return;
  }

  var lookup = __buildReleaseLookup(releaseData);

  var counts = __countReleaseStabilityBlurb(sortedVers, lookup);
  if (blurb) blurb.textContent = t("releaseStabilityBlurb")
    .replace("{total}", String(sortedVers.length))
    .replace("{matched}", String(counts.matched))
    .replace("{stable}", String(counts.stableN))
    .replace("{hotfixes}", String(counts.hotN))
    .replace("{regressions}", String(counts.regN));

  var series = __buildReleaseStabilitySeries(sortedVers, lookup);
  var stableData = series.stableData;
  var regressionData = series.regressionData;
  var hotfixData = series.hotfixData;
  var unknownData = series.unknownData;
  var meta = series.meta;

  var datasets = [
    { label: t("releaseStabilityStable"), data: stableData, backgroundColor: "rgba(34,197,94,0.8)", stack: "s" },
    { label: t("releaseStabilityRegression"), data: regressionData, backgroundColor: "rgba(250,204,21,0.85)", stack: "s" },
    { label: t("releaseStabilityHotfix"), data: hotfixData, backgroundColor: "rgba(248,113,113,0.85)", stack: "s" },
    { label: t("releaseStabilityUnknown"), data: unknownData, backgroundColor: "rgba(100,116,139,0.4)", stack: "s" }
  ];

  var rsXMax = __stackedHBarXMax(datasets);
  _userCharts.releaseStability = new Chart(el, {
    type: "bar",
    data: { labels: sortedVers, datasets: datasets },
    options: {
      indexAxis: "y",
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      transitions: __chartTransitionsOff,
      layout: { padding: { left: 2, right: 10, top: 4, bottom: 32 } },
      interaction: { mode: "index", intersect: false },
      datasets: {
        bar: { categoryPercentage: 0.88, barPercentage: 0.92 }
      },
      scales: {
        x: {
          stacked: true,
          min: 0,
          max: rsXMax,
          grid: { color: "rgba(51,65,85,0.5)" },
          ticks: { color: "#94a3b8" },
          title: {
            display: true,
            text: t("releaseStabilityXAxis"),
            color: "#64748b",
            font: { size: 11 },
            padding: { top: 10 }
          }
        },
        y: {
          stacked: false,
          offset: true,
          grid: { color: "rgba(51,65,85,0.18)" },
          ticks: { color: "#e2e8f0", font: { family: "monospace" }, autoSkip: false }
        }
      },
      plugins: {
        legend: { labels: { color: "#cbd5e1" } },
        tooltip: {
          callbacks: {
            afterBody: function(items) {
              return __releaseStabilityTooltipAfterBody(meta, items, t);
            }
          }
        }
      }
    }
  });
}

// ── Budget Efficiency Section ─────────────────────────────────────────────
var _budgetCharts = { waterfall: null, trend: null, quota: null };

function __aggregateBudgetDaysForEfficiency(days, filteredHost) {
  var tot = { input: 0, output: 0, cache_read: 0, cache_creation: 0, total: 0,
    retries: 0, interrupts: 0, api_errors: 0, hit_limits: 0, calls: 0, active_hours: 0 };
  var dailyTrend = [];
  for (const d of days) {
    var src_d = d;
    if (filteredHost && d.hosts?.[filteredHost]) src_d = d.hosts[filteredHost];
    tot.input += src_d.input || 0;
    tot.output += src_d.output || 0;
    tot.cache_read += src_d.cache_read || 0;
    tot.cache_creation += src_d.cache_creation || 0;
    var daySum = src_d.total;
    if (daySum == null) daySum = (src_d.input || 0) + (src_d.output || 0) + (src_d.cache_read || 0) + (src_d.cache_creation || 0);
    tot.total += daySum;
    tot.calls += src_d.calls || 0;
    tot.active_hours += src_d.active_hours || 0;
    var ss = src_d.session_signals || d.session_signals || {};
    tot.retries += ss.retry || 0;
    tot.interrupts += ss.interrupt || 0;
    tot.api_errors += ss.api_error || 0;
    var hitLim = src_d.hit_limit;
    if (hitLim == null) hitLim = d.hit_limit;
    tot.hit_limits += hitLim || 0;

    var dayTotal = d.total || 0;
    var dayOutput = d.output || 0;
    dailyTrend.push({
      date: d.date,
      overhead: dayOutput > 0 ? Math.round(dayTotal / dayOutput * 10) / 10 : 0,
      output_pct: dayTotal > 0 ? Math.round(dayOutput / dayTotal * 100) : 0,
      cache_miss_rate: (d.cache_creation || 0) + (d.cache_read || 0) > 0
        ? Math.round((d.cache_creation || 0) / ((d.cache_creation || 0) + (d.cache_read || 0)) * 100)
        : 0
    });
  }
  return { tot: tot, dailyTrend: dailyTrend };
}

function __budgetHostTotalsFromDays(days) {
  var hostTotals = {};
  for (const dayRow of days) {
    var dh = dayRow.hosts || {};
    for (const hl of Object.keys(dh)) {
      var hv = dh[hl];
      if (!hostTotals[hl]) hostTotals[hl] = { output: 0, input: 0, cache_read: 0, cache_creation: 0, total: 0 };
      hostTotals[hl].output += hv.output || 0;
      hostTotals[hl].input += hv.input || 0;
      hostTotals[hl].cache_read += hv.cache_read || 0;
      hostTotals[hl].cache_creation += hv.cache_creation || 0;
      hostTotals[hl].total += hv.total || (hv.output || 0) + (hv.input || 0) + (hv.cache_read || 0) + (hv.cache_creation || 0);
    }
  }
  return hostTotals;
}

function __budgetSankeyWeights(src) {
  var allVals = [src.out, src.inp, src.cr, src.cc].filter(function(v) { return v > 0; });
  var maxLog = 0;
  for (const av of allVals) {
    var lx = Math.log10(1 + av);
    if (lx > maxLog) maxLog = lx;
  }
  function wOf(v) {
    if (v <= 0) return 0;
    var logV = Math.log10(1 + v);
    var normalized = maxLog > 0 ? (logV / maxLog) : 1;
    return Math.max(1, Math.round(1 + normalized * 3));
  }
  return { wOut: wOf(src.out), wInp: wOf(src.inp), wCr: wOf(src.cr), wCc: wOf(src.cc), wOf: wOf };
}

function __budgetKpiCardsHtml(days, tot, outputPct, overheadFactor, cacheMissRate, lostSignals) {
  var totalOutageH = 0;
  for (const d of days) totalOutageH += d.outage_hours || 0;
  var totalTruncated = 0;
  for (const d of days) totalTruncated += d.session_signals?.truncated || 0;
  var cards = [
    { label: t("budgetCardOutput"), value: outputPct + "%", sub: t("budgetCardOutputSub"), cls: outputPct < 25 ? "warn" : "" },
    { label: t("budgetCardOverhead"), value: overheadFactor + "x", sub: t("budgetCardOverheadSub"), cls: overheadFactor > 4 ? "warn" : "" },
    { label: t("budgetCardCacheMiss"), value: cacheMissRate + "%", sub: t("budgetCardCacheMissSub"), cls: cacheMissRate > 40 ? "warn" : "" },
    { label: t("budgetCardLost"), value: String(lostSignals), sub: t("budgetCardLostSub").replace("{r}", String(tot.retries)).replace("{i}", String(tot.interrupts)).replace("{e}", String(tot.api_errors)), cls: lostSignals > 5 ? "warn" : "" },
    { label: t("budgetCardOutage"), value: totalOutageH.toFixed(1) + "h", sub: t("budgetCardOutageSub"), cls: totalOutageH > 2 ? "warn" : "" },
    { label: t("budgetCardTruncated"), value: String(totalTruncated), sub: t("budgetCardTruncatedSub"), cls: totalTruncated > 50 ? "warn" : "" }
  ];
  var ch = "";
  cards.forEach(function(c) {
    ch += "<div class=\"card " + c.cls + "\"><div class=\"label\">" + escHtml(c.label) + "</div><div class=\"value\">" + escHtml(c.value) + "</div><div class=\"sub\">" + escHtml(c.sub) + "</div></div>";
  });
  return ch;
}

function __budgetQuotaFromLatestProxy(proxy) {
  var quota = { pct_5h: null, pct_7d: null, visible_tokens_per_pct: 0,
    fallback_pct: null, overage_status: null, overage_reason: null, representative_claim: null };
  var pDays = proxy?.proxy_days;
  if (!pDays?.length) return quota;
  var lastPd = pDays.at(-1);
  if (lastPd.rate_limit) {
    var rl = lastPd.rate_limit;
    var rlQ5 = rl["anthropic-ratelimit-unified-5h-utilization"];
    var rlQ7 = rl["anthropic-ratelimit-unified-7d-utilization"];
    if (rlQ5 != null) quota.pct_5h = Number.parseFloat(rlQ5) * 100;
    if (rlQ7 != null) quota.pct_7d = Number.parseFloat(rlQ7) * 100;
    var rlFb = rl["anthropic-ratelimit-unified-fallback-percentage"];
    if (rlFb != null) quota.fallback_pct = Number.parseFloat(rlFb);
    var ov = rl["anthropic-ratelimit-unified-overage-status"];
    if (ov) quota.overage_status = ov;
    var ovr = rl["anthropic-ratelimit-unified-overage-disabled-reason"];
    if (ovr) quota.overage_reason = ovr;
    var rc = rl["anthropic-ratelimit-unified-representative-claim"];
    if (rc) quota.representative_claim = rc;
  }
  if (lastPd.visible_tokens_per_pct) quota.visible_tokens_per_pct = lastPd.visible_tokens_per_pct;
  return quota;
}

function __budgetQuotaByDateMap(proxyDays) {
  var quotaByDate = {};
  for (const pd of proxyDays) {
    if (!pd.date || !pd.rate_limit) continue;
    var rl = pd.rate_limit;
    var pdQ5 = rl["anthropic-ratelimit-unified-5h-utilization"];
    var pdQ7 = rl["anthropic-ratelimit-unified-7d-utilization"];
    var pdFb = rl["anthropic-ratelimit-unified-fallback-percentage"];
    quotaByDate[pd.date] = {
      pct_5h: pdQ5 == null ? null : Math.round(Number.parseFloat(pdQ5) * 1000) / 10,
      pct_7d: pdQ7 == null ? null : Math.round(Number.parseFloat(pdQ7) * 1000) / 10,
      vis_per_pct: pd.visible_tokens_per_pct || 0,
      fallback_pct: pdFb == null ? null : Math.round(Number.parseFloat(pdFb) * 100)
    };
  }
  return quotaByDate;
}

function __budgetApplyQuotaToTrend(dailyTrend, quotaByDate) {
  for (const dt of dailyTrend) {
    var qd = quotaByDate[dt.date];
    dt.quota_5h = qd ? qd.pct_5h : null;
    dt.quota_7d = qd ? qd.pct_7d : null;
    dt.vis_per_pct = qd ? qd.vis_per_pct : 0;
    dt.fallback_pct = qd ? qd.fallback_pct : null;
  }
}

function __budgetFuelGaugeHtml(tot, quota, t) {
  var fuelColor = function(pct) {
    var p = Math.min(100, Math.max(0, pct)) / 100;
    var r = Math.round(p < 0.5 ? p * 2 * 245 : 245);
    var g = Math.round(p < 0.5 ? 197 : (1 - p) * 2 * 197);
    return "rgb(" + r + "," + g + ",20)";
  };
  var fuelRows = [];
  var pct5 = Math.min(quota.pct_5h, 100);
  var left5 = (100 - pct5);
  var hrs5 = quota.pct_5h > 0 && tot.active_hours > 0
    ? (left5 / quota.pct_5h * tot.active_hours).toFixed(1) : "?";
  fuelRows.push(
    "<div class=\"fuel-row\"><span class=\"fuel-label\">5h Window</span>" +
    "<div class=\"fuel-bar\"><div class=\"fuel-fill\" style=\"width:" + pct5 + "%;background:" + fuelColor(pct5) + "\"></div>" +
    "<span class=\"fuel-text\">" + pct5.toFixed(0) + "% used \u00B7 ~" + hrs5 + "h left</span></div></div>"
  );
  if (quota.pct_7d != null) {
    var pct7 = Math.min(quota.pct_7d, 100);
    fuelRows.push(
      "<div class=\"fuel-row\"><span class=\"fuel-label\">7d Window</span>" +
      "<div class=\"fuel-bar\"><div class=\"fuel-fill\" style=\"width:" + pct7 + "%;background:" + fuelColor(pct7) + "\"></div>" +
      "<span class=\"fuel-text\">" + pct7.toFixed(0) + "% used</span></div></div>"
    );
  }
  if (quota.fallback_pct != null) {
    var fbPctG = Math.round(quota.fallback_pct * 100);
    fuelRows.push(
      "<div class=\"fuel-row\"><span class=\"fuel-label\">" + t("budgetCardFallback") + "</span>" +
      "<div class=\"fuel-bar\"><div class=\"fuel-fill\" style=\"width:" + fbPctG + "%;background:" + fuelColor(100 - fbPctG) + "\"></div>" +
      "<span class=\"fuel-text\">" + fbPctG + "% " + t("budgetWfOfQuota") + "</span></div></div>"
    );
  }
  return fuelRows.join("");
}

/** Destroy waterfall + trend chart instances (called from empty-state handler). */
function __budgetDisposeCharts() {
  if (_budgetCharts.waterfall) { _budgetCharts.waterfall.destroy(); _budgetCharts.waterfall = null; }
  if (_budgetCharts.trend) { _budgetCharts.trend.destroy(); _budgetCharts.trend = null; }
}

/** Handle empty-data state: render 'no data' text and clean up charts. */
function __budgetHandleEmpty(sumEl, cardsEl) {
  sumEl.textContent = t("budgetNoData");
  if (cardsEl) cardsEl.innerHTML = "";
  __budgetDisposeCharts();
}

/** Compute aggregated budget-efficiency metrics from totals. */
function __budgetMetricsFromTot(tot) {
  return {
    outputPct: tot.total > 0 ? Math.round(tot.output / tot.total * 100) : 0,
    overheadFactor: tot.output > 0 ? Math.round(tot.total / tot.output * 10) / 10 : 0,
    cacheMissRate: (tot.cache_creation + tot.cache_read) > 0
      ? Math.round(tot.cache_creation / (tot.cache_creation + tot.cache_read) * 100) : 0,
    lostSignals: tot.retries + tot.interrupts + tot.api_errors
  };
}

/** Fill the budget summary line with placeholder substitution. */
function __budgetFillSummary(sumEl, tot, m) {
  sumEl.textContent = t("budgetSummary")
    .replace("{overhead}", String(m.overheadFactor))
    .replace("{outputPct}", String(m.outputPct))
    .replace("{cmr}", String(m.cacheMissRate))
    .replace("{retries}", String(tot.retries))
    .replace("{interrupts}", String(tot.interrupts));
}

/** Show or hide the fuel gauge row based on quota availability. */
function __budgetRenderFuel(fuelEl, tot, quota) {
  if (fuelEl == null) return;
  if (quota.pct_5h == null) {
    fuelEl.style.display = "none";
    return;
  }
  fuelEl.innerHTML = __budgetFuelGaugeHtml(tot, quota, t);
  fuelEl.style.display = "flex";
}

/** Build the HTML parts for the capacity-reduced alert banner. */
function __budgetAlertParts(quota) {
  var fbPctAlert = Math.round(quota.fallback_pct * 100);
  var parts = ["<strong>" + t("budgetAlertTitle") + "</strong> "];
  parts.push(t("budgetAlertFallback").split("{pct}").join(String(fbPctAlert)));
  if (quota.overage_status === "rejected") parts.push(" · " + t("budgetAlertOverage"));
  if (quota.representative_claim) parts.push(" · " + t("budgetAlertClaim").replace("{claim}", quota.representative_claim.replaceAll("_", " ")));
  return parts;
}

/** Show or hide the capacity-reduced alert banner. */
function __budgetRenderAlert(alertEl, quota) {
  if (!alertEl) return;
  if (quota.fallback_pct != null && quota.fallback_pct < 1) {
    alertEl.innerHTML = __budgetAlertParts(quota).join("");
    alertEl.style.display = "block";
  } else {
    alertEl.style.display = "none";
  }
}

function renderBudgetEfficiency(data) {
  var sumEl = document.getElementById("budget-summary-line");
  var cardsEl = document.getElementById("budget-cards");
  if (!sumEl) return;

  var days = getFilteredDays(data.days);
  if (!days?.length) {
    __budgetHandleEmpty(sumEl, cardsEl);
    return;
  }

  // Respect host filter from top bar
  var filteredHost = typeof getFilterHost === "function" ? getFilterHost() : "";
  __budgetFilteredHost = filteredHost;

  var aggBe = __aggregateBudgetDaysForEfficiency(days, filteredHost);
  var tot = aggBe.tot;
  var dailyTrend = aggBe.dailyTrend;

  var m = __budgetMetricsFromTot(tot);
  __budgetFillSummary(sumEl, tot, m);

  if (cardsEl) {
    cardsEl.innerHTML = __budgetKpiCardsHtml(days, tot, m.outputPct, m.overheadFactor, m.cacheMissRate, m.lostSignals);
  }

  var quota = __budgetQuotaFromLatestProxy(data.proxy);
  __budgetRenderFuel(document.getElementById("budget-fuel"), tot, quota);
  __budgetRenderAlert(document.getElementById("budget-alert"), quota);

  var hostTotals = __budgetHostTotalsFromDays(days);

  // Waterfall Chart — if host filter active, skip multi-host view
  renderBudgetWaterfall(tot, quota, filteredHost ? {} : hostTotals);

  var proxyDays = data.proxy?.proxy_days || [];
  __budgetApplyQuotaToTrend(dailyTrend, __budgetQuotaByDateMap(proxyDays));

  renderBudgetTrend(dailyTrend);
}

// Approximate quota cost weights (relative to output=1)
var __quotaWeights = {
  output: 1,
  input: 0.33,
  cache_creation: 0.42,
  cache_read: 0.03
};
var __budgetViewMode = "volume"; // "volume" | "cost"
var __budgetFlowMode = "budget"; // "budget" | "api" | "user"
var __budgetSankeyState = null;
var __budgetFilteredHost = "";
var __budgetSwitchesWired = false;
var __googleChartsReady = false;
var __budgetSankeyChart = null;
var __budgetSankeyData = null;
var __budgetSankeyRowCount = 0;
var __budgetSankeyRo = null;
var __budgetSankeyResizeDeb = null;
var __budgetSankeyWindowResizeBound = false;

function __budgetSankeyDispose() {
  if (__budgetSankeyRo) {
    try {
      __budgetSankeyRo.disconnect();
    } catch {
      // ResizeObserver may already be disconnected
    }
    __budgetSankeyRo = null;
  }
  if (__budgetSankeyResizeDeb) {
    clearTimeout(__budgetSankeyResizeDeb);
    __budgetSankeyResizeDeb = null;
  }
  __budgetSankeyChart = null;
  __budgetSankeyData = null;
  __budgetSankeyRowCount = 0;
}

function __budgetSankeyMeasure(el, rowCount) {
  var w = 0;
  if (el?.getBoundingClientRect) {
    w = Math.floor(el.getBoundingClientRect().width);
  }
  if (w < 48 && el?.closest) {
    var box = el.closest(".chart-box");
    if (box?.getBoundingClientRect) {
      w = Math.floor(box.getBoundingClientRect().width - 36);
    }
  }
  var win = globalThis.window;
  if (w < 48 && win) {
    w = Math.floor(win.innerWidth - 80);
  }
  // Kein Math.max(300, …): sonst wird beim Verkleinern nie schmaler neu gezeichnet.
  w = Math.max(160, Math.min(w, 12000));
  var rc = Math.max(rowCount, 1);
  var pitch = Math.max(14, Math.min(26, Math.round(w / 26)));
  var hFromRows = Math.max(220, rc * pitch);
  var vh = win ? win.innerHeight : 700;
  var hFromVp = Math.floor(Math.min(720, Math.max(220, vh * 0.42)));
  var h = Math.min(780, Math.max(hFromRows, hFromVp));
  return { width: w, height: h };
}

function __budgetSankeyDrawOptions(width, height) {
  var fs = Math.max(10, Math.min(12, Math.round(width / 72)));
  var pad = Math.max(10, Math.min(18, Math.round(width / 52)));
  var nw = Math.max(22, Math.min(34, Math.round(width / 26)));
  return {
    width: width,
    height: height,
    sankey: {
      node: {
        label: { fontSize: fs, bold: true, color: "#e2e8f0" },
        nodePadding: pad,
        width: nw,
        colors: ["#94a3b8", "#22c55e", "#3b82f6", "#22d3ee", "#f59e0b", "#f87171", "#a855f7", "#8b5cf6"]
      },
      link: {
        color: { fill: "#94a3b8", fillOpacity: 0.18 },
        colorMode: "gradient"
      }
    }
  };
}

function __budgetSankeyRedraw() {
  if (!__budgetSankeyChart || !__budgetSankeyData || !globalThis.google?.visualization) return;
  var el = document.getElementById("c-budget-sankey");
  if (!el) return;
  var m = __budgetSankeyMeasure(el, __budgetSankeyRowCount || 1);
  try {
    if (typeof __budgetSankeyChart.clearChart === "function") __budgetSankeyChart.clearChart();
  } catch {
    // Google Charts may throw on repeat clearChart
  }
  el.style.minWidth = "";
  el.style.width = "100%";
  __budgetSankeyChart.draw(__budgetSankeyData, __budgetSankeyDrawOptions(m.width, m.height));
}

function __budgetSankeyBindResize(el) {
  if (typeof ResizeObserver !== "undefined") {
    if (__budgetSankeyRo) {
      try {
        __budgetSankeyRo.disconnect();
      } catch {
        // already disconnected
      }
      __budgetSankeyRo = null;
    }
    __budgetSankeyRo = new ResizeObserver(function() {
      if (__budgetSankeyResizeDeb) clearTimeout(__budgetSankeyResizeDeb);
      __budgetSankeyResizeDeb = setTimeout(__budgetSankeyRedraw, 100);
    });
    __budgetSankeyRo.observe(el);
    var box = el.closest?.(".chart-box");
    if (box && box !== el) __budgetSankeyRo.observe(box);
  }
  var winB = globalThis.window;
  if (winB && !__budgetSankeyWindowResizeBound) {
    __budgetSankeyWindowResizeBound = true;
    winB.addEventListener("resize", function() {
      if (__budgetSankeyResizeDeb) clearTimeout(__budgetSankeyResizeDeb);
      __budgetSankeyResizeDeb = setTimeout(__budgetSankeyRedraw, 120);
    });
  }
}

// Load Google Charts Sankey package
(function() {
  if (globalThis.google?.charts) {
    globalThis.google.charts.load("current", { packages: ["sankey"] });
    globalThis.google.charts.setOnLoadCallback(function() { __googleChartsReady = true; });
  } else {
    var iv = setInterval(function() {
      if (globalThis.google?.charts) {
        clearInterval(iv);
        globalThis.google.charts.load("current", { packages: ["sankey"] });
        globalThis.google.charts.setOnLoadCallback(function() { __googleChartsReady = true; });
      }
    }, 200);
  }
})();

function __renderBudgetGroup(el, modes, current, setter) {
  el.innerHTML = "";
  for (const mode of modes) {
    var btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = mode.label;
    btn.dataset.key = mode.key;
    if (mode.key === current) btn.className = "active";
    btn.addEventListener("click", (function(k) {
      return function() {
        setter(k);
        if (__budgetSankeyState) renderBudgetWaterfall(__budgetSankeyState.tot, __budgetSankeyState.quota, __budgetSankeyState.hostTotals);
      };
    })(mode.key));
    el.appendChild(btn);
  }
}

function __buildBudgetSwitches() {
  if (__budgetSwitchesWired) return;
  __budgetSwitchesWired = true;

  var flowGrp = document.getElementById("budget-flow-group");
  var weightGrp = document.getElementById("budget-weight-group");
  if (!flowGrp || !weightGrp) return;

  var flowModes = [
    { key: "budget", label: t("budgetFlowBudget") },
    { key: "api",    label: t("budgetFlowApi") },
    { key: "user",   label: t("budgetFlowUser") }
  ];
  var weightModes = [
    { key: "volume", label: t("budgetWfVolume") },
    { key: "cost",   label: t("budgetWfCost") }
  ];

  __renderBudgetGroup(flowGrp, flowModes, __budgetFlowMode, function(k) { __budgetFlowMode = k; });
  __renderBudgetGroup(weightGrp, weightModes, __budgetViewMode, function(k) { __budgetViewMode = k; });
}

function __updateBudgetSwitchActive() {
  var flowGrp = document.getElementById("budget-flow-group");
  var weightGrp = document.getElementById("budget-weight-group");
  if (flowGrp) {
    for (const btn of flowGrp.querySelectorAll("button")) {
      btn.className = btn.dataset.key === __budgetFlowMode ? "active" : "";
    }
  }
  if (weightGrp) {
    for (const b2 of weightGrp.querySelectorAll("button")) {
      b2.className = b2.dataset.key === __budgetViewMode ? "active" : "";
    }
  }
}

/** Build host-local src (weighted if cost view, raw otherwise). */
function __budgetHostSrc(hd, isCost) {
  if (isCost) {
    return {
      out: hd.output * __quotaWeights.output,
      inp: hd.input * __quotaWeights.input,
      cr:  hd.cache_read * __quotaWeights.cache_read,
      cc:  hd.cache_creation * __quotaWeights.cache_creation
    };
  }
  return { out: hd.output, inp: hd.input, cr: hd.cache_read, cc: hd.cache_creation };
}

/** Push one conditional row per token-kind (output / input / cache_read / cache_creation). */
function __budgetPushLeafs(rows, from, s, x, w) {
  if (s.out > 0) rows.push([from, x.nOut, w.out]);
  if (s.inp > 0) rows.push([from, x.nInp, w.inp]);
  if (s.cr  > 0) rows.push([from, x.nCr,  w.cr]);
  if (s.cc  > 0) rows.push([from, x.nCc,  w.cc]);
}

/** Expand parentNode into per-host sub-nodes and recurse into leafs. */
function __budgetExpandHosts(rows, parentNode, x) {
  for (const hk of x.hostKeys) {
    var hd = x.hostTotals[hk];
    var hLabel = hk + " (" + x.fmtTok(hd.total) + ")";
    var hsrc = __budgetHostSrc(hd, x.isCost);
    var hTotal = hsrc.out + hsrc.inp + hsrc.cr + hsrc.cc;
    rows.push([parentNode, hLabel, x.wOf(hTotal)]);
    __budgetPushLeafs(rows, hLabel, hsrc, x, {
      out: x.wOf(hsrc.out),
      inp: x.wOf(hsrc.inp),
      cr:  x.wOf(hsrc.cr),
      cc:  x.wOf(hsrc.cc)
    });
  }
}

/** Push final leaf→target rows (output → outNode, overhead → restNode). */
function __budgetPushFinalLeafs(rows, x, outNode, restNode) {
  if (x.src.out > 0) rows.push([x.nOut, outNode,  x.wOut]);
  if (x.src.inp > 0) rows.push([x.nInp, restNode, x.wInp]);
  if (x.src.cr  > 0) rows.push([x.nCr,  restNode, x.wCr]);
  if (x.src.cc  > 0) rows.push([x.nCc,  restNode, x.wCc]);
}

/** Top-level weights adapter for __budgetPushLeafs. */
function __budgetTopWeights(x) {
  return { out: x.wOut, inp: x.wInp, cr: x.wCr, cc: x.wCc };
}

/** Build budget-mode sankey rows: Plan Budget → (hosts) → leafs → Productive/Overhead. */
function __budgetRowsBudget(x) {
  var rows = [];
  var srcN = getSelectedPlanLabel() + " Budget";
  var prodN = t("budgetWfProductive") + " (" + x.fmtTok(x.raw.out) + ")";
  var overN = t("budgetWfOverhead") + " (" + x.fmtTok(x.raw.inp + x.raw.cr + x.raw.cc) + ")";
  if (x.hostKeys.length > 1) {
    __budgetExpandHosts(rows, srcN, x);
  } else {
    __budgetPushLeafs(rows, srcN, x.src, x, __budgetTopWeights(x));
  }
  __budgetPushFinalLeafs(rows, x, prodN, overN);
  return rows;
}

/** Build api-mode sankey rows: Claude API → (hosts) → leafs → You. */
function __budgetRowsApi(x) {
  var rows = [];
  var apiN = "Claude API";
  var youN = t("budgetWfYou") + " (" + x.fmtTok(x.totalVal) + ")";
  if (x.hostKeys.length > 1) {
    __budgetExpandHosts(rows, apiN, x);
  } else {
    __budgetPushLeafs(rows, apiN, x.src, x, __budgetTopWeights(x));
  }
  __budgetPushFinalLeafs(rows, x, youN, youN);
  return rows;
}

/** Build user-mode sankey rows: You → (hosts | Claude API) → leafs → Result. */
function __budgetRowsUser(x) {
  var rows = [];
  var youN = t("budgetWfYou");
  var resN = t("budgetWfResult") + " (" + x.fmtTok(x.totalVal) + ")";
  if (x.hostKeys.length > 1) {
    __budgetExpandHosts(rows, youN, x);
  } else {
    var apiN = "Claude API";
    rows.push([youN, apiN, x.wOut + x.wInp + x.wCr + x.wCc]);
    __budgetPushLeafs(rows, apiN, x.src, x, __budgetTopWeights(x));
  }
  __budgetPushFinalLeafs(rows, x, resN, resN);
  return rows;
}

/** Build Sankey rows for budget / api / user flow (reduces renderBudgetWaterfall complexity). */
function __budgetBuildSankeyRows(x) {
  if (x.flowMode === "budget") return __budgetRowsBudget(x);
  if (x.flowMode === "api")    return __budgetRowsApi(x);
  return __budgetRowsUser(x);
}

/** Compact token formatter: 1.2B / 3.4M / 56K / 789. Shared by sankey and tooltip paths. */
function __budgetFmtTok(v) {
  if (v >= 1e9) return (v / 1e9).toFixed(1) + "B";
  if (v >= 1e6) return (v / 1e6).toFixed(1) + "M";
  if (v >= 1e3) return (v / 1e3).toFixed(0) + "K";
  return String(Math.round(v));
}

function renderBudgetWaterfall(tot, quota, hostTotals) {
  __budgetSankeyState = { tot: tot, quota: quota, hostTotals: hostTotals || {} };
  __buildBudgetSwitches();
  __updateBudgetSwitchActive();

  var el = document.getElementById("c-budget-sankey");
  var h3 = document.getElementById("budget-waterfall-h3");
  if (h3) h3.textContent = t("budgetWaterfallTitle");
  var blurb = document.getElementById("budget-waterfall-blurb");
  if (!el) return;

  if (!__googleChartsReady || !globalThis.google?.visualization) {
    __budgetSankeyDispose();
    el.innerHTML = "<div style='text-align:center;padding:2rem;color:#94a3b8'>Loading Google Charts...</div>";
    setTimeout(function() { if (__budgetSankeyState) renderBudgetWaterfall(__budgetSankeyState.tot, __budgetSankeyState.quota, __budgetSankeyState.hostTotals); }, 500);
    return;
  }

  if (tot.total <= 0) {
    __budgetSankeyDispose();
    el.innerHTML = "<div style='text-align:center;padding:2rem;color:#94a3b8'>" + t("budgetNoData") + "</div>";
    return;
  }

  var isCost = __budgetViewMode === "cost";
  var raw = { out: tot.output, inp: tot.input, cr: tot.cache_read, cc: tot.cache_creation };
  var weighted = {
    out: tot.output * __quotaWeights.output,
    inp: tot.input * __quotaWeights.input,
    cr:  tot.cache_read * __quotaWeights.cache_read,
    cc:  tot.cache_creation * __quotaWeights.cache_creation
  };
  var src = isCost ? weighted : raw;
  var totalVal = src.out + src.inp + src.cr + src.cc;

  var pctOf = function(v) { return totalVal > 0 ? Math.round(v / totalVal * 1000) / 10 : 0; };

  if (blurb) {
    blurb.textContent = isCost ? t("budgetWaterfallBlurbCost") : t("budgetWaterfallBlurb");
  }

  // Build Google DataTable rows: [From, To, Weight]
  var nOut = t("budgetWfOutput") + " " + pctOf(src.out) + "%";
  var nInp = t("budgetWfInput") + " " + pctOf(src.inp) + "%";
  var nCr  = t("budgetWfCacheRead") + " " + pctOf(src.cr) + "%";
  var nCc  = t("budgetWfCacheCreate") + " " + pctOf(src.cc) + "%";

  // Compressed weights: log-scaled (see __budgetSankeyWeights)
  var sw2 = __budgetSankeyWeights(src);
  var wOf = sw2.wOf;
  var wOut = sw2.wOut, wInp = sw2.wInp, wCr = sw2.wCr, wCc = sw2.wCc;

  var hostKeys = Object.keys(hostTotals || {}).sort(function (a, b) { return a.localeCompare(b); });

  var rows = __budgetBuildSankeyRows({
    flowMode: __budgetFlowMode,
    src: src,
    raw: raw,
    hostKeys: hostKeys,
    hostTotals: hostTotals,
    isCost: isCost,
    wOf: wOf,
    wOut: wOut, wInp: wInp, wCr: wCr, wCc: wCc,
    nOut: nOut, nInp: nInp, nCr: nCr, nCc: nCc,
    totalVal: totalVal,
    fmtTok: __budgetFmtTok
  });

  if (!rows.length) {
    __budgetSankeyDispose();
    el.innerHTML = "";
    return;
  }

  var data = new globalThis.google.visualization.DataTable();
  data.addColumn("string", "From");
  data.addColumn("string", "To");
  data.addColumn("number", "Weight");
  data.addRows(rows);

  if (!__budgetSankeyChart) {
    el.innerHTML = "";
    __budgetSankeyChart = new globalThis.google.visualization.Sankey(el);
    __budgetSankeyBindResize(el);
  }
  __budgetSankeyData = data;
  __budgetSankeyRowCount = rows.length;
  var m0 = __budgetSankeyMeasure(el, rows.length);
  __budgetSankeyChart.draw(data, __budgetSankeyDrawOptions(m0.width, m0.height));
}

function __budgetDrawTrendEfficiencyChart(el, labels, dailyTrend, t) {
  if (!el || !dailyTrend.length) return;
  var outputPctData = dailyTrend.map(function(d) { return d.output_pct; });
  var overheadInvData = dailyTrend.map(function(d) { return d.overhead > 0 ? -Math.min(d.overhead, 100) : 0; });
  var cacheMissData = dailyTrend.map(function(d) { return d.cache_miss_rate; });
  _budgetCharts.trend = new Chart(el, {
    type: "line",
    data: {
      labels: labels,
      datasets: [
        {
          label: t("budgetTrendOutputPct"),
          data: outputPctData,
          borderColor: "rgba(34,197,94,0.9)",
          backgroundColor: "rgba(34,197,94,0.15)",
          tension: 0.3,
          fill: "origin",
          pointRadius: 3
        },
        {
          label: t("budgetTrendOverhead"),
          data: overheadInvData,
          borderColor: "rgba(248,113,113,0.9)",
          backgroundColor: "rgba(248,113,113,0.15)",
          tension: 0.3,
          fill: "origin",
          pointRadius: 3
        },
        {
          label: t("budgetTrendCacheMiss"),
          data: cacheMissData,
          borderColor: "rgba(245,158,11,0.8)",
          backgroundColor: "transparent",
          tension: 0.3,
          fill: false,
          borderDash: [5, 3],
          pointRadius: 2
        }
      ]
    },
    options: {
      responsive: true,
      animation: false,
      transitions: __chartTransitionsOff,
      interaction: { mode: "index", intersect: false },
      scales: {
        x: { grid: { color: "rgba(51,65,85,0.3)" }, ticks: { color: "#94a3b8", maxRotation: 45 } },
        y: {
          grid: { color: "rgba(51,65,85,0.3)" },
          ticks: {
            color: "#94a3b8",
            callback: function(v) {
              if (v >= 0) return v + "%";
              return Math.abs(v) + "x";
            }
          },
          suggestedMin: -20,
          suggestedMax: 50
        }
      },
      plugins: {
        legend: { labels: { color: "#cbd5e1" } },
        tooltip: {
          callbacks: {
            label: function(ctx) {
              if (ctx.raw == null) return null;
              if (ctx.datasetIndex === 1) return ctx.dataset.label + ": " + Math.abs(ctx.raw) + "x";
              return ctx.dataset.label + ": " + ctx.raw + "%";
            }
          }
        }
      }
    }
  });
}

function __budgetQuotaTrendDatasets(dailyTrend, t) {
  var quota5hData = dailyTrend.map(function(d) { return d.quota_5h; });
  var quota7dData = dailyTrend.map(function(d) { return d.quota_7d; });
  var fallbackData = dailyTrend.map(function(d) { return d.fallback_pct; });
  var hasQuota = quota5hData.some(function(v) { return v !== null && v !== undefined; });
  var hasFallback = fallbackData.some(function(v) { return v !== null && v !== undefined; });
  var qDatasets = [];
  if (hasQuota) {
    qDatasets.push(
      {
        label: t("budgetTrendQuota5h"),
        data: quota5hData,
        borderColor: "rgba(168,85,247,0.9)",
        backgroundColor: "rgba(168,85,247,0.1)",
        tension: 0.3,
        fill: true,
        pointRadius: 4,
        pointStyle: "rectRounded",
        borderWidth: 2,
        spanGaps: true
      },
      {
        label: t("budgetTrendQuota7d"),
        data: quota7dData,
        borderColor: "rgba(236,72,153,0.8)",
        backgroundColor: "transparent",
        tension: 0.3,
        fill: false,
        borderDash: [6, 3],
        pointRadius: 3,
        pointStyle: "triangle",
        borderWidth: 2,
        spanGaps: true
      }
    );
  }
  if (hasFallback) {
    qDatasets.push({
      label: t("budgetTrendFallback"),
      data: fallbackData,
      borderColor: "rgba(239,68,68,1)",
      backgroundColor: "rgba(239,68,68,0.12)",
      tension: 0,
      fill: true,
      pointRadius: 5,
      pointStyle: "star",
      borderWidth: 3,
      spanGaps: true
    });
  }
  return qDatasets;
}

function __budgetDrawQuotaUsageChart(el2, labels, qDatasets) {
  if (!el2 || !labels.length) return;
  if (!qDatasets.length) {
    el2.parentElement.style.display = "none";
    return;
  }
  el2.parentElement.style.display = "";
  _budgetCharts.quota = new Chart(el2, {
    type: "line",
    data: { labels: labels, datasets: qDatasets },
    options: {
      responsive: true,
      animation: false,
      transitions: __chartTransitionsOff,
      interaction: { mode: "index", intersect: false },
      scales: {
        x: { grid: { color: "rgba(51,65,85,0.3)" }, ticks: { color: "#94a3b8", maxRotation: 45 } },
        y: {
          grid: { color: "rgba(51,65,85,0.3)" },
          ticks: { color: "#a855f7", callback: function(v) { return v + "%"; } },
          min: 0,
          suggestedMax: 100
        }
      },
      plugins: {
        legend: { labels: { color: "#cbd5e1" } },
        tooltip: {
          callbacks: {
            label: function(ctx) {
              if (ctx.raw == null) return null;
              return ctx.dataset.label + ": " + ctx.raw + "%";
            }
          }
        }
      }
    }
  });
}

function renderBudgetTrend(dailyTrend) {
  if (_budgetCharts.trend) { _budgetCharts.trend.destroy(); _budgetCharts.trend = null; }
  if (_budgetCharts.quota) { _budgetCharts.quota.destroy(); _budgetCharts.quota = null; }

  var labels = dailyTrend.map(function(d) { return d.date; });

  var el = document.getElementById("c-budget-trend");
  var h3 = document.getElementById("budget-trend-h3");
  if (h3) h3.textContent = t("budgetTrendTitle");
  var blurb = document.getElementById("budget-trend-blurb");
  if (blurb) blurb.textContent = t("budgetTrendBlurb");
  __budgetDrawTrendEfficiencyChart(el, labels, dailyTrend, t);

  var el2 = document.getElementById("c-budget-quota");
  var h32 = document.getElementById("budget-quota-h3");
  if (h32) h32.textContent = t("budgetQuotaTitle");
  var blurb2 = document.getElementById("budget-quota-blurb");
  if (blurb2) blurb2.textContent = t("budgetQuotaBlurb");
  if (el2 && dailyTrend.length) {
    __budgetDrawQuotaUsageChart(el2, labels, __budgetQuotaTrendDatasets(dailyTrend, t));
  }
}

// ── Proxy Analytics Panel ─────────────────────────────────────────────────
var _proxyCharts = { tokens: null, latency: null };
// ECharts instances for Efficiency Trend (Phase 1 PoC for #166)
var _effCharts = { heatmap: null, ratio: null, vispct: null, cachemiss: null };
var __effResizeT = null;
function __effResizeAll() {
  for (const key of Object.keys(_effCharts)) {
    var c = _effCharts[key];
    if (c && typeof c.resize === "function") {
      try {
        c.resize();
      } catch {
        // chart detached or not initialized
      }
    }
  }
}
var __effWin = globalThis.window;
if (__effWin) {
  __effWin.addEventListener("resize", function () {
    if (__effResizeT) clearTimeout(__effResizeT);
    __effResizeT = setTimeout(__effResizeAll, 120);
  });
}

function getProxyDay(data) {
  var pd = data?.proxy?.proxy_days;
  if (!pd?.length) return null;
  return pd.at(-1);
}

var __lastProxyFingerprint = "";
function renderProxyAnalysis(data) {
  var sumEl = document.getElementById("proxy-summary-line");
  var noteEl = document.getElementById("proxy-note");
  var cardsEl = document.getElementById("proxy-cards");
  if (!sumEl) return;

  var pd = getProxyDay(data);
  var fp = (data.proxy && data.proxy.generated) || "";
  if (fp && fp === __lastProxyFingerprint && _proxyCharts.gauge5h) return;
  __lastProxyFingerprint = fp;
  if (!pd) {
    sumEl.textContent = t("proxySummaryNoData");
    if (noteEl) noteEl.textContent = "";
    if (cardsEl) cardsEl.innerHTML = "";
    destroyProxyCharts();
    return;
  }

  // Summary line
  var rl = pd.rate_limit || {};
  var q5h = rl["anthropic-ratelimit-unified-5h-utilization"];
  var q7d = rl["anthropic-ratelimit-unified-7d-utilization"];
  var q5pct = "?";
  var q7pct = "?";
  if (q5h !== undefined && q5h !== null) q5pct = (Number.parseFloat(q5h) * 100).toFixed(1);
  if (q7d !== undefined && q7d !== null) q7pct = (Number.parseFloat(q7d) * 100).toFixed(1);
  sumEl.textContent = tr("proxySummaryLine", {
    reqs: pd.requests || 0,
    errs: pd.errors || 0,
    q5h: q5pct,
    q7d: q7pct
  });
  if (noteEl) noteEl.textContent = t("proxyNote");

  // Cards
  var ch = pd.cache_health || {};
  var models = pd.models || {};
  var opusReqs = (models["claude-opus-4-6"] || {}).requests || 0;
  var sonnetReqs = 0;
  var otherReqs = 0;
  for (var mk in models) {
    if (!Object.prototype.hasOwnProperty.call(models, mk)) continue;
    if (mk.indexOf("opus") >= 0) continue;
    else if (mk.indexOf("sonnet") >= 0) sonnetReqs += models[mk].requests || 0;
    else otherReqs += models[mk].requests || 0;
  }

  // Status code breakdown for request card sub text
  var sc = pd.status_codes || {};
  var scParts = [];
  var scKeys = Object.keys(sc).sort();
  for (var si = 0; si < scKeys.length; si++) {
    if (scKeys[si] !== "200" && sc[scKeys[si]] > 0) scParts.push(scKeys[si] + ":" + sc[scKeys[si]]);
  }
  var reqSub = tr("proxyCardRequestsSub", { errs: pd.errors || 0, rate: (pd.error_rate || 0).toFixed(1) });
  if (scParts.length) reqSub += " (" + scParts.join(", ") + ")";

  // Quota values (rl already declared above for summary line)
  var q5raw = Number.parseFloat(rl["anthropic-ratelimit-unified-5h-utilization"] || 0);
  var q7raw = Number.parseFloat(rl["anthropic-ratelimit-unified-7d-utilization"] || 0);
  var q5pctVal = q5raw * 100;
  var q7pctVal = q7raw * 100;

  function quotaResetStr(epoch) {
    if (!epoch) return "";
    var diff = Number.parseInt(epoch, 10) - Date.now() / 1000;
    if (diff <= 0) return "";
    var rh = Math.floor(diff / 3600);
    var rm = Math.floor((diff % 3600) / 60);
    return tr("proxyGaugeResetIn", { h: rh, m: rm });
  }

  var pcards = [
    {
      label: t("proxyCardRequests"),
      value: String(pd.requests || 0),
      sub: reqSub,
      cls: (pd.error_rate || 0) > 5 ? "warn" : ""
    },
    {
      label: t("proxyCardLatency"),
      value: (pd.avg_duration_ms >= 1000 ? (pd.avg_duration_ms/1000).toFixed(1) + "s" : Math.round(pd.avg_duration_ms || 0) + "ms"),
      sub: tr("proxyCardLatencySub", { min: pd.min_duration_ms || 0, max: pd.max_duration_ms || 0 }),
      cls: (pd.avg_duration_ms || 0) > 15000 ? "warn" : ""
    },
    {
      label: t("proxyCardCacheRatio"),
      value: ((pd.cache_read_ratio || 0) * 100).toFixed(1) + "%",
      sub: tr("proxyCardCacheRatioSub", { healthy: ch.healthy || 0, affected: ch.affected || 0 }),
      cls: (pd.cache_read_ratio || 0) < 0.8 ? "warn" : "ok"
    },
    {
      label: t("proxyCardModels"),
      value: String(pd.requests || 0),
      sub: tr("proxyCardModelsSub", { opus: opusReqs, sonnet: sonnetReqs, other: otherReqs }),
      cls: ""
    },
    {
      label: t("proxyCardQuota5h"),
      value: q5pctVal.toFixed(1) + "%",
      sub: quotaResetStr(rl["anthropic-ratelimit-unified-5h-reset"]),
      cls: q5pctVal >= 80 ? "danger" : q5pctVal >= 50 ? "warn" : "",
      valueColor: gaugeColor(q5pctVal)
    },
    {
      label: t("proxyCardQuota7d"),
      value: q7pctVal.toFixed(1) + "%",
      sub: quotaResetStr(rl["anthropic-ratelimit-unified-7d-reset"]),
      cls: q7pctVal >= 80 ? "danger" : q7pctVal >= 50 ? "warn" : "",
      valueColor: gaugeColor(q7pctVal)
    }
  ];
  if (cardsEl) {
    var ch2 = "";
    pcards.forEach(function (c) {
      var valStyle = c.valueColor ? " style=\"color:" + c.valueColor + "\"" : "";
      ch2 += "<div class=\"card " + c.cls + "\"><div class=\"label\">" + escHtml(c.label) + "</div><div class=\"value\"" + valStyle + ">" + escHtml(c.value) + "</div><div class=\"sub\">" + escHtml(c.sub) + "</div></div>";
    });
    cardsEl.innerHTML = ch2;
  }

  // i18n labels for chart headings
  var h3tok = document.getElementById("proxy-token-chart-h3");
  if (h3tok) h3tok.textContent = t("proxyTokenChartTitle");
  var blurbTok = document.getElementById("proxy-token-blurb");
  if (blurbTok) blurbTok.textContent = t("proxyTokenBlurb");
  var h3lat = document.getElementById("proxy-latency-chart-h3");
  if (h3lat) h3lat.textContent = t("proxyLatencyChartTitle");
  var blurbLat = document.getElementById("proxy-latency-blurb");
  if (blurbLat) blurbLat.textContent = t("proxyLatencyBlurb");

  renderProxyTokenChart(data);
  renderProxyLatencyChart(data);
  renderProxyHourlyHeatmap(data);
  renderProxyModelChart(data);
  renderProxyInvisibleCost(pd);
  // i18n for new chart headings
  var h3hr = document.getElementById("proxy-hourly-h3");
  if (h3hr) h3hr.textContent = t("proxyHourlyTitle");
  var blurbHr = document.getElementById("proxy-hourly-blurb");
  if (blurbHr) blurbHr.textContent = t("proxyHourlyBlurb");
  var h3mod = document.getElementById("proxy-model-h3");
  if (h3mod) h3mod.textContent = t("proxyModelTitle");
  var blurbMod = document.getElementById("proxy-model-blurb");
  if (blurbMod) blurbMod.textContent = t("proxyModelBlurb");
  renderProxyColdStart(pd);
  renderProxyHourlyLatency(data);
  renderProxyErrorTrend(data);
  renderProxyCacheTrend(data);
  renderProxyEfficiencyTrend(data);
  var h3hl = document.getElementById("proxy-hourly-latency-h3");
  if (h3hl) h3hl.textContent = t("proxyHourlyLatencyTitle");
  var blurbHl = document.getElementById("proxy-hourly-latency-blurb");
  if (blurbHl) blurbHl.textContent = t("proxyHourlyLatencyBlurb");
}

function destroyProxyCharts() {
  for (var k in _proxyCharts) {
    if (_proxyCharts[k]) { try { _proxyCharts[k].destroy(); } catch (e) {} _proxyCharts[k] = null; }
  }
}

function gaugeColor(pct) {
  if (pct >= 80) return "#ef4444";
  if (pct >= 50) return "#f59e0b";
  return "#22c55e";
}


function renderProxyTokenChart(data) {
  if (typeof Chart === "undefined") return;
  var proxyDays = data.proxy?.proxy_days || [];
  if (!proxyDays.length) { chartShellSetLoading("c-proxy-tokens", false); return; }

  var labels = [];
  var cacheRead = [];
  var cacheCreate = [];
  var output = [];
  for (var i = 0; i < proxyDays.length; i++) {
    var d = proxyDays[i];
    labels.push(d.date ? d.date.slice(5) : String(i));
    cacheRead.push(d.cache_read_tokens || 0);
    cacheCreate.push(d.cache_creation_tokens || 0);
    output.push(d.output_tokens || 0);
  }

  chartShellSetLoading("c-proxy-tokens", false);
  var el = document.getElementById("c-proxy-tokens");
  if (!el) return;

  if (_proxyCharts.tokens) {
    _proxyCharts.tokens.data.labels = labels;
    _proxyCharts.tokens.data.datasets[0].data = cacheRead;
    _proxyCharts.tokens.data.datasets[1].data = cacheCreate;
    _proxyCharts.tokens.data.datasets[2].data = output;
    freezeChartNoAnim(_proxyCharts.tokens);
    _proxyCharts.tokens.update("none");
    return;
  }

  _proxyCharts.tokens = new Chart(el.getContext("2d"), {
    type: "bar",
    data: {
      labels: labels,
      datasets: [
        { label: t("proxyDSCacheRead"), data: cacheRead, backgroundColor: "rgba(139,92,246,.7)", stack: "s" },
        { label: t("proxyDSCacheCreate"), data: cacheCreate, backgroundColor: "rgba(6,182,212,.6)", stack: "s" },
        { label: t("proxyDSOutput"), data: output, backgroundColor: "rgba(34,197,94,.7)", stack: "s" }
      ]
    },
    options: {
      responsive: true,
      animation: false,
      transitions: __chartTransitionsOff,
      interaction: { mode: "index", intersect: false },
      scales: {
        x: { stacked: true, ticks: { color: "#94a3b8", font: { size: 10 } }, grid: { color: "rgba(51,65,85,.4)" } },
        y: { stacked: true, ticks: { color: "#94a3b8", callback: function (v) { return fmt(v); } }, grid: { color: "rgba(51,65,85,.4)" } }
      },
      plugins: {
        legend: { labels: { color: "#e2e8f0", boxWidth: 12, font: { size: 11 } } },
        tooltip: {
          callbacks: {
            label: function (ctx) { return ctx.dataset.label + ": " + fmt(ctx.parsed.y); }
          }
        }
      }
    }
  });
}

function renderProxyLatencyChart(data) {
  if (typeof Chart === "undefined") return;
  var proxyDays = data.proxy?.proxy_days || [];
  if (!proxyDays.length) { chartShellSetLoading("c-proxy-latency", false); return; }

  var labels = [];
  var avg = [];
  var mn = [];
  for (var i = 0; i < proxyDays.length; i++) {
    var d = proxyDays[i];
    labels.push(d.date ? d.date.slice(5) : String(i));
    avg.push(d.avg_duration_ms || 0);
    mn.push(d.min_duration_ms || 0);
  }

  chartShellSetLoading("c-proxy-latency", false);
  var el = document.getElementById("c-proxy-latency");
  if (!el) return;

  if (_proxyCharts.latency) {
    _proxyCharts.latency.data.labels = labels;
    _proxyCharts.latency.data.datasets[0].data = avg;
    _proxyCharts.latency.data.datasets[1].data = mn;
    freezeChartNoAnim(_proxyCharts.latency);
    _proxyCharts.latency.update("none");
    return;
  }

  _proxyCharts.latency = new Chart(el.getContext("2d"), {
    type: "line",
    data: {
      labels: labels,
      datasets: [
        { label: t("proxyDSAvgLatency"), data: avg, borderColor: "#3b82f6", backgroundColor: "rgba(59,130,246,.15)", fill: true, tension: .3, pointRadius: 3, borderWidth: 2 },
        { label: t("proxyDSMinLatency"), data: mn, borderColor: "#22c55e", borderDash: [4, 2], tension: .3, pointRadius: 2, borderWidth: 1 }
      ]
    },
    options: {
      responsive: true,
      animation: false,
      transitions: __chartTransitionsOff,
      interaction: { mode: "index", intersect: false },
      scales: {
        x: { ticks: { color: "#94a3b8", font: { size: 10 } }, grid: { color: "rgba(51,65,85,.4)" } },
        y: { ticks: { color: "#94a3b8", callback: function (v) { return v >= 1000 ? (v/1000).toFixed(1) + "s" : v + "ms"; } }, grid: { color: "rgba(51,65,85,.4)" }, beginAtZero: true }
      },
      plugins: {
        legend: { labels: { color: "#e2e8f0", boxWidth: 12, font: { size: 11 } } },
        tooltip: {
          callbacks: {
            label: function (ctx) {
              var v = ctx.parsed.y;
              return ctx.dataset.label + ": " + (v >= 1000 ? (v/1000).toFixed(1) + "s" : Math.round(v) + "ms");
            }
          }
        }
      }
    }
  });
}

// ── Phase 2: Invisible Cost Indicator ─────────────────────────────────────
function renderProxyInvisibleCost(pd) {
  var el = document.getElementById("proxy-invisible-cost");
  if (!el) return;
  var rl = pd.rate_limit || {};
  var q5 = Number.parseFloat(rl["anthropic-ratelimit-unified-5h-utilization"] || 0);
  var visibleTokens = (pd.output_tokens || 0) + (pd.input_tokens || 0);
  var cacheTokens = (pd.cache_read_tokens || 0) + (pd.cache_creation_tokens || 0);
  var totalVisible = visibleTokens + cacheTokens;
  // If we have quota utilization, estimate total cost
  var costNote = "";
  if (q5 > 0 && visibleTokens > 0) {
    var visPerPct = visibleTokens / (q5 * 100);
    costNote = tr("proxyInvisibleCostNote", {
      visible: fmt(visibleTokens),
      cache: fmt(cacheTokens),
      perPct: fmt(Math.round(visPerPct))
    });
  }
  el.textContent = costNote;
}

// ── Phase 4: Hourly Request Heatmap ───────────────────────────────────────
function aggregateHourlyTotals(proxyDays) {
  var totals = {};
  for (const pd of proxyDays) {
    var dh = pd.hours || {};
    for (var hk in dh) {
      if (Object.hasOwn(dh, hk)) totals[hk] = (totals[hk] || 0) + (dh[hk] || 0);
    }
  }
  var labels = [], values = [], maxVal = 0;
  for (var h = 0; h <= 23; h++) {
    var v = totals[String(h)] || 0;
    if (v > maxVal) maxVal = v;
    values.push(v);
    labels.push(String(h).length < 2 ? "0" + h : String(h));
  }
  var bgColors = values.map(function(val) {
    var intensity = maxVal > 0 ? Math.min(1, val / maxVal) : 0;
    return val === 0 ? "rgba(51,65,85,.2)" : "rgba(59,130,246," + (0.2 + intensity * 0.7).toFixed(2) + ")";
  });
  return { labels: labels, values: values, bgColors: bgColors };
}

function renderProxyHourlyHeatmap(data) {
  if (typeof Chart === "undefined") return;
  var el = document.getElementById("c-proxy-hourly");
  if (!el) return;
  var proxyDays = data.proxy?.proxy_days || [];
  var hd = aggregateHourlyTotals(proxyDays);

  chartShellSetLoading("c-proxy-hourly", false);

  if (_proxyCharts.hourly) {
    _proxyCharts.hourly.data.datasets[0].data = hd.values;
    _proxyCharts.hourly.data.datasets[0].backgroundColor = hd.bgColors;
    freezeChartNoAnim(_proxyCharts.hourly);
    _proxyCharts.hourly.update("none");
    return;
  }

  _proxyCharts.hourly = new Chart(el.getContext("2d"), {
    type: "bar",
    data: {
      labels: hd.labels,
      datasets: [{
        label: t("proxyDSRequestsPerHour"),
        data: hd.values,
        backgroundColor: hd.bgColors,
        borderRadius: 3
      }]
    },
    options: {
      responsive: true,
      animation: false,
      transitions: __chartTransitionsOff,
      scales: {
        x: { ticks: { color: "#94a3b8", font: { size: 10 } }, grid: { color: "rgba(51,65,85,.4)" } },
        y: { ticks: { color: "#94a3b8" }, grid: { color: "rgba(51,65,85,.4)" }, beginAtZero: true }
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            title: function (ctx) { return ctx[0].label + ":00 UTC"; },
            label: function (ctx) { return ctx.parsed.y + " requests (" + proxyDays.length + " days)"; }
          }
        }
      }
    }
  });
}


// ── Phase 5: Model Breakdown ──────────────────────────────────────────────
function renderProxyModelChart(data) {
  if (typeof Chart === "undefined") return;
  var el = document.getElementById("c-proxy-models");
  if (!el) return;
  var proxyDays = data.proxy?.proxy_days || [];
  if (!proxyDays.length) return;
  var colors = ["#8b5cf6", "#3b82f6", "#06b6d4", "#22c55e", "#f59e0b", "#ef4444", "#ec4899"];
  // Collect all model keys across all days
  var allModels = {};
  for (const pd of proxyDays) {
    var dm = pd.models || {};
    for (var mk in dm) { if (Object.hasOwn(dm, mk)) allModels[mk] = true; }
  }
  var modelKeys = Object.keys(allModels).sort(function(a, b) { return a.localeCompare(b); });
  var labels = proxyDays.map(function(d) { return d.date ? d.date.slice(5) : "?"; });
  // Build stacked bar datasets per model + latency line
  var datasets = [];
  for (var mi = 0; mi < modelKeys.length; mi++) {
    var mKey = modelKeys[mi];
    var short = mKey.replace("claude-", "").replace(/-\d{8}$/, "");
    var mData = proxyDays.map(function(d) { return d.models?.[mKey]?.requests || 0; });
    datasets.push({ label: short, data: mData, backgroundColor: colors[mi % colors.length], stack: "models", yAxisID: "y", borderRadius: 2 });
  }
  // Avg latency line across all models per day
  var latData = proxyDays.map(function(d) { return d.avg_duration_ms || 0; });
  datasets.push({ label: t("proxyDSModelLatency"), data: latData, type: "line", borderColor: "#f59e0b", backgroundColor: "rgba(245,158,11,.15)", yAxisID: "y1", tension: 0.3, pointRadius: 3 });

  chartShellSetLoading("c-proxy-models", false);

  if (_proxyCharts.models) {
    _proxyCharts.models.data.labels = labels;
    _proxyCharts.models.data.datasets = datasets;
    freezeChartNoAnim(_proxyCharts.models);
    _proxyCharts.models.update("none");
    return;
  }

  _proxyCharts.models = new Chart(el.getContext("2d"), {
    type: "bar",
    data: { labels: labels, datasets: datasets },
    options: {
      responsive: true,
      animation: false,
      transitions: __chartTransitionsOff,
      interaction: { mode: "index", intersect: false },
      scales: {
        x: { stacked: true, ticks: { color: "#94a3b8", font: { size: 10 } }, grid: { color: "rgba(51,65,85,.4)" } },
        y: { stacked: true, position: "left", ticks: { color: "#94a3b8" }, grid: { color: "rgba(51,65,85,.4)" }, beginAtZero: true, title: { display: true, text: "Requests", color: "#94a3b8", font: { size: 10 } } },
        y1: { position: "right", ticks: { color: "#f59e0b", callback: function (v) { return v >= 1000 ? (v / 1000).toFixed(1) + "s" : v + "ms"; } }, grid: { drawOnChartArea: false }, beginAtZero: true, title: { display: true, text: "Latency", color: "#f59e0b", font: { size: 10 } } }
      },
      plugins: {
        legend: { labels: { color: "#e2e8f0", boxWidth: 12, font: { size: 11 } } },
        tooltip: {
          callbacks: {
            label: function (ctx) {
              if (ctx.dataset.yAxisID === "y1") return ctx.dataset.label + ": " + (ctx.parsed.y >= 1000 ? (ctx.parsed.y / 1000).toFixed(1) + "s" : Math.round(ctx.parsed.y) + "ms");
              return ctx.dataset.label + ": " + ctx.parsed.y;
            }
          }
        }
      }
    }
  });
}

// ── P3.2 Cold-Start Detection ─────────────────────────────────────────────
function renderProxyColdStart(pd) {
  var el = document.getElementById("proxy-coldstart-info");
  if (!el) return;
  var cs = pd.cold_starts || 0;
  var ratios = pd.cache_ratios || [];
  if (!ratios.length) { el.textContent = ""; return; }
  var avgRatio = 0;
  for (var i = 0; i < ratios.length; i++) avgRatio += ratios[i];
  avgRatio = avgRatio / ratios.length;
  var minRatio = ratios[0];
  for (var j = 1; j < ratios.length; j++) { if (ratios[j] < minRatio) minRatio = ratios[j]; }
  var text = tr("proxyColdStartInfo", {
    cold: cs,
    total: ratios.length,
    avg: (avgRatio * 100).toFixed(1),
    min: (minRatio * 100).toFixed(1)
  });
  el.textContent = text;
  el.style.color = cs > 0 ? "#f59e0b" : "#22c55e";
}

// ── P4.4 JSONL vs Proxy Token Comparison ──────────────────────────────────
function __proxyJsonlMatchAggregate(days, proxyByDate) {
  var matches = 0;
  var jsonlTotal = 0;
  var proxyTotal = 0;
  for (const day of days) {
    var pdx = proxyByDate[day.date];
    if (!pdx) continue;
    matches++;
    jsonlTotal += (day.total || 0);
    proxyTotal += (pdx.total_tokens || 0);
  }
  return { matches: matches, jsonlTotal: jsonlTotal, proxyTotal: proxyTotal };
}

function renderProxyJsonlComparison(data) {
  var el = document.getElementById("proxy-jsonl-compare");
  if (!el) return;
  var days = data.days || [];
  var proxyDays = data.proxy?.proxy_days || [];
  if (!days.length || !proxyDays.length) {
    el.textContent = days.length ? "" : t("proxyJsonlNoData");
    return;
  }
  var proxyByDate = {};
  for (const pDay of proxyDays) {
    proxyByDate[pDay.date] = pDay;
  }
  var agg = __proxyJsonlMatchAggregate(days, proxyByDate);
  var matches = agg.matches;
  var jsonlTotal = agg.jsonlTotal;
  var proxyTotal = agg.proxyTotal;
  if (!matches) { el.textContent = t("proxyJsonlNoOverlap"); return; }
  var ratio = proxyTotal > 0 ? (jsonlTotal / proxyTotal) : 0;
  el.textContent = tr("proxyJsonlCompare", {
    days: matches,
    jsonl: fmt(jsonlTotal),
    proxy: fmt(proxyTotal),
    ratio: ratio.toFixed(2)
  });
  el.style.color = ratio > 1.5 ? "#ef4444" : ratio > 1.1 ? "#f59e0b" : "#22c55e";
}

// ── Per-Hour Latency Heatmap ──────────────────────────────────────────────
/** Fold one hour-latency entry into the aggregate. */
function __aggAddHourLatency(agg, hk, hl) {
  if (!agg[hk]) agg[hk] = { sum: 0, count: 0, max: 0 };
  agg[hk].sum += hl.sum;
  agg[hk].count += hl.count;
  if (hl.max > agg[hk].max) agg[hk].max = hl.max;
}

function aggregateHourlyLatency(proxyDays) {
  var agg = {};
  for (const pd of proxyDays) {
    var phl = pd.per_hour_latency || {};
    for (var hk in phl) {
      if (!Object.hasOwn(phl, hk)) continue;
      var hl = phl[hk];
      if (hl?.count) __aggAddHourLatency(agg, hk, hl);
    }
  }
  var labels = [], avgData = [], maxData = [];
  for (var h = 0; h <= 23; h++) {
    var key = String(h);
    labels.push(key.length < 2 ? "0" + key : key);
    var a = agg[key];
    avgData.push(a?.count > 0 ? Math.round(a.sum / a.count) : 0);
    maxData.push(a?.max || 0);
  }
  return { labels: labels, avgData: avgData, maxData: maxData };
}

function renderProxyHourlyLatency(data) {
  if (typeof Chart === "undefined") return;
  var el = document.getElementById("c-proxy-hourly-latency");
  if (!el) return;
  var proxyDays = data.proxy?.proxy_days || [];
  var ld = aggregateHourlyLatency(proxyDays);

  chartShellSetLoading("c-proxy-hourly-latency", false);

  if (_proxyCharts.hourlyLatency) {
    _proxyCharts.hourlyLatency.data.datasets[0].data = ld.avgData;
    _proxyCharts.hourlyLatency.data.datasets[1].data = ld.maxData;
    freezeChartNoAnim(_proxyCharts.hourlyLatency);
    _proxyCharts.hourlyLatency.update("none");
    return;
  }

  _proxyCharts.hourlyLatency = new Chart(el.getContext("2d"), {
    type: "bar",
    data: {
      labels: ld.labels,
      datasets: [
        { label: t("proxyDSAvgLatency"), data: ld.avgData, backgroundColor: "rgba(59,130,246,.6)", borderRadius: 2 },
        { label: t("proxyDSMaxLatency"), data: ld.maxData, backgroundColor: "rgba(239,68,68,.35)", borderRadius: 2 }
      ]
    },
    options: {
      responsive: true,
      animation: false,
      transitions: __chartTransitionsOff,
      interaction: { mode: "index", intersect: false },
      scales: {
        x: { ticks: { color: "#94a3b8", font: { size: 10 } }, grid: { color: "rgba(51,65,85,.4)" } },
        y: { ticks: { color: "#94a3b8", callback: function(v) { return v >= 1000 ? (v/1000).toFixed(1)+"s" : v+"ms"; } }, grid: { color: "rgba(51,65,85,.4)" }, beginAtZero: true }
      },
      plugins: {
        legend: { labels: { color: "#e2e8f0", boxWidth: 12, font: { size: 11 } } },
        tooltip: {
          callbacks: {
            label: function(ctx) { return ctx.dataset.label + ": " + (ctx.parsed.y >= 1000 ? (ctx.parsed.y/1000).toFixed(1)+"s" : ctx.parsed.y+"ms"); }
          }
        }
      }
    }
  });
}

// ── Error/429 Rate Trend ─────────────────────────────────────────────────
function renderProxyErrorTrend(data) {
  if (typeof Chart === "undefined") return;
  var el = document.getElementById("c-proxy-error-trend");
  if (!el) return;
  var proxyDays = data.proxy?.proxy_days || [];
  if (proxyDays.length < 2) return;
  var labels = proxyDays.map(function(d) { return d.date ? d.date.slice(5) : "?"; });
  var errRate = proxyDays.map(function(d) { return d.error_rate || 0; });
  var f429 = proxyDays.map(function(d) { return d.requests > 0 ? Math.round((d.false_429s || 0) / d.requests * 100 * 10) / 10 : 0; });

  chartShellSetLoading("c-proxy-error-trend", false);
  var h3 = document.getElementById("proxy-error-trend-h3");
  if (h3) h3.textContent = t("proxyErrorTrendTitle");
  var blurb = document.getElementById("proxy-error-trend-blurb");
  if (blurb) blurb.textContent = t("proxyErrorTrendBlurb");

  if (_proxyCharts.errorTrend) {
    _proxyCharts.errorTrend.data.labels = labels;
    _proxyCharts.errorTrend.data.datasets[0].data = errRate;
    _proxyCharts.errorTrend.data.datasets[1].data = f429;
    freezeChartNoAnim(_proxyCharts.errorTrend);
    _proxyCharts.errorTrend.update("none");
    return;
  }

  _proxyCharts.errorTrend = new Chart(el.getContext("2d"), {
    type: "line",
    data: {
      labels: labels,
      datasets: [
        { label: t("proxyDSErrorRate"), data: errRate, borderColor: "#ef4444", backgroundColor: "rgba(239,68,68,.1)", fill: true, tension: 0.3, pointRadius: 3 },
        { label: t("proxyDSFalse429Rate"), data: f429, borderColor: "#f59e0b", backgroundColor: "rgba(245,158,11,.1)", fill: true, tension: 0.3, pointRadius: 3 }
      ]
    },
    options: {
      responsive: true,
      animation: false,
      transitions: __chartTransitionsOff,
      interaction: { mode: "index", intersect: false },
      scales: {
        x: { ticks: { color: "#94a3b8", font: { size: 10 } }, grid: { color: "rgba(51,65,85,.4)" } },
        y: { ticks: { color: "#94a3b8", callback: function(v) { return v + "%"; } }, grid: { color: "rgba(51,65,85,.4)" }, beginAtZero: true }
      },
      plugins: {
        legend: { labels: { color: "#e2e8f0", boxWidth: 12, font: { size: 11 } } },
        tooltip: { callbacks: { label: function(ctx) { return ctx.dataset.label + ": " + ctx.parsed.y.toFixed(1) + "%"; } } }
      }
    }
  });
}

// ── Cache Quality Trend ──────────────────────────────────────────────────
function renderProxyCacheTrend(data) {
  if (typeof Chart === "undefined") return;
  var el = document.getElementById("c-proxy-cache-trend");
  if (!el) return;
  var proxyDays = data.proxy?.proxy_days || [];
  if (proxyDays.length < 2) return;
  var labels = proxyDays.map(function(d) { return d.date ? d.date.slice(5) : "?"; });
  var ratio = proxyDays.map(function(d) { return d.cache_read_ratio == null ? 0 : Math.round(d.cache_read_ratio * 100 * 10) / 10; });
  var coldStarts = proxyDays.map(function(d) { return d.cold_starts || 0; });

  chartShellSetLoading("c-proxy-cache-trend", false);
  var h3 = document.getElementById("proxy-cache-trend-h3");
  if (h3) h3.textContent = t("proxyCacheTrendTitle");
  var blurb = document.getElementById("proxy-cache-trend-blurb");
  if (blurb) blurb.textContent = t("proxyCacheTrendBlurb");

  if (_proxyCharts.cacheTrend) {
    _proxyCharts.cacheTrend.data.labels = labels;
    _proxyCharts.cacheTrend.data.datasets[0].data = ratio;
    _proxyCharts.cacheTrend.data.datasets[1].data = coldStarts;
    freezeChartNoAnim(_proxyCharts.cacheTrend);
    _proxyCharts.cacheTrend.update("none");
    return;
  }

  _proxyCharts.cacheTrend = new Chart(el.getContext("2d"), {
    type: "line",
    data: {
      labels: labels,
      datasets: [
        { label: t("proxyDSCacheRatio"), data: ratio, borderColor: "#22c55e", backgroundColor: "rgba(34,197,94,.1)", fill: true, tension: 0.3, pointRadius: 3, yAxisID: "y" },
        { label: t("proxyDSColdStarts"), data: coldStarts, type: "bar", backgroundColor: "rgba(59,130,246,.5)", borderRadius: 2, yAxisID: "y1" }
      ]
    },
    options: {
      responsive: true,
      animation: false,
      transitions: __chartTransitionsOff,
      interaction: { mode: "index", intersect: false },
      scales: {
        x: { ticks: { color: "#94a3b8", font: { size: 10 } }, grid: { color: "rgba(51,65,85,.4)" } },
        y: { position: "left", ticks: { color: "#22c55e", callback: function(v) { return v + "%"; } }, grid: { color: "rgba(51,65,85,.4)" }, beginAtZero: true, max: 100, title: { display: true, text: "Cache Ratio", color: "#22c55e", font: { size: 10 } } },
        y1: { position: "right", ticks: { color: "#3b82f6" }, grid: { drawOnChartArea: false }, beginAtZero: true, title: { display: true, text: "Cold Starts", color: "#3b82f6", font: { size: 10 } } }
      },
      plugins: {
        legend: { labels: { color: "#e2e8f0", boxWidth: 12, font: { size: 11 } } },
        tooltip: {
          callbacks: {
            label: function(ctx) {
              if (ctx.dataset.yAxisID === "y") return ctx.dataset.label + ": " + ctx.parsed.y.toFixed(1) + "%";
              return ctx.dataset.label + ": " + ctx.parsed.y;
            }
          }
        }
      }
    }
  });
}

// ── Efficiency Trend (JSONL Ratio + Visible/1% + Cache Miss aus JSONL) ───
function buildEfficiencyData(proxyDays, mainDays) {
  var jsonlByDate = {};
  var jsonlVisibleByDate = {};
  var cacheMissByDate = {};
  for (const md of mainDays) {
    if (!md.date) continue;
    jsonlByDate[md.date] = (md.input || 0) + (md.output || 0) + (md.cache_read || 0) + (md.cache_creation || 0);
    jsonlVisibleByDate[md.date] = (md.input || 0) + (md.output || 0);
    var cc = md.cache_creation || 0;
    var cr = md.cache_read || 0;
    cacheMissByDate[md.date] = cc + cr > 0 ? Math.round((cc / (cc + cr)) * 1000) / 10 : 0;
  }
  var labels = [], ratioData = [], visPerPctData = [], cacheMissData = [];
  var visPerPctMeta = []; // per-day {method, q5Pct, coverage, samples, lowCoverage}
  for (const pd of proxyDays) {
    var dk = pd.date || "";
    labels.push(dk ? dk.slice(5) : "?");
    var proxyTotal = pd.total_tokens || 0;
    var jsonlTotal = jsonlByDate[dk] || 0;
    ratioData.push(proxyTotal > 0 ? Math.round(jsonlTotal / proxyTotal * 100) / 100 : 0);

    var vpp = pd.visible_tokens_per_pct;
    visPerPctData.push(vpp || 0);

    // Proxy coverage: active-phase proxy tokens / JSONL visible tokens for same day
    var jsonlVisible = jsonlVisibleByDate[dk] || 0;
    var proxyActive = pd.proxy_active_visible_tokens || 0;
    var coverage = jsonlVisible > 0 ? proxyActive / jsonlVisible : null;
    visPerPctMeta.push({
      method: pd.visible_tokens_per_pct_method || null,
      q5Pct: pd.q5_consumed_pct || 0,
      samples: pd.q5_samples || 0,
      proxyActive: proxyActive,
      jsonlVisible: jsonlVisible,
      coverage: coverage,
      lowCoverage: coverage != null && coverage < 0.5
    });

    cacheMissData.push(cacheMissByDate[dk] || 0);
  }
  return {
    labels: labels,
    ratioData: ratioData,
    visPerPctData: visPerPctData,
    visPerPctMeta: visPerPctMeta,
    cacheMissData: cacheMissData
  };
}

// ── Efficiency Trend: ECharts PoC (issue #166, Phase 1) ────────────────
// 1 Heatmap Matrix (metric x day, per-row min-max normalized) +
// 3 Small Multiples (JSONL/Proxy Ratio, Visible Tokens/1%, Cache Miss %).
// Synced tooltips via echarts.connect(). No Chart.js here.

function __effNormalizeRow(row) {
  var min = Infinity, max = -Infinity;
  for (const v of row) {
    if (v == null || Number.isNaN(v)) continue;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (Number.isFinite(min) && Number.isFinite(max) && min < max) {
    var span = max - min;
    return row.map(function (v) {
      if (v == null || Number.isNaN(v)) return 0;
      return (v - min) / span;
    });
  }
  return row.map(function () { return 0.5; });
}

function __effHeatmapOption(ed) {
  var covLabel = t("proxyDSCoverage");
  if (covLabel === "proxyDSCoverage") covLabel = "Coverage %";
  var metricLabels = [
    t("proxyDSJsonlRatio"),
    t("proxyDSVisPerPct"),
    t("budgetTrendCacheMiss"),
    covLabel
  ];
  var rawRows = [
    ed.ratioData,
    ed.visPerPctData,
    ed.cacheMissData,
    ed.visPerPctMeta.map(function (m) { return m?.coverage != null ? m.coverage * 100 : 0; })
  ];
  var normRows = rawRows.map(__effNormalizeRow);
  var hdata = [];
  rawRows.forEach(function (rawRow, m) {
    ed.labels.forEach(function (_unused, d) {
      hdata.push([d, m, normRows[m][d], rawRow[d]]);
    });
  });
  return {
    animation: false,
    backgroundColor: "transparent",
    tooltip: {
      position: "top",
      backgroundColor: "rgba(15,23,42,.95)",
      borderColor: "#475569",
      textStyle: { color: "#e2e8f0" },
      formatter: function (p) {
        var raw = p.data[3];
        var norm = p.data[2];
        var metricName = metricLabels[p.data[1]];
        var dayLabel = ed.labels[p.data[0]];
        var rawStr;
        if (metricName.includes("Ratio")) rawStr = raw.toFixed(2) + "x";
        else if (metricName.includes("%")) rawStr = raw.toFixed(1) + "%";
        else rawStr = Math.round(raw).toLocaleString();
        return dayLabel + "<br/>" + metricName + ": <b>" + rawStr + "</b><br/>"
          + "normalized: " + (norm * 100).toFixed(0) + "%";
      }
    },
    grid: { left: 110, right: 20, top: 8, bottom: 24 },
    xAxis: {
      type: "category",
      data: ed.labels,
      axisLabel: { color: "#94a3b8", fontSize: 10 },
      axisLine: { lineStyle: { color: "#475569" } },
      splitArea: { show: false }
    },
    yAxis: {
      type: "category",
      data: metricLabels,
      axisLabel: { color: "#cbd5e1", fontSize: 10 },
      axisLine: { lineStyle: { color: "#475569" } },
      splitArea: { show: false }
    },
    visualMap: {
      min: 0,
      max: 1,
      dimension: 2,
      show: false,
      inRange: { color: ["#1e3a5f", "#3b82f6", "#a855f7", "#f59e0b", "#ef4444"] }
    },
    series: [{
      type: "heatmap",
      data: hdata,
      label: {
        show: true,
        color: "#f1f5f9",
        fontSize: 9,
        formatter: function (p) {
          var raw = p.data[3];
          var m = p.data[1];
          if (m === 0) return raw.toFixed(1) + "x";
          if (m === 1) return raw >= 1000 ? (raw / 1000).toFixed(1) + "K" : String(Math.round(raw));
          return raw.toFixed(1) + "%";
        }
      },
      itemStyle: { borderColor: "#0f172a", borderWidth: 1 }
    }]
  };
}

function __effSmallMultipleOption(spec) {
  return {
    animation: false,
    backgroundColor: "transparent",
    title: {
      text: spec.title,
      left: "center",
      top: 4,
      textStyle: { color: spec.color, fontSize: 11, fontWeight: "normal" }
    },
    tooltip: {
      trigger: "axis",
      backgroundColor: "rgba(15,23,42,.95)",
      borderColor: "#475569",
      textStyle: { color: "#e2e8f0", fontSize: 11 },
      formatter: spec.tooltipFormatter
    },
    grid: { left: 42, right: 10, top: 28, bottom: 22 },
    xAxis: {
      type: "category",
      data: spec.labels,
      axisLabel: { color: "#94a3b8", fontSize: 9 },
      axisLine: { lineStyle: { color: "#475569" } },
      splitLine: { show: false }
    },
    yAxis: {
      type: "value",
      axisLabel: { color: "#94a3b8", fontSize: 9, formatter: spec.yFormatter },
      axisLine: { show: false },
      splitLine: { lineStyle: { color: "rgba(51,65,85,.4)" } }
    },
    series: [spec.series]
  };
}

function __effInitOrSet(key, el, option) {
  if (!el) return;
  if (!_effCharts[key]) {
    if (typeof echarts === "undefined") return;
    _effCharts[key] = echarts.init(el, null, { renderer: "canvas" });
  }
  _effCharts[key].setOption(option, { notMerge: false, lazyUpdate: false });
}

function __effConnectCharts() {
  if (typeof echarts === "undefined" || !echarts.connect) return;
  var group = [];
  if (_effCharts.ratio) group.push(_effCharts.ratio);
  if (_effCharts.vispct) group.push(_effCharts.vispct);
  if (_effCharts.cachemiss) group.push(_effCharts.cachemiss);
  if (group.length >= 2) echarts.connect(group);
}

function renderProxyEfficiencyTrend(data) {
  if (typeof echarts === "undefined") return;
  var elHeat = document.getElementById("c-proxy-efficiency-heatmap");
  var elR = document.getElementById("c-proxy-efficiency-ratio");
  var elV = document.getElementById("c-proxy-efficiency-vispct");
  var elC = document.getElementById("c-proxy-efficiency-cachemiss");
  if (!elHeat || !elR || !elV || !elC) return;
  var proxyDays = data.proxy?.proxy_days || [];
  if (proxyDays.length < 2) return;
  var ed = buildEfficiencyData(proxyDays, data.days || []);

  var h3 = document.getElementById("proxy-efficiency-trend-h3");
  if (h3) h3.textContent = t("proxyEfficiencyTrendTitle");
  var blurb = document.getElementById("proxy-efficiency-trend-blurb");
  if (blurb) blurb.textContent = t("proxyEfficiencyTrendBlurb");

  // Heatmap Matrix
  __effInitOrSet("heatmap", elHeat, __effHeatmapOption(ed));

  // Small multiple 1: JSONL/Proxy Ratio (line + B8 reference at 2.87)
  __effInitOrSet("ratio", elR, __effSmallMultipleOption({
    title: t("proxyDSJsonlRatio"),
    color: "#f59e0b",
    labels: ed.labels,
    yFormatter: function (v) { return v.toFixed(1) + "x"; },
    tooltipFormatter: function (ps) {
      if (!ps?.length) return "";
      var p = ps[0];
      return p.axisValue + "<br/>" + t("proxyDSJsonlRatio") + ": <b>" + p.value.toFixed(2) + "x</b><br/>"
        + "<span style='color:#94a3b8'>B8 baseline: 2.87x</span>";
    },
    series: {
      type: "line",
      data: ed.ratioData,
      smooth: 0.3,
      symbol: "circle",
      symbolSize: 6,
      lineStyle: { color: "#f59e0b", width: 2 },
      itemStyle: { color: "#f59e0b" },
      areaStyle: { color: "rgba(245,158,11,.12)" },
      markLine: {
        silent: true,
        symbol: "none",
        data: [{ yAxis: 2.87, lineStyle: { color: "#94a3b8", type: "dashed", width: 1 }, label: { show: true, position: "end", color: "#94a3b8", fontSize: 9, formatter: "B8 2.87x" } }]
      }
    }
  }));

  // Small multiple 2: Visible Tokens per 1% (bar with coverage-aware tooltip)
  var visMeta = ed.visPerPctMeta;
  __effInitOrSet("vispct", elV, __effSmallMultipleOption({
    title: t("proxyDSVisPerPct"),
    color: "#8b5cf6",
    labels: ed.labels,
    yFormatter: function (v) { return v >= 1000 ? (v / 1000).toFixed(1) + "K" : String(Math.round(v)); },
    tooltipFormatter: function (ps) {
      if (!ps?.length) return "";
      var p = ps[0];
      var meta = visMeta[p.dataIndex];
      var val = p.value;
      var txt = p.axisValue + "<br/>" + t("proxyDSVisPerPct") + ": <b>"
        + (val >= 1000 ? (val / 1000).toFixed(2) + "K" : Math.round(val)) + "/1%</b>";
      if (!meta) return txt;
      if (meta.method === "cumulative_delta") {
        txt += "<br/><span style='color:#94a3b8'>Δq5: " + meta.q5Pct.toFixed(1) + "% / " + meta.samples + " samples</span>";
      }
      if (meta.coverage != null) {
        var covPct = Math.round(meta.coverage * 100);
        txt += "<br/><span style='color:#94a3b8'>proxy coverage: " + covPct + "% of JSONL</span>";
        if (meta.lowCoverage) {
          txt += "<br/><span style='color:#f59e0b'>⚠ below 50% — lower bound</span>";
        }
      }
      return txt;
    },
    series: {
      type: "bar",
      data: ed.visPerPctData,
      barMaxWidth: 28,
      itemStyle: { color: "rgba(139,92,246,.75)", borderRadius: [2, 2, 0, 0] }
    }
  }));

  // Small multiple 3: Cache Miss % (dashed line)
  __effInitOrSet("cachemiss", elC, __effSmallMultipleOption({
    title: t("budgetTrendCacheMiss"),
    color: "#eab308",
    labels: ed.labels,
    yFormatter: function (v) { return v.toFixed(1) + "%"; },
    tooltipFormatter: function (ps) {
      if (!ps?.length) return "";
      var p = ps[0];
      return p.axisValue + "<br/>" + t("budgetTrendCacheMiss") + ": <b>" + p.value.toFixed(2) + "%</b>";
    },
    series: {
      type: "line",
      data: ed.cacheMissData,
      smooth: 0.3,
      symbol: "circle",
      symbolSize: 5,
      lineStyle: { color: "#eab308", width: 2, type: "dashed" },
      itemStyle: { color: "#eab308" }
    }
  }));

  __effConnectCharts();
}

// ── Health Score Ampel ────────────────────────────────────────────────────
var __lastHealthFingerprint = "";

function healthColor(value, greenMax, yellowMax) {
  // greenMax = upper bound for green, yellowMax = upper bound for yellow
  if (value <= greenMax) return "green";
  if (value <= yellowMax) return "yellow";
  return "red";
}
function healthColorInverse(value, greenMin, yellowMin) {
  // For metrics where HIGHER is better (cache health)
  if (value >= greenMin) return "green";
  if (value >= yellowMin) return "yellow";
  return "red";
}
function healthPoints(color) { return color === "green" ? 2 : color === "yellow" ? 1 : 0; }

function computeHealthIndicators(data) {
  var days = data.days || [];
  var proxy = data.proxy || {};
  var pdays = proxy.proxy_days || [];
  var pd = pdays.length > 0 ? pdays[pdays.length - 1] : null;
  var numDays = days.length || 1;

  // Averages from JSONL
  var totalHits = 0, totalInterrupts = 0, totalRetries = 0;
  for (var i = 0; i < days.length; i++) {
    totalHits += (days[i].hit_limit || 0);
    var ss = days[i].session_signals || {};
    totalInterrupts += (ss.interrupt || 0);
    totalRetries += (ss.retry || 0);
  }
  var hitsPerDay = Math.round(totalHits / numDays);
  var interruptsPerDay = Math.round(totalInterrupts / numDays);
  var retriesPerDay = Math.round(totalRetries / numDays);

  // Thinking Gap: compare JSONL vs proxy for matching day
  var thinkingGap = 0;
  if (pd && days.length) {
    // Try matching proxy days from newest to oldest until we find one with JSONL data
    var pdAll = data.proxy?.proxy_days || [];
    for (var tgi = pdAll.length - 1; tgi >= 0; tgi--) {
      var tgPd = pdAll[tgi];
      if (!(tgPd.total_tokens > 0)) continue;
      var tgJsonl = null;
      for (var tgj = 0; tgj < days.length; tgj++) {
        if (days[tgj].date === tgPd.date && (days[tgj].total || 0) > 0) { tgJsonl = days[tgj]; break; }
      }
      if (tgJsonl) {
        thinkingGap = tgJsonl.total / tgPd.total_tokens;
        break;
      }
    }
  }

  // Proxy metrics (fallback to 0/defaults if no proxy)
  var rl = pd ? (pd.rate_limit || {}) : {};
  var q5h = Number.parseFloat(rl["anthropic-ratelimit-unified-5h-utilization"] || 0) * 100;
  var cacheRatio = pd ? ((pd.cache_read_ratio || 0) * 100) : 100;
  var errorRate = pd ? (pd.error_rate || 0) : 0;
  var avgLatMs = pd ? (pd.avg_duration_ms || 0) : 0;
  var avgLatS = avgLatMs / 1000;
  var coldStarts = pd ? (pd.cold_starts || 0) : 0;
  var false429s = pd ? (pd.false_429s || 0) : 0;
  var contextResets = pd ? (pd.context_resets || 0) : 0;
  var tokPerPct = pd ? (pd.visible_tokens_per_pct || 0) : 0;
  var tokPerPctM = tokPerPct > 0 ? (tokPerPct / 1000000).toFixed(1) + "M" : "-";

  // B5: Truncations from JSONL session_signals
  var truncPerDay = 0;
  if (days.length) {
    var truncTotal = 0;
    for (var tri = 0; tri < days.length; tri++) {
      var trSig = days[tri].session_signals;
      if (trSig) truncTotal += (trSig.truncated || 0);
    }
    truncPerDay = Math.round(truncTotal / days.length);
  }

  // Stop-reason anomalies: count non-standard stop reasons
  var anomalStops = 0;
  if (days.length) {
    for (var sri = 0; sri < days.length; sri++) {
      var sr = days[sri].stop_reasons || {};
      for (var srk in sr) {
        if (srk !== "end_turn" && srk !== "tool_use" && srk !== "max_tokens" && srk !== "unknown") {
          anomalStops += sr[srk];
        }
      }
    }
  }

  return [
    { id: "quota5h", label: t("healthQuota5h"), value: q5h, display: q5h.toFixed(0) + "%", color: healthColor(q5h, 50, 80), barPct: Math.min(100, q5h) },
    { id: "thinkingGap", label: t("healthThinkingGap"), value: thinkingGap, display: thinkingGap > 0 ? thinkingGap.toFixed(1) + "x" : "-", color: thinkingGap <= 0 ? "green" : healthColor(thinkingGap, 2, 5), barPct: Math.min(100, thinkingGap * 10) },
    { id: "cacheHealth", label: t("healthCacheHealth"), value: cacheRatio, display: cacheRatio.toFixed(1) + "%", color: healthColorInverse(cacheRatio, 90, 70), barPct: cacheRatio },
    { id: "errorRate", label: t("healthErrorRate"), value: errorRate, display: errorRate.toFixed(1) + "%", color: healthColor(errorRate, 3, 10), barPct: Math.min(100, errorRate * 5) },
    { id: "hitLimits", label: t("healthHitLimits"), value: hitsPerDay, display: String(hitsPerDay), color: healthColor(hitsPerDay, 50, 500), barPct: Math.min(100, hitsPerDay / 10) },
    { id: "latency", label: t("healthLatency"), value: avgLatS, display: avgLatS >= 1 ? avgLatS.toFixed(1) + "s" : Math.round(avgLatMs) + "ms", color: healthColor(avgLatS, 5, 15), barPct: Math.min(100, avgLatS * 5) },
    { id: "interrupts", label: t("healthInterrupts"), value: interruptsPerDay, display: String(interruptsPerDay), color: healthColor(interruptsPerDay, 100, 500), barPct: Math.min(100, interruptsPerDay / 10) },
    { id: "coldStarts", label: t("healthColdStarts"), value: coldStarts, display: String(coldStarts), color: healthColor(coldStarts, 0, 5), barPct: Math.min(100, coldStarts * 10) },
    { id: "retries", label: t("healthRetries"), value: retriesPerDay, display: String(retriesPerDay), color: healthColor(retriesPerDay, 50, 200), barPct: Math.min(100, retriesPerDay / 5) },
    { id: "false429", label: t("healthFalse429"), value: false429s, display: String(false429s), color: healthColor(false429s, 0, 1), barPct: Math.min(100, false429s * 50) },
    { id: "truncations", label: t("healthTruncations"), value: truncPerDay, display: String(truncPerDay), color: healthColor(truncPerDay, 0, 5), barPct: Math.min(100, truncPerDay * 10) },
    { id: "contextResets", label: t("healthContextResets"), value: contextResets, display: String(contextResets), color: healthColor(contextResets, 0, 3), barPct: Math.min(100, contextResets * 20) },
    { id: "quotaBench", label: t("healthQuotaBench"), value: tokPerPct, display: tokPerPctM, color: tokPerPct > 0 ? healthColor(tokPerPct / 1000000, 2.1, 3) : "gray", barPct: tokPerPct > 0 ? Math.min(100, tokPerPct / 21000) : 0 },
    { id: "anomalStops", label: t("healthAnomalStops"), value: anomalStops, display: String(anomalStops), color: healthColor(anomalStops, 0, 10), barPct: Math.min(100, anomalStops * 5) }
  ];
}

function renderHealthScore(data) {
  var headerEl = document.getElementById("health-header");
  var gridEl = document.getElementById("health-grid");
  if (!headerEl || !gridEl) return;

  var fp = (data.generated || "") + "|" + ((data.proxy && data.proxy.generated) || "");
  if (fp === __lastHealthFingerprint) return;
  __lastHealthFingerprint = fp;

  var days = data.days || [];
  var proxy = data.proxy || {};
  var pdays = proxy.proxy_days || [];
  if (!days.length && !pdays.length) {
    headerEl.innerHTML = "<span style=\"color:#94a3b8\">" + escHtml(t("healthScoreNoData")) + "</span>";
    gridEl.innerHTML = "";
    return;
  }

  var indicators = computeHealthIndicators(data);
  var totalPts = 0, warns = 0, crits = 0;
  for (var i = 0; i < indicators.length; i++) {
    totalPts += healthPoints(indicators[i].color);
    if (indicators[i].color === "yellow") warns++;
    if (indicators[i].color === "red") crits++;
  }
  var score = Math.round(totalPts / (indicators.length * 2) * 10);
  var scoreColor = score > 7 ? "#22c55e" : score >= 4 ? "#f59e0b" : "#ef4444";

  // Header
  var hh = "<div class=\"health-total-circle\" style=\"background:" + scoreColor + "\">" + score + "</div>";
  hh += "<div class=\"health-total-text\">";
  hh += "<strong>" + escHtml(t("healthScoreTitle")) + "</strong><br>";
  hh += "<span" + (crits > 0 ? " class=\"health-crits\"" : warns > 0 ? " class=\"health-warns\"" : "") + ">";
  hh += escHtml(tr("healthScoreSummary", { score: score, warns: warns, crits: crits }));
  hh += "</span></div>";
  if (headerEl.innerHTML !== hh) headerEl.innerHTML = hh;

  // Update collapsed summary: score circle + inline indicator dots + findings count
  var smCircle = document.getElementById("health-circle-sm");
  var smText = document.getElementById("health-summary-text");
  if (smCircle) { smCircle.style.background = scoreColor; smCircle.textContent = score; }
  if (smText) {
    var sh = "";
    for (var si = 0; si < indicators.length; si++) {
      var ind = indicators[si];
      var dc = ind.color === "red" ? "#ef4444" : ind.color === "yellow" ? "#f59e0b" : "#22c55e";
      sh += '<span class="hs-inline-badge"><span class="hs-inline-dot" style="background:' + dc + '"></span>' + escHtml(ind.label) + ' <strong>' + escHtml(ind.display) + '</strong></span>';
    }

    smText.innerHTML = sh;
  }
  renderUptimeChart(data);
  renderIncidentHistory(data);
  renderOutageTimeline(data);
  renderAvailabilityKpis(data);

  // Grid
  var gh = "";
  for (var gi = 0; gi < indicators.length; gi++) {
    var ind = indicators[gi];
    gh += "<div class=\"health-badge health-badge--" + ind.color + "\">";
    gh += "<div class=\"health-badge-label\">" + escHtml(ind.label) + "</div>";
    gh += "<div class=\"health-badge-value\">" + escHtml(ind.display) + "</div>";
    gh += "<div class=\"health-badge-bar\"><div class=\"health-badge-bar-fill health-badge-bar-fill--" + ind.color + "\" style=\"width:" + Math.round(ind.barPct) + "%\"></div></div>";
    gh += "</div>";
  }
  if (gridEl.innerHTML !== gh) gridEl.innerHTML = gh;
}

// ── Key Findings Panel ────────────────────────────────────────────────────
var __lastFindingsFingerprint = "";

function computeKeyFindings(data) {
  var days = data.days || [];
  var proxy = data.proxy || {};
  var pdays = proxy.proxy_days || [];
  var pd = pdays.length > 0 ? pdays[pdays.length - 1] : null;
  var numDays = days.length || 1;
  var findings = [];

  // Totals from JSONL
  var totalOut = 0, totalCache = 0, totalAll = 0, totalCalls = 0;
  var totalHits = 0, totalRetries = 0, totalInterrupts = 0, totalContinue = 0;
  var peakDay = null, peakTotal = 0;
  for (var i = 0; i < days.length; i++) {
    var d = days[i];
    totalOut += (d.output || 0);
    totalCache += (d.cache_read || 0);
    totalAll += (d.total || 0);
    totalCalls += (d.calls || 0);
    totalHits += (d.hit_limit || 0);
    var ss = d.session_signals || {};
    totalRetries += (ss.retry || 0);
    totalInterrupts += (ss.interrupt || 0);
    totalContinue += (ss["continue"] || 0);
    if ((d.total || 0) > peakTotal) { peakTotal = d.total || 0; peakDay = d; }
  }

  // 1. Thinking Token Gap
  if (pd && days.length) {
    var todayJ = null;
    for (var j = 0; j < days.length; j++) { if (days[j].date === pd.date) { todayJ = days[j]; break; } }
    if (todayJ && pd.total_tokens > 0) {
      var gap = (todayJ.total || 0) / pd.total_tokens;
      findings.push({
        icon: gap > 5 ? "red" : gap > 2 ? "yellow" : "green",
        title: t("findingThinkingGap"),
        value: gap.toFixed(1) + "x",
        detail: tr("findingThinkingGapDetail", { jsonl: fmt(todayJ.total || 0), proxy: fmt(pd.total_tokens) })
      });
    }
  }

  // 2. Overhead
  if (totalOut > 0) {
    var overhead = Math.round(totalAll / totalOut);
    findings.push({
      icon: overhead > 1000 ? "red" : overhead > 500 ? "yellow" : "green",
      title: t("findingOverhead"),
      value: overhead + "x",
      detail: tr("findingOverheadDetail", { total: fmt(totalAll), output: fmt(totalOut), days: numDays })
    });
  }

  // 3. Hit Limits
  if (totalHits > 0) {
    var hpd = Math.round(totalHits / numDays);
    findings.push({
      icon: hpd > 500 ? "red" : hpd > 50 ? "yellow" : "green",
      title: t("findingHitLimits"),
      value: fmt(totalHits),
      detail: tr("findingHitLimitsDetail", { total: totalHits, perDay: hpd, days: numDays })
    });
  }

  // 4. Interrupts vs Hit Limits
  if (totalInterrupts > 0) {
    findings.push({
      icon: totalInterrupts > totalHits ? "red" : "yellow",
      title: t("findingInterrupts"),
      value: fmt(totalInterrupts),
      detail: tr("findingInterruptsDetail", { interrupts: totalInterrupts, hits: totalHits, ratio: totalHits > 0 ? (totalInterrupts / totalHits).toFixed(1) : "-" })
    });
  }

  // 5. Quota (from proxy)
  if (pd) {
    var rl = pd.rate_limit || {};
    var q5 = Number.parseFloat(rl["anthropic-ratelimit-unified-5h-utilization"] || 0) * 100;
    var q7 = Number.parseFloat(rl["anthropic-ratelimit-unified-7d-utilization"] || 0) * 100;
    if (q5 > 0) {
      findings.push({
        icon: q5 > 80 ? "red" : q5 > 50 ? "yellow" : "green",
        title: t("findingQuota"),
        value: q5.toFixed(0) + "% / " + q7.toFixed(0) + "%",
        detail: tr("findingQuotaDetail", { q5: q5.toFixed(1), q7: q7.toFixed(1), reqs: pd.requests || 0, output: fmt(pd.output_tokens || 0) })
      });
    }
  }

  // 6. Fallback Budget (from proxy headers)
  if (pd) {
    var rl6 = pd.rate_limit || {};
    var fb = rl6["anthropic-ratelimit-unified-fallback-percentage"];
    if (fb !== undefined && fb !== null) {
      var fbPct = Math.round(Number.parseFloat(fb) * 100);
      findings.push({
        icon: fbPct < 100 ? "red" : "green",
        title: t("findingFallback"),
        value: fbPct + "%",
        detail: tr("findingFallbackDetail", { pct: fbPct })
      });
    }
  }

  // 7. Overage Policy (from proxy headers)
  if (pd) {
    var rl7 = pd.rate_limit || {};
    var ovStatus = rl7["anthropic-ratelimit-unified-overage-status"];
    var ovReason = rl7["anthropic-ratelimit-unified-overage-disabled-reason"];
    if (ovStatus) {
      findings.push({
        icon: ovStatus === "rejected" ? "red" : "green",
        title: t("findingOveragePolicy"),
        value: ovStatus,
        detail: ovReason ? tr("findingOveragePolicyDetail", { status: ovStatus, reason: ovReason }) : ovStatus
      });
    }
  }

  // 8. Binding Window (from proxy headers)
  if (pd) {
    var rl8 = pd.rate_limit || {};
    var claim = rl8["anthropic-ratelimit-unified-representative-claim"];
    if (claim) {
      findings.push({
        icon: claim === "five_hour" ? "yellow" : "green",
        title: t("findingClaim"),
        value: claim.replaceAll("_", " "),
        detail: t("findingClaimDetail")
      });
    }
  }

  // 9. Peak Day
  if (peakDay) {
    findings.push({
      icon: peakTotal > 2e9 ? "red" : peakTotal > 500e6 ? "yellow" : "green",
      title: t("findingPeakDay"),
      value: peakDay.date,
      detail: tr("findingPeakDayDetail", { total: fmt(peakTotal), calls: peakDay.calls || 0, overhead: peakDay.overhead || 0 })
    });
  }

  // 10. Retries
  if (totalRetries > 0) {
    var rpd = Math.round(totalRetries / numDays);
    findings.push({
      icon: rpd > 200 ? "red" : rpd > 50 ? "yellow" : "green",
      title: t("findingRetries"),
      value: fmt(totalRetries),
      detail: tr("findingRetriesDetail", { total: totalRetries, perDay: rpd })
    });
  }

  // 11. Cache paradox
  if (pd && pd.cache_read_ratio > 0.9 && totalHits > 100) {
    findings.push({
      icon: "yellow",
      title: t("findingCacheParadox"),
      value: (pd.cache_read_ratio * 100).toFixed(1) + "%",
      detail: t("findingCacheParadoxDetail")
    });
  }

  return findings;
}

function renderKeyFindings(data) {
  var el = document.getElementById("key-findings-grid");
  var headerEl = document.getElementById("key-findings-header");
  if (!el) return;

  var fp = (data.generated || "") + "|" + ((data.proxy && data.proxy.generated) || "");
  if (fp === __lastFindingsFingerprint) return;
  __lastFindingsFingerprint = fp;

  var days = data.days || [];
  var pdays = data.proxy?.proxy_days || [];
  if (!days.length && !pdays.length) {
    if (headerEl) headerEl.textContent = t("findingsNoData");
    el.innerHTML = "";
    return;
  }

  var findings = computeKeyFindings(data);
  if (headerEl) {
    var reds = 0, yellows = 0;
    for (var c = 0; c < findings.length; c++) {
      if (findings[c].icon === "red") reds++;
      if (findings[c].icon === "yellow") yellows++;
    }
    headerEl.innerHTML = "<strong>" + escHtml(t("findingsTitle")) + "</strong> <span style=\"font-size:.78rem;color:#94a3b8\">" +
      escHtml(tr("findingsSummary", { total: findings.length, reds: reds, yellows: yellows })) + "</span>";
  }

  var html = "";
  for (var fi = 0; fi < findings.length; fi++) {
    var f = findings[fi];
    var dot = f.icon === "red" ? "#ef4444" : f.icon === "yellow" ? "#f59e0b" : "#22c55e";
    html += "<div class=\"finding-card\">";
    html += "<div class=\"finding-head\"><span class=\"finding-dot\" style=\"background:" + dot + "\"></span>";
    html += "<span class=\"finding-title\">" + escHtml(f.title) + "</span>";
    html += "<span class=\"finding-value\">" + escHtml(f.value) + "</span></div>";
    html += "<div class=\"finding-detail\">" + escHtml(f.detail) + "</div>";
    html += "</div>";
  }
  if (el.innerHTML !== html) el.innerHTML = html;
}

// ── Filter Bar ────────────────────────────────────────────────────────────
function initFilterBar(data) {
  var days = data.days || [];
  if (!days.length) return;

  // Filter bar title
  var ftitle = document.getElementById('filter-bar-title');
  if (ftitle) ftitle.textContent = t('filterBarTitle');
  // Date labels
  var dlabel = document.getElementById('filter-date-label');
  if (dlabel) dlabel.textContent = t('filterDateRange');
  var slabel = document.getElementById('filter-scope-label');
  if (slabel) slabel.textContent = t('filterScope');
  var hlabel = document.getElementById('filter-host-label');
  if (hlabel) hlabel.textContent = t('filterHost');

  // Date range selects
  var startEl = document.getElementById('filter-date-start');
  var endEl = document.getElementById('filter-date-end');
  if (startEl && endEl && days.length && !startEl.dataset.bound) {
    startEl.dataset.bound = '1';
    var opts = '';
    for (var di = 0; di < days.length; di++) opts += '<option value="' + escHtml(days[di].date) + '">' + escHtml(days[di].date) + '</option>';
    startEl.innerHTML = opts;
    endEl.innerHTML = opts;
    startEl.value = days[0].date;
    endEl.value = days[days.length - 1].date;
  }

  // Scope chips (All days / 24h) — mirror existing main-charts-scope
  var scopeChips = document.getElementById('filter-scope-chips');
  if (scopeChips && !scopeChips.dataset.bound) {
    scopeChips.dataset.bound = '1';
    scopeChips.innerHTML = '<button type="button" class="filter-chip active" data-scope="timeline">' + escHtml(t('mainChartsScopeTimeline')) + '</button>' +
      '<button type="button" class="filter-chip" data-scope="hourly">' + escHtml(t('mainChartsScopeHourly')) + '</button>';
    scopeChips.addEventListener('click', function(e) {
      var btn = e.target.closest('.filter-chip');
      if (!btn || !btn.dataset.scope) return;
      scopeChips.querySelectorAll('.filter-chip').forEach(function(c) { c.classList.remove('active'); });
      btn.classList.add('active');
      // Sync with existing scope chips
      var existing = document.getElementById('main-charts-scope-chips');
      if (existing) {
        var btns = existing.querySelectorAll('[data-scope]');
        for (var i = 0; i < btns.length; i++) {
          if (btns[i].dataset.scope === btn.dataset.scope) btns[i].click();
        }
      }
    });
  }

  // Host filter: chips if <=3, multi-select if 4+
  var hostContainer = document.getElementById('filter-host-container');
  if (hostContainer && days.length && !hostContainer.dataset.bound) {
    hostContainer.dataset.bound = '1';
    var hosts = {};
    for (var hdi = 0; hdi < days.length; hdi++) {
      var dh = days[hdi].hosts || {};
      for (var hk in dh) { if (Object.prototype.hasOwnProperty.call(dh, hk)) hosts[hk] = true; }
    }
    var hkeys = Object.keys(hosts).sort(function (a, b) { return a.localeCompare(b); });
    if (hkeys.length <= 5) {
      // Chips mode
      var hhtml = '<div class="filter-chips">';
      hhtml += '<button type="button" class="filter-chip active" data-host="">' + escHtml(t('filterHostAll')) + '</button>';
      for (var hci = 0; hci < hkeys.length; hci++) {
        hhtml += '<button type="button" class="filter-chip" data-host="' + escHtml(hkeys[hci]) + '">' + escHtml(hkeys[hci]) + '</button>';
      }
      hhtml += '</div>';
      hostContainer.innerHTML = hhtml;
      hostContainer.addEventListener('click', function(e) {
        var btn = e.target.closest('.filter-chip');
        if (!btn) return;
        hostContainer.querySelectorAll('.filter-chip').forEach(function(c) { c.classList.remove('active'); });
        btn.classList.add('active');
        // Sync with forensic host filter + persist in sessionStorage
        var hostVal = btn.dataset.host || "";
        __forensicHostFilterSig = hostVal;
        try {
          if (hostVal) sessionStorage.setItem("usageForensicHostFilter", hostVal);
          else sessionStorage.removeItem("usageForensicHostFilter");
        } catch(ehf) {}
        if (__lastUsageData) renderDashboard(__lastUsageData, true);
      });
    } else {
      // Multi-select mode
      var hopts = '<option value="" selected>' + escHtml(t('filterHostAll')) + '</option>';
      for (var hsi = 0; hsi < hkeys.length; hsi++) {
        hopts += '<option value="' + escHtml(hkeys[hsi]) + '">' + escHtml(hkeys[hsi]) + '</option>';
      }
      hostContainer.innerHTML = '<select class="filter-input" multiple size="' + Math.min(hkeys.length + 1, 6) + '">' + hopts + '</select>';
      hostContainer.querySelector('select').addEventListener('change', function() {
        if (__lastUsageData) renderDashboard(__lastUsageData, true);
      });
    }
  }

  // Day picker in filter bar — mirror the original day-picker
  var fDayPicker = document.getElementById('filter-day-picker');
  var origDayPicker = document.getElementById('day-picker');
  var fDayLabel = document.getElementById('filter-day-label');
  if (fDayLabel) fDayLabel.textContent = t('dayPickerLabel');
  if (fDayPicker && origDayPicker) {
    // Copy options from original
    fDayPicker.innerHTML = origDayPicker.innerHTML;
    fDayPicker.value = origDayPicker.value;
    fDayPicker.addEventListener('change', function() {
      origDayPicker.value = this.value;
      origDayPicker.dispatchEvent(new Event('change'));
    });
    // Watch original for changes
    var _origObserver = new MutationObserver(function() {
      if (fDayPicker.innerHTML !== origDayPicker.innerHTML) fDayPicker.innerHTML = origDayPicker.innerHTML;
      if (fDayPicker.value !== origDayPicker.value) fDayPicker.value = origDayPicker.value;
    });
    _origObserver.observe(origDayPicker, { childList: true, attributes: true });
  }

  // Date change listeners
  if (startEl) startEl.addEventListener('change', onFilterDateChange);
  if (endEl) endEl.addEventListener('change', onFilterDateChange);
}

function onFilterDateChange() {
  if (__lastUsageData) renderDashboard(__lastUsageData, true);
}

// ── Plan Selector ───────────────────────────────────────────────────────
var __planLabels = { max5: "MAX 5", max20: "MAX 20", pro: "Pro", free: "Free", api: "API" };

function getSelectedPlan() {
  var sel = document.getElementById("plan-select");
  return sel ? sel.value : (localStorage.getItem("cud_plan") || "max5");
}

function getSelectedPlanLabel() {
  return __planLabels[getSelectedPlan()] || "MAX 5";
}

(function initPlanSelector() {
  var saved = localStorage.getItem("cud_plan") || "max5";
  var sel = document.getElementById("plan-select");
  if (sel) {
    sel.value = saved;
    sel.addEventListener("change", function() {
      localStorage.setItem("cud_plan", sel.value);
      if (__lastUsageData) renderDashboard(__lastUsageData, true);
    });
  }
})();

function getFilterDateRange() {
  var s = document.getElementById('filter-date-start');
  var e = document.getElementById('filter-date-end');
  return { start: s ? s.value : '', end: e ? e.value : '' };
}

// ── Health Score History ──────────────────────────────────────────────────
function computeHealthScoreForDay(dayData, proxyDay) {
  var pd = proxyDay || null;
  var d = dayData;
  var ss = d.session_signals || {};
  var hits = d.hit_limit || 0;
  var interrupts = ss.interrupt || 0;
  var retries = ss.retry || 0;
  var rl = pd ? (pd.rate_limit || {}) : {};
  var q5h = Number.parseFloat(rl["anthropic-ratelimit-unified-5h-utilization"] || 0) * 100;
  var cacheRatio = pd ? ((pd.cache_read_ratio || 0) * 100) : 95;
  var errorRate = pd ? (pd.error_rate || 0) : 0;
  var avgLatS = pd ? ((pd.avg_duration_ms || 0) / 1000) : 5;
  var coldStarts = pd ? (pd.cold_starts || 0) : 0;
  var thinkingGap = (pd && pd.total_tokens > 0 && d.total > 0) ? d.total / pd.total_tokens : 0;

  var colors = [
    healthColor(q5h, 50, 80),
    thinkingGap <= 0 ? "green" : healthColor(thinkingGap, 2, 5),
    healthColorInverse(cacheRatio, 90, 70),
    healthColor(errorRate, 3, 10),
    healthColor(hits, 50, 500),
    healthColor(avgLatS, 5, 15),
    healthColor(interrupts, 100, 500),
    healthColor(coldStarts, 0, 5),
    healthColor(retries, 50, 200)
  ];
  var pts = 0;
  for (var i = 0; i < colors.length; i++) pts += healthPoints(colors[i]);
  return Math.round(pts / (colors.length * 2) * 10);
}

function buildHealthScoreHistory(data) {
  var days = getFilteredDays(data.days || []);
  var proxyDays = data.proxy?.proxy_days || [];
  var proxyByDate = {};
  for (var pi = 0; pi < proxyDays.length; pi++) proxyByDate[proxyDays[pi].date] = proxyDays[pi];
  var scores = [];
  for (var di = 0; di < days.length; di++) {
    scores.push(computeHealthScoreForDay(days[di], proxyByDate[days[di].date] || null));
  }
  return scores;
}

// ── Uptime Chart (24h stacked by component status) ───────────────────────
function renderUptimeChart(data) {
  if (typeof Chart === "undefined") return;
  var el = document.getElementById("c-uptime-chart");
  if (!el) return;
  var titleEl = document.getElementById("uptime-chart-title");
  if (titleEl) titleEl.textContent = t("uptimeChartTitle");

  // Apply month filter (same as outage timeline)
  var srcDays = _outageTimelineMonthFilter ? (data.days || []) : getFilteredDays(data.days || []);
  var filtDays = [];
  for (var fi = 0; fi < srcDays.length; fi++) {
    if (_outageTimelineMonthFilter && srcDays[fi].date && srcDays[fi].date.slice(0, 7) !== _outageTimelineMonthFilter) continue;
    filtDays.push(srcDays[fi]);
  }
  if (filtDays.length < 1) filtDays = getFilteredDays(data.days || []);

  // Pad month with empty days
  var dayMap = {};
  for (var dm = 0; dm < filtDays.length; dm++) dayMap[filtDays[dm].date] = filtDays[dm];
  var days = [];
  if (_outageTimelineMonthFilter) {
    var parts = _outageTimelineMonthFilter.split("-");
    var yr = parseInt(parts[0], 10), mo = parseInt(parts[1], 10);
    var dim = new Date(yr, mo, 0).getDate();
    for (var pd = 1; pd <= dim; pd++) {
      var dk = yr + "-" + String(mo).padStart(2, "0") + "-" + String(pd).padStart(2, "0");
      days.push(dayMap[dk] || { date: dk, outage_spans: [], _empty: true });
    }
  } else {
    days = filtDays;
  }
  if (days.length < 2) return;

  var labels = [], opData = [], degData = [], partData = [], outData = [], greyData = [];

  for (var di = 0; di < days.length; di++) {
    var d = days[di];
    labels.push(d.date.slice(5));
    if (d._empty) {
      opData.push(0); degData.push(0); partData.push(0); outData.push(0); greyData.push(24);
      continue;
    }
    var spans = d.outage_spans || [];

    // Total hours by comp_status (unfiltered)
    var totalByStatus = { major_outage: 0, partial_outage: 0, degraded_performance: 0 };
    for (var sa = 0; sa < spans.length; sa++) {
      var aCs = spans[sa].comp_status || "degraded_performance";
      var aDur = (spans[sa].to || 0) - (spans[sa].from || 0);
      if (aDur < 0) aDur = 0;
      if (totalByStatus[aCs] !== undefined) totalByStatus[aCs] += aDur;
      else totalByStatus.degraded_performance += aDur;
    }

    var totalInc = totalByStatus.major_outage + totalByStatus.partial_outage + totalByStatus.degraded_performance;
    if (totalInc > 24) {
      var sc = 24 / totalInc;
      totalByStatus.major_outage *= sc; totalByStatus.partial_outage *= sc; totalByStatus.degraded_performance *= sc;
      totalInc = 24;
    }

    // Apply status exclude filter
    var visOut = _outageStatusExclude["major_outage"] ? 0 : totalByStatus.major_outage;
    var visPart = _outageStatusExclude["partial_outage"] ? 0 : totalByStatus.partial_outage;
    var visDeg = _outageStatusExclude["degraded_performance"] ? 0 : totalByStatus.degraded_performance;
    var visInc = visOut + visPart + visDeg;
    var opH = 24 - totalInc;
    var visOp = _outageStatusExclude["operational"] ? 0 : opH;
    var greyH = (totalByStatus.major_outage - visOut) + (totalByStatus.partial_outage - visPart) + (totalByStatus.degraded_performance - visDeg) + (opH - visOp);
    if (greyH < 0) greyH = 0;

    opData.push(Math.round(visOp * 10) / 10);
    degData.push(Math.round(visDeg * 10) / 10);
    partData.push(Math.round(visPart * 10) / 10);
    outData.push(Math.round(visOut * 10) / 10);
    greyData.push(Math.round(greyH * 10) / 10);
  }

  if (_proxyCharts.uptimeChart) {
    _proxyCharts.uptimeChart.destroy();
    _proxyCharts.uptimeChart = null;
  }

  _proxyCharts.uptimeChart = new Chart(el.getContext("2d"), {
    type: "bar",
    data: {
      labels: labels,
      datasets: [
        { label: t("uptimeOperational"), data: opData, backgroundColor: "rgba(34,197,94,.3)", borderColor: "rgba(34,197,94,.5)", borderWidth: 1, stack: "s" },
        { label: t("uptimeDegraded"), data: degData, backgroundColor: "rgba(245,158,11,.3)", borderColor: "rgba(245,158,11,.6)", borderWidth: 1, stack: "s" },
        { label: t("uptimePartial"), data: partData, backgroundColor: "rgba(249,115,22,.35)", borderColor: "rgba(249,115,22,.7)", borderWidth: 1, stack: "s" },
        { label: t("uptimeOutage"), data: outData, backgroundColor: "rgba(239,68,68,.4)", borderColor: "rgba(239,68,68,.7)", borderWidth: 1, stack: "s" },
        { label: "", data: greyData, backgroundColor: "rgba(51,65,85,.45)", borderColor: "rgba(51,65,85,.55)", borderWidth: 1, stack: "s", hidden: false }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      transitions: __chartTransitionsOff,
      layout: { padding: { left: 0, right: 2, top: 4, bottom: 0 } },
      interaction: { mode: "index", intersect: false },
      scales: {
        x: { stacked: true, ticks: { color: "#cbd5e1", font: { size: _cf().tick } }, grid: { color: "rgba(51,65,85,.3)" } },
        y: { stacked: true, max: 24, ticks: { color: "#cbd5e1", font: { size: _cf().tick }, stepSize: 6, callback: function(v) { return v + "h"; } }, grid: { color: "rgba(51,65,85,.3)" } }
      },
      plugins: {
        legend: { labels: { color: "#f8fafc", boxWidth: 12, font: { size: _cf().legend } } },
        tooltip: {
          titleFont: { size: _cf().tooltip },
          bodyFont: { size: _cf().tooltip },
          callbacks: {
            label: function(ctx) { return ctx.dataset.label + ": " + ctx.parsed.y + "h"; }
          }
        }
      }
    }
  });
  __scheduleAnthropicHealthChartsResize();
}

// ── Incident History Chart ────────────────────────────────────────────────
function renderIncidentHistory(data) {
  if (typeof Chart === "undefined") return;
  var el = document.getElementById("c-incident-history");
  if (!el) return;
  var titleEl = document.getElementById("incident-history-title");
  if (titleEl) titleEl.textContent = t("incidentHistoryLabel");

  var titleOT = document.getElementById("outage-timeline-title");
  if (titleOT) titleOT.textContent = t("outageTimelineTitle");

  // Apply same month filter as other charts
  var srcDays = _outageTimelineMonthFilter ? (data.days || []) : getFilteredDays(data.days || []);
  var days = [];
  for (var fi = 0; fi < srcDays.length; fi++) {
    if (_outageTimelineMonthFilter && srcDays[fi].date && srcDays[fi].date.slice(0, 7) !== _outageTimelineMonthFilter) continue;
    days.push(srcDays[fi]);
  }
  if (days.length < 1) days = getFilteredDays(data.days || []);
  if (days.length < 2) return;

  var labels = [];
  var critH = [], majorH = [], minorH = [], greyH = [];
  var hitLimits = [];

  for (var i = 0; i < days.length; i++) {
    var d = days[i];
    labels.push(d.date.slice(5));
    hitLimits.push(d.hit_limit || 0);

    var spans = d.outage_spans || [];
    var bySev = { critical: 0, major: 0, minor: 0 };
    var excludedH = 0;
    for (var si = 0; si < spans.length; si++) {
      var imp = spans[si].impact || "none";
      if (imp === "none") continue; // none = uptime, skip
      var dur = (spans[si].to || 0) - (spans[si].from || 0);
      if (dur < 0) dur = 0;
      if (_outageImpactExclude[imp]) { excludedH += dur; continue; }
      if (bySev[imp] !== undefined) bySev[imp] += dur;
    }
    critH.push(Math.round(bySev.critical * 10) / 10);
    majorH.push(Math.round(bySev.major * 10) / 10);
    minorH.push(Math.round(bySev.minor * 10) / 10);
    greyH.push(Math.round(excludedH * 10) / 10);
  }

  if (_proxyCharts.incidentHistory) {
    _proxyCharts.incidentHistory.destroy();
    _proxyCharts.incidentHistory = null;
  }

  _proxyCharts.incidentHistory = new Chart(el.getContext("2d"), {
    type: "bar",
    data: {
      labels: labels,
      datasets: [
        { label: "critical", data: critH, backgroundColor: "rgba(239,68,68,.4)", borderColor: "rgba(239,68,68,.7)", borderWidth: 1, yAxisID: "y", stack: "inc" },
        { label: "major", data: majorH, backgroundColor: "rgba(249,115,22,.35)", borderColor: "rgba(249,115,22,.6)", borderWidth: 1, yAxisID: "y", stack: "inc" },
        { label: "minor", data: minorH, backgroundColor: "rgba(245,158,11,.3)", borderColor: "rgba(245,158,11,.6)", borderWidth: 1, yAxisID: "y", stack: "inc" },
        { label: "", data: greyH, backgroundColor: "rgba(51,65,85,.45)", borderColor: "rgba(51,65,85,.55)", borderWidth: 1, yAxisID: "y", stack: "inc", hidden: false },
        { label: t("incidentDSHitLimits"), data: hitLimits, type: "line", borderColor: "#f59e0b", backgroundColor: "rgba(245,158,11,.1)", yAxisID: "y1", tension: 0.3, pointRadius: 3, fill: true }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      transitions: __chartTransitionsOff,
      layout: { padding: { left: 0, right: 4, top: 4, bottom: 0 } },
      interaction: { mode: "index", intersect: false },
      scales: {
        x: { stacked: true, ticks: { color: "#cbd5e1", font: { size: _cf().tick } }, grid: { color: "rgba(51,65,85,.4)" } },
        y: { stacked: true, position: "left", ticks: { color: "#cbd5e1", font: { size: _cf().tick } }, grid: { color: "rgba(51,65,85,.4)" }, beginAtZero: true, title: { display: true, text: t("incidentAxisOutage"), color: "#cbd5e1", font: { size: _cf().title } } },
        y1: { position: "right", ticks: { color: "#f59e0b", font: { size: _cf().tick } }, grid: { drawOnChartArea: false }, beginAtZero: true, title: { display: true, text: t("incidentAxisHitLimits"), color: "#f59e0b", font: { size: _cf().title } } }
      },
      plugins: {
        legend: { labels: { color: "#f8fafc", boxWidth: 12, font: { size: _cf().legend }, filter: function(item) { return item.text !== ""; } } },
        tooltip: {
          titleFont: { size: _cf().tooltip },
          bodyFont: { size: _cf().tooltip },
          callbacks: {
            label: function(ctx) { if (!ctx.dataset.label) return null; return ctx.dataset.label + ": " + ctx.parsed.y + (ctx.dataset.yAxisID === "y1" ? "" : "h"); }
          }
        }
      }
    }
  });
  __scheduleAnthropicHealthChartsResize();
}


function updateAnthropicPopup(data) {
  if (typeof Chart === "undefined") return;
  var el = document.getElementById("c-anthropic-incidents");
  if (!el) return;

  var label = document.getElementById("anthropic-label");
  if (label) label.textContent = "Anthropic";



  var days = getFilteredDays(data.days || []);
  if (days.length < 2) return;

  var labels = [];
  var outageH = [];
  var outageColors = [];
  var incidentCounts = [];
  for (var i = 0; i < days.length; i++) {
    var d = days[i];
    labels.push(d.date.slice(5));
    var oh = d.outage_hours || 0;
    outageH.push(oh);
    outageColors.push(oh > 2 ? "rgba(239,68,68,.08)" : oh > 0 ? "rgba(245,158,11,.08)" : "rgba(51,65,85,.05)");
    incidentCounts.push((d.outage_incidents || []).length);
  }

  if (_proxyCharts.anthropicIncidents) {
    freezeChartNoAnim(_proxyCharts.anthropicIncidents);
    _proxyCharts.anthropicIncidents.data.labels = labels;
    _proxyCharts.anthropicIncidents.data.datasets[0].data = outageH;
    _proxyCharts.anthropicIncidents.data.datasets[0].backgroundColor = outageColors;
    _proxyCharts.anthropicIncidents.data.datasets[1].data = incidentCounts;
    _proxyCharts.anthropicIncidents.update("none");
    return;
  }

  _proxyCharts.anthropicIncidents = new Chart(el.getContext("2d"), {
    type: "bar",
    data: {
      labels: labels,
      datasets: [
        { label: t("incidentDSOutageHours"), data: outageH, backgroundColor: outageColors, borderColor: outageColors.map(function(c) { return c.replace(/,[\d.]+\)/, ",0.8)"); }), borderWidth: 1, yAxisID: "y", borderRadius: 2, barPercentage: 0.35, categoryPercentage: 0.6 },
        { label: "Incidents", data: incidentCounts, type: "scatter", borderColor: "rgba(239,68,68,.8)", backgroundColor: "rgba(239,68,68,.15)", pointRadius: function(ctx) { return ctx.parsed.y > 0 ? 4 : 0; }, pointBorderWidth: 2, pointStyle: "circle", yAxisID: "y1" }
      ]
    },
    options: {
      responsive: true,
      animation: false,
      transitions: __chartTransitionsOff,
      interaction: { mode: "index", intersect: false },
      scales: {
        x: { ticks: { color: "#94a3b8", font: { size: 9 } }, grid: { color: "rgba(51,65,85,.4)" } },
        y: { position: "left", ticks: { color: "#94a3b8" }, grid: { color: "rgba(51,65,85,.4)" }, beginAtZero: true, title: { display: true, text: "Outage (h)", color: "#94a3b8", font: { size: 9 } } },
        y1: { position: "right", ticks: { color: "#ef4444" }, grid: { drawOnChartArea: false }, beginAtZero: true, title: { display: true, text: "Incidents", color: "#ef4444", font: { size: 9 } } }
      },
      plugins: { legend: { labels: { color: "#e2e8f0", boxWidth: 10, font: { size: 10 } } } }
    }
  });
}


// ── Outage Timeline (24h stacked per day) ─────────────────────────────────
var _isModalOpen = false;
var _modalFontScale = { tick: 13, legend: 12, title: 12, tooltip: 12 };
var _popupFontScale = { tick: 10, legend: 10, title: 10, tooltip: 11 };
function _cf() { return _isModalOpen ? _modalFontScale : _popupFontScale; }
var _outageTimelineMonthFilter = null;   // null = all, "2026-03" = single month
var _outageImpactExclude = {};            // { "critical": true, "minor": true } = hidden
var _outageStatusExclude = {};            // { "major_outage": true } = hidden (uptime chart)
function renderOutageTimeline(data, monthFilter) {
  if (typeof Chart === "undefined") return;
  var el = document.getElementById("c-outage-timeline");
  if (!el) return;
  if (monthFilter !== undefined) _outageTimelineMonthFilter = monthFilter;

  var srcDays = _outageTimelineMonthFilter ? (data.days || []) : getFilteredDays(data.days || []);
  var days = [];
  for (var fi = 0; fi < srcDays.length; fi++) {
    if (_outageTimelineMonthFilter && srcDays[fi].date && srcDays[fi].date.slice(0, 7) !== _outageTimelineMonthFilter) continue;
    days.push(srcDays[fi]);
  }
  if (days.length < 1) days = getFilteredDays(data.days || []);
  if (days.length < 2 && !_outageTimelineMonthFilter) return;

  // When filtering by month, pad to full month with empty (future) days
  var dayMap = {};
  for (var dm = 0; dm < days.length; dm++) dayMap[days[dm].date] = days[dm];

  var paddedDays = [];
  if (_outageTimelineMonthFilter) {
    var parts = _outageTimelineMonthFilter.split("-");
    var yr = parseInt(parts[0], 10);
    var mo = parseInt(parts[1], 10);
    var daysInMonth = new Date(yr, mo, 0).getDate();
    for (var pd = 1; pd <= daysInMonth; pd++) {
      var dk = yr + "-" + String(mo).padStart(2, "0") + "-" + String(pd).padStart(2, "0");
      paddedDays.push(dayMap[dk] || { date: dk, outage_spans: [], _empty: true });
    }
  } else {
    paddedDays = days;
  }
  if (paddedDays.length < 2) return;

  var labels = [];
  var critData = [], majorData = [], minorData = [], noneData = [], greyData = [];

  for (var di = 0; di < paddedDays.length; di++) {
    var d = paddedDays[di];
    labels.push(d.date.slice(5));
    if (d._empty) {
      critData.push(0); majorData.push(0); minorData.push(0); noneData.push(0); greyData.push(24);
      continue;
    }
    var spans = d.outage_spans || [];

    // Hours per severity
    var bySev = { critical: 0, major: 0, minor: 0, none: 0 };
    for (var si = 0; si < spans.length; si++) {
      var dur = (spans[si].to || 0) - (spans[si].from || 0);
      if (dur < 0) dur = 0;
      var imp = spans[si].impact || "none";
      if (bySev[imp] !== undefined) bySev[imp] += dur;
      else bySev.none += dur;
    }

    // Cap total to 24h
    var totalInc = bySev.critical + bySev.major + bySev.minor + bySev.none;
    if (totalInc > 24) {
      var scale = 24 / totalInc;
      bySev.critical *= scale; bySev.major *= scale; bySev.minor *= scale; bySev.none *= scale;
      totalInc = 24;
    }

    // Uptime = 24h - all incident hours
    var uptimeH = 24 - totalInc;
    if (uptimeH < 0) uptimeH = 0;

    // none severity = uptime (no impact = service was fine)
    bySev.none += uptimeH;

    // Apply exclude filter: excluded severity → grey
    var greyH = 0;
    var visCrit = bySev.critical, visMajor = bySev.major, visMinor = bySev.minor, visNone = bySev.none;
    if (_outageImpactExclude["critical"]) { greyH += visCrit; visCrit = 0; }
    if (_outageImpactExclude["major"]) { greyH += visMajor; visMajor = 0; }
    if (_outageImpactExclude["minor"]) { greyH += visMinor; visMinor = 0; }
    if (_outageImpactExclude["none"]) { greyH += visNone; visNone = 0; }

    critData.push(Math.round(visCrit * 10) / 10);
    majorData.push(Math.round(visMajor * 10) / 10);
    minorData.push(Math.round(visMinor * 10) / 10);
    noneData.push(Math.round(visNone * 10) / 10);
    greyData.push(Math.round(greyH * 10) / 10);
  }

  if (_proxyCharts.outageTimeline) {
    _proxyCharts.outageTimeline.destroy();
    _proxyCharts.outageTimeline = null;
  }

  // Always stacked bar — thin bars for many days
  var barOpts = paddedDays.length > 31 ? { barPercentage: 0.95, categoryPercentage: 0.95 } : {};
  var xTickOpts = paddedDays.length > 31
    ? { color: "#cbd5e1", font: { size: Math.max(9, _cf().tick - 2) }, maxRotation: 45, autoSkip: true, maxTicksLimit: 25 }
    : { color: "#cbd5e1", font: { size: _cf().tick } };

  var datasets = [
    Object.assign({ label: "none", data: noneData, backgroundColor: "rgba(34,197,94,.25)", borderColor: "rgba(34,197,94,.5)", borderWidth: 1, stack: "s" }, barOpts),
    Object.assign({ label: "critical", data: critData, backgroundColor: "rgba(239,68,68,.35)", borderColor: "rgba(239,68,68,.7)", borderWidth: 1, stack: "s" }, barOpts),
    Object.assign({ label: "major", data: majorData, backgroundColor: "rgba(249,115,22,.3)", borderColor: "rgba(249,115,22,.6)", borderWidth: 1, stack: "s" }, barOpts),
    Object.assign({ label: "minor", data: minorData, backgroundColor: "rgba(245,158,11,.25)", borderColor: "rgba(245,158,11,.6)", borderWidth: 1, stack: "s" }, barOpts),
    Object.assign({ label: "", data: greyData, backgroundColor: "rgba(51,65,85,.45)", borderColor: "rgba(51,65,85,.55)", borderWidth: 1, stack: "s", hidden: false }, barOpts)
  ];
  var scaleOpts = {
    x: { stacked: true, ticks: xTickOpts, grid: { color: "rgba(51,65,85,.3)" } },
    y: { stacked: true, max: 24, ticks: { color: "#cbd5e1", font: { size: _cf().tick }, stepSize: 6, callback: function(v) { return v + "h"; } }, grid: { color: "rgba(51,65,85,.3)" } }
  };

  _proxyCharts.outageTimeline = new Chart(el.getContext("2d"), {
    type: "bar",
    data: { labels: labels, datasets: datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      transitions: __chartTransitionsOff,
      layout: { padding: { left: 0, right: 2, top: 4, bottom: 0 } },
      interaction: { mode: "index", intersect: false },
      scales: scaleOpts,
      plugins: {
        legend: { labels: { color: "#f8fafc", boxWidth: 12, font: { size: _cf().legend }, filter: function(item) { return item.text !== ""; } } },
        tooltip: {
          titleFont: { size: _cf().tooltip },
          bodyFont: { size: _cf().tooltip },
          callbacks: {
            label: function(ctx) { if (!ctx.dataset.label) return null; return ctx.dataset.label + ": " + ctx.parsed.y + "h"; }
          }
        }
      }
    }
  });
  __scheduleAnthropicHealthChartsResize();
}


// ── Availability KPIs (Anthropic popup fold-out) ─────────────────────────
var _lastAvailKpiData = null;
function renderAvailabilityKpis(data) {
  _lastAvailKpiData = data;
  var panel = document.getElementById("avail-kpi-panel");
  var summary = document.getElementById("avail-kpi-summary");
  if (!panel || !summary) return;
  summary.textContent = t("availKpiSummary");

  var allDays = data.days || [];
  if (allDays.length < 2) { panel.innerHTML = ""; return; }

  // ── Collect per-day degradation + uptime + per-incident impact counts ──
  // Degradation = critical + major + minor hours (NOT "none")
  // Outage = only major_outage comp_status hours
  var totalDegradationH = 0;
  var totalOutageH = 0;
  var byMonth = {};       // { "2026-03": { count, hours, days } }
  var byImpact = {};      // { "critical": { count, hours } }
  var seenIncidents = {};  // dedup by name+date

  for (var i = 0; i < allDays.length; i++) {
    var d = allDays[i];
    var spans = d.outage_spans || [];
    var dayDegH = 0;
    for (var si = 0; si < spans.length; si++) {
      var dur = (spans[si].to || 0) - (spans[si].from || 0);
      if (dur < 0) dur = 0;
      var imp = spans[si].impact || "none";
      // Only critical/major/minor count as degradation
      if (imp !== "none") dayDegH += dur;
      if ((spans[si].comp_status || "degraded_performance") === "major_outage") totalOutageH += dur;
      if (!byImpact[imp]) byImpact[imp] = { count: 0, hours: 0 };
      byImpact[imp].hours += dur;
    }
    if (dayDegH > 24) dayDegH = 24;
    totalDegradationH += dayDegH;

    var mk = d.date ? d.date.slice(0, 7) : "";
    if (mk) {
      if (!byMonth[mk]) byMonth[mk] = { count: 0, hours: 0, days: 0 };
      byMonth[mk].hours += dayDegH;
      byMonth[mk].days++;
    }

    var incidents = d.outage_incidents || [];
    for (var ii = 0; ii < incidents.length; ii++) {
      var inc = incidents[ii];
      var ikey = (inc.name || "") + "|" + d.date;
      if (seenIncidents[ikey]) continue;
      seenIncidents[ikey] = true;
      var incImp = inc.impact || "none";
      if (!byImpact[incImp]) byImpact[incImp] = { count: 0, hours: 0 };
      byImpact[incImp].count++;
      if (mk) byMonth[mk].count++;
    }
  }

  var totalDays = allDays.length;
  var totalH = totalDays * 24;
  var uptimePct = totalH > 0 ? ((totalH - totalDegradationH) / totalH * 100) : 100;
  var firstDate = allDays[0].date || "";
  var lastDate = allDays[allDays.length - 1].date || "";

  var realUptimePct = totalH > 0 ? ((totalH - totalOutageH) / totalH * 100) : 100;

  // Median-based color: per-day weighted quality %, sort, take median
  // Severity weights: critical=1, major=0.7, minor=0.3, none=0
  var _sevWeight = { critical: 1, major: 0.7, minor: 0.3, none: 0 };
  var dailySqPcts = [];
  var dailyUtPcts = [];
  for (var dpi = 0; dpi < allDays.length; dpi++) {
    var dpSpans = allDays[dpi].outage_spans || [];
    var dpWeightedH = 0, dpOutH = 0;
    for (var dpsi = 0; dpsi < dpSpans.length; dpsi++) {
      var dpDur = (dpSpans[dpsi].to || 0) - (dpSpans[dpsi].from || 0);
      if (dpDur < 0) dpDur = 0;
      var dpImp = dpSpans[dpsi].impact || "none";
      dpWeightedH += dpDur * (_sevWeight[dpImp] || 0);
      if ((dpSpans[dpsi].comp_status || "degraded_performance") === "major_outage") dpOutH += dpDur;
    }
    if (dpWeightedH > 24) dpWeightedH = 24;
    dailySqPcts.push(((24 - dpWeightedH) / 24 * 100));
    dailyUtPcts.push(dpOutH > 24 ? 0 : ((24 - dpOutH) / 24 * 100));
  }
  dailySqPcts.sort(function(a, b) { return a - b; });
  dailyUtPcts.sort(function(a, b) { return a - b; });
  var medianSq = dailySqPcts.length > 0 ? dailySqPcts[Math.floor(dailySqPcts.length / 2)] : 100;
  var medianUt = dailyUtPcts.length > 0 ? dailyUtPcts[Math.floor(dailyUtPcts.length / 2)] : 100;

  // ITSCM color bands based on MEDIAN (not average)
  var utColorCls = medianUt >= 99.8 ? "ok" : medianUt >= 99 ? "warn" : medianUt >= 95 ? "caution" : "danger";
  var sqColorCls = medianSq >= 99 ? "ok" : medianSq >= 95 ? "warn" : medianSq >= 85 ? "caution" : "danger";

  // ── Build HTML ──
  var h = "";

  var inModal = document.getElementById("anthropic-modal-overlay");
  var isWide = inModal && inModal.classList.contains("is-open");

  var utCCls = medianUt >= 99.8 ? "ok" : medianUt >= 99 ? "warn" : medianUt >= 95 ? "caution" : "danger";
  var sqCCls = medianSq >= 99 ? "ok" : medianSq >= 95 ? "warn" : medianSq >= 85 ? "caution" : "danger";
  var utColorTxt = "avail-" + (medianUt >= 99.8 ? "green" : medianUt >= 99 ? "yellow" : medianUt >= 95 ? "orange" : "red");
  var sqColorTxt = "avail-" + (medianSq >= 99 ? "green" : medianSq >= 95 ? "yellow" : medianSq >= 85 ? "orange" : "red");

  if (isWide) {
    // Popout: full cards side by side (like Peak-Tag Total)
    h += "<div class=\"avail-kpi-cards\">";
    h += "<div class=\"card " + utCCls + "\"><div class=\"label\">" + escHtml(t("cardUptime")) + "</div>";
    h += "<div class=\"value\">" + realUptimePct.toFixed(2) + "%</div>";
    h += "<div class=\"sub\">" + escHtml(firstDate) + " \u2013 " + escHtml(lastDate) + " (" + totalDays + "d)</div></div>";
    h += "<div class=\"card " + sqCCls + "\"><div class=\"label\">" + escHtml(t("cardServiceQuality")) + "</div>";
    h += "<div class=\"value\">" + uptimePct.toFixed(1) + "%</div>";
    h += "<div class=\"sub\">" + escHtml(t("availKpiDowntime")) + ": " + (Math.round(totalDegradationH * 10) / 10) + "h</div></div>";
    h += "</div>";
  } else {
    // Popup: compact inline row
    h += "<div class=\"avail-kpi-row\">";
    h += "<span class=\"avail-kpi-metric\"><span class=\"avail-kpi-label\">" + escHtml(t("cardUptime")) + "</span> <span class=\"" + utColorTxt + " avail-kpi-val\">" + realUptimePct.toFixed(2) + "%</span></span>";
    h += "<span class=\"avail-kpi-metric\"><span class=\"avail-kpi-label\">" + escHtml(t("cardServiceQuality")) + "</span> <span class=\"" + sqColorTxt + " avail-kpi-val\">" + uptimePct.toFixed(1) + "%</span></span>";
    h += "</div>";
  }

  // Monthly table
  var monthKeys = Object.keys(byMonth).sort(function (a, b) { return a.localeCompare(b); });
  if (monthKeys.length > 0) {
    var now = new Date();
    var curMonth = now.getFullYear() + "-" + String(now.getMonth() + 1).padStart(2, "0");

    // Precompute month data
    var totalIncidents = 0;
    var cols = []; // { key, label, count, hours, pct, trendHtml, isCurrent, isActive }
    for (var ti = 0; ti < monthKeys.length; ti++) totalIncidents += byMonth[monthKeys[ti]].count;

    // "Gesamt" column
    var isAllActive = !_outageTimelineMonthFilter;
    cols.push({ key: "__all__", label: t("availKpiTotal"), count: totalIncidents, hours: totalDegradationH, pct: uptimePct, trendHtml: "", isCurrent: false, isActive: isAllActive, bold: true });

    for (var mi = 0; mi < monthKeys.length; mi++) {
      var mk2 = monthKeys[mi];
      var m = byMonth[mk2];
      var mTotalH = m.days * 24;
      var mPct = mTotalH > 0 ? ((mTotalH - m.hours) / mTotalH * 100) : 100;
      var isCurrent = mk2 === curMonth;
      var isActive = mk2 === _outageTimelineMonthFilter;
      var trendHtml = "";
      if (mi > 0) {
        var prev = byMonth[monthKeys[mi - 1]];
        var prevTotalH = prev.days * 24;
        var prevPct = prevTotalH > 0 ? ((prevTotalH - prev.hours) / prevTotalH * 100) : 100;
        var delta = mPct - prevPct;
        if (Math.abs(delta) >= 0.1) {
          var trendCls = delta > 0 ? "trend-up" : "trend-down";
          var arrow = delta > 0 ? "\u2191" : "\u2193";
          trendHtml = "<span class=\"avail-kpi-trend " + trendCls + "\">" + arrow + Math.abs(delta).toFixed(1) + "%</span>";
        }
      }
      var mlabel = mk2.slice(2);  // "26-03" instead of "2026-03"
      if (isCurrent) mlabel += " *";
      cols.push({ key: mk2, label: mlabel, count: m.count, hours: m.hours, pct: mPct, trendHtml: trendHtml, isCurrent: isCurrent, isActive: isActive, bold: false, empty: false });
    }

    // Pad +12 future months from current month
    var padStart = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    for (var fp = 0; fp < 12; fp++) {
      var fy = padStart.getFullYear();
      var fm = padStart.getMonth() + 1;
      var fk = fy + "-" + String(fm).padStart(2, "0");
      if (!byMonth[fk]) {
        var fl = fk.slice(2);
        cols.push({ key: fk, label: fl, count: null, hours: null, pct: null, trendHtml: "", isCurrent: false, isActive: false, bold: false, empty: true });
      }
      padStart.setMonth(padStart.getMonth() + 1);
    }

    if (isWide) {
      // ── Modal: transposed — months as columns, in card wrapper ──
      h += "<div class=\"card\" style=\"margin-top:12px;padding:14px 16px;overflow-x:auto\">";
      h += "<div class=\"label\" style=\"margin-bottom:8px\">" + escHtml(t("availKpiMonth")) + "</div>";
      h += "<table class=\"avail-kpi-table avail-kpi-table-cols\"><thead><tr><th></th>";
      for (var ci = 0; ci < cols.length; ci++) {
        var c = cols[ci];
        var thCls = [];
        if (c.isActive) thCls.push("avail-kpi-col-active");
        if (c.isCurrent) thCls.push("avail-kpi-col-current");
        h += "<th class=\"num" + (thCls.length ? " " + thCls.join(" ") : "") + "\" data-month=\"" + escHtml(c.key) + "\"" + (c.empty ? "" : " style=\"cursor:pointer\"") + ">";
        h += (c.bold ? "<strong>" : "") + escHtml(c.label) + (c.bold ? "</strong>" : "");
        h += "<span style=\"display:inline-block;width:1em;text-align:center\">" + (c.isActive ? "\u25bc" : "") + "</span>";
        h += "</th>";
      }
      h += "</tr></thead><tbody>";
      // Incidents row
      h += "<tr><td>" + escHtml(t("availKpiIncidents")) + "</td>";
      for (var ci2 = 0; ci2 < cols.length; ci2++) {
        h += "<td class=\"num" + (cols[ci2].empty ? " avail-kpi-empty" : "") + "\">" + (cols[ci2].empty ? "\u2013" : cols[ci2].count) + "</td>";
      }
      h += "</tr>";
      // Downtime row
      h += "<tr><td>" + escHtml(t("availKpiDowntime")) + "</td>";
      for (var ci3 = 0; ci3 < cols.length; ci3++) {
        h += "<td class=\"num" + (cols[ci3].empty ? " avail-kpi-empty" : "") + "\">" + (cols[ci3].empty ? "\u2013" : (Math.round(cols[ci3].hours * 10) / 10) + "h") + "</td>";
      }
      h += "</tr>";
      // Availability row
      h += "<tr><td>" + escHtml(t("availKpiAvail")) + "</td>";
      for (var ci4 = 0; ci4 < cols.length; ci4++) {
        var cp = cols[ci4];
        if (cp.empty) {
          h += "<td class=\"num avail-kpi-empty\">\u2013</td>";
        } else {
          var pctCls = cp.pct >= 99 ? "avail-green" : cp.pct >= 95 ? "avail-yellow" : cp.pct >= 85 ? "avail-orange" : "avail-red";
          h += "<td class=\"num\"><span class=\"" + pctCls + "\">" + (cp.bold ? "<strong>" : "") + cp.pct.toFixed(1) + "%" + (cp.bold ? "</strong>" : "") + "</span>";
          if (cp.trendHtml) h += " " + cp.trendHtml;
          h += "</td>";
        }
      }
      h += "</tr>";
      h += "</tbody></table></div>";
    } else {
      h += "<div class=\"avail-kpi-section-head\">" + escHtml(t("availKpiMonth")) + "</div>";
      // ── Popup: classic rows — months as rows, metrics as columns ──
      h += "<table class=\"avail-kpi-table\"><thead><tr>";
      h += "<th>" + escHtml(t("availKpiMonth")) + "</th>";
      h += "<th class=\"num\">" + escHtml(t("availKpiIncidents")) + "</th>";
      h += "<th class=\"num\">" + escHtml(t("availKpiDowntime")) + "</th>";
      h += "<th class=\"num\">" + escHtml(t("availKpiAvail")) + "</th>";
      h += "</tr></thead><tbody>";
      // Only data cols (no future empty months in popup)
      for (var ri = 0; ri < cols.length; ri++) {
        var rc = cols[ri];
        if (rc.empty) continue;
        var rCls = [];
        if (rc.isActive) rCls.push("avail-kpi-month-active");
        if (rc.isCurrent) rCls.push("avail-kpi-month-current");
        h += "<tr" + (rCls.length ? " class=\"" + rCls.join(" ") + "\"" : "") + " data-month=\"" + escHtml(rc.key) + "\" style=\"cursor:pointer\">";
        h += "<td>" + (rc.bold ? "<strong>" + escHtml(rc.label) + "</strong>" : escHtml(rc.label));
        if (rc.isCurrent) h += " <em>" + escHtml(t("availKpiCurrent")) + "</em>";
        if (rc.isActive) h += " \u25c0";
        h += "</td>";
        h += "<td class=\"num\">" + rc.count + "</td>";
        h += "<td class=\"num\">" + (Math.round(rc.hours * 10) / 10) + "h</td>";
        var rpCls = rc.pct >= 99 ? "avail-green" : rc.pct >= 95 ? "avail-yellow" : rc.pct >= 85 ? "avail-orange" : "avail-red";
        h += "<td class=\"num\"><span class=\"" + rpCls + "\">" + (rc.bold ? "<strong>" : "") + rc.pct.toFixed(1) + "%" + (rc.bold ? "</strong>" : "") + "</span>";
        if (rc.trendHtml) h += " " + rc.trendHtml;
        h += "</td></tr>";
      }
      h += "</tbody></table>";
    }
  }

  // Impact breakdown + Status filters
  var impactOrder = ["critical", "major", "minor", "none"];
  var hasImpact = false;
  for (var ci = 0; ci < impactOrder.length; ci++) {
    if (byImpact[impactOrder[ci]]) { hasImpact = true; break; }
  }
  var statusOrder = [
    { key: "operational", label: t("uptimeOperational"), cls: "kind-ok" },
    { key: "degraded_performance", label: t("uptimeDegraded"), cls: "impact-minor" },
    { key: "partial_outage", label: t("uptimePartial"), cls: "impact-major" },
    { key: "major_outage", label: t("uptimeOutage"), cls: "impact-critical" }
  ];

  if (isWide) {
    // Popout: both filter groups side by side in one row
    h += "<div class=\"avail-kpi-filters-row\">";
    if (hasImpact) {
      h += "<div class=\"avail-kpi-filter-group\">";
      h += "<span class=\"avail-kpi-filter-label\">" + escHtml(t("availKpiImpact")) + "</span>";
      for (var bi = 0; bi < impactOrder.length; bi++) {
        var ik = impactOrder[bi];
        var iv = byImpact[ik];
        if (!iv) continue;
        var impExcluded = !!_outageImpactExclude[ik];
        h += "<span class=\"avail-kpi-impact-badge impact-" + ik + (impExcluded ? " impact-excluded" : "") + "\" data-impact=\"" + ik + "\" style=\"cursor:pointer\">";
        h += escHtml(ik) + ": " + iv.count + " / " + (Math.round(iv.hours * 10) / 10) + "h";
        h += "</span>";
      }
      h += "</div>";
    }
    h += "<div class=\"avail-kpi-filter-group\">";
    h += "<span class=\"avail-kpi-filter-label\">Service Status</span>";
    for (var sti = 0; sti < statusOrder.length; sti++) {
      var st = statusOrder[sti];
      var stExcl = !!_outageStatusExclude[st.key];
      h += "<span class=\"avail-kpi-impact-badge " + st.cls + (stExcl ? " impact-excluded" : "") + "\" data-status=\"" + st.key + "\" style=\"cursor:pointer\">";
      h += st.label;
      h += "</span>";
    }
    h += "</div>";
    h += "</div>";
  } else {
    // Popup: stacked with section heads
    if (hasImpact) {
      h += "<div class=\"avail-kpi-section-head\">" + escHtml(t("availKpiImpact")) + "</div>";
      h += "<div class=\"avail-kpi-impact-row\">";
      for (var bi2 = 0; bi2 < impactOrder.length; bi2++) {
        var ik2 = impactOrder[bi2];
        var iv2 = byImpact[ik2];
        if (!iv2) continue;
        var impExcl2 = !!_outageImpactExclude[ik2];
        h += "<span class=\"avail-kpi-impact-badge impact-" + ik2 + (impExcl2 ? " impact-excluded" : "") + "\" data-impact=\"" + ik2 + "\" style=\"cursor:pointer\">";
        h += escHtml(ik2) + ": " + iv2.count + " / " + (Math.round(iv2.hours * 10) / 10) + "h";
        h += "</span>";
      }
      h += "</div>";
    }
    h += "<div class=\"avail-kpi-section-head\">Service Status</div>";
    h += "<div class=\"avail-kpi-impact-row\">";
    for (var sti2 = 0; sti2 < statusOrder.length; sti2++) {
      var st2 = statusOrder[sti2];
      var stExcl2 = !!_outageStatusExclude[st2.key];
      h += "<span class=\"avail-kpi-impact-badge " + st2.cls + (stExcl2 ? " impact-excluded" : "") + "\" data-status=\"" + st2.key + "\" style=\"cursor:pointer\">";
      h += st2.label;
      h += "</span>";
    }
    h += "</div>";
  }

  panel.innerHTML = h;

  // Bind month-column click → filter outage timeline chart
  var rows = panel.querySelectorAll("[data-month]");
  for (var ri = 0; ri < rows.length; ri++) {
    rows[ri].addEventListener("click", function() {
      var mk = this.dataset.month;
      var newFilter;
      if (mk === "__all__") {
        newFilter = null;
      } else {
        newFilter = (_outageTimelineMonthFilter === mk) ? null : mk;
      }
      _outageTimelineMonthFilter = newFilter;
      renderUptimeChart(data);
      renderIncidentHistory(data);
      renderOutageTimeline(data);
      renderAvailabilityKpis(data);
      var otDet = document.getElementById("outage-timeline-details");
      if (otDet && !otDet.open) otDet.setAttribute("open", "");
    });
  }

  // Bind impact-badge click → toggle exclude from all charts
  var badges = panel.querySelectorAll("[data-impact]");
  for (var bi2 = 0; bi2 < badges.length; bi2++) {
    badges[bi2].addEventListener("click", function() {
      var imp = this.dataset.impact;
      if (_outageImpactExclude[imp]) { delete _outageImpactExclude[imp]; } else { _outageImpactExclude[imp] = true; }
      renderUptimeChart(data);
      renderIncidentHistory(data);
      renderOutageTimeline(data);
      renderAvailabilityKpis(data);
      var otDet = document.getElementById("outage-timeline-details");
      if (otDet && !otDet.open) otDet.setAttribute("open", "");
    });
  }

  // Bind status-badge click → toggle exclude for uptime chart
  var stBadges = panel.querySelectorAll("[data-status]");
  for (var sb = 0; sb < stBadges.length; sb++) {
    stBadges[sb].addEventListener("click", function() {
      var sk = this.dataset.status;
      if (_outageStatusExclude[sk]) { delete _outageStatusExclude[sk]; } else { _outageStatusExclude[sk] = true; }
      renderUptimeChart(data);
      renderAvailabilityKpis(data);
    });
  }
}

// ── Auto-collapse charts when Kennzahlen opens (and vice versa) ──────────
(function() {
  var kpiDet = document.getElementById("avail-kpi-details");
  var chartIds = ["uptime-chart-details", "incident-history-details"];
  var keepOpen = "outage-timeline-details";
  if (!kpiDet) return;
  function isInModal() {
    var overlay = document.getElementById("anthropic-modal-overlay");
    return overlay && overlay.classList.contains("is-open");
  }
  kpiDet.addEventListener("toggle", function() {
    if (isInModal()) return;
    if (kpiDet.open) {
      for (var i = 0; i < chartIds.length; i++) {
        var el = document.getElementById(chartIds[i]);
        if (el) el.removeAttribute("open");
      }
    }
  });
  // Re-open charts when Kennzahlen closes
  kpiDet.addEventListener("toggle", function() {
    if (isInModal()) return;
    if (!kpiDet.open) {
      for (var i = 0; i < chartIds.length; i++) {
        var el = document.getElementById(chartIds[i]);
        if (el) el.setAttribute("open", "");
      }
    }
  });
})();

// Anthropic badge click toggle popup
(function() {
  var badge = document.getElementById("anthropic-badge");
  if (badge) {
    badge.style.cursor = "pointer";
    badge.addEventListener("click", function(e) {
      e.stopPropagation();
      badge.classList.toggle("popup-open");
    });
    document.addEventListener("click", function() {
      badge.classList.remove("popup-open");
    });
    var popup = document.getElementById("anthropic-popup");
    if (popup) popup.addEventListener("click", function(e) { e.stopPropagation(); });
  }
})();

// ── Anthropic popup → fullscreen modal ───────────────────────────────────
(function() {
  var expandBtn = document.getElementById("anthropic-popup-expand");
  var overlay = document.getElementById("anthropic-modal-overlay");
  var modalBody = document.getElementById("anthropic-modal-body");
  var closeBtn = document.getElementById("anthropic-modal-close");
  var popup = document.getElementById("anthropic-popup");
  var badge = document.getElementById("anthropic-badge");
  if (!expandBtn || !overlay || !modalBody || !popup) return;

  var chartDetailIds = ["uptime-chart-details", "incident-history-details", "outage-timeline-details"];

  function forceChartsOpen() {
    for (var i = 0; i < chartDetailIds.length; i++) {
      var el = document.getElementById(chartDetailIds[i]);
      if (el) { el.setAttribute("open", ""); el.classList.add("no-collapse"); }
    }
  }

  function restoreChartsCollapse() {
    for (var i = 0; i < chartDetailIds.length; i++) {
      var el = document.getElementById(chartDetailIds[i]);
      if (el) el.classList.remove("no-collapse");
    }
  }

  function openModal() {
    // Move popup content into modal
    while (popup.firstChild) modalBody.appendChild(popup.firstChild);
    // Hide expand button inside modal (not needed)
    var expInModal = modalBody.querySelector(".anthropic-popup-expand");
    if (expInModal) expInModal.style.display = "none";
    // Force all charts open and disable collapsing
    forceChartsOpen();
    // Move Kennzahlen above charts in modal + force open
    var kpiEl = modalBody.querySelector("#avail-kpi-details");
    var chartsRow = modalBody.querySelector(".health-charts-row");
    if (kpiEl && chartsRow && chartsRow.parentNode) {
      chartsRow.parentNode.insertBefore(kpiEl, chartsRow);
      kpiEl.setAttribute("open", "");
    }
    // Close the dropdown popup
    if (badge) badge.classList.remove("popup-open");
    overlay.classList.add("is-open");
    document.body.style.overflow = "hidden";
    _isModalOpen = true;
    // Re-render all charts with modal font sizes
    if (_lastAvailKpiData) {
      renderUptimeChart(_lastAvailKpiData);
      renderIncidentHistory(_lastAvailKpiData);
      renderOutageTimeline(_lastAvailKpiData);
      renderAvailabilityKpis(_lastAvailKpiData);
    }
    requestAnimationFrame(function () {
      __bumpAnthropicHealthCharts();
      requestAnimationFrame(__bumpAnthropicHealthCharts);
    });
    setTimeout(__bumpAnthropicHealthCharts, 220);
  }

  function closeModal() {
    // Move Kennzahlen back below charts
    var kpiEl = modalBody.querySelector("#avail-kpi-details");
    var chartsRow = modalBody.querySelector(".health-charts-row");
    if (kpiEl && chartsRow && chartsRow.parentNode) {
      chartsRow.parentNode.insertBefore(kpiEl, chartsRow.nextSibling);
    }
    // Restore collapse behavior
    restoreChartsCollapse();
    // Move content back into popup
    while (modalBody.firstChild) popup.appendChild(modalBody.firstChild);
    // Restore expand button
    var expInPopup = popup.querySelector(".anthropic-popup-expand");
    if (expInPopup) expInPopup.style.display = "";
    overlay.classList.remove("is-open");
    document.body.style.overflow = "";
    _isModalOpen = false;
    // Re-render all charts with popup font sizes
    if (_lastAvailKpiData) {
      renderUptimeChart(_lastAvailKpiData);
      renderIncidentHistory(_lastAvailKpiData);
      renderOutageTimeline(_lastAvailKpiData);
      renderAvailabilityKpis(_lastAvailKpiData);
    }
    requestAnimationFrame(function () {
      __bumpAnthropicHealthCharts();
      requestAnimationFrame(__bumpAnthropicHealthCharts);
    });
    setTimeout(__bumpAnthropicHealthCharts, 220);
  }

  expandBtn.addEventListener("click", function(e) {
    e.stopPropagation();
    openModal();
  });

  if (closeBtn) closeBtn.addEventListener("click", function() { closeModal(); });

  // Close on overlay background click
  overlay.addEventListener("click", function(e) {
    if (e.target === overlay) closeModal();
  });

  // Close on Escape
  document.addEventListener("keydown", function(e) {
    if (e.key === "Escape" && overlay.classList.contains("is-open")) closeModal();
  });
})();

(function __initAnthropicHealthChartResizeWatch() {
  var winH = globalThis.window;
  if (!winH) return;
  winH.addEventListener("resize", __scheduleAnthropicHealthChartsResize);
  ["uptime-chart-details", "incident-history-details", "outage-timeline-details"].forEach(function (id) {
    var d = document.getElementById(id);
    if (d) d.addEventListener("toggle", __scheduleAnthropicHealthChartsResize);
  });
  if (typeof ResizeObserver === "undefined") return;
  var ids = ["c-uptime-chart", "c-incident-history", "c-outage-timeline"];
  for (const id of ids) {
    var cv = document.getElementById(id);
    var host = cv?.parentElement;
    if (host?.classList?.contains("health-chart-canvas-host")) {
      var ro = new ResizeObserver(__scheduleAnthropicHealthChartsResize);
      ro.observe(host);
    }
  }
})();

fetchUsageJsonOnce();
connectUsageStream();
scheduleFetchExtensionTimeline(900);

// ── Mini Markdown → HTML (for release notes) ────────────────────────────
function miniMd(src) {
  var lines = (src || "").split("\n");
  var html = "", inList = false;
  for (const ln of lines) {
    // Headings
    var hm = ln.match(/^(#{1,4})\s+(.*)/);
    if (hm) {
      if (inList) { html += "</ul>"; inList = false; }
      var lvl = hm[1].length;
      html += "<h" + lvl + " style=\"font-size:" + (1.1 - lvl * 0.1) + "rem;color:#e2e8f0;margin:10px 0 4px\">" + escHtml(hm[2]) + "</h" + lvl + ">";
      continue;
    }
    // List items
    var lm = ln.match(/^[-*]\s+(?:\[.\]\s*)?(.*)/);
    if (lm) {
      if (!inList) { html += "<ul style=\"margin:4px 0;padding-left:18px\">"; inList = true; }
      html += "<li>" + inlineMd(lm[1]) + "</li>";
      continue;
    }
    // Empty line
    if (!ln.trim()) {
      if (inList) { html += "</ul>"; inList = false; }
      continue;
    }
    // Paragraph
    if (inList) { html += "</ul>"; inList = false; }
    html += "<p style=\"margin:3px 0\">" + inlineMd(ln) + "</p>";
  }
  if (inList) html += "</ul>";
  return html;
}
function inlineMd(s) {
  s = escHtml(s);
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/`([^`]+)`/g, "<code style=\"background:#334155;padding:1px 4px;border-radius:3px;font-size:.9em\">$1</code>");
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "<a href=\"$2\" target=\"_blank\" rel=\"noopener\" style=\"color:#93c5fd\">$1</a>");
  return s;
}

// ── Dev Mode Overlay ─────────────────────────────────────────────────────
(function () {
  var xhr = new XMLHttpRequest();
  xhr.open("GET", "/api/debug/status", true);
  xhr.onload = function () {
    if (xhr.status !== 200) return;
    try {
      var info = JSON.parse(xhr.responseText);
      // Show release version in Live panel — compact row
      var relRow = document.getElementById("live-release-row");
      var ver = info.version?.length && info.version !== "dev" ? info.version : null;
      if (relRow) {
        if (ver) {
          relRow.innerHTML = '<span class="live-rel-badge live-rel-badge-ok">' + escHtml(ver) + '</span>' +
            '<a class="live-rel-link" href="https://github.com/fgrosswig/claude-usage-dashboard/releases/tag/' + escHtml(ver) + '" target="_blank" rel="noopener">GitHub</a>' +
            '<button class="live-rel-expand" id="live-rel-expand-btn">History</button>';
        } else {
          relRow.innerHTML = '<span class="live-rel-badge live-rel-badge-dev">dev</span>' +
            '<a class="live-rel-link" href="https://github.com/fgrosswig/claude-usage-dashboard/releases" target="_blank" rel="noopener">GitHub</a>' +
            '<button class="live-rel-expand" id="live-rel-expand-btn">History</button>';
        }
        // Release History popout
        var expandBtn = document.getElementById("live-rel-expand-btn");
        var relOverlay = document.getElementById("release-modal-overlay");
        var relBody = document.getElementById("release-modal-body");
        var relClose = document.getElementById("release-modal-close");
        if (expandBtn && relOverlay && relBody) {
          expandBtn.addEventListener("click", function() {
            relOverlay.classList.add("is-open");
            document.body.style.overflow = "hidden";
            if (relBody.dataset.loaded) return;
            relBody.innerHTML = '<p style="color:#64748b;font-size:.75rem">Loading releases...</p>';
            var rlXhr = new XMLHttpRequest();
            rlXhr.open("GET", "https://api.github.com/repos/fgrosswig/claude-usage-dashboard/releases?per_page=20", true);
            rlXhr.onload = function() {
              if (rlXhr.status !== 200) { relBody.innerHTML = '<p style="color:#ef4444;font-size:.75rem">Failed to load releases</p>'; return; }
              try {
                var releases = JSON.parse(rlXhr.responseText);
                if (!releases.length) { relBody.innerHTML = '<p style="color:#64748b;font-size:.75rem">No releases found</p>'; return; }
                var rh = "";
                var isFirst = true;
                for (const rel of releases) {
                  var rDate = rel.published_at ? rel.published_at.slice(0, 10) : "";
                  var rBody2 = (rel.body || "").replace(/^## .+\n?/m, "");
                  rh += "<details class=\"release-modal-item\"" + (isFirst ? " open" : "") + ">";
                  isFirst = false;
                  rh += "<summary class=\"release-modal-item-head\">";
                  rh += "<span class=\"rel-tag\">" + escHtml(rel.tag_name) + "</span>";
                  rh += "<span class=\"rel-date\">" + escHtml(rDate) + "</span>";
                  if (rel.name && rel.name !== rel.tag_name) rh += " — " + escHtml(rel.name);
                  rh += "</summary>";
                  rh += "<div class=\"release-modal-item-body\">" + miniMd(rBody2) + "</div>";
                  rh += "</details>";
                }
                relBody.innerHTML = rh;
                relBody.dataset.loaded = "1";
              } catch (e) { relBody.innerHTML = '<p style="color:#ef4444;font-size:.75rem">Parse error</p>'; }
            };
            rlXhr.send();
          });
          if (relClose) relClose.addEventListener("click", function() { relOverlay.classList.remove("is-open"); document.body.style.overflow = ""; });
          relOverlay.addEventListener("click", function(e) { if (e.target === relOverlay) { relOverlay.classList.remove("is-open"); document.body.style.overflow = ""; } });
        }
      }
      if (!info.dev_mode) return;
      var modeLabel = info.dev_mode === "full" ? "FULL" : "PROXY";
      var bar = document.createElement("div");
      bar.id = "dev-overlay";
      bar.style.cssText = "position:fixed;top:0;left:0;right:0;z-index:9999;background:#1e293b;border-bottom:2px solid #f59e0b;padding:6px 16px;display:flex;align-items:center;gap:12px;font-size:.8rem;color:#f59e0b";
      bar.innerHTML = '<span style="font-weight:700">DEV ' + modeLabel + '</span>' +
        '<span style="color:#94a3b8">Source: ' + escHtml(info.dev_proxy_source || "") + '</span>' +
        '<span id="dev-last-sync" style="color:#94a3b8">Sync: ' + info.refresh_sec + 's</span>' +
        '<button id="dev-sync-btn" style="background:#f59e0b;color:#0f172a;border:none;border-radius:4px;padding:3px 10px;cursor:pointer;font-size:.75rem;font-weight:600">Sync Now</button>' +
        '<span id="dev-sync-status" style="color:#64748b;font-size:.7rem"></span>';
      document.body.prepend(bar);
      var devH = bar.offsetHeight;
      document.body.style.paddingTop = devH + "px";
      document.documentElement.style.setProperty("--dev-bar-h", devH + "px");
      document.getElementById("dev-sync-btn").addEventListener("click", function () {
        var st = document.getElementById("dev-sync-status");
        st.textContent = "syncing...";
        var sx = new XMLHttpRequest();
        sx.open("POST", "/api/debug/sync-proxy-logs", true);
        sx.onload = function () { st.textContent = "synced " + new Date().toLocaleTimeString(); st.style.color = "#22c55e"; setTimeout(function(){ st.style.color = "#64748b"; }, 3000); };
        sx.onerror = function () { st.textContent = "sync failed"; };
        sx.send();
      });
    } catch (e) {}
  };
  xhr.send();
})();

// ── Ökonomische Nutzung — Session-Turn-Level Efficiency Charts ───────

var _econCharts = {};
var _econData = null;

function renderEconomicSection(data) {
  var collapse = document.getElementById("economic-collapse");
  if (!collapse) return;
  var sumEl = document.getElementById("economic-summary-line");
  var datePicker = document.getElementById("econ-date-picker");
  var sessPicker = document.getElementById("econ-session-picker");
  var infoEl = document.getElementById("econ-session-info");

  // Set labels
  var lblDate = document.getElementById("lbl-econ-date");
  var lblSess = document.getElementById("lbl-econ-session");
  if (lblDate) lblDate.textContent = t("econDateLabel");
  if (lblSess) lblSess.textContent = t("econSessionLabel");

  // Section header titles
  var wH = document.getElementById("econ-waste-h3");
  var eH = document.getElementById("econ-efficiency-h3");
  var dH = document.getElementById("econ-daycompare-h3");
  if (wH) wH.textContent = t("econWasteTitle");
  if (eH) eH.textContent = t("econEfficiencyTitle");
  if (dH) dH.textContent = t("econDayCompareTitle");
  var wB = document.getElementById("econ-waste-blurb");
  var eB = document.getElementById("econ-efficiency-blurb");
  var dB = document.getElementById("econ-daycompare-blurb");
  if (wB) wB.textContent = t("econWasteBlurb");
  if (eB) eB.textContent = t("econEfficiencyBlurb");
  if (dB) dB.textContent = t("econDayCompareBlurb");

  // Default date from day picker or today
  var defaultDate = (data.days && data.days.length) ? data.days[data.days.length - 1].date : new Date().toISOString().slice(0, 10);
  if (datePicker && !datePicker.value) datePicker.value = defaultDate;

  // Fetch session turns for selected date
  function fetchAndRender() {
    var dateVal = datePicker ? datePicker.value : defaultDate;
    fetch("/api/session-turns?date=" + encodeURIComponent(dateVal))
      .then(function (r) { return r.json(); })
      .then(function (stData) {
        _econData = stData;
        populateSessionPicker(stData, sessPicker, infoEl, sumEl);
        var sel = sessPicker ? sessPicker.value : "";
        var session = findSession(stData, sel);
        if (session) {
          renderWasteCurve(session);
          renderEfficiencyTimeline(stData);
        }
        renderDayComparison(data.days || []);
      })
      .catch(function () {
        if (sumEl) sumEl.textContent = t("econSummaryNoData");
      });
  }

  if (datePicker) datePicker.addEventListener("change", fetchAndRender);
  if (sessPicker) sessPicker.addEventListener("change", function () {
    var session = findSession(_econData, sessPicker.value);
    if (session) {
      updateSessionInfo(session, infoEl);
      renderWasteCurve(session);
    }
  });

  fetchAndRender();
}

function populateSessionPicker(stData, picker, infoEl, sumEl) {
  if (!picker || !stData || !stData.sessions) return;
  picker.innerHTML = "";
  var sessions = stData.sessions;
  for (var i = 0; i < sessions.length; i++) {
    var s = sessions[i];
    var opt = document.createElement("option");
    opt.value = s.session_id_hash;
    var timeRange = s.first_ts.slice(11, 16) + "–" + s.last_ts.slice(11, 16);
    opt.textContent = s.session_id_hash.slice(0, 8) + " (" + timeRange + ", " + s.turn_count + " turns)";
    picker.appendChild(opt);
  }
  if (sessions.length && !picker.value) picker.value = sessions[0].session_id_hash;
  var sel = findSession(stData, picker.value);
  if (sel) updateSessionInfo(sel, infoEl);

  if (sumEl) {
    if (!sessions.length) {
      sumEl.textContent = t("econSummaryNoData");
    } else {
      var totalOut = sessions.reduce(function (s, x) { return s + x.total_output; }, 0);
      var totalAll = sessions.reduce(function (s, x) { return s + x.total_all; }, 0);
      var ratio = totalAll > 0 ? (totalOut / totalAll * 100).toFixed(2) : "0";
      sumEl.textContent = tr("econSummaryLine", { sessions: sessions.length, ratio: ratio });
    }
  }
}

function findSession(stData, hash) {
  if (!stData || !stData.sessions) return null;
  for (var i = 0; i < stData.sessions.length; i++) {
    if (stData.sessions[i].session_id_hash === hash) return stData.sessions[i];
  }
  return stData.sessions[0] || null;
}

function updateSessionInfo(session, infoEl) {
  if (!infoEl || !session) return;
  infoEl.textContent = tr("econSessionInfo", {
    turns: session.turn_count,
    output: fmt(session.total_output),
    cacheRead: fmt(session.total_cache_read),
    total: fmt(session.total_all)
  });
}

function renderWasteCurve(session) {
  if (typeof echarts === "undefined") return;
  var el = document.getElementById("chart-shell-econ-waste");
  if (!el || !session || !session.turns || !session.turns.length) return;

  var turns = session.turns;
  var xData = [];
  var cumOutput = [];
  var cumCacheRead = [];
  var cumCacheCreate = [];
  var cumInput = [];
  var cO = 0, cR = 0, cC = 0, cI = 0;
  var splitIndex = -1;

  for (var i = 0; i < turns.length; i++) {
    var T = turns[i];
    cO += T.output;
    cR += T.cache_read;
    cC += T.cache_creation;
    cI += T.input;
    xData.push(i + 1);
    cumOutput.push(cO);
    cumCacheRead.push(cR);
    cumCacheCreate.push(cC);
    cumInput.push(cI);
    if (splitIndex < 0 && cO > 0 && cR / cO > 500) splitIndex = i;
  }

  var option = {
    tooltip: {
      trigger: "axis",
      formatter: function (params) {
        var idx = params[0].dataIndex;
        var T = turns[idx];
        var lines = ["Turn " + (idx + 1)];
        for (var p = 0; p < params.length; p++) {
          lines.push(params[p].marker + " " + params[p].seriesName + ": " + fmt(params[p].value));
        }
        lines.push("");
        lines.push("Turn: out=" + fmt(T.output) + " cr=" + fmt(T.cache_read));
        if (cR > 0 && cumOutput[idx] > 0) {
          lines.push("Ratio: " + Math.round(cumCacheRead[idx] / cumOutput[idx]) + "×");
        }
        return lines.join("<br>");
      }
    },
    legend: { top: 4, textStyle: { color: "#94a3b8", fontSize: 11 } },
    grid: { top: 40, right: 20, bottom: 30, left: 60 },
    xAxis: { type: "category", data: xData, name: "Turn", axisLabel: { color: "#64748b" } },
    yAxis: { type: "value", axisLabel: { color: "#64748b", formatter: function (v) { return fmt(v); } } },
    series: [
      {
        name: t("econWasteCacheRead"),
        type: "line",
        stack: "total",
        areaStyle: { color: "rgba(100,116,139,0.35)" },
        lineStyle: { color: "#64748b", width: 1 },
        symbol: "none",
        data: cumCacheRead
      },
      {
        name: t("econWasteCacheCreate"),
        type: "line",
        stack: "total",
        areaStyle: { color: "rgba(251,191,36,0.25)" },
        lineStyle: { color: "#fbbf24", width: 1 },
        symbol: "none",
        data: cumCacheCreate
      },
      {
        name: t("econWasteInput"),
        type: "line",
        stack: "total",
        areaStyle: { color: "rgba(96,165,250,0.2)" },
        lineStyle: { color: "#60a5fa", width: 1 },
        symbol: "none",
        data: cumInput
      },
      {
        name: t("econWasteOutput"),
        type: "line",
        areaStyle: { color: "rgba(52,211,153,0.4)" },
        lineStyle: { color: "#34d399", width: 2 },
        symbol: "none",
        data: cumOutput,
        markLine: splitIndex >= 0 ? {
          silent: true,
          symbol: "none",
          lineStyle: { color: "#ef4444", type: "dashed", width: 1.5 },
          data: [{ xAxis: splitIndex, label: { formatter: t("econWasteSplitHint"), color: "#ef4444", fontSize: 10, position: "insideEndTop" } }]
        } : undefined
      }
    ]
  };

  __effInitOrSet("econWaste", el, option);
}

function renderEfficiencyTimeline(stData) {
  if (typeof echarts === "undefined") return;
  var el = document.getElementById("chart-shell-econ-efficiency");
  if (!el || !stData || !stData.sessions) return;

  // Aggregate all turns across sessions by hour
  var hourly = {};
  for (var si = 0; si < stData.sessions.length; si++) {
    var turns = stData.sessions[si].turns;
    for (var ti = 0; ti < turns.length; ti++) {
      var T = turns[ti];
      var h = parseInt(T.ts.slice(11, 13), 10);
      if (!hourly[h]) hourly[h] = { output: 0, total: 0 };
      hourly[h].output += T.output;
      hourly[h].total += T.input + T.output + T.cache_read + T.cache_creation;
    }
  }

  var hours = Object.keys(hourly).map(Number).sort(function (a, b) { return a - b; });
  if (!hours.length) return;
  var xData = hours.map(function (h) { return (h < 10 ? "0" : "") + h + ":00"; });
  var outputData = hours.map(function (h) { return hourly[h].output; });
  var totalData = hours.map(function (h) { return hourly[h].total; });

  // Peak hours: 13-19 UTC = 15-21 MESZ (mark in UTC since timestamps are UTC)
  var peakStart = 13;
  var peakEnd = 19;

  var option = {
    tooltip: {
      trigger: "axis",
      formatter: function (params) {
        var lines = [params[0].axisValue];
        for (var p = 0; p < params.length; p++) {
          lines.push(params[p].marker + " " + params[p].seriesName + ": " + fmt(params[p].value));
        }
        var idx = params[0].dataIndex;
        var h = hours[idx];
        if (h >= peakStart && h < peakEnd) lines.push("⚠ " + t("econEfficiencyPeakBand"));
        var tot = totalData[idx];
        var out = outputData[idx];
        if (tot > 0) lines.push(t("econEfficiencyRatio") + ": " + (out / tot * 100).toFixed(2) + "%");
        return lines.join("<br>");
      }
    },
    legend: { top: 4, textStyle: { color: "#94a3b8", fontSize: 11 } },
    grid: { top: 40, right: 60, bottom: 30, left: 60 },
    xAxis: { type: "category", data: xData, axisLabel: { color: "#64748b" } },
    yAxis: [
      { type: "value", name: t("econEfficiencyTotal"), axisLabel: { color: "#64748b", formatter: function (v) { return fmt(v); } }, position: "left" },
      { type: "value", name: t("econEfficiencyOutput"), axisLabel: { color: "#34d399", formatter: function (v) { return fmt(v); } }, position: "right" }
    ],
    series: [
      {
        name: t("econEfficiencyTotal"),
        type: "bar",
        yAxisIndex: 0,
        itemStyle: {
          color: function (params) {
            var h = hours[params.dataIndex];
            return (h >= peakStart && h < peakEnd) ? "rgba(251,146,60,0.5)" : "rgba(100,116,139,0.35)";
          }
        },
        data: totalData
      },
      {
        name: t("econEfficiencyOutput"),
        type: "bar",
        yAxisIndex: 1,
        itemStyle: { color: "rgba(52,211,153,0.7)" },
        data: outputData
      }
    ],
    // Peak hours visual band
    visualMap: undefined
  };

  __effInitOrSet("econEfficiency", el, option);
}

function renderDayComparison(days) {
  if (typeof echarts === "undefined") return;
  var el = document.getElementById("chart-shell-econ-daycompare");
  if (!el || !days || days.length < 2) return;

  var xData = [];
  var ratioData = [];
  for (var i = 0; i < days.length; i++) {
    var d = days[i];
    var total = (d.input || 0) + (d.output || 0) + (d.cache_read || 0) + (d.cache_creation || 0);
    var ratio = total > 0 ? (d.output || 0) / total * 100 : 0;
    xData.push(d.date);
    ratioData.push(Math.round(ratio * 100) / 100);
  }

  var option = {
    tooltip: {
      trigger: "axis",
      formatter: function (params) {
        var idx = params[0].dataIndex;
        var d = days[idx];
        return d.date + "<br>" + t("econEfficiencyRatio") + ": " + params[0].value + "%<br>Output: " + fmt(d.output || 0) + "<br>Total: " + fmt((d.input || 0) + (d.output || 0) + (d.cache_read || 0) + (d.cache_creation || 0));
      }
    },
    grid: { top: 20, right: 20, bottom: 40, left: 50 },
    xAxis: { type: "category", data: xData, axisLabel: { color: "#64748b", rotate: 45, fontSize: 10 } },
    yAxis: { type: "value", name: "%", axisLabel: { color: "#64748b" }, max: function (v) { return Math.max(v.max * 1.2, 1); } },
    series: [{
      type: "bar",
      data: ratioData,
      itemStyle: {
        color: function (params) {
          var v = params.value;
          return v > 0.5 ? "#34d399" : v > 0.1 ? "#fbbf24" : "#ef4444";
        }
      },
      label: { show: true, position: "top", formatter: "{c}%", fontSize: 9, color: "#94a3b8" }
    }]
  };

  __effInitOrSet("econDayCompare", el, option);
}

// ── Korean term tooltip system (ko locale only) ──────────────────────
(function () {
  var GLOSSARY = {
    "Thinking Token": "AI 내부 추론에 사용되는 비공개 Token",
    "Health Score": "종합 API 사용 건강 점수 (10점 만점)",
    "Hit Limit": "API 사용 한도 도달",
    "Rate Limit": "시간당 허용 요청 수 제한",
    "Cold Start": "캐시 없이 시작하는 첫 요청",
    "Cache Read": "캐시에서 재사용된 Token",
    "Cache Create": "새로 캐시에 저장된 Token",
    "Cache": "이전 대화를 재사용하여 비용을 줄이는 메커니즘",
    "Token": "API 요청/응답의 기본 단위 (단어 조각)",
    "Output": "AI가 생성한 응답 Token",
    "Overhead": "Output 대비 전체 Token 사용 비율",
    "Forensic": "사용 패턴 심층 분석",
    "NDJSON": "줄 구분 JSON (Proxy 로그 형식)",
    "JSONL": "줄 단위 JSON 로그 형식",
    "SSE": "서버→브라우저 실시간 데이터 전송",
    "Proxy": "API 요청을 중계하는 중간 서버",
    "Subagent": "메인 에이전트가 생성한 하위 작업 에이전트",
    "Quota": "일정 기간 내 허용된 총 사용량",
    "Budget": "세션당 허용된 Token 총량",
    "Latency": "API 요청~응답 사이 지연 시간",
    "Interrupt": "사용자에 의한 세션 중단",
    "Retry": "API 오류 후 자동 재시도",
    "Incident": "Anthropic 서비스 장애 이벤트",
    "Outage": "서비스 중단 기간",
    "Extension": "VS Code 확장 프로그램",
    "Peak": "최대 사용량을 기록한 시점",
    "Context": "AI 대화의 전체 입력 맥락",
    "Compaction": "긴 대화를 압축하여 Context 줄이기",
    "PAT": "GitHub Personal Access Token (개인 인증 토큰)"
  };

  var TERMS = Object.keys(GLOSSARY).sort(function (a, b) { return b.length - a.length; });
  var RE = new RegExp("(" + TERMS.map(function (t) { return t.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`); }).join("|") + ")", "g");
  var SKIP_TAGS = { SCRIPT: 1, STYLE: 1, INPUT: 1, SELECT: 1, TEXTAREA: 1, CODE: 1 };
  var observer = null;
  var debounceTimer = null;

  var pop = document.createElement("div");
  pop.id = "tt-pop";
  document.body.appendChild(pop);

  function showPop(e) {
    var tip = e.currentTarget.dataset.tip;
    if (!tip) return;
    pop.textContent = tip;
    pop.style.opacity = "1";
    positionPop(e);
  }
  function movePop(e) { positionPop(e); }
  function hidePop() { pop.style.opacity = "0"; }
  function positionPop(e) {
    var x = e.clientX + 12;
    var y = e.clientY - 8;
    pop.style.left = "0px";
    pop.style.top = "0px";
    var pw = pop.offsetWidth;
    var ph = pop.offsetHeight;
    if (x + pw > window.innerWidth - 8) x = e.clientX - pw - 12;
    if (y - ph < 4) y = e.clientY + 20;
    else y = y - ph;
    pop.style.left = x + "px";
    pop.style.top = y + "px";
  }

  function wrapTextNode(node) {
    var text = node.nodeValue;
    if (!text || !RE.test(text)) return;
    RE.lastIndex = 0;
    var frag = document.createDocumentFragment();
    var lastIdx = 0;
    var parent = node.parentNode;
    var parentSeen = parent.__ttSeen || (parent.__ttSeen = {});
    var match;
    RE.lastIndex = 0;
    while ((match = RE.exec(text)) !== null) {
      var term = match[1];
      if (match.index > lastIdx) frag.appendChild(document.createTextNode(text.slice(lastIdx, match.index)));
      if (parentSeen[term]) {
        frag.appendChild(document.createTextNode(term));
      } else {
        var span = document.createElement("span");
        span.className = "tt";
        span.dataset.tip = GLOSSARY[term];
        span.textContent = term;
        span.addEventListener("mouseenter", showPop);
        span.addEventListener("mousemove", movePop);
        span.addEventListener("mouseleave", hidePop);
        frag.appendChild(span);
        parentSeen[term] = true;
      }
      lastIdx = RE.lastIndex;
    }
    if (lastIdx < text.length) frag.appendChild(document.createTextNode(text.slice(lastIdx)));
    if (frag.childNodes.length) node.replaceWith(frag);
  }

  function scanElement(root) {
    var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: function (node) {
        var p = node.parentNode;
        if (!p) return NodeFilter.FILTER_REJECT;
        if (p.classList?.contains("tt")) return NodeFilter.FILTER_REJECT;
        if (SKIP_TAGS[p.tagName]) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    var nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    for (const n of nodes) wrapTextNode(n);
  }

  function removeAllTips() {
    hidePop();
    var tips = document.querySelectorAll(".tt");
    for (const span of tips) {
      span.removeEventListener("mouseenter", showPop);
      span.removeEventListener("mousemove", movePop);
      span.removeEventListener("mouseleave", hidePop);
      var parent = span.parentNode;
      if (parent) {
        span.replaceWith(document.createTextNode(span.textContent));
        parent.normalize();
        if (parent.__ttSeen) parent.__ttSeen = {};
      }
    }
  }

  function debouncedScan() {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(function () {
      if (getLang() === "ko") scanElement(document.body);
    }, 200);
  }

  function startObserver() {
    if (observer) return;
    observer = new MutationObserver(function (mutations) {
      for (const mut of mutations) {
        if (mut.addedNodes.length || mut.type === "characterData") {
          debouncedScan();
          break;
        }
      }
    });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  }

  function stopObserver() {
    if (observer) { observer.disconnect(); observer = null; }
    if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null; }
  }

  var _origSetLang = setLang;
  setLang = function (code) {
    stopObserver();
    removeAllTips();
    _origSetLang(code);
    if (code === "ko") {
      scanElement(document.body);
      startObserver();
    }
  };

  if (getLang() === "ko") {
    setTimeout(function () {
      scanElement(document.body);
      startObserver();
    }, 500);
  }
})();
