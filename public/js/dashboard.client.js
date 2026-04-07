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
function escHtml(s){return String(s==null?"":s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");}
/** Stunden mit Arbeit (tokens) ∪ Stunden mit JSONL-Session-Signalen, nach Log-Zeitstempel. */
function unionWorkHourKeys(sd) {
  var m = {};
  var k;
  var ho = sd.hours || {};
  var hs = sd.hour_signals || {};
  for (k in ho) if (Object.prototype.hasOwnProperty.call(ho, k)) m[k] = true;
  for (k in hs) if (Object.prototype.hasOwnProperty.call(hs, k)) m[k] = true;
  return Object.keys(m).map(function (x) { return parseInt(x, 10); }).filter(function (n) { return !isNaN(n) && n >= 0 && n <= 23; });
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
  for (var oi = 0; oi < spans.length; oi++) {
    if (wh >= Math.floor(spans[oi].from) && wh < Math.ceil(spans[oi].to)) {
      if (spans[oi].kind === "server") hitSrv = true;
      else hitCli = true;
    }
  }
  return { hitSrv: hitSrv, hitCli: hitCli };
}
/** Balken: nur Stunden mit echtem Token-Output zählen als betroffen/sauber (kein Aufblasen durch reine Session-Signale). */
function sumServiceImpactForDay(sd) {
  var wHrs = unionWorkHourKeys(sd);
  wHrs.sort(function (a, b) { return a - b; });
  var spans = sd.outage_spans || [];
  var affSrv = 0;
  var affCli = 0;
  var cleanCount = 0;
  for (var wi = 0; wi < wHrs.length; wi++) {
    var wh = wHrs[wi];
    var hasW = hourHasTokenUsage(sd, wh);
    var hit = outageSpanHitsAtHour(spans, wh);
    var sig = hourSignalsAt(sd, wh);
    var ryH = sig.retry || 0;
    var riH = sig.interrupt || 0;
    if (hit.hitSrv && hasW) affSrv++;
    else if (hit.hitCli && hasW) affCli++;
    else if (!hit.hitSrv && !hit.hitCli) {
      if (hasW && ryH > 0) affSrv++;
      else if (hasW && riH > 0) affCli++;
      else if (hasW) cleanCount++;
    }
  }
  var outTotal = 0;
  for (var oj = 0; oj < spans.length; oj++) outTotal += spans[oj].to - spans[oj].from;
  var outOnly = Math.max(0, Math.round((outTotal - affSrv - affCli) * 10) / 10);
  return { cleanWork: cleanCount, affSrv: affSrv, affCli: affCli, outOnly: outOnly };
}
/** Pro Kalendertag: session_signals, outage_hours, cache_read (API) — für Korrelation Interrupt/Outage vs. Cache.
 *  Ausfallstunden als Balken: Höhe skaliert (Stunden vs. JSONL-Zähler), Tooltip zeigt echte h. Reihenfolge im Stack
 *  unten→oben = continue, resume, retry, interrupt, Ausfall (oben), damit Ausfall nicht unter großen Interrupt-Anteilen liegt.
 *  @param {string} [hostLabel] — wenn gesetzt: Signale + Cache Read nur aus days[].hosts[hostLabel]; outage_hours weiter Kalendertag (Anthropic). */
function buildSessionSignalsStackedByDay(days, hostLabel) {
  var hostKey = hostLabel && String(hostLabel).trim() ? String(hostLabel).trim() : "";
  var cont = [];
  var res = [];
  var retry = [];
  var intr = [];
  var outageH = [];
  var cacheRead = [];
  for (var di = 0; di < days.length; di++) {
    var d = days[di];
    var oh = d && d.outage_hours;
    outageH.push(oh != null && !isNaN(Number(oh)) ? Number(oh) : 0);
    if (hostKey) {
      var H = d && d.hosts && d.hosts[hostKey];
      if (H) {
        var sH = H.session_signals || {};
        cont.push(sH.continue || 0);
        res.push(sH.resume || 0);
        retry.push(sH.retry || 0);
        intr.push(sH.interrupt || 0);
        cacheRead.push(H.cache_read != null ? Number(H.cache_read) || 0 : 0);
      } else {
        cont.push(0);
        res.push(0);
        retry.push(0);
        intr.push(0);
        cacheRead.push(0);
      }
      continue;
    }
    var s = (d && d.session_signals) || {};
    cont.push(s.continue || 0);
    res.push(s.resume || 0);
    retry.push(s.retry || 0);
    intr.push(s.interrupt || 0);
    cacheRead.push(d && d.cache_read != null ? Number(d.cache_read) || 0 : 0);
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

var I18N = (typeof __I18N_BUNDLES === "object" && __I18N_BUNDLES && __I18N_BUNDLES.de && __I18N_BUNDLES.en)
  ? __I18N_BUNDLES
  : { de: {}, en: {} };
function detectLang() {
  try {
    var sv = localStorage.getItem("usageDashboardLang");
    if (sv === "de" || sv === "en") return sv;
  } catch (e0) {}
  var langs = navigator.languages;
  if (langs && langs.length) {
    for (var li = 0; li < langs.length; li++) {
      var x = String(langs[li] || "").toLowerCase();
      if (x.indexOf("de") === 0) return "de";
    }
  }
  var nav = String(navigator.language || "").toLowerCase();
  if (nav.indexOf("de") === 0) return "de";
  return "en";
}
var __lang = detectLang();
function getLang() { return __lang; }
function setLang(code) {
  if (code !== "de" && code !== "en") return;
  __lang = code;
  try { localStorage.setItem("usageDashboardLang", code); } catch (e1) {}
  document.documentElement.lang = code === "de" ? "de" : "en";
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
  var H = d.hosts && d.hosts[hostKey];
  return H && H.cache_output_ratio != null ? H.cache_output_ratio : 0;
}
function dayOutputPerHourForMainCharts(d, hostKey) {
  if (!hostKey) return d.output_per_hour || 0;
  var H = d.hosts && d.hosts[hostKey];
  return H && H.output_per_hour != null ? H.output_per_hour : 0;
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
  if (bde) {
    bde.classList.toggle("active", __lang === "de");
    bde.setAttribute("aria-pressed", __lang === "de" ? "true" : "false");
  }
  if (ben) {
    ben.classList.toggle("active", __lang === "en");
    ben.setAttribute("aria-pressed", __lang === "en" ? "true" : "false");
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
  renderProxyAnalysis(data);
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
  function forensicScoreDay(d){
    var c=d.forensic_code||"—";
    if(c==="?")return 3;
    if(c==="HIT")return 2;
    if(c==="<<P")return 1;
    return 0;
  }
  function hitLimitBarForChart(d) {
    if (!fhForensic) return d.hit_limit || 0;
    var H = d.hosts && d.hosts[fhForensic];
    return H ? H.hit_limit || 0 : 0;
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
    label.textContent = t("statusPending");
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
    label.textContent = t("statusOutage");
    dot.parentElement.title = t("statusOutageTip");
  } else if (hasRecentIncident) {
    dot.style.background = "#f59e0b";
    label.textContent = t("statusIncident");
    dot.parentElement.title = t("statusIncidentTip");
  } else {
    dot.style.background = "#22c55e";
    label.textContent = t("statusOk");
    dot.parentElement.title = t("statusOkTip");
  }
}

// ─── Forensic Report Generator ───
function generateForensicReportMd(data) {
  var days = data.days || [];
  if (!days.length) return t("reportNoData");
  var isDE = __lang === "de";
  var CACHE_THRESH = 500000000;
  var HIT_MIN = 50;
  var md = [];
  var now = new Date().toISOString().replace("T"," ").slice(0,19);

  // helper
  function pad(s,w){s=String(s);while(s.length<w)s=" "+s;return s;}
  function dayTotal(d){return (d.input||0)+(d.output||0)+(d.cache_read||0)+(d.cache_creation||0);}
  function sigCell(d){var s=d.session_signals||{};return (s.continue||0)+"/"+(s.resume||0)+"/"+(s.retry||0)+"/"+(s.interrupt||0);}

  // Detect peak + limit days
  var peakDay=null,peakVal=0;
  for(var i=0;i<days.length;i++){var tt=dayTotal(days[i]);if(tt>peakVal){peakVal=tt;peakDay=days[i];}}
  var limitDays=[];
  for(var i=0;i<days.length;i++){var d=days[i];var fl=[];if((d.hit_limit||0)>=HIT_MIN)fl.push("HIT("+(d.hit_limit)+")");if((d.cache_read||0)>=CACHE_THRESH)fl.push("CACHE\u2265500M");if(fl.length)limitDays.push({d:d,flags:fl});}

  md.push("# Forensic Report \u2014 Claude Code Token Usage");
  md.push("");
  md.push((isDE?"Erstellt: ":"Generated: ")+now);
  md.push((isDE?"Peak-Tag: ":"Peak day: ")+(peakDay?peakDay.date+" ("+fmt(peakVal)+")":"\u2014"));
  md.push((isDE?"Limit-Tage: ":"Limit days: ")+limitDays.length);
  md.push("");

  // 1. Daily overview
  md.push("## 1. "+(isDE?"Tages\u00fcbersicht":"Daily Overview"));
  md.push("");
  md.push("| "+(isDE?"Datum":"Date")+" | Output | Cache Read | C:O | Calls | "+(isDE?"Std.":"Hours")+" | Sig c/r/y/i | Limit |");
  md.push("|------------|----------|------------|--------|-------|-------|-------------|--------|");
  for(var i=0;i<days.length;i++){var d=days[i];var cr=d.output>0?Math.round(d.cache_read/d.output):0;var lim="\u2014";if((d.hit_limit||0)>=HIT_MIN)lim="HIT("+(d.hit_limit)+")";if((d.cache_read||0)>=CACHE_THRESH)lim+=(lim!=="\u2014"?", ":"")+"CACHE\u2265500M";md.push("| "+d.date+" | "+fmt(d.output)+" | "+fmt(d.cache_read)+" | "+cr+"x | "+d.calls+" | "+(d.active_hours||0)+" | "+sigCell(d)+" | "+lim+" |");}
  md.push("");

  // 2. Efficiency
  md.push("## 2. "+(isDE?"Effizienz":"Efficiency"));
  md.push("");
  md.push("| "+(isDE?"Datum":"Date")+" | Overhead | Output/h | Total/h | Subagent% |");
  md.push("|------------|----------|----------|---------|-----------|");
  for(var i=0;i<days.length;i++){var d=days[i];var tot=dayTotal(d);var ah=Math.max(1,d.active_hours||1);var oh=d.output>0?(tot/d.output).toFixed(0)+"x":"\u2014";var sp=(d.sub_pct||0)+"%";md.push("| "+d.date+" | "+oh+" | "+fmt(Math.round(d.output/ah))+" | "+fmt(Math.round(tot/ah))+" | "+sp+" |");}
  md.push("");

  // 3. Subagent
  md.push("## 3. "+(isDE?"Subagent-Analyse":"Subagent Analysis"));
  md.push("");
  md.push("| "+(isDE?"Datum":"Date")+" | "+(isDE?"Aufrufe":"Calls")+" | Sub | Sub-Cache | Sub-Cache% |");
  md.push("|------------|--------|------|-----------|------------|");
  for(var i=0;i<days.length;i++){var d=days[i];var sc=d.sub_cache||0;var scp=(d.sub_cache_pct||0)+"%";md.push("| "+d.date+" | "+d.calls+" | "+(d.sub_calls||0)+" | "+fmt(sc)+" | "+scp+" |");}
  md.push("");

  // 4. Budget estimate
  if(limitDays.length>0 && peakDay){
    md.push("## 4. "+(isDE?"Budget-Sch\u00e4tzung":"Budget Estimate"));
    md.push("");
    md.push((isDE?"Impl@90% = Total / 0.9 (gesch\u00e4tztes Budget wenn ~90% erreicht).":"Impl@90% = total / 0.9 (estimated budget if ~90% was reached)."));
    md.push("");
    md.push("| "+(isDE?"Datum":"Date")+" | Total | Impl@90% | vs Peak | "+(isDE?"Std.":"Hours")+" | "+(isDE?"Signal":"Signal")+" |");
    md.push("|------------|---------|----------|---------|-------|--------|");
    var prevI=0;
    for(var li=0;li<limitDays.length;li++){var ld=limitDays[li];var tot=dayTotal(ld.d);var impl=Math.round(tot/0.9);var vsp=peakVal>0?(peakVal/impl).toFixed(1)+"x":"\u2014";var trend="";if(prevI>0){var ch=Math.round(((impl-prevI)/prevI)*100);if(ch>5)trend=" \u2191"+ch+"%";else if(ch<-5)trend=" \u2193"+Math.abs(ch)+"%";else trend=" \u2192";}prevI=impl;md.push("| "+ld.d.date+" | "+fmt(tot)+" | "+fmt(impl)+" | "+vsp+" | "+(ld.d.active_hours||0)+" | "+ld.flags.join(", ")+trend+" |");}

    // Median
    var ivs=[];
    for(var li=0;li<limitDays.length;li++){var ld=limitDays[li];if(ld.d.calls>=50&&(ld.d.active_hours||0)>=2)ivs.push(Math.round(dayTotal(ld.d)/0.9));}
    if(ivs.length>=2){
      ivs.sort(function(a,b){return a-b;});
      var med=ivs[Math.floor(ivs.length/2)];
      md.push("");
      md.push((isDE?"**Zusammenfassung** (":"**Summary** (")+ivs.length+(isDE?" aussagekr\u00e4ftige Limit-Tage):":" meaningful limit days):"));
      md.push("- Median Impl@90%: ~"+fmt(med));
      md.push("- "+(isDE?"Bereich: ":"Range: ")+fmt(ivs[0])+" .. "+fmt(ivs[ivs.length-1]));
      md.push("- Peak: "+fmt(peakVal)+" ("+peakDay.date+")");
      if(med>0)md.push("- Peak / Median: "+(peakVal/med).toFixed(1)+"x");
    }
    md.push("");
  }

  // 5. Peak vs Limit comparison
  if(peakDay && limitDays.length>0){
    var bestLim=null;
    for(var li=limitDays.length-1;li>=0;li--){var ld=limitDays[li];if(ld.d.calls>=50&&(ld.d.active_hours||0)>=2){bestLim=ld;break;}}
    if(!bestLim)bestLim=limitDays[limitDays.length-1];
    if(bestLim && bestLim.d.date!==peakDay.date){
      md.push("## "+(isDE?"Fazit: Peak vs. Limit-Tag":"Conclusion: Peak vs. Limit Day"));
      md.push("");
      var tP=dayTotal(peakDay),tL=dayTotal(bestLim.d);
      md.push("| | "+peakDay.date+" (Peak) | "+bestLim.d.date+" (Limit) |");
      md.push("|---|---|---|");
      md.push("| Output | "+fmt(peakDay.output)+" | "+fmt(bestLim.d.output)+" |");
      md.push("| Cache Read | "+fmt(peakDay.cache_read)+" | "+fmt(bestLim.d.cache_read)+" |");
      md.push("| Total | "+fmt(tP)+" | "+fmt(tL)+" |");
      md.push("| "+(isDE?"Stunden":"Hours")+" | "+(peakDay.active_hours||0)+" | "+(bestLim.d.active_hours||0)+" |");
      md.push("| Calls | "+peakDay.calls+" | "+bestLim.d.calls+" |");
      var crP=peakDay.output>0?Math.round(peakDay.cache_read/peakDay.output):0;
      var crL=bestLim.d.output>0?Math.round(bestLim.d.cache_read/bestLim.d.output):0;
      md.push("| C:O Ratio | "+crP+"x | "+crL+"x |");
      md.push("");
      var impl=Math.round(tL/0.9);
      var drop=impl>0?Math.round(tP/impl):0;
      if(drop>1){
        md.push("**"+(isDE?"Effektive Budget-Reduktion: ~":"Effective budget reduction: ~")+drop+"x**");
        md.push("");
      }
    }
  }

  // ─── Service Impact: Work vs Outage mit ASCII-Bars ───
  var hasAnyOutage=false;
  for(var oi=0;oi<days.length;oi++){if((days[oi].outage_hours||0)>0){hasAnyOutage=true;break;}}
  if(hasAnyOutage){
    md.push("## "+(isDE?"Service Impact: Arbeitszeit vs. Ausfall":"Service Impact: Work vs. Outage"));
    md.push("");
    md.push((isDE?"Legende: ":"Legend: ")+"\u2588 = "+(isDE?"saubere Arbeit":"clean work")+" | \u2593 = "+(isDE?"Arbeit bei Ausfall":"work during outage")+" | \u2591 = "+(isDE?"Ausfall (keine Arbeit)":"outage (no work)"));
    md.push("");
    // Berechne max Stunden fuer Skalierung
    var maxH=0;
    var svcRows=[];
    for(var si=0;si<days.length;si++){
      var sd=days[si];
      var wHrs=Object.keys(sd.hours||{}).map(function(h){return parseInt(h);});
      var spans=sd.outage_spans||[];
      var affected=0;
      for(var wi=0;wi<wHrs.length;wi++){
        for(var oj=0;oj<spans.length;oj++){
          if(wHrs[wi]>=Math.floor(spans[oj].from)&&wHrs[wi]<Math.ceil(spans[oj].to)){affected++;break;}
        }
      }
      var outTotal=0;
      for(var oj=0;oj<spans.length;oj++) outTotal+=spans[oj].to-spans[oj].from;
      var clean=wHrs.length-affected;
      var outOnly=Math.max(0,Math.round((outTotal-affected)*10)/10);
      var totalH=clean+affected+outOnly;
      if(totalH>maxH)maxH=totalH;
      svcRows.push({date:sd.date,clean:clean,affected:affected,outOnly:outOnly,cr:sd.cache_read||0,co:sd.cache_output_ratio||0,outageH:sd.outage_hours||0,mc:sd.model_change});
    }
    var barW=40;
    md.push("```");
    for(var si=0;si<svcRows.length;si++){
      var r=svcRows[si];
      var totalH=r.clean+r.affected+r.outOnly;
      if(totalH===0&&r.outageH===0) continue;
      var scale=maxH>0?barW/maxH:1;
      var bClean=Math.round(r.clean*scale);
      var bAff=Math.round(r.affected*scale);
      var bOut=Math.round(r.outOnly*scale);
      var bar="";
      for(var b=0;b<bClean;b++) bar+="\u2588";
      for(var b=0;b<bAff;b++) bar+="\u2593";
      for(var b=0;b<bOut;b++) bar+="\u2591";
      var label=r.date.slice(5)+" "+bar+" ";
      if(r.affected>0) label+=r.clean+"h+"+(isDE?r.affected+"h Ausfall":r.affected+"h outage");
      else label+=r.clean+"h";
      if(r.outOnly>0) label+=" (+"+r.outOnly.toFixed(0)+"h "+(isDE?"nur Ausfall":"outage only")+")";
      if(r.cr>0) label+=" | C:"+fmt(r.cr)+" ("+r.co+"x)";
      if(r.mc){
        if(r.mc.added&&r.mc.added.length) label+=" \u25c7+"+r.mc.added.join(",");
        if(r.mc.removed&&r.mc.removed.length) label+=" \u25c7-"+r.mc.removed.join(",");
      }
      md.push(label);
    }
    md.push("```");
    md.push("");
    // Zusammenfassung
    var totClean=0,totAff=0,totOutOnly=0;
    for(var si=0;si<svcRows.length;si++){totClean+=svcRows[si].clean;totAff+=svcRows[si].affected;totOutOnly+=svcRows[si].outOnly;}
    md.push((isDE?"**Gesamt:** ":"**Total:** ")+totClean+"h "+(isDE?"saubere Arbeit":"clean work")+" | "+totAff+"h "+(isDE?"Arbeit bei Ausfall":"work during outage")+" | "+Math.round(totOutOnly)+"h "+(isDE?"Ausfall ohne Arbeit":"outage without work"));
    if(totAff>0&&(totClean+totAff)>0){
      var pctAff=Math.round(totAff/(totClean+totAff)*100);
      md.push((isDE?"**Betroffene Arbeitszeit: ":"**Affected work time: ")+pctAff+"%**");
    }
    md.push("");
  }

  // ─── Extension-Versionen & Releases ───
  var hasVerChange=false;
  for(var vi=0;vi<days.length;vi++){if(days[vi].version_change){hasVerChange=true;break;}}
  if(hasVerChange){
    md.push("## "+(isDE?"Extension-Updates (Claude Code)":"Extension Updates (Claude Code)"));
    md.push("");
    md.push("| "+(isDE?"Datum":"Date")+" | Version | Highlights |");
    md.push("|------------|---------|------------|");
    for(var vi=0;vi<days.length;vi++){
      var vc=days[vi].version_change;
      if(!vc)continue;
      var ver=vc.added.join(", ");
      if(vc.from)ver=vc.from+" \u2192 "+ver;
      var hl=(vc.highlights||[]).slice(0,3).join("; ");
      if(hl.length>120)hl=hl.slice(0,117)+"...";
      md.push("| "+days[vi].date+" | "+ver+" | "+hl+" |");
    }
    md.push("");
  }

  // ─── Thinking-Token Hinweis ───
  md.push("> "+(isDE?"\u26a0 **Hinweis:** Thinking-Tokens (internes Reasoning) erscheinen nicht in der API-Antwort und werden nicht gez\u00e4hlt. Sie belasten wahrscheinlich das Session-Budget.":"\u26a0 **Note:** Thinking tokens (internal reasoning) do not appear in the API response and are not counted here. They likely count against the session budget."));
  md.push("");

  md.push("---");
  md.push((isDE?"*Alle Werte heuristisch \u2014 kein offizieller API-Nachweis. Generiert vom Claude Usage Dashboard.*":"*All values are heuristic \u2014 not official API proof. Generated by Claude Usage Dashboard.*"));
  md.push("");
  return md.join("\n");
}

function openReportModal(){
  if(!__lastUsageData||!__lastUsageData.days||!__lastUsageData.days.length)return;
  var md=generateForensicReportMd(__lastUsageData);
  document.getElementById("report-content").textContent=md;
  document.getElementById("report-modal-title").textContent=t("reportTitle");
  document.getElementById("report-copy-btn").textContent=t("reportCopy");
  document.getElementById("report-download-btn").textContent=t("reportDownload");
  document.getElementById("report-modal-overlay").classList.add("open");
}
function closeReportModal(){
  document.getElementById("report-modal-overlay").classList.remove("open");
}
function downloadReport(){
  var text=document.getElementById("report-content").textContent;
  var blob=new Blob([text],{type:"text/markdown;charset=utf-8"});
  var url=URL.createObjectURL(blob);
  var a=document.createElement("a");
  a.href=url;a.download="forensic-report-"+new Date().toISOString().slice(0,10)+".md";
  document.body.appendChild(a);a.click();document.body.removeChild(a);URL.revokeObjectURL(url);
}
function copyReport(){
  var text=document.getElementById("report-content").textContent;
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
  if(bde) bde.addEventListener("click",function(){ setLang("de"); });
  if(ben) ben.addEventListener("click",function(){ setLang("en"); });
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
        openUpdateSlideout(parseInt(btn.dataset.dayIndex, 10));
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
  var rov=document.getElementById("report-modal-overlay");
  if(rov){rov.addEventListener("click",function(e){if(e.target===rov)closeReportModal();});}
})();

// ── Proxy Analytics Panel ─────────────────────────────────────────────────
var _proxyCharts = { gauge5h: null, gauge7d: null, tokens: null, latency: null };

function getProxyDay(data) {
  if (!data || !data.proxy || !data.proxy.proxy_days) return null;
  var pd = data.proxy.proxy_days;
  return pd.length > 0 ? pd[pd.length - 1] : null;
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
  var q5pct = q5h != null ? (parseFloat(q5h) * 100).toFixed(1) : "?";
  var q7pct = q7d != null ? (parseFloat(q7d) * 100).toFixed(1) : "?";
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

  var pcards = [
    {
      label: t("proxyCardRequests"),
      value: String(pd.requests || 0),
      sub: tr("proxyCardRequestsSub", { errs: pd.errors || 0, rate: (pd.error_rate || 0).toFixed(1) }),
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
    }
  ];
  if (cardsEl) {
    var ch2 = "";
    pcards.forEach(function (c) {
      ch2 += "<div class=\"card " + c.cls + "\"><div class=\"label\">" + escHtml(c.label) + "</div><div class=\"value\">" + escHtml(c.value) + "</div><div class=\"sub\">" + escHtml(c.sub) + "</div></div>";
    });
    cardsEl.innerHTML = ch2;
  }

  // i18n labels for chart headings
  var h3rl = document.getElementById("proxy-ratelimit-h3");
  if (h3rl) h3rl.textContent = t("proxyRatelimitTitle");
  var blurbRl = document.getElementById("proxy-ratelimit-blurb");
  if (blurbRl) blurbRl.textContent = t("proxyRatelimitBlurb");
  var h3tok = document.getElementById("proxy-token-chart-h3");
  if (h3tok) h3tok.textContent = t("proxyTokenChartTitle");
  var blurbTok = document.getElementById("proxy-token-blurb");
  if (blurbTok) blurbTok.textContent = t("proxyTokenBlurb");
  var h3lat = document.getElementById("proxy-latency-chart-h3");
  if (h3lat) h3lat.textContent = t("proxyLatencyChartTitle");
  var blurbLat = document.getElementById("proxy-latency-blurb");
  if (blurbLat) blurbLat.textContent = t("proxyLatencyBlurb");

  renderProxyGauges(pd);
  renderProxyTokenChart(data);
  renderProxyLatencyChart(data);
  renderProxyHourlyHeatmap(pd);
  renderProxyModelChart(pd);
  renderProxyStatusChart(pd);
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
  renderProxyJsonlComparison(data);
  renderProxyHourlyLatency(pd);
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

function renderProxyGauges(pd) {
  if (typeof Chart === "undefined") return;
  var rl = pd.rate_limit || {};

  var q5 = parseFloat(rl["anthropic-ratelimit-unified-5h-utilization"] || 0) * 100;
  var q7 = parseFloat(rl["anthropic-ratelimit-unified-7d-utilization"] || 0) * 100;

  renderOneGauge("c-proxy-5h", "gauge5h", q5, "proxy-gauge-5h-title", t("proxyGauge5hTitle"), rl["anthropic-ratelimit-unified-5h-reset"]);
  renderOneGauge("c-proxy-7d", "gauge7d", q7, "proxy-gauge-7d-title", t("proxyGauge7dTitle"), rl["anthropic-ratelimit-unified-7d-reset"]);
}

function renderOneGauge(canvasId, chartKey, usedPct, titleId, titleText, resetEpoch) {
  var el = document.getElementById(canvasId);
  if (!el) return;
  var titleEl = document.getElementById(titleId);
  var resetStr = "";
  if (resetEpoch) {
    var now = Date.now() / 1000;
    var diff = parseInt(resetEpoch, 10) - now;
    if (diff > 0) {
      var rh = Math.floor(diff / 3600);
      var rm = Math.floor((diff % 3600) / 60);
      resetStr = tr("proxyGaugeResetIn", { h: rh, m: rm });
    }
  }
  if (titleEl) titleEl.textContent = titleText + (resetStr ? " — " + resetStr : "");

  var remaining = Math.max(0, 100 - usedPct);
  var color = gaugeColor(usedPct);

  if (_proxyCharts[chartKey]) {
    _proxyCharts[chartKey].data.datasets[0].data = [usedPct, remaining];
    _proxyCharts[chartKey].data.datasets[0].backgroundColor = [color, "rgba(51,65,85,.3)"];
    _proxyCharts[chartKey].options.plugins.title.text = usedPct.toFixed(1) + "%";
    freezeChartNoAnim(_proxyCharts[chartKey]);
    _proxyCharts[chartKey].update("none");
    return;
  }

  _proxyCharts[chartKey] = new Chart(el.getContext("2d"), {
    type: "doughnut",
    data: {
      labels: [t("proxyGaugeUsed"), t("proxyGaugeRemaining")],
      datasets: [{
        data: [usedPct, remaining],
        backgroundColor: [color, "rgba(51,65,85,.3)"],
        borderWidth: 0,
        cutout: "75%"
      }]
    },
    options: {
      responsive: true,
      animation: false,
      transitions: __chartTransitionsOff,
      maintainAspectRatio: true,
      transitions: __chartTransitionsOff,
      plugins: {
        legend: { display: false },
        title: {
          display: true,
          text: usedPct.toFixed(1) + "%",
          color: color,
          font: { size: 28, weight: "bold" },
          position: "bottom",
          padding: { top: 0 }
        },
        tooltip: {
          callbacks: {
            label: function (ctx) { return ctx.label + ": " + ctx.parsed.toFixed(1) + "%"; }
          }
        }
      }
    }
  });
}

function renderProxyTokenChart(data) {
  if (typeof Chart === "undefined") return;
  var proxyDays = (data.proxy && data.proxy.proxy_days) || [];
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
  var proxyDays = (data.proxy && data.proxy.proxy_days) || [];
  if (!proxyDays.length) { chartShellSetLoading("c-proxy-latency", false); return; }

  var labels = [];
  var avg = [];
  var mn = [];
  var mx = [];
  for (var i = 0; i < proxyDays.length; i++) {
    var d = proxyDays[i];
    labels.push(d.date ? d.date.slice(5) : String(i));
    avg.push(d.avg_duration_ms || 0);
    mn.push(d.min_duration_ms || 0);
    mx.push(d.max_duration_ms || 0);
  }

  chartShellSetLoading("c-proxy-latency", false);
  var el = document.getElementById("c-proxy-latency");
  if (!el) return;

  if (_proxyCharts.latency) {
    _proxyCharts.latency.data.labels = labels;
    _proxyCharts.latency.data.datasets[0].data = avg;
    _proxyCharts.latency.data.datasets[1].data = mn;
    _proxyCharts.latency.data.datasets[2].data = mx;
    freezeChartNoAnim(_proxyCharts.latency);
    _proxyCharts.latency.update("none");
    return;
  }

  _proxyCharts.latency = new Chart(el.getContext("2d"), {
    type: "line",
    data: {
      labels: labels,
      datasets: [
        { label: t("proxyDSAvgLatency"), data: avg, borderColor: "#3b82f6", backgroundColor: "rgba(59,130,246,.15)", fill: true, tension: .3, pointRadius: 3 },
        { label: t("proxyDSMinLatency"), data: mn, borderColor: "#22c55e", borderDash: [4, 2], tension: .3, pointRadius: 2 },
        { label: t("proxyDSMaxLatency"), data: mx, borderColor: "#ef4444", borderDash: [4, 2], tension: .3, pointRadius: 2 }
      ]
    },
    options: {
      responsive: true,
      animation: false,
      transitions: __chartTransitionsOff,
      interaction: { mode: "index", intersect: false },
      scales: {
        x: { ticks: { color: "#94a3b8", font: { size: 10 } }, grid: { color: "rgba(51,65,85,.4)" } },
        y: { ticks: { color: "#94a3b8", callback: function (v) { return v + "ms"; } }, grid: { color: "rgba(51,65,85,.4)" } }
      },
      plugins: {
        legend: { labels: { color: "#e2e8f0", boxWidth: 12, font: { size: 11 } } },
        tooltip: {
          callbacks: {
            label: function (ctx) { return ctx.dataset.label + ": " + Math.round(ctx.parsed.y) + "ms"; }
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
  var q5 = parseFloat(rl["anthropic-ratelimit-unified-5h-utilization"] || 0);
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
function renderProxyHourlyHeatmap(pd) {
  if (typeof Chart === "undefined") return;
  var el = document.getElementById("c-proxy-hourly");
  if (!el) return;
  var hours = pd.hours || {};
  var labels = [];
  var values = [];
  var bgColors = [];
  for (var h = 0; h <= 23; h++) {
    labels.push(String(h).length < 2 ? "0" + h : String(h));
    var v = hours[String(h)] || 0;
    values.push(v);
    var intensity = v === 0 ? 0 : Math.min(1, v / 80);
    bgColors.push(v === 0 ? "rgba(51,65,85,.2)" : "rgba(59,130,246," + (0.2 + intensity * 0.7).toFixed(2) + ")");
  }

  chartShellSetLoading("c-proxy-hourly", false);

  if (_proxyCharts.hourly) {
    _proxyCharts.hourly.data.datasets[0].data = values;
    _proxyCharts.hourly.data.datasets[0].backgroundColor = bgColors;
    freezeChartNoAnim(_proxyCharts.hourly);
    _proxyCharts.hourly.update("none");
    return;
  }

  _proxyCharts.hourly = new Chart(el.getContext("2d"), {
    type: "bar",
    data: {
      labels: labels,
      datasets: [{
        label: t("proxyDSRequestsPerHour"),
        data: values,
        backgroundColor: bgColors,
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
            label: function (ctx) { return ctx.parsed.y + " requests"; }
          }
        }
      }
    }
  });
}

// ── Phase 4: Error/Status Timeline ────────────────────────────────────────
function renderProxyStatusChart(pd) {
  if (typeof Chart === "undefined") return;
  var el = document.getElementById("c-proxy-status");
  if (!el) return;
  var sc = pd.status_codes || {};
  var labels = [];
  var values = [];
  var colors = [];
  var colorMap = { "200": "#22c55e", "401": "#f59e0b", "403": "#f97316", "404": "#94a3b8", "405": "#94a3b8", "429": "#ef4444", "500": "#ef4444", "502": "#ef4444", "503": "#ef4444" };
  var keys = Object.keys(sc).sort();
  for (var i = 0; i < keys.length; i++) {
    labels.push(keys[i]);
    values.push(sc[keys[i]]);
    colors.push(colorMap[keys[i]] || "#8b5cf6");
  }

  chartShellSetLoading("c-proxy-status", false);
  if (!keys.length) return;

  if (_proxyCharts.status) {
    _proxyCharts.status.data.labels = labels;
    _proxyCharts.status.data.datasets[0].data = values;
    _proxyCharts.status.data.datasets[0].backgroundColor = colors;
    freezeChartNoAnim(_proxyCharts.status);
    _proxyCharts.status.update("none");
    return;
  }

  _proxyCharts.status = new Chart(el.getContext("2d"), {
    type: "doughnut",
    data: {
      labels: labels,
      datasets: [{ data: values, backgroundColor: colors, borderWidth: 0 }]
    },
    options: {
      responsive: true,
      animation: false,
      transitions: __chartTransitionsOff,
      maintainAspectRatio: true,
      transitions: __chartTransitionsOff,
      plugins: {
        legend: { position: "right", labels: { color: "#e2e8f0", boxWidth: 12, font: { size: 11 } } },
        tooltip: {
          callbacks: {
            label: function (ctx) { return "HTTP " + ctx.label + ": " + ctx.parsed + " (" + pct(ctx.parsed, pd.requests || 1) + ")"; }
          }
        }
      }
    }
  });
}

// ── Phase 5: Model Breakdown ──────────────────────────────────────────────
function renderProxyModelChart(pd) {
  if (typeof Chart === "undefined") return;
  var el = document.getElementById("c-proxy-models");
  if (!el) return;
  var models = pd.models || {};
  var labels = [];
  var reqData = [];
  var latData = [];
  var colors = ["#8b5cf6", "#3b82f6", "#06b6d4", "#22c55e", "#f59e0b", "#ef4444", "#ec4899"];
  var ci = 0;
  var bgColors = [];
  for (var mk in models) {
    if (!Object.prototype.hasOwnProperty.call(models, mk)) continue;
    var m = models[mk];
    var short = mk.replace("claude-", "").replace(/-\d{8}$/, "");
    labels.push(short);
    reqData.push(m.requests || 0);
    latData.push(m.avg_duration_ms || 0);
    bgColors.push(colors[ci % colors.length]);
    ci++;
  }

  chartShellSetLoading("c-proxy-models", false);
  if (!labels.length) return;

  if (_proxyCharts.models) {
    _proxyCharts.models.data.labels = labels;
    _proxyCharts.models.data.datasets[0].data = reqData;
    _proxyCharts.models.data.datasets[1].data = latData;
    freezeChartNoAnim(_proxyCharts.models);
    _proxyCharts.models.update("none");
    return;
  }

  _proxyCharts.models = new Chart(el.getContext("2d"), {
    type: "bar",
    data: {
      labels: labels,
      datasets: [
        { label: t("proxyDSModelRequests"), data: reqData, backgroundColor: bgColors, yAxisID: "y", borderRadius: 3 },
        { label: t("proxyDSModelLatency"), data: latData, type: "line", borderColor: "#f59e0b", backgroundColor: "rgba(245,158,11,.15)", yAxisID: "y1", tension: 0.3, pointRadius: 4 }
      ]
    },
    options: {
      responsive: true,
      animation: false,
      transitions: __chartTransitionsOff,
      interaction: { mode: "index", intersect: false },
      scales: {
        x: { ticks: { color: "#94a3b8", font: { size: 10 } }, grid: { color: "rgba(51,65,85,.4)" } },
        y: { position: "left", ticks: { color: "#94a3b8" }, grid: { color: "rgba(51,65,85,.4)" }, beginAtZero: true, title: { display: true, text: "Requests", color: "#94a3b8", font: { size: 10 } } },
        y1: { position: "right", ticks: { color: "#f59e0b", callback: function (v) { return v >= 1000 ? (v / 1000).toFixed(1) + "s" : v + "ms"; } }, grid: { drawOnChartArea: false }, beginAtZero: true, title: { display: true, text: "Latency", color: "#f59e0b", font: { size: 10 } } }
      },
      plugins: {
        legend: { labels: { color: "#e2e8f0", boxWidth: 12, font: { size: 11 } } },
        tooltip: {
          callbacks: {
            label: function (ctx) {
              if (ctx.datasetIndex === 1) return ctx.dataset.label + ": " + (ctx.parsed.y >= 1000 ? (ctx.parsed.y / 1000).toFixed(1) + "s" : Math.round(ctx.parsed.y) + "ms");
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
function renderProxyJsonlComparison(data) {
  var el = document.getElementById("proxy-jsonl-compare");
  if (!el) return;
  var days = data.days || [];
  var proxyDays = (data.proxy && data.proxy.proxy_days) || [];
  if (!days.length || !proxyDays.length) {
    el.textContent = days.length ? "" : t("proxyJsonlNoData");
    return;
  }
  // Match days
  var proxyByDate = {};
  for (var pi = 0; pi < proxyDays.length; pi++) {
    proxyByDate[proxyDays[pi].date] = proxyDays[pi];
  }
  var matches = 0;
  var jsonlTotal = 0;
  var proxyTotal = 0;
  for (var di = 0; di < days.length; di++) {
    var pd = proxyByDate[days[di].date];
    if (!pd) continue;
    matches++;
    jsonlTotal += (days[di].total || 0);
    proxyTotal += (pd.total_tokens || 0);
  }
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
function renderProxyHourlyLatency(pd) {
  if (typeof Chart === "undefined") return;
  var el = document.getElementById("c-proxy-hourly-latency");
  if (!el) return;
  var phl = pd.per_hour_latency || {};
  var labels = [];
  var avgData = [];
  var maxData = [];
  for (var h = 0; h <= 23; h++) {
    labels.push(String(h).length < 2 ? "0" + h : String(h));
    var hl = phl[String(h)] || phl[h];
    if (hl && hl.count > 0) {
      avgData.push(Math.round(hl.sum / hl.count));
      maxData.push(hl.max);
    } else {
      avgData.push(0);
      maxData.push(0);
    }
  }

  chartShellSetLoading("c-proxy-hourly-latency", false);

  if (_proxyCharts.hourlyLatency) {
    _proxyCharts.hourlyLatency.data.datasets[0].data = avgData;
    _proxyCharts.hourlyLatency.data.datasets[1].data = maxData;
    freezeChartNoAnim(_proxyCharts.hourlyLatency);
    _proxyCharts.hourlyLatency.update("none");
    return;
  }

  _proxyCharts.hourlyLatency = new Chart(el.getContext("2d"), {
    type: "bar",
    data: {
      labels: labels,
      datasets: [
        { label: t("proxyDSAvgLatency"), data: avgData, backgroundColor: "rgba(59,130,246,.6)", borderRadius: 2 },
        { label: t("proxyDSMaxLatency"), data: maxData, backgroundColor: "rgba(239,68,68,.35)", borderRadius: 2 }
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

  // Thinking Gap: compare today JSONL vs proxy
  var thinkingGap = 0;
  if (pd && days.length) {
    var todayJsonl = null;
    for (var j = 0; j < days.length; j++) {
      if (days[j].date === pd.date) { todayJsonl = days[j]; break; }
    }
    if (todayJsonl && (pd.total_tokens || 0) > 0) {
      thinkingGap = (todayJsonl.total || 0) / pd.total_tokens;
    }
  }

  // Proxy metrics (fallback to 0/defaults if no proxy)
  var rl = pd ? (pd.rate_limit || {}) : {};
  var q5h = parseFloat(rl["anthropic-ratelimit-unified-5h-utilization"] || 0) * 100;
  var cacheRatio = pd ? ((pd.cache_read_ratio || 0) * 100) : 100;
  var errorRate = pd ? (pd.error_rate || 0) : 0;
  var avgLatMs = pd ? (pd.avg_duration_ms || 0) : 0;
  var avgLatS = avgLatMs / 1000;
  var coldStarts = pd ? (pd.cold_starts || 0) : 0;

  return [
    { id: "quota5h", label: t("healthQuota5h"), value: q5h, display: q5h.toFixed(0) + "%", color: healthColor(q5h, 50, 80), barPct: Math.min(100, q5h) },
    { id: "thinkingGap", label: t("healthThinkingGap"), value: thinkingGap, display: thinkingGap > 0 ? thinkingGap.toFixed(1) + "x" : "-", color: thinkingGap <= 0 ? "green" : healthColor(thinkingGap, 2, 5), barPct: Math.min(100, thinkingGap * 10) },
    { id: "cacheHealth", label: t("healthCacheHealth"), value: cacheRatio, display: cacheRatio.toFixed(1) + "%", color: healthColorInverse(cacheRatio, 90, 70), barPct: cacheRatio },
    { id: "errorRate", label: t("healthErrorRate"), value: errorRate, display: errorRate.toFixed(1) + "%", color: healthColor(errorRate, 3, 10), barPct: Math.min(100, errorRate * 5) },
    { id: "hitLimits", label: t("healthHitLimits"), value: hitsPerDay, display: String(hitsPerDay), color: healthColor(hitsPerDay, 50, 500), barPct: Math.min(100, hitsPerDay / 10) },
    { id: "latency", label: t("healthLatency"), value: avgLatS, display: avgLatS >= 1 ? avgLatS.toFixed(1) + "s" : Math.round(avgLatMs) + "ms", color: healthColor(avgLatS, 5, 15), barPct: Math.min(100, avgLatS * 5) },
    { id: "interrupts", label: t("healthInterrupts"), value: interruptsPerDay, display: String(interruptsPerDay), color: healthColor(interruptsPerDay, 100, 500), barPct: Math.min(100, interruptsPerDay / 10) },
    { id: "coldStarts", label: t("healthColdStarts"), value: coldStarts, display: String(coldStarts), color: healthColor(coldStarts, 0, 5), barPct: Math.min(100, coldStarts * 10) },
    { id: "retries", label: t("healthRetries"), value: retriesPerDay, display: String(retriesPerDay), color: healthColor(retriesPerDay, 50, 200), barPct: Math.min(100, retriesPerDay / 5) }
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
  renderHealthHistory(data);
  renderIncidentHistory(data);

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
    var q5 = parseFloat(rl["anthropic-ratelimit-unified-5h-utilization"] || 0) * 100;
    var q7 = parseFloat(rl["anthropic-ratelimit-unified-7d-utilization"] || 0) * 100;
    if (q5 > 0) {
      findings.push({
        icon: q5 > 80 ? "red" : q5 > 50 ? "yellow" : "green",
        title: t("findingQuota"),
        value: q5.toFixed(0) + "% / " + q7.toFixed(0) + "%",
        detail: tr("findingQuotaDetail", { q5: q5.toFixed(1), q7: q7.toFixed(1), reqs: pd.requests || 0, output: fmt(pd.output_tokens || 0) })
      });
    }
  }

  // 6. Peak Day
  if (peakDay) {
    findings.push({
      icon: peakTotal > 2e9 ? "red" : peakTotal > 500e6 ? "yellow" : "green",
      title: t("findingPeakDay"),
      value: peakDay.date,
      detail: tr("findingPeakDayDetail", { total: fmt(peakTotal), calls: peakDay.calls || 0, overhead: peakDay.overhead || 0 })
    });
  }

  // 7. Retries
  if (totalRetries > 0) {
    var rpd = Math.round(totalRetries / numDays);
    findings.push({
      icon: rpd > 200 ? "red" : rpd > 50 ? "yellow" : "green",
      title: t("findingRetries"),
      value: fmt(totalRetries),
      detail: tr("findingRetriesDetail", { total: totalRetries, perDay: rpd })
    });
  }

  // 8. Cache paradox
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
  var pdays = (data.proxy && data.proxy.proxy_days) || [];
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
    var hkeys = Object.keys(hosts).sort();
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
  var q5h = parseFloat(rl["anthropic-ratelimit-unified-5h-utilization"] || 0) * 100;
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
  var proxyDays = (data.proxy && data.proxy.proxy_days) || [];
  var proxyByDate = {};
  for (var pi = 0; pi < proxyDays.length; pi++) proxyByDate[proxyDays[pi].date] = proxyDays[pi];
  var scores = [];
  for (var di = 0; di < days.length; di++) {
    scores.push(computeHealthScoreForDay(days[di], proxyByDate[days[di].date] || null));
  }
  return scores;
}

function renderHealthHistory(data) {
  if (typeof Chart === "undefined") return;
  var el = document.getElementById("c-health-history");
  if (!el) return;
  var titleEl = document.getElementById("health-history-title");
  if (titleEl) titleEl.textContent = t("healthHistoryLabel");

  var scores = buildHealthScoreHistory(data);
  if (scores.length < 2) { return; }

  var days = getFilteredDays(data.days || []);
  var labels = [];
  var colors = [];
  for (var i = 0; i < days.length && i < scores.length; i++) {
    labels.push(days[i].date.slice(5));
    colors.push(scores[i] > 7 ? "#22c55e" : scores[i] >= 4 ? "#f59e0b" : "#ef4444");
  }

  if (_proxyCharts.healthHistory) {
    freezeChartNoAnim(_proxyCharts.healthHistory);
    _proxyCharts.healthHistory.data.labels = labels;
    _proxyCharts.healthHistory.data.datasets[0].data = scores;
    _proxyCharts.healthHistory.data.datasets[0].pointBackgroundColor = colors;
    _proxyCharts.healthHistory.update("none");
    return;
  }

  _proxyCharts.healthHistory = new Chart(el.getContext("2d"), {
    type: "line",
    data: {
      labels: labels,
      datasets: [{
        label: t("healthHistoryLabel"),
        data: scores,
        borderColor: "#3b82f6",
        backgroundColor: "rgba(59,130,246,.08)",
        fill: true,
        tension: 0.3,
        pointRadius: 5,
        pointBackgroundColor: colors,
        pointBorderColor: colors
      }]
    },
    options: {
      responsive: true,
      animation: false,
      transitions: __chartTransitionsOff,
      scales: {
        x: { ticks: { color: "#94a3b8", font: { size: 10 } }, grid: { color: "rgba(51,65,85,.4)" } },
        y: { min: 0, max: 10, ticks: { color: "#94a3b8", stepSize: 2 }, grid: { color: "rgba(51,65,85,.4)" } }
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: function(ctx) {
              var s = ctx.parsed.y;
              var status = s > 7 ? "OK" : s >= 4 ? t("healthHistoryWarn") : t("healthHistoryCrit");
              return t("healthScoreTitle") + ": " + s + "/10 (" + status + ")";
            }
          }
        }
      }
    }
  });
}

// ── Incident History Chart ────────────────────────────────────────────────
function renderIncidentHistory(data) {
  if (typeof Chart === "undefined") return;
  var el = document.getElementById("c-incident-history");
  if (!el) return;
  var titleEl = document.getElementById("incident-history-title");
  if (titleEl) titleEl.textContent = t("incidentHistoryLabel");

  var days = getFilteredDays(data.days || []);
  if (days.length < 2) return;

  var labels = [];
  var outageHours = [];
  var hitLimits = [];
  var colors = [];
  for (var i = 0; i < days.length; i++) {
    var d = days[i];
    labels.push(d.date.slice(5));
    var oh = d.outage_hours || 0;
    outageHours.push(oh);
    hitLimits.push(d.hit_limit || 0);
    colors.push(oh > 2 ? "#ef4444" : oh > 0 ? "#f59e0b" : "#22c55e");
  }

  if (_proxyCharts.incidentHistory) {
    freezeChartNoAnim(_proxyCharts.incidentHistory);
    _proxyCharts.incidentHistory.data.labels = labels;
    _proxyCharts.incidentHistory.data.datasets[0].data = outageHours;
    _proxyCharts.incidentHistory.data.datasets[0].backgroundColor = colors;
    _proxyCharts.incidentHistory.data.datasets[1].data = hitLimits;
    _proxyCharts.incidentHistory.update("none");
    return;
  }

  _proxyCharts.incidentHistory = new Chart(el.getContext("2d"), {
    type: "bar",
    data: {
      labels: labels,
      datasets: [
        {
          label: t("incidentDSOutageHours"),
          data: outageHours,
          backgroundColor: colors,
          yAxisID: "y",
          borderRadius: 3
        },
        {
          label: t("incidentDSHitLimits"),
          data: hitLimits,
          type: "line",
          borderColor: "#f59e0b",
          backgroundColor: "rgba(245,158,11,.1)",
          yAxisID: "y1",
          tension: 0.3,
          pointRadius: 3,
          fill: true
        }
      ]
    },
    options: {
      responsive: true,
      animation: false,
      transitions: __chartTransitionsOff,
      interaction: { mode: "index", intersect: false },
      scales: {
        x: { ticks: { color: "#94a3b8", font: { size: 10 } }, grid: { color: "rgba(51,65,85,.4)" } },
        y: { position: "left", ticks: { color: "#94a3b8" }, grid: { color: "rgba(51,65,85,.4)" }, beginAtZero: true, title: { display: true, text: t("incidentAxisOutage"), color: "#94a3b8", font: { size: 10 } } },
        y1: { position: "right", ticks: { color: "#f59e0b" }, grid: { drawOnChartArea: false }, beginAtZero: true, title: { display: true, text: t("incidentAxisHitLimits"), color: "#f59e0b", font: { size: 10 } } }
      },
      plugins: {
        legend: { labels: { color: "#e2e8f0", boxWidth: 12, font: { size: 11 } } }
      }
    }
  });
}


function updateAnthropicPopup(data) {
  var oHead = document.getElementById("anthropic-popup-outage-head");
  var oList = document.getElementById("anthropic-popup-outage-list");
  var eHead = document.getElementById("anthropic-popup-ext-head");
  var eList = document.getElementById("anthropic-popup-ext-list");
  if (!oHead) return;

  // Outages
  var outages = data.outages || [];
  oHead.textContent = t("liveOutageHead");
  var ohtml = "";
  for (var oi = 0; oi < outages.length; oi++) {
    var o = outages[oi];
    var imp = (o.impact || "none").toUpperCase();
    var kind = o.kind ? " (" + o.kind + ")" : "";
    ohtml += "<li>" + escHtml(o.date || "") + " · [" + escHtml(imp) + "] " + escHtml(o.name || "") + escHtml(kind) + "</li>";
  }
  if (!ohtml) ohtml = '<li style="color:#64748b">' + escHtml(t("liveOutageEmpty")) + '</li>';
  if (oList) oList.innerHTML = ohtml;

  // Extensions
  var exts = data.extension_updates || [];
  eHead.textContent = t("liveExtHead");
  var ehtml = "";
  for (var ei = 0; ei < exts.length; ei++) {
    var ex = exts[ei];
    ehtml += "<li>" + escHtml(ex.date || "") + ": " + escHtml(ex.summary || ex.from + " → " + ex.to) + "</li>";
  }
  if (!ehtml) ehtml = '<li style="color:#64748b">' + escHtml(t("liveExtEmpty")) + '</li>';
  if (eList) eList.innerHTML = ehtml;
}

fetchUsageJsonOnce();
connectUsageStream();
scheduleFetchExtensionTimeline(900);
