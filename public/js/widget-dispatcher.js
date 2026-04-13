/**
 * Widget Dispatcher — Registry-driven orchestration layer.
 *
 * Reads __widgetRegistry and controls:
 *   - Render dispatch (which sections render, in what order)
 *   - Unified resize (one handler for all ECharts instances)
 *   - Visibility control (section + chart level, persisted in localStorage)
 *   - Section reordering (DOM reorder via insertBefore)
 *   - Disclosure toggle auto-binding
 *
 * Loads BEFORE dashboard.client.js but AFTER widget-registry.js.
 * All render functions are resolved by name from window[fnName] at dispatch time.
 */
'use strict';

(function (global) {
  /**
   * Layout-Prefs (Reihenfolge, Sichtbarkeit, widgets[]):
   * - Primärquelle: localStorage unter PREFS_KEY — nach DOM-Reload ist nur das sofort wieder da.
   * - GET/PUT /api/layout: immer derselbe Origin wie die Seite (lokaler dashboard-server). Datei = os.homedir()/.claude/…
   *   auf dem Rechner, auf dem Node läuft — auch bei DEV_MODE=full: dort kommen nur Nutzungsdaten von DEV_PROXY_SOURCE,
   *   nicht das Layout; deine gespeicherte usage-dashboard-layout.json bleibt lokal (z. B. C:\\Users\\…\\.claude\\…).
   *   loadPrefs: GET + X-Layout-Mtime; ist die Datei neuer als cud_layout_file_mtime, LS aus Datei überschreiben.
   */
  var PREFS_KEY = 'cud_widget_prefs';
  /** Letzter bekannter mtimeMs der Layout-Datei auf dem Server (Abgleich Handedit vs. LS). */
  var LAYOUT_FILE_MTIME_KEY = 'cud_layout_file_mtime';
  var PREFS_VERSION = 1;

  var _initialized = false;
  var _prefs = null;
  var _wtreeDragGhost = null;
  var _wtreeDragSrc = null;
  var _wtreeDropState = null;
  var _sidebarEventsBound = false;
  var _sidebarRestoreScheduled = false;
  /** Sidebar layout tree: Bearbeiten aktiv (bleibt über renderWidgetTree erhalten). */
  var _layoutTreeEditMode = false;

  function wtreeNextSectionLi(li) {
    if (!li?.parentNode) return null;
    var n = li.nextSibling;
    while (n) {
      if (n.nodeType === 1 && n.matches?.('li.widget-tree-item[data-section]')) return n;
      n = n.nextSibling;
    }
    return null;
  }

  function wtreePrevSectionLi(li) {
    if (!li?.parentNode) return null;
    var n = li.previousSibling;
    while (n) {
      if (n.nodeType === 1 && n.matches?.('li.widget-tree-item[data-section]')) return n;
      n = n.previousSibling;
    }
    return null;
  }

  function clearWtreeDropUi(ul) {
    if (!ul) return;
    var marks = ul.querySelectorAll(
      '.widget-tree-item--drop-before,.widget-tree-item--drop-after,.widget-tree-item--drop-gap-up,.widget-tree-item--drop-gap-down'
    );
    for (var mark of marks) {
      mark.classList.remove(
        'widget-tree-item--drop-before',
        'widget-tree-item--drop-after',
        'widget-tree-item--drop-gap-up',
        'widget-tree-item--drop-gap-down'
      );
    }
  }

  function wtreeFindDropState(ul, clientY, dragSrc) {
    var arr = [];
    var items = ul.querySelectorAll(':scope > li.widget-tree-item[data-section]');
    for (var item of items) arr.push(item);
    if (!arr.length) return null;
    var slot = arr.length;
    for (var j = 0; j < arr.length; j++) {
      var r = arr[j].getBoundingClientRect();
      var mid = r.top + r.height * 0.5;
      if (clientY < mid) {
        slot = j;
        break;
      }
    }
    var fromIdx = -1;
    for (var k = 0; k < arr.length; k++) {
      if (arr[k] === dragSrc) {
        fromIdx = k;
        break;
      }
    }
    if (fromIdx < 0) return null;
    if (slot === fromIdx || slot === fromIdx + 1) return { noop: true };
    var insertBeforeEl = slot < arr.length ? arr[slot] : null;
    return { noop: false, insertBefore: insertBeforeEl };
  }

  function applyWtreeDropUi(ul, state, dragSrc) {
    clearWtreeDropUi(ul);
    if (!state || state.noop || !dragSrc) return;
    if (state.insertBefore) {
      state.insertBefore.classList.add('widget-tree-item--drop-before');
      var prevEl = wtreePrevSectionLi(state.insertBefore);
      if (prevEl && prevEl !== dragSrc) prevEl.classList.add('widget-tree-item--drop-gap-up');
    } else {
      var lastEl = (function () {
        var it = ul.querySelectorAll(':scope > li.widget-tree-item[data-section]');
        return it.length ? it[it.length - 1] : null;
      })();
      if (lastEl) {
        lastEl.classList.add('widget-tree-item--drop-after');
        var nextEl = wtreeNextSectionLi(lastEl);
        if (nextEl && nextEl !== dragSrc) nextEl.classList.add('widget-tree-item--drop-gap-down');
      }
    }
  }

  // ── Preferences (localStorage) ──────────────────────────────────

  function sanitizeLayoutJsonRaw(raw) {
    if (raw == null || raw === '') return '';
    var s = String(raw);
    if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
    return s.trim();
  }

  function normalizePrefsShape(p) {
    if (!p || typeof p !== 'object') return p;
    if (!Array.isArray(p.hiddenSections)) p.hiddenSections = [];
    if (!Array.isArray(p.hiddenCharts)) p.hiddenCharts = [];
    // Strip empty layout blocks (legacy from pre-filter saves)
    if (Array.isArray(p.widgets)) {
      p.widgets = p.widgets.filter(function (w) {
        if (w.type === 'layout' && Array.isArray(w.nested) && !w.nested.length) return false;
        return true;
      });
    }
    return p;
  }

  /**
   * Akzeptiert Layout-JSON: fehlendes v, oder v als String ("1") aus Export/Handedit —
   * striktes p.v === 1 scheitert sonst und loadPrefs liefert jedes Mal defaultPrefs.
   */
  function prefsHasUsableWidgets(p) {
    return !!(p && Array.isArray(p.widgets) && p.widgets.length);
  }

  function tryAcceptPrefsPayload(p) {
    if (!p || typeof p !== 'object') return null;
    if (p.v != null && Number(p.v) === PREFS_VERSION) p.v = PREFS_VERSION;
    else if (
      p.v == null &&
      ((Array.isArray(p.widgets) && p.widgets.length) || (Array.isArray(p.order) && p.order.length))
    ) {
      p.v = PREFS_VERSION;
    }
    if (p.v !== PREFS_VERSION) return null;
    return normalizePrefsShape(p);
  }

  /**
   * Re-read layout JSON from localStorage (PREFS_KEY) into _prefs.
   * Wichtig: nicht nur hidden* — sonst bleibt widgets[] aus init() stehen, obwohl LS schon die Datei/JSON enthält;
   * getSortedSections() fällt dann auf Registry-Sortierung zurück (wie in deinem DOM: economic zuletzt).
   */
  /** Sync nur Sichtbarkeit (hidden*) aus localStorage — widgets[]/order bleiben unangetastet. */
  function syncVisibilityPrefsFromLocalStorage() {
    if (!_prefs) return;
    try {
      var raw = sanitizeLayoutJsonRaw(localStorage.getItem(PREFS_KEY));
      if (!raw) return;
      var o = JSON.parse(raw);
      if (!o) return;
      if (!tryAcceptPrefsPayload(o)) return;
      if (Array.isArray(o.hiddenCharts)) _prefs.hiddenCharts = o.hiddenCharts.slice();
      if (Array.isArray(o.hiddenSections)) _prefs.hiddenSections = o.hiddenSections.slice();
    } catch (error) { /* intentional */ }
  }

  function loadPrefs() {
    var fromLs = null;
    try {
      var raw = sanitizeLayoutJsonRaw(localStorage.getItem(PREFS_KEY));
      if (raw) {
        var p = JSON.parse(raw);
        fromLs = tryAcceptPrefsPayload(p);
      }
    } catch (error) { /* intentional */ }

    // Datei ist Single Source of Truth
    try {
      var xhrGet = new XMLHttpRequest();
      xhrGet.open('GET', '/api/layout', false);
      xhrGet.send();
      if (xhrGet.status === 200 && xhrGet.responseText) {
        var rt = sanitizeLayoutJsonRaw(xhrGet.responseText);
        if (rt && rt !== 'null') {
          var sp = JSON.parse(rt);
          if (sp && typeof sp === 'object') {
            if (sp.v == null) sp.v = PREFS_VERSION;
            else sp.v = Number(sp.v);
            normalizePrefsShape(sp);
            try { localStorage.setItem(PREFS_KEY, JSON.stringify(sp)); } catch (error) { /* intentional */ }
            return sp;
          }
        }
      }
    } catch (error) { /* intentional */ }
    if (fromLs) return fromLs;
    return defaultPrefs();
  }

  function savePrefs() {
    if (!_prefs) return;
    var json = JSON.stringify(_prefs);
    try { localStorage.setItem(PREFS_KEY, json); } catch (error) { /* intentional */ }
    // PUT /api/layout synchron — Datei ist Single Source of Truth, muss vor Reload fertig sein.
    try {
      var xhrPut = new XMLHttpRequest();
      xhrPut.open('PUT', '/api/layout', false);
      xhrPut.setRequestHeader('Content-Type', 'application/json');
      xhrPut.send(json);
      if (xhrPut.status === 200) {
        try {
          var mPut = xhrPut.getResponseHeader('X-Layout-Mtime');
          if (mPut) localStorage.setItem(LAYOUT_FILE_MTIME_KEY, mPut);
        } catch (error) { /* intentional */ }
      }
    } catch (e) { /* offline */ }
  }

  function defaultPrefs() {
    return {
      v: PREFS_VERSION,
      order: [],
      hiddenSections: [],
      hiddenCharts: [],
      widgets: null
    };
  }

  // ── Registry helpers ────────────────────────────────────────────

  function getRegistry() {
    return global.__widgetRegistry || null;
  }

  function idOccursInWidgetList(widgetsArr, id) {
    if (!widgetsArr || !id) return false;
    for (var w of widgetsArr) {
      if (w.id === id) return true;
    }
    return false;
  }

  function getSortedSections() {
    var reg = getRegistry();
    if (!reg) return [];
    var byId = {};
    for (var sec0 of reg.sections) {
      byId[sec0.id] = sec0;
    }
    /** v2: Reihenfolge exakt aus widgets[] — gleicher Pfad wie applyGridLayout (appendChild). */
    if (_prefs?.widgets?.length) {
      var outW = [];
      var seenW = {};
      var ww = _prefs.widgets;
      for (var wEnt2 of ww) {
        var wid = wEnt2.id;
        if (seenW[wid]) continue;
        var secW = byId[wid];
        if (!secW) continue;
        if (secW.reorderable === false) continue;
        if (secW.parentSection) continue;
        if (!secW.domId) continue;
        seenW[wid] = true;
        outW.push(secW);
      }
      // Remainder: sections with domId that are not in widgets[] at all
      var remW = Object.keys(byId).sort(function (a, b) {
        return (byId[a].order || 0) - (byId[b].order || 0);
      });
      for (var rid of remW) {
        if (seenW[rid]) continue;
        var s2 = byId[rid];
        if (!s2 || s2.reorderable === false) continue;
        if (s2.parentSection) continue;
        if (!s2.domId) continue;
        if (idOccursInWidgetList(ww, rid)) continue;
        outW.push(s2);
        seenW[rid] = true;
      }
      return outW;
    }
    if (_prefs?.order?.length > 0) {
      var result = [];
      for (var oKey of _prefs.order) {
        if (byId[oKey]) {
          result.push(byId[oKey]);
          delete byId[oKey];
        }
      }
      var remaining = Object.keys(byId).sort(function (a, b) {
        return (byId[a].order || 0) - (byId[b].order || 0);
      });
      for (var remKey of remaining) {
        result.push(byId[remKey]);
      }
      return result;
    }
    return reg.getSectionsSorted();
  }

  function isSectionVisible(sectionId) {
    if (!_prefs) return true;
    var hs = _prefs.hiddenSections;
    if (!Array.isArray(hs)) hs = [];
    var reg = getRegistry();
    var secDef = reg?.findSection ? reg.findSection(sectionId) : null;
    // Sections without a layout <details> host (e.g. anthropic-status in the top bar) are not
    // listed in widgets[] — they must stay "visible" so chart visibility only uses hiddenCharts.
    if (secDef?.domId === null && secDef?.reorderable === false) {
      return true;
    }
    if (secDef?.parentSection) {
      if (hs.includes(sectionId)) return false;
      return isSectionVisible(secDef.parentSection);
    }
    if (hs.includes(sectionId)) return false;
    if (_prefs.widgets?.length) {
      var wi;
      for (wi = 0; wi < _prefs.widgets.length; wi++) {
        if (_prefs.widgets[wi].id === sectionId) return true;
      }
      return false;
    }
    return true;
  }

  function isChartVisible(chartId) {
    if (!_prefs) return true;
    var reg = getRegistry();
    var secId = null;
    if (reg?.sections) {
      for (var secX of reg.sections) {
        var charts = secX.charts || [];
        for (var chX of charts) {
          if (chX.id === chartId) {
            secId = secX.id;
            break;
          }
        }
        if (secId) break;
      }
    }
    if (secId && !isSectionVisible(secId)) return false;
    var h = _prefs.hiddenCharts;
    if (!Array.isArray(h)) return true;
    return !h.includes(chartId);
  }

  function getWidgetSpan(sectionId) {
    if (!_prefs?.widgets) return null;
    for (var wgt of _prefs.widgets) {
      if (wgt.id === sectionId) return wgt.span;
    }
    return null;
  }

  /** When v2 widgets[] drives the grid, _prefs.order must match or sidebar and page diverge. */
  function syncPrefsOrderFromWidgets() {
    if (!_prefs?.widgets?.length) return false;
    var ids = [];
    for (var wEnt of _prefs.widgets) {
      var wT = wEnt.type || 'section';
      if (wT === 'layout') continue;
      ids.push(wEnt.id);
    }
    var changed = false;
    if (!_prefs.order || _prefs.order?.length !== ids.length) changed = true;
    else {
      for (var c = 0; c < ids.length; c++) {
        if (_prefs.order[c] !== ids[c]) {
          changed = true;
          break;
        }
      }
    }
    if (changed) {
      _prefs.order = ids;
      return true;
    }
    return false;
  }

  /**
   * Sidebar drag only lists reorderable sections; keep non-reorderable widget rows
   * (e.g. anthropic-status) in their relative tail positions.
   */
  function syncPrefsWidgetsFromDraggableOrder(orderedIds) {
    if (!_prefs?.widgets?.length) return false;
    var inDrag = {};
    for (var oId of orderedIds) inDrag[oId] = true;
    var before = _prefs.widgets;
    var extras = [];
    for (var bw of before) {
      if (!inDrag[bw.id]) extras.push({ id: bw.id, span: bw.span });
    }
    var newW = [];
    for (var oid of orderedIds) {
      var span = 12;
      for (var bw2 of before) {
        if (bw2.id === oid) {
          span = bw2.span;
          break;
        }
      }
      newW.push({ id: oid, span: span });
    }
    for (var ext of extras) {
      var extraId = ext.id;
      var afterDragged = null;
      var foundExtra = false;
      for (var bw3 of before) {
        if (bw3.id === extraId) { foundExtra = true; continue; }
        if (foundExtra && inDrag[bw3.id]) {
          afterDragged = bw3.id;
          break;
        }
      }
      var inserted = false;
      if (afterDragged) {
        for (var ni = 0; ni < newW.length; ni++) {
          if (newW[ni].id === afterDragged) {
            newW.splice(ni, 0, ext);
            inserted = true;
            break;
          }
        }
      }
      if (!inserted) newW.push(ext);
    }
    _prefs.widgets = newW;
    return true;
  }

  // ── Visibility ──────────────────────────────────────────────────

  function applyVisibility() {
    var sections = getSortedSections();
    for (var sec of sections) {
      if (!sec.domId) continue;
      var el = document.getElementById(sec.domId);
      if (!el) continue;
      var vis = isSectionVisible(sec.id);
      el.style.display = vis ? '' : 'none';
      // Hide companion elements too
      var companions = sec.companionIds || [];
      for (var compId of companions) {
        var comp = document.getElementById(compId);
        if (comp) comp.style.display = vis ? '' : 'none';
      }
    }
  }

  // ── DOM Reorder ─────────────────────────────────────────────────

  function applyOrder() {
    if (!_prefs?.order?.length) return;
    var sections = getSortedSections();
    // Find the parent container of sections
    var firstSec = null;
    for (var secF of sections) {
      if (secF.domId) {
        firstSec = document.getElementById(secF.domId);
        if (firstSec) break;
      }
    }
    if (!firstSec?.parentNode) return;
    var parent = firstSec.parentNode;

    // Collect all section elements + their companions in desired order
    for (var si = sections.length - 1; si >= 0; si--) {
      var sec = sections[si];
      if (!sec.domId || sec.reorderable === false) continue;
      var el = document.getElementById(sec.domId);
      if (!el) continue;
      // Insert companions after section (in reverse order)
      var companions = sec.companionIds || [];
      for (var ci = companions.length - 1; ci >= 0; ci--) {
        var comp = document.getElementById(companions[ci]);
        if (comp && el.nextSibling !== comp) {
          parent.insertBefore(comp, el.nextSibling);
        }
      }
    }
  }

  // ── Unified Resize ──────────────────────────────────────────────

  function resizeChartOnDomId(domId) {
    var node = document.getElementById(domId);
    if (!node) return;
    var inst = echarts.getInstanceByDom(node);
    if (inst && typeof inst.resize === 'function') {
      try {
        inst.resize();
      } catch (eR) {
        /* detached */
      }
    }
  }

  function resizeAll() {
    var reg = getRegistry();
    if (!reg || typeof echarts === 'undefined') return;
    var sections = reg.sections;
    for (var sec of sections) {
      if (!isSectionVisible(sec.id)) continue;
      if (sec.domId) {
        var det = document.getElementById(sec.domId);
        if (det?.tagName === 'DETAILS' && !det.open) continue;
      }
      var charts = sec.charts || [];
      for (var ch of charts) {
        if (!isChartVisible(ch.id)) continue;
        var el = document.getElementById(ch.canvasId);
        if (!el) continue;
        var inst = echarts.getInstanceByDom(el);
        if (inst && typeof inst.resize === 'function') {
          try { inst.resize(); } catch (e) { /* detached */ }
        }
      }
    }
    /* Nicht in sec.charts: Proxy Effizienz-Trend, Live-JSONL, Sidebar-Stats (ECharts auf eigenem Host-DIV) */
    var extraDomIds = [
      'c-proxy-efficiency-heatmap',
      'c-proxy-efficiency-ratio',
      'c-proxy-efficiency-vispct',
      'c-proxy-efficiency-cachemiss',
      'live-files-chart-host',
      'sb-user-versions',
      'sb-user-entrypoints',
      'sb-user-stability'
    ];
    for (var eDomId of extraDomIds) {
      resizeChartOnDomId(eDomId);
    }
  }

  // ── Render Dispatch ─────────────────────────────────────────────

  function dispatchRender(data, days) {
    var sections = getSortedSections();
    for (var sec of sections) {
      if (!isSectionVisible(sec.id)) continue;
      if (!sec.sectionRenderFn) continue;
      var fn = global[sec.sectionRenderFn];
      if (typeof fn !== 'function') continue;

      if (sec.dataSource === '/api/session-turns') {
        fn(data, days);
      } else {
        fn(data, days);
      }
    }

    // Render extracted charts individually (Phase 5: chart-level widgets)
    var extracted = global.__extractedChartIds;
    if (extracted && Object.keys(extracted).length) {
      var reg = getRegistry();
      if (reg) {
        for (var ek in extracted) {
          if (!Object.hasOwn(extracted, ek)) continue;
          var chartDef = reg.findChart(ek);
          if (!chartDef?.renderFn) continue;
          var rf = global[chartDef.renderFn];
          if (typeof rf !== 'function') continue;
          try {
            invokeChartRenderFn(chartDef.renderFn, rf);
          } catch (error) { /* intentional */ }
        }
      }
    }
  }

  /** Invoke a standalone chart render function with the correct context data. */
  function invokeChartRenderFn(rfName, rf) {
    if (String(rfName).startsWith('renderProxy_')) {
      var dataP = global.__lastUsageData;
      if (dataP && typeof global._computeProxyCtx === 'function') global._computeProxyCtx(dataP);
      if (global.__sectionCtx_proxy) rf(global.__sectionCtx_proxy);
    } else if (String(rfName).startsWith('renderForensic_')) {
      var fctx = global.__sectionCtx_forensic;
      if (fctx) rf(fctx);
    } else if (String(rfName).startsWith('renderUserProfile_')) {
      var uctx = global.__sectionCtx_userProfile;
      if (uctx) rf(uctx);
    } else if (String(rfName).startsWith('renderBudget_')) {
      var bctx = global.__sectionCtx_budget;
      if (!bctx && global.__lastUsageData && typeof global._computeBudgetCtx === 'function') {
        bctx = global._computeBudgetCtx(global.__lastUsageData);
      }
      if (bctx) rf(bctx);
    } else if (String(rfName).startsWith('renderTokenStats_')) {
      var tsctx = global.__sectionCtx_tokenStats;
      if (tsctx) rf(tsctx);
    } else if (String(rfName).startsWith('renderStatus_')) {
      rf();
    } else if (
      rfName === 'renderWasteCurve' || rfName === 'renderCacheExplosion' ||
      rfName === 'renderBudgetDrain' || rfName === 'renderEfficiencyTimeline' ||
      rfName === 'renderMonthlyButterfly' || rfName === 'renderDayComparison'
    ) {
      var uDataE = global.__lastUsageData;
      var eDaysE = [];
      if (uDataE?.days?.length) {
        eDaysE = typeof global.getFilteredDays === 'function'
          ? global.getFilteredDays(uDataE.days) : uDataE.days.slice();
      }
      var stEcon = global._econData;
      if (rfName === 'renderMonthlyButterfly' || rfName === 'renderDayComparison') {
        rf(eDaysE);
      } else if (rfName === 'renderEfficiencyTimeline') {
        if (stEcon) rf(stEcon);
      } else if (rfName === 'renderBudgetDrain') {
        if (stEcon) rf(stEcon, global._econQdData || undefined);
      } else if (rfName === 'renderWasteCurve' || rfName === 'renderCacheExplosion') {
        var sessEl = document.getElementById('econ-session-picker');
        var selV = sessEl ? sessEl.value : '';
        var sessE = null;
        if (stEcon && typeof global.findSession === 'function') {
          sessE = global.findSession(stEcon, selV);
        }
        if (sessE) rf(sessE);
      }
    } else {
      rf();
    }
  }

  // ── Disclosure Toggle Auto-Binding ──────────────────────────────

  function bindDisclosureToggles() {
    var reg = getRegistry();
    if (!reg) return;
    var sections = reg.sections;
    for (var sec of sections) {
      if (!sec.domId) continue;
      var det = document.getElementById(sec.domId);
      if (!det || det?.tagName !== 'DETAILS') continue;
      if (det.dataset.dispatcherBound) continue;
      det.dataset.dispatcherBound = '1';
      (function (sectionId) {
        det.addEventListener('toggle', function () {
          if (this.open) {
            setTimeout(function () { resizeAll(); }, 60);
          }
        });
      })(sec.id);
    }
  }

  /**
   * hiddenSections = (nicht in widgets[]) union (Checkbox-aus, aber noch in widgets[]).
   * So bleibt Sichtbarkeit beim Reload erhalten, ohne Reihenfolge aus widgets[] zu streichen.
   */
  function reconcileHiddenSectionsWithWidgets() {
    if (!_prefs?.widgets?.length) return false;
    var reg = getRegistry();
    if (!reg) return false;
    var inW = {};
    for (var pw of _prefs.widgets) inW[pw.id] = true;
    var notInWidgets = [];
    for (var rs of reg.sections) {
      if (rs.reorderable === false || rs.parentSection) continue;
      if (!inW[rs.id]) notInWidgets.push(rs.id);
    }
    var curHs = _prefs.hiddenSections || [];
    var checkboxHiddenInLayout = [];
    for (var hid of curHs) {
      if (inW[hid]) checkboxHiddenInLayout.push(hid);
    }
    var nextMap = {};
    var u;
    for (u = 0; u < notInWidgets.length; u++) nextMap[notInWidgets[u]] = true;
    for (u = 0; u < checkboxHiddenInLayout.length; u++) nextMap[checkboxHiddenInLayout[u]] = true;
    var next = Object.keys(nextMap).sort();
    var cur = curHs.slice().sort();
    if (cur.length !== next.length) {
      _prefs.hiddenSections = next;
      return true;
    }
    for (var kk = 0; kk < next.length; kk++) {
      if (cur[kk] !== next[kk]) {
        _prefs.hiddenSections = next;
        return true;
      }
    }
    return false;
  }

  // ── Init ────────────────────────────────────────────────────────

  /**
   * Build default flat widgets[] from TB_PAGE_SCAFFOLD_PLAN + Registry.
   * Same flatten logic as saveTemplateFromBuilder but without UI dependency.
   */
  function buildDefaultWidgetsFromScaffold() {
    var nested = tbNestedModelFromPageScaffold();
    if (!nested?.length) return null;
    var flatW = [];
    var regSv = getRegistry();
    for (var nSec of nested) {
      flatW.push({ id: nSec.id, span: nSec.span || 12 });
      var ch = nSec.children || [];
      for (var ci = 0; ci < ch.length; ci++) {
        var chEnt = ch[ci];
        if (tbIsLayoutBlock(chEnt)) {
          var nestedOut = [];
          var innSv = chEnt.children || [];
          for (var innE of innSv) {
            var idef = regSv?.findChart ? regSv.findChart(innE.id) : null;
            if (idef && (idef.kind === 'chip' || idef.engine !== 'echarts')) continue;
            nestedOut.push({ id: innE.id, span: innE.span || 6 });
          }
          // Skip empty layout blocks (chips-only rows)
          if (nestedOut.length) {
            flatW.push({
              type: 'layout',
              span: chEnt.span || 12,
              section: nSec.id,
              bid: chEnt.bid || chEnt.id || 'tbblk_s' + ci,
              nested: nestedOut
            });
          }
          continue;
        }
        var cdef = regSv?.findChart ? regSv.findChart(chEnt.id) : null;
        if (cdef && (cdef.kind === 'chip' || cdef.engine !== 'echarts')) continue;
        flatW.push({ id: chEnt.id, span: chEnt.span || 6, type: 'chart', section: nSec.id });
      }
    }
    return flatW.length ? flatW : null;
  }

  function init() {
    if (_initialized) return;
    _initialized = true;
    _prefs = loadPrefs();
    if (migrateHiddenChartsLegacy()) savePrefs();
    // Migrate prefs to v2 if needed (auch widgets: [] mit gültigem order[])
    if ((!_prefs.widgets?.length) && _prefs.order?.length) {
      var migrated = migrateTemplateV1toV2({ order: _prefs.order, hiddenSections: _prefs.hiddenSections });
      _prefs.widgets = migrated.widgets;
      savePrefs();
    }
    // No widgets at all → generate from scaffold (same as TB "Load Default")
    if (!_prefs.widgets?.length) {
      var scaffoldWidgets = buildDefaultWidgetsFromScaffold();
      if (scaffoldWidgets) {
        _prefs.widgets = scaffoldWidgets;
        savePrefs();
        console.info('[widget-dispatcher] scaffold default applied — %d widgets generated from TB_PAGE_SCAFFOLD_PLAN', scaffoldWidgets.length);
        if (console.table) console.table(scaffoldWidgets.map(function(w) { return { id: w.id || '—', type: w.type || 'section', span: w.span, section: w.section || '' }; }));
      } else {
        console.warn('[widget-dispatcher] scaffold default FAILED — no registry or no scaffold plan');
      }
    }
    if (_prefs.widgets?.length) {
      if (syncPrefsOrderFromWidgets()) savePrefs();
      if (reconcileHiddenSectionsWithWidgets()) savePrefs();
      applyGridLayout();
      expandVisibleSectionPanels();
    } else {
      applyVisibility();
      applyOrder();
    }
    applyAllChartVisibility();
    bindDisclosureToggles();
  }

  // ── Public API ──────────────────────────────────────────────────

  function setVisibility(id, visible) {
    if (!_prefs) _prefs = defaultPrefs();
    if (!Array.isArray(_prefs.hiddenSections)) _prefs.hiddenSections = [];
    var idx = _prefs.hiddenSections.indexOf(id);
    if (visible && idx >= 0) {
      _prefs.hiddenSections.splice(idx, 1);
    } else if (!visible && idx === -1) {
      _prefs.hiddenSections.push(id);
    }
    if (visible && _prefs.widgets) {
      var found = false;
      for (var pw2 of _prefs.widgets) {
        if (pw2.id === id) {
          found = true;
          break;
        }
      }
      if (!found) {
        var reg2 = getRegistry();
        var targetSec = reg2 ? reg2.findSection(id) : null;
        var targetOrder = targetSec ? (targetSec.order || 999) : 999;
        var insertIdx = _prefs.widgets.length;
        for (var fi = 0; fi < _prefs.widgets.length; fi++) {
          var existSec = reg2 ? reg2.findSection(_prefs.widgets[fi].id) : null;
          var existOrder = existSec ? (existSec.order || 0) : 0;
          if (targetOrder < existOrder) {
            insertIdx = fi;
            break;
          }
        }
        _prefs.widgets.splice(insertIdx, 0, { id: id, span: 12 });
        syncPrefsOrderFromWidgets();
      }
    }
    savePrefs();
    if (_prefs.widgets?.length) applyGridLayout();
    else applyVisibility();
  }

  /** Show/hide all charts in a widgetGroup in one prefs write (leaves stay individually toggleable). */
  function setGroupChartsVisibility(childIds, visible) {
    if (!childIds?.length) return;
    if (!_prefs) _prefs = defaultPrefs();
    if (!Array.isArray(_prefs.hiddenCharts)) _prefs.hiddenCharts = [];
    for (var cid of childIds) {
      if (!cid) continue;
      var idx = _prefs.hiddenCharts.indexOf(cid);
      if (visible && idx >= 0) {
        _prefs.hiddenCharts.splice(idx, 1);
      } else if (!visible && idx === -1) {
        _prefs.hiddenCharts.push(cid);
      }
    }
    savePrefs();
    applyAllChartVisibility();
    var needsHealth = false;
    for (var id0 of childIds) {
      if (!id0) continue;
      if (id0.startsWith('health-kpi-') || id0.startsWith('health-finding-')) {
        needsHealth = true;
        break;
      }
    }
    if (needsHealth) {
      if (typeof global.invalidateHealthAndFindingsRender === 'function') {
        global.invalidateHealthAndFindingsRender();
      }
      var dd = global.__lastUsageData;
      if (dd) {
        if (typeof global.renderHealthScore === 'function') global.renderHealthScore(dd);
        if (typeof global.renderKeyFindings === 'function') global.renderKeyFindings(dd);
      }
    }
    scheduleResizeAfterChartVisibility();
  }

  function syncChartGroupCheckboxFromLeaves(leafCb) {
    if (!leafCb?.parentNode) return;
    var li = leafCb.closest('li.widget-tree-item');
    if (!li) return;
    var groupUl = li.parentNode;
    if (!groupUl?.classList?.contains('widget-tree-group-charts')) return;
    var cluster = groupUl.closest('li.widget-tree-group-cluster');
    if (!cluster) return;
    var head = cluster.querySelector('.widget-tree-group-head');
    if (!head) return;
    var groupCb = head.querySelector('input[data-type="chart-group"]');
    if (!groupCb) return;
    var checks = groupUl.querySelectorAll('.widget-tree-check[data-type="chart"]');
    var total = 0;
    var checked = 0;
    for (var chk of checks) {
      total++;
      if (chk.checked) checked++;
    }
    groupCb.checked = total > 0 && checked === total;
    groupCb.indeterminate = checked > 0 && checked < total;
  }

  function syncAllWidgetTreeGroupCheckboxes(root) {
    if (!root) return;
    var heads = root.querySelectorAll('.widget-tree-group-head input[data-type="chart-group"]');
    for (var gcb of heads) {
      var cluster = gcb.closest('li.widget-tree-group-cluster');
      if (!cluster) continue;
      var ul = cluster.querySelector(':scope > ul.widget-tree-group-charts');
      if (!ul) continue;
      var checks = ul.querySelectorAll('.widget-tree-check[data-type="chart"]');
      var total = 0;
      var checked = 0;
      for (var chk2 of checks) {
        total++;
        if (chk2.checked) checked++;
      }
      gcb.checked = total > 0 && checked === total;
      gcb.indeterminate = checked > 0 && checked < total;
    }
  }

  function setChartVisibility(chartId, visible) {
    if (!_prefs) _prefs = defaultPrefs();
    if (!Array.isArray(_prefs.hiddenCharts)) _prefs.hiddenCharts = [];
    var idx = _prefs.hiddenCharts.indexOf(chartId);
    if (visible && idx >= 0) {
      _prefs.hiddenCharts.splice(idx, 1);
    } else if (!visible && idx === -1) {
      _prefs.hiddenCharts.push(chartId);
    }
    savePrefs();
    applyChartVisibility(chartId, visible);
    if (
      chartId.startsWith('health-kpi-') ||
      chartId.startsWith('health-finding-')
    ) {
      if (typeof global.invalidateHealthAndFindingsRender === 'function') {
        global.invalidateHealthAndFindingsRender();
      }
      var dd = global.__lastUsageData;
      if (dd) {
        if (typeof global.renderHealthScore === 'function') global.renderHealthScore(dd);
        if (typeof global.renderKeyFindings === 'function') global.renderKeyFindings(dd);
      }
      // renderHealthScore / renderKeyFindings replace innerHTML — restores default display; re-sync prefs
      applyAllChartVisibility();
    }
  }

  /** One DOM host (canvas / KPI grid) may map to several registry charts — OR visibility. */
  function syncCanvasGroupVisibility(canvasId) {
    if (!canvasId) return;
    var reg = getRegistry();
    if (!reg) return;
    var show = false;
    for (var regSec of reg.sections) {
      var charts = regSec.charts || [];
      for (var ch of charts) {
        if (ch.canvasId === canvasId && isChartVisible(ch.id)) {
          show = true;
          break;
        }
      }
      if (show) break;
    }
    var el = null;
    if (
      canvasId === 'c-uptime-chart' ||
      canvasId === 'c-incident-history' ||
      canvasId === 'c-outage-timeline' ||
      canvasId === 'c-anthropic-incidents'
    ) {
      var ab = document.getElementById('anthropic-badge');
      if (ab) el = ab.querySelector('#' + canvasId);
    }
    if (!el) el = document.getElementById(canvasId);
    if (!el) return;
    var box = el.closest('.chart-box');
    if (box) {
      box.style.display = show ? '' : 'none';
      return;
    }
    el.style.display = show ? '' : 'none';
  }

  /** ECharts mis-measures after host display:none -> visible; defer resize until layout settles. */
  function scheduleResizeAfterChartVisibility() {
    setTimeout(function () {
      resizeAll();
    }, 50);
    setTimeout(function () {
      resizeAll();
    }, 200);
  }

  function applyChartVisibility(chartId, visible) {
    var reg = getRegistry();
    if (!reg) return;
    var chartDef = reg.findChart(chartId);
    if (!chartDef) return;
    syncCanvasGroupVisibility(chartDef.canvasId);
    scheduleResizeAfterChartVisibility();
  }

  function migrateHiddenChartsLegacy() {
    if (!_prefs) return false;
    if (!Array.isArray(_prefs.hiddenCharts)) _prefs.hiddenCharts = [];
    var tsKpisAll = [
      'token-stats-kpi-day-output',
      'token-stats-kpi-day-cache-read',
      'token-stats-kpi-day-total',
      'token-stats-kpi-hit-day',
      'token-stats-kpi-hit-all',
      'token-stats-kpi-overhead',
      'token-stats-kpi-peak',
      'token-stats-kpi-all-out',
      'token-stats-kpi-all-cache',
      'token-stats-kpi-session-signals',
      'token-stats-kpi-hosts'
    ];
    var changedTs = false;
    if (_prefs.hiddenCharts.includes('ts-kpis')) {
      var merged = [];
      for (var tid of _prefs.hiddenCharts) {
        if (tid === 'ts-kpis') {
          for (var tsKpi of tsKpisAll) {
            if (!merged.includes(tsKpi)) merged.push(tsKpi);
          }
          changedTs = true;
        } else if (!merged.includes(tid)) merged.push(tid);
      }
      _prefs.hiddenCharts = merged;
    }
    if (!_prefs.hiddenCharts.length) return changedTs;
    var mapLegacyToCanon = {
      'token-hourly': 'ts-c1',
      'token-daily': 'ts-c1',
      'cache-ratio-hourly': 'ts-c2',
      'cache-ratio-daily': 'ts-c2',
      'api-events-hourly': 'ts-c3',
      'api-events-daily': 'ts-c3',
      'signals-hourly': 'ts-c4',
      'signals-daily': 'ts-c4',
      'token-hosts': 'ts-hosts'
    };
    var set = {};
    var changed = false;
    for (var hcId of _prefs.hiddenCharts) {
      var c = mapLegacyToCanon[hcId];
      if (c) {
        set[c] = true;
        changed = true;
      } else {
        set[hcId] = true;
      }
    }
    if (!changed && !changedTs) return false;
    var out = [];
    for (var k in set) {
      if (set[k]) out.push(k);
    }
    _prefs.hiddenCharts = out;
    return true;
  }

  function applyAllChartVisibility() {
    var reg = getRegistry();
    if (!reg) return;
    var seen = {};
    for (var acSec of reg.sections) {
      var charts = acSec.charts || [];
      for (var acCh of charts) {
        var cid = acCh.canvasId;
        if (!cid || seen[cid]) continue;
        seen[cid] = true;
        syncCanvasGroupVisibility(cid);
      }
    }
    scheduleResizeAfterChartVisibility();
  }

  function setOrder(orderedIds) {
    if (!_prefs) _prefs = defaultPrefs();
    var list = orderedIds.slice();
    _prefs.order = list;
    if (_prefs.widgets?.length) {
      syncPrefsWidgetsFromDraggableOrder(list);
      savePrefs();
      applyGridLayout();
      return;
    }
    savePrefs();
    applyOrder();
  }

  function getPrefs() {
    return _prefs ? JSON.parse(JSON.stringify(_prefs)) : defaultPrefs();
  }

  function resetPrefs() {
    // Build default widgets from registry (all sections, span 12)
    var reg = getRegistry();
    var defWidgets = [];
    if (reg) {
      for (var s of reg.sections) {
        if (s.parentSection) continue;
        defWidgets.push({ id: s.id, span: 12 });
      }
    }
    _prefs = defaultPrefs();
    _prefs.widgets = defWidgets.length ? defWidgets : null;
    savePrefs();
    location.reload();
  }

  function shouldRender(sectionId) {
    return isSectionVisible(sectionId);
  }

  // ── Sidebar UI ───────────────────────────────────────────────

  var _sidebarOpen = false;

  function toggleSidebar(force) {
    var sb = document.getElementById('sidebar');
    if (!sb) return;
    if (typeof force === 'boolean' && force === _sidebarOpen) return;
    _sidebarOpen = typeof force === 'boolean' ? force : !_sidebarOpen;
    sb.classList.toggle('is-open', _sidebarOpen);
    document.body.classList.toggle('sidebar-open', _sidebarOpen);
    var btn = document.getElementById('settings-nav-btn');
    if (btn) btn.classList.toggle('is-active', _sidebarOpen);
    // Match sidebar-head height to top-bar
    var topBar = document.querySelector('.top-bar');
    var sbHead = document.querySelector('.sidebar-head');
    if (topBar && sbHead) {
      sbHead.style.minHeight = topBar.offsetHeight + 'px';
    }
    if (_sidebarOpen) {
      renderWidgetTree();
      renderSettingsSection();
      renderTemplatesSection();
      bindToolsSection();
      renderExportSection();
      bindUserSettingsModal();
      bindTemplateBuilder();
      // Resize charts after layout shift
      setTimeout(function () { resizeAll(); }, 250);
    }
    // Original filters hidden via CSS (body.sidebar-open selector)
    try { localStorage.setItem('cud_sidebar_open', _sidebarOpen ? '1' : '0'); } catch (error) { /* intentional */ }
  }

  function bindSidebarEvents() {
    if (_sidebarEventsBound) return;
    _sidebarEventsBound = true;
    var btn = document.getElementById('settings-nav-btn');
    if (btn) btn.addEventListener('click', function () { toggleSidebar(); });
    var close = document.getElementById('sidebar-close');
    if (close) close.addEventListener('click', function () { toggleSidebar(false); });
    // ESC key closes sidebar
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && _sidebarOpen) toggleSidebar(false);
    });
    // Restore sidebar state (once per page — initFull runs on every data refresh)
    try {
      if (localStorage.getItem('cud_sidebar_open') === '1' && !_sidebarRestoreScheduled) {
        _sidebarRestoreScheduled = true;
        setTimeout(function () { toggleSidebar(true); }, 100);
      }
    } catch (error) { /* intentional */ }
  }

  // ── Widget Tree (Layout section) ────────────────────────────────

  /** Außerhalb Bearbeiten: alle Layout-Häkchen disabled (checked bleibt); im Modus widget-tree--edit aktiv. */
  function applyWidgetTreeCheckboxLock(treeEl, editing) {
    if (!treeEl) return;
    var checks = treeEl.querySelectorAll('.widget-tree-check');
    for (var chk of checks) {
      chk.disabled = !editing;
    }
  }

  function renderWidgetTree() {
    var body = document.getElementById('sidebar-layout-body');
    if (!body) return;
    if (!_prefs) _prefs = loadPrefs();
    syncVisibilityPrefsFromLocalStorage();
    var reg = getRegistry();
    if (!reg) return;
    var sections = getSortedSections();
    var html = '<ul class="widget-tree">';
    for (var sec of sections) {
      if (sec.reorderable === false) continue;
      var secVis = isSectionVisible(sec.id);
      var hasCharts = sec.charts && sec.charts.length > 0;
      var spanVal = getWidgetSpan(sec.id);
      var spanDisp = spanVal || 12;
      html += '<li class="widget-tree-item" data-section="' + sec.id + '" draggable="false">';
      html += '<div class="widget-tree-head">';
      html += '<span class="widget-tree-drag" title="Drag to reorder">&#x2630;</span>';
      html += '<input type="checkbox" class="widget-tree-check" data-type="section" data-id="' + sec.id + '"' + (secVis ? ' checked' : '') + '>';
      html += '<span class="widget-tree-label">' + _t(sec.titleKey) + '</span>';
      if (spanDisp !== 12) {
        html +=
          '<span class="widget-tree-span" title="' +
          escT(_t('settingsLayoutGridSpanTitle')) +
          '">' +
          spanDisp +
          '/12</span>';
      }
      html += '<button type="button" class="widget-tree-expand" data-expand="' + sec.id + '"' + (hasCharts ? '' : ' style="visibility:hidden"') + '>&#x25B6;</button>';
      html += '</div>';
      if (hasCharts) {
        html += buildSectionChartsTreeHtml(sec);
      }
      html += '</li>';
    }
    html += '</ul>';
    body.innerHTML = html;
    syncAllWidgetTreeGroupCheckboxes(body);

    // Delegated events (once per sidebar body — survives re-renders)
    if (!body.dataset.wtreeChangeBound) {
      body.dataset.wtreeChangeBound = '1';
      body.addEventListener('change', function (e) {
        var cb = e.target;
        if (!cb.classList.contains('widget-tree-check')) return;
        if (cb.disabled) return;
        var type = cb.dataset.type;
        var id = cb.dataset.id;
        if (type === 'section') setVisibility(id, cb.checked);
        else if (type === 'chart-group') {
          var raw = cb.getAttribute('data-child-ids') || '';
          var ids = raw.split('|');
          var clean = [];
          for (var idVal of ids) {
            if (idVal) clean.push(idVal);
          }
          setGroupChartsVisibility(clean, cb.checked);
          var cluster = cb.closest('li.widget-tree-group-cluster');
          if (cluster) {
            var leafChecks = cluster.querySelectorAll('.widget-tree-group-charts .widget-tree-check[data-type="chart"]');
            for (var lc of leafChecks) {
              lc.checked = cb.checked;
            }
          }
          cb.indeterminate = false;
        } else if (type === 'chart') {
          setChartVisibility(id, cb.checked);
          syncChartGroupCheckboxFromLeaves(cb);
        }
      });
      body.addEventListener('click', function (e) {
        var btn = e.target.closest('.widget-tree-expand');
        if (!btn) return;
        if (btn.dataset.wtreeGroupId) {
          var nest = body.querySelector('[data-wtree-group-ul="' + btn.dataset.wtreeGroupId + '"]');
          if (!nest) return;
          var openG = nest.style.display !== 'none';
          nest.style.display = openG ? 'none' : '';
          btn.style.transform = openG ? '' : 'rotate(90deg)';
          return;
        }
        var secId = btn.dataset.expand;
        var charts = body.querySelector('[data-charts-for="' + secId + '"]');
        if (!charts) return;
        var open = charts.style.display !== 'none';
        charts.style.display = open ? 'none' : '';
        btn.style.transform = open ? '' : 'rotate(90deg)';
      });
    }

    // Drag & Drop for section reorder (once per sidebar body)
    if (!body.dataset.wtreeDndBound) {
      body.dataset.wtreeDndBound = '1';
      body.addEventListener('dragstart', function (e) {
        var item = e.target.closest('.widget-tree-item[data-section]');
        if (!item) { e.preventDefault(); return; }
        var ulEdit = body.querySelector('.widget-tree');
        if (!ulEdit?.classList.contains('widget-tree--edit')) {
          e.preventDefault();
          return;
        }
        _wtreeDragSrc = item;
        _wtreeDropState = null;
        item.classList.add('is-dragging');
        e.dataTransfer.effectAllowed = 'move';
        if (_wtreeDragGhost?.parentNode) {
          _wtreeDragGhost.parentNode.removeChild(_wtreeDragGhost);
        }
        _wtreeDragGhost = null;
        try {
          var ghost = item.cloneNode(true);
          ghost.classList.add('widget-tree-drag-ghost');
          ghost.removeAttribute('draggable');
          var ghostCtrls = ghost.querySelectorAll('input,button');
          for (var gc of ghostCtrls) {
            gc.remove();
          }
          document.body.appendChild(ghost);
          var r = item.getBoundingClientRect();
          var ox = e.clientX - r.left;
          var oy = e.clientY - r.top;
          e.dataTransfer.setDragImage(ghost, ox, oy);
          _wtreeDragGhost = ghost;
        } catch (eGhost) {
          _wtreeDragGhost = null;
        }
      });
      body.addEventListener('dragover', function (e) {
        if (!_wtreeDragSrc) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        var ul = body.querySelector('.widget-tree');
        if (!ul) return;
        var ulRect = ul.getBoundingClientRect();
        if (
          e.clientX < ulRect.left ||
          e.clientX > ulRect.right ||
          e.clientY < ulRect.top ||
          e.clientY > ulRect.bottom
        ) {
          clearWtreeDropUi(ul);
          _wtreeDropState = null;
          return;
        }
        var st = wtreeFindDropState(ul, e.clientY, _wtreeDragSrc);
        _wtreeDropState = st;
        if (!st || st.noop) {
          clearWtreeDropUi(ul);
          return;
        }
        applyWtreeDropUi(ul, st, _wtreeDragSrc);
      });
      body.addEventListener('dragleave', function (e) {
        if (!_wtreeDragSrc) return;
        var ul = body.querySelector('.widget-tree');
        if (!ul) return;
        var rel = e.relatedTarget;
        if (rel && ul.contains(rel)) return;
        clearWtreeDropUi(ul);
        _wtreeDropState = null;
      });
      body.addEventListener('drop', function (e) {
        e.preventDefault();
        var ul = body.querySelector('.widget-tree');
        if (!ul || !_wtreeDragSrc) return;
        clearWtreeDropUi(ul);
        var st = _wtreeDropState;
        _wtreeDropState = null;
        if (!st || st.noop) return;
        if (st.insertBefore) ul.insertBefore(_wtreeDragSrc, st.insertBefore);
        else ul.appendChild(_wtreeDragSrc);
        var newItems = ul.querySelectorAll(':scope > li.widget-tree-item[data-section]');
        var newOrder = [];
        for (var ni of newItems) newOrder.push(ni.dataset.section);
        setOrder(newOrder);
      });
      body.addEventListener('dragend', function () {
        var ul = body.querySelector('.widget-tree');
        if (ul) clearWtreeDropUi(ul);
        if (_wtreeDragSrc) _wtreeDragSrc.classList.remove('is-dragging');
        _wtreeDragSrc = null;
        _wtreeDropState = null;
        if (_wtreeDragGhost?.parentNode) {
          _wtreeDragGhost.parentNode.removeChild(_wtreeDragGhost);
        }
        _wtreeDragGhost = null;
      });
    }

    // Reset button
    var resetBtn = document.getElementById('sidebar-layout-reset');
    if (resetBtn && !resetBtn.dataset.bound) {
      resetBtn.dataset.bound = '1';
      resetBtn.addEventListener('click', function () {
        _layoutTreeEditMode = false;
        resetPrefs();
        renderWidgetTree();
      });
    }
    var treeAfter = body.querySelector('.widget-tree');
    var editBtnLbl = document.getElementById('sidebar-layout-edit');
    if (treeAfter && editBtnLbl) {
      var secLisApply = treeAfter.querySelectorAll(':scope > li.widget-tree-item[data-section]');
      var sxa;
      if (_layoutTreeEditMode) {
        treeAfter.classList.add('widget-tree--edit');
        editBtnLbl.textContent = _t('settingsSaveLayout');
        editBtnLbl.classList.add('is-active');
        for (sxa = 0; sxa < secLisApply.length; sxa++) secLisApply[sxa].setAttribute('draggable', 'true');
      } else {
        treeAfter.classList.remove('widget-tree--edit');
        editBtnLbl.textContent = _t('settingsEditLayout');
        editBtnLbl.classList.remove('is-active');
        for (sxa = 0; sxa < secLisApply.length; sxa++) secLisApply[sxa].setAttribute('draggable', 'false');
      }
      applyWidgetTreeCheckboxLock(treeAfter, _layoutTreeEditMode);
    } else if (treeAfter) {
      applyWidgetTreeCheckboxLock(treeAfter, _layoutTreeEditMode);
    }
    applyAllChartVisibility();
  }

  // ── (Stats section removed — User Profile stays as dashboard section) ──
  // placeholder to maintain code structure
  var _statsRemoved = true;

  function renderStatsSection() {
    var body = document.getElementById('sidebar-stats-body');
    if (!body) return;
    if (!body.dataset.built) {
      body.dataset.built = '1';
      body.innerHTML =
        '<div id="sb-user-versions" style="width:100%;height:220px"></div>' +
        '<div id="sb-user-entrypoints" style="width:100%;height:220px;margin-top:12px"></div>' +
        '<div id="sb-user-stability" style="width:100%;height:220px;margin-top:12px"></div>';
    }
    // Render mini versions of the user profile charts
    if (typeof echarts === 'undefined') return;
    var data = global.__lastUsageData;
    if (!data) return;
    var days = typeof getFilteredDays === 'function' ? getFilteredDays(data.days) : data.days || [];
    if (!days.length) return;
    var relStab = data.release_stability || null;

    // --- Versions chart (horizontal bar) ---
    var verEl = document.getElementById('sb-user-versions');
    if (verEl) {
      if (!_statsCharts.versions) _statsCharts.versions = echarts.init(verEl, null, { renderer: 'canvas' });
      var verCounts = {};
      for (var dayV of days) {
        var dv = dayV.versions;
        if (!dv) continue;
        for (var vk in dv) {
          verCounts[vk] = (verCounts[vk] || 0) + dv[vk];
        }
      }
      var verLabels = Object.keys(verCounts).sort(function (a, b) { return verCounts[a] - verCounts[b]; });
      var verData = verLabels.map(function (k) { return verCounts[k]; });
      _statsCharts.versions.setOption({
        animation: false,
        grid: { left: 100, right: 16, top: 8, bottom: 20 },
        tooltip: { trigger: 'axis' },
        xAxis: { type: 'value', axisLabel: { color: '#94a3b8', fontSize: 10 }, splitLine: { lineStyle: { color: 'rgba(51,65,85,0.5)' } } },
        yAxis: { type: 'category', data: verLabels, axisLabel: { color: '#94a3b8', fontSize: 10 } },
        series: [{ type: 'bar', data: verData, itemStyle: { color: 'rgba(59,130,246,0.7)' } }]
      }, true);
    }

    // --- Entrypoints chart ---
    var epEl = document.getElementById('sb-user-entrypoints');
    if (epEl) {
      if (!_statsCharts.entrypoints) _statsCharts.entrypoints = echarts.init(epEl, null, { renderer: 'canvas' });
      var epCounts = {};
      for (var dayE of days) {
        var de = dayE.entrypoints;
        if (!de) continue;
        for (var ek in de) {
          epCounts[ek] = (epCounts[ek] || 0) + de[ek];
        }
      }
      var epLabels = Object.keys(epCounts).sort(function (a, b) { return epCounts[a] - epCounts[b]; });
      var epData = epLabels.map(function (k) { return epCounts[k]; });
      _statsCharts.entrypoints.setOption({
        animation: false,
        grid: { left: 100, right: 16, top: 8, bottom: 20 },
        tooltip: { trigger: 'axis' },
        xAxis: { type: 'value', axisLabel: { color: '#94a3b8', fontSize: 10 }, splitLine: { lineStyle: { color: 'rgba(51,65,85,0.5)' } } },
        yAxis: { type: 'category', data: epLabels, axisLabel: { color: '#94a3b8', fontSize: 10 } },
        series: [{ type: 'bar', data: epData, itemStyle: { color: 'rgba(6,182,212,0.7)' } }]
      }, true);
    }

    // --- Release Stability chart ---
    var rsEl = document.getElementById('sb-user-stability');
    if (rsEl && relStab) {
      if (!_statsCharts.stability) _statsCharts.stability = echarts.init(rsEl, null, { renderer: 'canvas' });
      var rsLabels = [];
      var rsGood = [];
      var rsBad = [];
      for (var r of relStab) {
        rsLabels.push(r.version || '?');
        rsGood.push(r.good || 0);
        rsBad.push(r.bad || 0);
      }
      _statsCharts.stability.setOption({
        animation: false,
        grid: { left: 100, right: 16, top: 8, bottom: 20 },
        tooltip: { trigger: 'axis' },
        xAxis: { type: 'value', axisLabel: { color: '#94a3b8', fontSize: 10 }, splitLine: { lineStyle: { color: 'rgba(51,65,85,0.5)' } } },
        yAxis: { type: 'category', data: rsLabels, axisLabel: { color: '#94a3b8', fontSize: 10 } },
        series: [
          { name: 'Good', type: 'bar', stack: 's', data: rsGood, itemStyle: { color: 'rgba(34,197,94,0.7)' } },
          { name: 'Bad', type: 'bar', stack: 's', data: rsBad, itemStyle: { color: 'rgba(239,68,68,0.7)' } }
        ]
      }, true);
    }

    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(function () {
        resizeChartOnDomId('sb-user-versions');
        resizeChartOnDomId('sb-user-entrypoints');
        resizeChartOnDomId('sb-user-stability');
      });
    }
  }

  // ── Settings Section (Language + Plan) ──────────────────────────

  function renderSettingsSection() {
    // Move language buttons into sidebar
    var langSlot = document.getElementById('sidebar-lang-slot');
    var planSlot = document.getElementById('sidebar-plan-slot');
    if (langSlot && !langSlot.dataset.filled) {
      langSlot.dataset.filled = '1';
      var origLang = document.getElementById('lang-switch-wrap');
      if (origLang) {
        langSlot.innerHTML = '<label>' + _t('settingsLangLabel') + '</label>';
        var clone = origLang.cloneNode(true);
        clone.id = 'sidebar-lang-switch';
        clone.style.display = 'flex';
        clone.style.gap = '4px';
        // Remove the duplicate label span from clone
        var cloneLabel = clone.querySelector('.lang-switch-label');
        if (cloneLabel) cloneLabel.remove();
        langSlot.appendChild(clone);
        var cloneBtnsForId = clone.querySelectorAll('.lang-btn');
        for (var clBtn of cloneBtnsForId) clBtn.removeAttribute('id');
        // Wire cloned buttons
        var btns = clone.querySelectorAll('.lang-btn');
        for (var btn of btns) {
          btn.addEventListener('click', function () {
            var origBtn = document.getElementById('lang-' + this.dataset.lang);
            if (origBtn) origBtn.click();
          });
        }
      }
    }
    if (planSlot && !planSlot.dataset.filled) {
      planSlot.dataset.filled = '1';
      var origPlan = document.getElementById('plan-select');
      if (origPlan) {
        planSlot.innerHTML = '<label>' + _t('settingsPlanLabel') + '</label>';
        var planClone = origPlan.cloneNode(true);
        planClone.id = 'sidebar-plan-select';
        planSlot.appendChild(planClone);
        planClone.value = origPlan.value;
        planClone.addEventListener('change', function () {
          origPlan.value = this.value;
          origPlan.dispatchEvent(new Event('change'));
        });
      }
    }
  }

  // ── Templates Section ───────────────────────────────────────────

  // ── Template System ──────────────────────────────────────────────

  var TEMPLATES_KEY = 'cud_templates';
  var ACTIVE_TPL_KEY = 'cud_active_template';

  // All section IDs in default order
  // Only top-level sections (efficiency-range is nested inside economic)
  var ALL_SECTION_IDS = ['health', 'token-stats', 'forensic', 'user-profile', 'budget', 'proxy', 'anthropic-status', 'economic'];

  /** Default chart/chip order per section (sidebar + getOrderedChartsForSection). */
  var DEFAULT_SECTION_WIDGETS = {
    health: [
      'health-finding-jsonlProxyGap', 'health-finding-overhead', 'health-finding-hitLimits', 'health-finding-interrupts', 'health-finding-quota', 'health-finding-fallback', 'health-finding-overage', 'health-finding-claim', 'health-finding-peakDay', 'health-finding-retries', 'health-finding-cacheParadox',
      'health-kpi-quota5h', 'health-kpi-thinkingGap', 'health-kpi-cacheHealth', 'health-kpi-errorRate', 'health-kpi-hitLimits', 'health-kpi-latency', 'health-kpi-interrupts', 'health-kpi-coldStarts', 'health-kpi-retries', 'health-kpi-false429', 'health-kpi-truncations', 'health-kpi-contextResets', 'health-kpi-quotaBench', 'health-kpi-anomalStops'
    ],
    'token-stats': [
      'token-stats-kpi-day-output', 'token-stats-kpi-day-cache-read', 'token-stats-kpi-day-total', 'token-stats-kpi-hit-day', 'token-stats-kpi-hit-all', 'token-stats-kpi-overhead', 'token-stats-kpi-peak', 'token-stats-kpi-all-out', 'token-stats-kpi-all-cache', 'token-stats-kpi-session-signals', 'token-stats-kpi-hosts',
      'ts-c1', 'ts-c2', 'ts-c3', 'ts-c4', 'ts-hosts', 'token-stats-daily-detail'
    ],
    forensic: ['forensic-card-code', 'forensic-card-impl', 'forensic-card-budget', 'forensic-hitlimit', 'forensic-signals', 'forensic-service'],
    'user-profile': ['user-versions', 'user-entrypoints', 'user-release-stability'],
    budget: ['budget-kpi-output', 'budget-kpi-overhead', 'budget-kpi-cache-miss', 'budget-kpi-lost', 'budget-kpi-outage', 'budget-kpi-truncated', 'budget-sankey', 'budget-trend', 'budget-quota'],
    proxy: [
      'proxy-kpi-requests', 'proxy-kpi-latency', 'proxy-kpi-cache-ratio', 'proxy-kpi-models', 'proxy-kpi-quota-5h', 'proxy-kpi-quota-7d', 'proxy-kpi-ttl-tier', 'proxy-kpi-peak-hours',
      'proxy-tokens', 'proxy-latency', 'proxy-hourly', 'proxy-models', 'proxy-hourly-latency', 'proxy-error-trend', 'proxy-cache-trend'
    ],
    'anthropic-status': ['status-uptime', 'status-incidents', 'status-outage-scatter', 'status-outage-timeline'],
    economic: ['econ-cumulative', 'econ-explosion', 'econ-budget-drain'],
    'efficiency-range': ['eff-efficiency-timeline', 'eff-monthly-butterfly', 'eff-day-comparison']
  };

  function getBuiltinSectionWidgetsMap() {
    return DEFAULT_SECTION_WIDGETS;
  }

  function getActiveTemplateSectionWidgets() {
    var name = getActiveTemplateName();
    var all = getAllTemplates();
    for (var tplE of all) {
      if (tplE.name !== name) continue;
      if (tplE.sectionWidgets && typeof tplE.sectionWidgets === 'object') return tplE.sectionWidgets;
      return getBuiltinSectionWidgetsMap();
    }
    return getBuiltinSectionWidgetsMap();
  }

  /** Kernbefunde-Gruppe immer vor Health-KPIs (auch bei alter sectionWidgets-Reihenfolge in Templates). */
  function stableHealthWidgetGroupOrder(arr) {
    if (!arr?.length) return arr;
    var kern = [];
    var kpis = [];
    var rest = [];
    for (var ch of arr) {
      var wg = ch.widgetGroup;
      if (wg === 'kernbefunde') kern.push(ch);
      else if (wg === 'health-kpis') kpis.push(ch);
      else rest.push(ch);
    }
    return kern.concat(kpis).concat(rest);
  }

  function getOrderedChartsForSection(sec) {
    if (!sec?.charts?.length) return [];
    var charts = sec.charts.slice();
    var sw = getActiveTemplateSectionWidgets();
    var orderIds = sw?.[sec.id] ? sw[sec.id] : null;
    if (!orderIds?.length) {
      charts.sort(function (a, b) {
        return (a.order || 0) - (b.order || 0);
      });
      return sec.id === 'health' ? stableHealthWidgetGroupOrder(charts) : charts;
    }
    var byId = {};
    for (var chrt of charts) {
      byId[chrt.id] = chrt;
    }
    var out = [];
    for (var oId of orderIds) {
      if (byId[oId]) out.push(byId[oId]);
    }
    for (var chrt2 of charts) {
      var cid = chrt2.id;
      var found = false;
      for (var oId2 of orderIds) {
        if (oId2 === cid) {
          found = true;
          break;
        }
      }
      if (!found) out.push(chrt2);
    }
    return sec.id === 'health' ? stableHealthWidgetGroupOrder(out) : out;
  }

  function wtreeGroupDomId(sectionId, widgetGroup) {
    return 'wtg-' + sectionId + '-' + String(widgetGroup).replace(/[^a-z0-9-]/gi, '-');
  }

  function widgetGroupTitleKey(sectionId, widgetGroup) {
    if (sectionId === 'health' && widgetGroup === 'kernbefunde') return 'findingsTitle';
    if (sectionId === 'health' && widgetGroup === 'health-kpis') return 'widgetGroupHealthKpis';
    if (sectionId === 'token-stats' && widgetGroup === 'token-stats-kpis') return 'widgetGroupTokenStatsKpis';
    if (sectionId === 'forensic' && widgetGroup === 'forensic-cards') return 'widgetGroupForensicCards';
    if (sectionId === 'budget' && widgetGroup === 'budget-kpis') return 'widgetGroupBudgetKpis';
    if (sectionId === 'proxy' && widgetGroup === 'proxy-kpis') return 'widgetGroupProxyKpis';
    return 'widgetGroupGeneric';
  }

  function buildSectionChartsTreeHtml(sec) {
    var ordered = getOrderedChartsForSection(sec);
    var html = '<ul class="widget-tree-charts" data-charts-for="' + escT(sec.id) + '" style="display:none">';
    var gi = 0;
    while (gi < ordered.length) {
      var ch0 = ordered[gi];
      var wg = ch0.widgetGroup;
      if (!wg) {
        var chVis0 = isChartVisible(ch0.id);
        html += '<li class="widget-tree-item">';
        html += '<input type="checkbox" class="widget-tree-check" data-type="chart" data-id="' + escT(ch0.id) + '"' + (chVis0 ? ' checked' : '') + '>';
        html += '<span class="widget-tree-label">' + _t(ch0.titleKey) + '</span>';
        html += '</li>';
        gi++;
        continue;
      }
      var gj = gi + 1;
      while (gj < ordered.length && ordered[gj].widgetGroup === wg) gj++;
      var gdom = wtreeGroupDomId(sec.id, wg);
      var childIdsArr = [];
      var allVis = true;
      for (var ck = gi; ck < gj; ck++) {
        childIdsArr.push(ordered[ck].id);
        if (!isChartVisible(ordered[ck].id)) allVis = false;
      }
      var childIdsAttr = childIdsArr.join('|');
      html += '<li class="widget-tree-group-cluster">';
      html += '<div class="widget-tree-group-head">';
      html += '<span class="widget-tree-group-spacer"></span>';
      html +=
        '<input type="checkbox" class="widget-tree-check" data-type="chart-group" data-child-ids="' +
        escT(childIdsAttr) +
        '" title="' +
        escT(_t('widgetTreeGroupToggleTitle')) +
        '"' +
        (allVis ? ' checked' : '') +
        '>';
      html += '<button type="button" class="widget-tree-expand widget-tree-expand--group" data-wtree-group-id="' + escT(gdom) + '">&#x25B6;</button>';
      html += '<span class="widget-tree-label">' + _t(widgetGroupTitleKey(sec.id, wg)) + '</span>';
      html += '</div>';
      html += '<ul class="widget-tree-group-charts" data-wtree-group-ul="' + escT(gdom) + '" style="display:none">';
      for (var k = gi; k < gj; k++) {
        var ch = ordered[k];
        var chVis = isChartVisible(ch.id);
        html += '<li class="widget-tree-item">';
        html += '<input type="checkbox" class="widget-tree-check" data-type="chart" data-id="' + escT(ch.id) + '"' + (chVis ? ' checked' : '') + '>';
        html += '<span class="widget-tree-label">' + _t(ch.titleKey) + '</span>';
        html += '</li>';
      }
      html += '</ul></li>';
      gi = gj;
    }
    html += '</ul>';
    return html;
  }

  var BUILTIN_TEMPLATES = [
    {
      name: 'Full',
      builtin: true,
      version: 2,
      sectionWidgets: DEFAULT_SECTION_WIDGETS,
      widgets: [
        { id: 'health', span: 12 },
        { id: 'token-stats', span: 12 },
        { id: 'forensic', span: 12 },
        { id: 'user-profile', span: 12 },
        { id: 'budget', span: 12 },
        { id: 'proxy', span: 12 },
        { id: 'economic', span: 12 },
      ]
    },
    {
      name: 'Performance',
      builtin: true,
      version: 2,
      sectionWidgets: DEFAULT_SECTION_WIDGETS,
      widgets: [
        { id: 'token-stats', span: 12 },
        { id: 'forensic', span: 12 },
        { id: 'economic', span: 12 }
      ]
    },
    {
      name: 'Cost',
      builtin: true,
      version: 2,
      sectionWidgets: DEFAULT_SECTION_WIDGETS,
      widgets: [
        { id: 'budget', span: 6 },
        { id: 'proxy', span: 6 },
        { id: 'economic', span: 12 }
      ]
    },
    {
      name: 'Compact',
      builtin: true,
      version: 2,
      sectionWidgets: DEFAULT_SECTION_WIDGETS,
      widgets: [
        { id: 'health', span: 12 },
        { id: 'token-stats', span: 4 },
        { id: 'budget', span: 4 },
        { id: 'forensic', span: 4 },
        { id: 'proxy', span: 6 },
        { id: 'economic', span: 6 }
      ]
    }
  ];

  /** Migrate v2 template to v3 (adds type field, supports chart-level widgets) */
  function migrateTemplateV2toV3(tpl) {
    if (tpl.version >= 3) return tpl;
    var out = { name: tpl.name, builtin: tpl.builtin || false, version: 3, widgets: [] };
    if (tpl.sectionWidgets) out.sectionWidgets = tpl.sectionWidgets;
    if (tpl.hiddenCharts) out.hiddenCharts = tpl.hiddenCharts;
    var w = tpl.widgets || [];
    for (var wItem of w) {
      out.widgets.push({ id: wItem.id, span: wItem.span || 12, type: wItem.type || 'section' });
    }
    return out;
  }

  /** Migrate v1 template (order/hiddenSections) to v2 (widgets[]) */
  function migrateTemplateV1toV2(tpl) {
    if (tpl.version === 2 || tpl.version >= 3) return tpl;
    var order = tpl.order?.length ? tpl.order : ALL_SECTION_IDS;
    var hidden = tpl.hiddenSections || [];
    var widgets = [];
    for (var oItem of order) {
      if (!hidden.includes(oItem)) {
        widgets.push({ id: oItem, span: 12 });
      }
    }
    // Add any sections not in order and not hidden
    for (var sid of ALL_SECTION_IDS) {
      if (!order.includes(sid) && !hidden.includes(sid)) {
        widgets.push({ id: sid, span: 12 });
      }
    }
    var outTpl = { name: tpl.name, builtin: tpl.builtin || false, version: 2, widgets: widgets };
    if (tpl.sectionWidgets && typeof tpl.sectionWidgets === 'object') outTpl.sectionWidgets = tpl.sectionWidgets;
    return outTpl;
  }

  function loadTemplates() {
    // Server file is source of truth (saved inside layout JSON as "templates" key)
    try {
      var xhrT = new XMLHttpRequest();
      xhrT.open('GET', '/api/layout', false);
      xhrT.send();
      if (xhrT.status === 200 && xhrT.responseText) {
        var parsed = JSON.parse(xhrT.responseText);
        if (parsed && Array.isArray(parsed.templates) && parsed.templates.length) {
          try { localStorage.setItem(TEMPLATES_KEY, JSON.stringify(parsed.templates)); } catch (error) { /* intentional */ }
          return parsed.templates;
        }
      }
    } catch (error) { /* intentional */ }
    // Fallback to localStorage
    try {
      var raw = localStorage.getItem(TEMPLATES_KEY);
      if (raw) return JSON.parse(raw);
    } catch (error) { /* intentional */ }
    return [];
  }

  function saveTemplates(list) {
    try { localStorage.setItem(TEMPLATES_KEY, JSON.stringify(list)); } catch (error) { /* intentional */ }
    // Persist to server layout file
    if (_prefs) {
      _prefs.templates = list;
      savePrefs();
    }
  }

  function getActiveTemplateName() {
    try { return localStorage.getItem(ACTIVE_TPL_KEY) || ''; } catch (error) { return ''; }
  }

  function setActiveTemplateName(name) {
    try { localStorage.setItem(ACTIVE_TPL_KEY, name); } catch (error) { /* intentional */ }
  }

  function getAllTemplates() {
    return BUILTIN_TEMPLATES.concat(loadTemplates());
  }

  /** Sichtbare Haupt-Sektionen (<details>) und verschachtelte Chart-Disclosures oeffnen (z. B. nach Vorlagenwechsel). */
  function expandVisibleSectionPanels() {
    var reg = getRegistry();
    if (!reg?.sections) return;
    for (var sec of reg.sections) {
      if (!sec.domId) continue;
      if (!isSectionVisible(sec.id)) continue;
      var el = document.getElementById(sec.domId);
      if (!el || el?.tagName !== 'DETAILS') continue;
      el.open = true;
      var nested = el.querySelectorAll('details');
      for (var nDet of nested) {
        nDet.open = true;
      }
    }
  }

  function applyTemplate(tpl) {
    var t2 = migrateTemplateV1toV2(tpl);
    var t3 = migrateTemplateV2toV3(t2);
    if (!_prefs) _prefs = defaultPrefs();
    // Derive v1 fields from v3 for backward compat
    var order = [];
    var widgetIds = {};
    for (var tw of t3.widgets) {
      var wType = tw.type || 'section';
      if (wType === 'section') {
        order.push(tw.id);
        widgetIds[tw.id] = true;
      }
    }
    var hidden = [];
    for (var asId of ALL_SECTION_IDS) {
      if (!widgetIds[asId]) hidden.push(asId);
    }
    _prefs.order = order;
    _prefs.hiddenSections = hidden;
    _prefs.hiddenCharts = (tpl.hiddenCharts || []).slice();
    migrateHiddenChartsLegacy();
    _prefs.widgets = t3.widgets.slice();
    savePrefs();
    setActiveTemplateName(tpl.name);
    applyGridLayout();
    applyAllChartVisibility();
    expandVisibleSectionPanels();
    renderWidgetTree();
    setTimeout(function () {
      resizeAll();
    }, 280);
  }

  /**
   * Create a standalone wrapper for a chart extracted from its section.
   * Returns the wrapper DOM element (creates if not exists).
   */
  function getOrCreateChartWrapper(chartDef) {
    var wrapperId = 'widget-' + chartDef.id;
    var existing = document.getElementById(wrapperId);
    if (existing) return existing;

    var wrapper = document.createElement('div');
    wrapper.id = wrapperId;
    wrapper.className = 'chart-box chart-box--standalone';

    var title = document.createElement('h3');
    title.textContent = typeof t === 'function' ? t(chartDef.titleKey || chartDef.id) : chartDef.id;
    wrapper.appendChild(title);

    if (chartDef.engine === 'echarts') {
      var canvas = document.createElement('div');
      canvas.id = wrapperId + '-canvas';
      var h = (chartDef.size?.minHeight) || 260;
      canvas.style.cssText = 'width:100%;height:' + h + 'px';
      wrapper.appendChild(canvas);
    } else {
      var content = document.createElement('div');
      content.id = wrapperId + '-content';
      wrapper.appendChild(content);
    }
    return wrapper;
  }

  /** Render sections into a 12-column CSS grid based on widgets[] */
  function applyGridLayout() {
    var widgets = _prefs?.widgets;
    if (!widgets?.length) {
      applyVisibility();
      applyOrder();
      return;
    }
    var reg = getRegistry();
    if (!reg) return;

    var gridEl = document.getElementById('layout-grid');
    if (!gridEl) return;

    // Hide all existing standalone chart wrappers (will re-show only those in current template)
    var existingWrappers = gridEl.querySelectorAll('[id^="widget-"]');
    for (var ew of existingWrappers) {
      ew.style.display = 'none';
    }

    // Collect all direct children that are NOT sections (table, day-picker, etc.)
    var nonSectionNodes = [];
    var children = gridEl.children;
    for (var ni = children.length - 1; ni >= 0; ni--) {
      var child = children[ni];
      if (!child.id?.match(/-collapse$/)) {
        // Also skip standalone chart wrappers
        if (child.id?.startsWith('widget-')) continue;
        nonSectionNodes.push(child);
      }
    }

    var placed = {};
    var extractedCharts = {};

    // Move sections and charts into grid in widget order
    for (var i = 0; i < widgets.length; i++) {
      var w = widgets[i];
      var wType = w.type || 'section';

      if (wType === 'layout') {
        // Layout blocks describe internal section structure (builder metadata).
        // Charts stay inside their section DOM — no standalone extraction.
        continue;
      }

      if (wType === 'chart') {
        // Chart-level widget: create standalone wrapper
        var chartDef = reg.findChart(w.id);
        if (!chartDef) continue;
        var wrapper = getOrCreateChartWrapper(chartDef);
        wrapper.setAttribute('data-span', String(w.span || 6));
        wrapper.style.display = '';
        gridEl.appendChild(wrapper);
        extractedCharts[w.id] = true;
        continue;
      }

      // Section-level widget (existing logic)
      var sec = reg.findSection(w.id);
      if (!sec?.domId) continue;
      // Skip nested sections — they stay inside their parent
      if (sec.parentSection) continue;
      var el = document.getElementById(sec.domId);
      if (!el) continue;

      var vis = isSectionVisible(sec.id);
      el.setAttribute('data-span', String(w.span || 12));
      el.style.display = vis ? '' : 'none';
      gridEl.appendChild(el);
      placed[w.id] = true;
      // If this section has child sections, mark them as placed too
      for (var csSec of reg.sections) {
        if (csSec.parentSection === w.id) placed[csSec.id] = true;
      }

      // Move companions after their section
      if (sec.companionIds) {
        for (var compId of sec.companionIds) {
          var comp = document.getElementById(compId);
          if (comp) {
            comp.setAttribute('data-span', String(w.span || 12));
            comp.style.display = vis ? '' : 'none';
            gridEl.appendChild(comp);
          }
        }
      }
    }

    // Store extracted chart IDs so section renderers can skip them
    window.__extractedChartIds = extractedCharts;

    // Append non-section elements at the end (table, day-picker, etc.)
    for (var ri = nonSectionNodes.length - 1; ri >= 0; ri--) {
      var node = nonSectionNodes[ri];
      node.setAttribute('data-span', '12');
      gridEl.appendChild(node);
    }

    // Hide sections not in the template (skip nested)
    for (var hSec of reg.sections) {
      if (!hSec.domId || placed[hSec.id] || hSec.parentSection) continue;
      var hEl = document.getElementById(hSec.domId);
      if (hEl) hEl.style.display = 'none';
    }

    // Resize all ECharts after layout shift
    setTimeout(function () { resizeAll(); }, 200);
  }

  function renderTemplatesSection() {
    var body = document.getElementById('sidebar-templates-body');
    if (!body) return;
    var all = getAllTemplates();
    var activeName = getActiveTemplateName();

    var html = '';
    for (var i = 0; i < all.length; i++) {
      var tpl = all[i];
      var isActive = tpl.name === activeName;
      html += '<div class="template-item' + (isActive ? ' is-active' : '') + '" data-tpl-idx="' + i + '">';
      html += '<span class="template-item-name">' + escT(tpl.name) + (tpl.builtin ? ' <span style="color:#475569;font-size:.6rem">(' + _t('settingsTemplateBuiltin') + ')</span>' : '') + '</span>';
      html += '<span class="template-item-actions">';
      html += '<button type="button" data-tpl-action="apply" data-tpl-idx="' + i + '" title="' + _t('settingsTemplateApply') + '">&#x25B6;</button>';
      if (!tpl.builtin) {
        html += '<button type="button" data-tpl-action="delete" data-tpl-idx="' + i + '" title="' + _t('settingsTemplateDelete') + '">&#x2715;</button>';
      }
      html += '</span></div>';
    }
    html += '<div style="margin-top:10px;display:flex;gap:6px">';
    html += '</div>';
    body.innerHTML = html;

    // Delegated click handler
    if (!body.dataset.bound) {
      body.dataset.bound = '1';
      body.addEventListener('click', function (e) {
        var btn = e.target.closest('[data-tpl-action]');
        if (!btn) return;
        var action = btn.dataset.tplAction;
        var idx = Number.parseInt(btn.dataset.tplIdx, 10);
        var all2 = getAllTemplates();
        if (idx < 0 || idx >= all2.length) return;

        if (action === 'apply') {
          applyTemplate(all2[idx]);
          renderTemplatesSection();
        } else if (action === 'delete') {
          var userTpls = loadTemplates();
          var builtinCount = BUILTIN_TEMPLATES.length;
          var userIdx = idx - builtinCount;
          if (userIdx >= 0 && userIdx < userTpls.length) {
            userTpls.splice(userIdx, 1);
            saveTemplates(userTpls);
            if (getActiveTemplateName() === all2[idx].name) setActiveTemplateName('');
            renderTemplatesSection();
          }
        }
      });
    }

    // "Save current layout" button removed — use Template Builder instead
  }

  function escT(s) {
    return String(s == null ? '' : s).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
  }

  // ── Export Section ──────────────────────────────────────────────

  function bindToolsSection() {
    var explorerBtn = document.getElementById('sidebar-open-explorer');
    if (explorerBtn && !explorerBtn.dataset.bound) {
      explorerBtn.dataset.bound = '1';
      explorerBtn.addEventListener('click', function () {
        var origBtn = document.getElementById('dev-cache-files-open') || document.getElementById('live-cache-files-open');
        if (origBtn) origBtn.click();
      });
    }
  }

  // ── User Settings Modal ──────────────────────────────────────────
  var _userSettingsOrigParents = {};

  function _saveDomPos(el, key) {
    if (!el) return;
    _userSettingsOrigParents[key] = { parent: el.parentNode, next: el.nextSibling };
  }
  function _restoreDomPos(el, key) {
    var info = _userSettingsOrigParents[key];
    if (!el || !info) return;
    if (info.next && info.next.parentNode === info.parent) info.parent.insertBefore(el, info.next);
    else if (info.parent) info.parent.appendChild(el);
  }

  function populateLangSection() {
    var body = document.getElementById('us-lang-body');
    if (!body || body.dataset.filled) return;
    body.dataset.filled = '1';
    var langs = ['de', 'en', 'ko'];
    var labels = { de: 'DE', en: 'EN', ko: 'KO' };
    var currentLang = (typeof getLang === 'function') ? getLang() : (localStorage.getItem('usageDashboardLang') || 'en');
    var html = '<div class="us-lang-row">';
    for (var l of langs) {
      html += '<button type="button" class="lang-btn' + (l === currentLang ? ' active' : '') + '" data-lang="' + l + '">' + labels[l] + '</button>';
    }
    html += '<span class="us-lang-saved" id="us-lang-indicator">' + _t('usPlanActive') + ': ' + (labels[currentLang] || 'EN') + '</span>';
    html += '</div>';
    body.innerHTML = html;
    body.addEventListener('click', function (e) {
      var btn = e.target.closest('[data-lang]');
      if (!btn) return;
      var origBtn = document.getElementById('lang-' + btn.dataset.lang);
      if (origBtn) origBtn.click();
      // Update active states
      var all = body.querySelectorAll('.lang-btn');
      for (var ab of all) ab.classList.remove('active');
      btn.classList.add('active');
      var indicator = document.getElementById('us-lang-indicator');
      if (indicator) indicator.textContent = _t('usPlanActive') + ': ' + btn.textContent;
    });
  }

  function populatePlanSection() {
    var body = document.getElementById('us-plan-body');
    if (!body || body.dataset.filled) return;
    body.dataset.filled = '1';
    var plans = { max5: 'MAX 5', max20: 'MAX 20', pro: 'Pro', free: 'Free', api: 'API' };
    var current = localStorage.getItem('cud_plan') || 'max5';
    var html = '<div class="us-plan-row">';
    html += '<select class="plan-select" id="us-plan-select">';
    for (var k in plans) {
      html += '<option value="' + k + '"' + (k === current ? ' selected' : '') + '>' + plans[k] + '</option>';
    }
    html += '</select>';
    html += '<span class="us-plan-active" id="us-plan-badge">' + _t('usPlanActive') + '</span>';
    html += '</div>';
    html += '<p class="us-plan-info">' + _t('usPlanInfo') + '</p>';
    body.innerHTML = html;
    var sel = document.getElementById('us-plan-select');
    if (sel) {
      sel.addEventListener('change', function () {
        var origPlan = document.getElementById('plan-select');
        if (origPlan) {
          origPlan.value = this.value;
          origPlan.dispatchEvent(new Event('change'));
        }
        // Also update sidebar clone if present
        var sidebarPlan = document.getElementById('sidebar-plan-select');
        if (sidebarPlan) sidebarPlan.value = this.value;
      });
    }
  }

  function populateProfileSection() {
    var body = document.getElementById('us-profile-body');
    if (!body) return;
    var profileCollapse = document.getElementById('user-profile-collapse');
    if (profileCollapse) {
      _saveDomPos(profileCollapse, 'profile');
      body.appendChild(profileCollapse);
      profileCollapse.open = true;
      profileCollapse.style.display = '';
      // Resize charts after move
      setTimeout(function () {
        var charts = body.querySelectorAll('[id^="c-user-"]');
        for (var chEl of charts) {
          var inst = typeof echarts !== 'undefined' ? echarts.getInstanceByDom(chEl) : null;
          if (inst) inst.resize();
        }
      }, 100);
    }
  }

  function populatePatSection() {
    var body = document.getElementById('us-pat-body');
    if (!body) return;
    var patPanel = document.getElementById('github-token-panel');
    if (patPanel) {
      _saveDomPos(patPanel, 'pat');
      body.appendChild(patPanel);
      patPanel.style.display = '';
    }
  }

  function populateMarketplaceSection() {
    var body = document.getElementById('us-marketplace-body');
    if (!body) return;
    // Marketplace refresh button — move from meta-details
    var mkRow = document.querySelector('.github-token-row');
    if (mkRow) {
      _saveDomPos(mkRow, 'marketplace');
      body.appendChild(mkRow);
      mkRow.style.display = '';
      // Fix button style to match modal CSS
      var btn = mkRow.querySelector('#marketplace-extension-refresh');
      if (btn) {
        btn.className = 'us-marketplace-btn';
      }
    }
    // Show last sync time
    var syncEl = document.getElementById('us-marketplace-sync-time');
    if (!syncEl) {
      syncEl = document.createElement('p');
      syncEl.className = 'us-marketplace-sync';
      syncEl.id = 'us-marketplace-sync-time';
      body.insertBefore(syncEl, body.firstChild);
    }
    // Get marketplace_fetched_at from last API data
    var data = global.__lastUsageData;
    if (data?.versionTimeline?.marketplace_fetched_at) {
      syncEl.textContent = _t('usMarketplaceLastSync') + ': ' + new Date(data.versionTimeline.marketplace_fetched_at).toLocaleString();
    } else {
      syncEl.textContent = _t('usMarketplaceLastSync') + ': —';
    }
  }

  function openUserSettingsModal() {
    var overlay = document.getElementById('user-settings-overlay');
    if (!overlay) return;

    // Set i18n titles
    var titleEl = document.getElementById('user-settings-modal-title');
    if (titleEl) titleEl.textContent = _t('userSettingsTitle');
    var sectionTitles = {
      'us-profile-title': 'usProfileTitle',
      'us-lang-title': 'usLangTitle',
      'us-plan-title': 'usPlanTitle',
      'us-health-title': 'usHealthTitle',
      'us-pat-title': 'usPatTitle',
      'us-marketplace-title': 'usMarketplaceTitle'
    };
    for (var id in sectionTitles) {
      var el = document.getElementById(id);
      if (el) el.textContent = el.textContent.split('\u25B6').pop().trim() ? el.textContent : _t(sectionTitles[id]);
      if (el) el.textContent = _t(sectionTitles[id]);
    }

    // Populate sections
    populateProfileSection();
    populateLangSection();
    populatePlanSection();
    populatePatSection();
    populateMarketplaceSection();

    overlay.classList.add('is-open');
    document.body.style.overflow = 'hidden';
  }

  function closeUserSettingsModal() {
    var overlay = document.getElementById('user-settings-overlay');
    if (!overlay) return;
    overlay.classList.remove('is-open');
    document.body.style.overflow = '';

    // Restore DOM-moved elements

    _restoreDomPos(document.getElementById('user-profile-collapse'), 'profile');
    _restoreDomPos(document.getElementById('github-token-panel'), 'pat');
    var mkRow = document.querySelector('#us-marketplace-body > .github-token-row');
    _restoreDomPos(mkRow, 'marketplace');
    _userSettingsOrigParents = {};
  }

  function bindUserSettingsModal() {
    var openBtn = document.getElementById('sidebar-open-user-settings');
    if (openBtn && !openBtn.dataset.bound) {
      openBtn.dataset.bound = '1';
      openBtn.addEventListener('click', function () {
        openUserSettingsModal();
      });
    }
    var closeBtn = document.getElementById('user-settings-modal-close');
    if (closeBtn && !closeBtn.dataset.bound) {
      closeBtn.dataset.bound = '1';
      closeBtn.addEventListener('click', closeUserSettingsModal);
    }
    var overlay = document.getElementById('user-settings-overlay');
    if (overlay && !overlay.dataset.bound) {
      overlay.dataset.bound = '1';
      overlay.addEventListener('click', function (e) {
        if (e.target === overlay) closeUserSettingsModal();
      });
    }
  }

  // ── Template Builder ──────────────────────────────────────────────

  var _tbWidgets = []; // working copy: [{ id, span, children: [{ id, span } | { type:'block', span, bid }] }]
  var _tbBlockSeq = 0;

  /** Which canvas sections were expanded (details open); keyed by section id, read before each renderCanvas. */
  function tbSnapshotSectionOpenState(canvas) {
    var map = {};
    if (!canvas) return map;
    var ds = canvas.querySelectorAll('details.tb-canvas-section[data-section-id]');
    var di;
    for (di = 0; di < ds.length; di++) {
      var sid = ds[di].dataset.sectionId;
      if (sid) map[sid] = ds[di].open;
    }
    return map;
  }

  function tbIsLayoutBlock(c) {
    return !!(c?.type === 'block');
  }

  function tbNewLayoutBlock(span) {
    _tbBlockSeq++;
    var s = Number.parseInt(span, 10) || 12;
    if (s < 1) s = 1;
    if (s > 12) s = 12;
    return { type: 'block', span: s, bid: 'tbblk_' + _tbBlockSeq, children: [] };
  }

  /** Section-level list (pc < 0) or inner list of layout block at index pc in section.children. */
  function tbGetChildListByParent(si, pc) {
    var sec = _tbWidgets[si];
    if (!sec?.children) return null;
    if (pc < 0) return sec.children;
    var b = sec.children[pc];
    if (!tbIsLayoutBlock(b)) return null;
    if (!b.children) b.children = [];
    return b.children;
  }

  /** Distribute chart rows across scaffold blocks by relative span weight; last block absorbs rounding remainder. */
  function tbPartitionChartsIntoBlocks(blockSpans, chartRows) {
    var ids = [];
    var ri;
    for (ri = 0; ri < chartRows.length; ri++) {
      ids.push({ id: chartRows[ri].id, span: chartRows[ri].span || 6 });
    }
    var nB = blockSpans.length;
    if (!nB) return [];
    var totalW = 0;
    for (ri = 0; ri < nB; ri++) totalW += blockSpans[ri] || 12;
    if (totalW <= 0) totalW = nB * 12;
    var out = [];
    var idx = 0;
    for (var bi = 0; bi < nB; bi++) {
      var cnt = bi === nB - 1 ? ids.length - idx : Math.floor(ids.length * ((blockSpans[bi] || 12) / totalW));
      if (cnt < 0) cnt = 0;
      if (bi === nB - 1) {
        out.push(ids.slice(idx));
      } else {
        out.push(ids.slice(idx, idx + cnt));
        idx += cnt;
      }
    }
    return out;
  }

  /**
   * Legacy flat builder rows: [ block, block, chart, chart, … ].
   * Moves trailing chart siblings into block.children (partition if all blocks empty; else append to last block).
   */
  function tbMigrateLooseChartsAfterBlocksIntoNested(children) {
    if (!children?.length) return;
    var blocks = [];
    var loose = [];
    var bi;
    for (bi = 0; bi < children.length; bi++) {
      var it = children[bi];
      if (tbIsLayoutBlock(it)) blocks.push(it);
      else if (it?.id) loose.push({ id: it.id, span: it.span || 6 });
    }
    if (!blocks.length || !loose.length) return;
    var allEmpty = true;
    for (bi = 0; bi < blocks.length; bi++) {
      if (blocks[bi].children?.length) {
        allEmpty = false;
        break;
      }
    }
    var spans = [];
    for (bi = 0; bi < blocks.length; bi++) spans.push(blocks[bi].span || 12);
    if (allEmpty) {
      var parts = tbPartitionChartsIntoBlocks(spans, loose);
      for (bi = 0; bi < blocks.length; bi++) {
        blocks[bi].children = parts[bi] ? parts[bi].slice() : [];
      }
    } else {
      var lastB = blocks[blocks.length - 1];
      if (!lastB.children) lastB.children = [];
      var usedId = {};
      for (bi = 0; bi < blocks.length; bi++) {
        var ex = blocks[bi].children || [];
        var ej;
        for (ej = 0; ej < ex.length; ej++) {
          if (ex[ej].id) usedId[ex[ej].id] = true;
        }
      }
      for (var looseItem of loose) {
        if (usedId[looseItem.id]) continue;
        lastB.children.push(looseItem);
        usedId[looseItem.id] = true;
      }
    }
    children.length = 0;
    for (bi = 0; bi < blocks.length; bi++) children.push(blocks[bi]);
  }

  /** Set on dragstart (pool / canvas section / canvas child), cleared on dragend — dragover cannot read getData reliably. */
  var _tbDrag = null;

  function tbClearCanvasDropUi() {
    var c = document.getElementById('tb-canvas');
    if (!c) return;
    var marks = c.querySelectorAll(
      '.tb-canvas-section--drop-before,.tb-canvas-section--drop-after,' +
        '.tb-canvas-child--drop-before,.tb-canvas-child--drop-after,' +
        '.tb-canvas-children--drop-append,.tb-canvas-placeholder--drop-here,' +
        '.tb-canvas-cell--drop-before,.tb-canvas-children--drop,.tb-canvas-block-inner--drop-append'
    );
    for (var mk of marks) {
      mk.classList.remove(
        'tb-canvas-section--drop-before',
        'tb-canvas-section--drop-after',
        'tb-canvas-child--drop-before',
        'tb-canvas-child--drop-after',
        'tb-canvas-children--drop-append',
        'tb-canvas-placeholder--drop-here',
        'tb-canvas-cell--drop-before',
        'tb-canvas-children--drop',
        'tb-canvas-block-inner--drop-append'
      );
    }
  }

  /** Insert before section at index `slot` (0..n); el = that section node or null = append after all. */
  function tbFindSectionInsertBefore(canvas, clientY) {
    var secs = canvas.querySelectorAll('.tb-canvas-section');
    var n = secs.length;
    if (!n) return { el: null, slot: 0 };
    var j;
    for (j = 0; j < n; j++) {
      var r = secs[j].getBoundingClientRect();
      var mid = r.top + r.height * 0.35;
      if (clientY < mid) {
        return { el: secs[j], slot: j };
      }
    }
    return { el: null, slot: n };
  }

  /** Highlight section insertion line (Layout-Baum-Stil). fromIdx >= 0 → reorder noop hides bar. */
  function tbApplySectionDropPreview(canvas, clientY, fromIdx) {
    var ti = tbFindSectionInsertBefore(canvas, clientY);
    if (fromIdx >= 0 && (ti.slot === fromIdx || ti.slot === fromIdx + 1)) return;
    var secs = canvas.querySelectorAll('.tb-canvas-section');
    if (!secs.length) {
      var ph = canvas.querySelector('.tb-canvas-placeholder');
      if (ph) ph.classList.add('tb-canvas-placeholder--drop-here');
      return;
    }
    if (ti.el) ti.el.classList.add('tb-canvas-section--drop-before');
    else secs[secs.length - 1].classList.add('tb-canvas-section--drop-after');
  }

  /** Insert before child at slot; el null = append in zone. */
  function tbFindChildInsertBefore(zone, clientY) {
    if (!zone) return { el: null, slot: 0 };
    var kids = [];
    var zc;
    for (zc = 0; zc < zone.children.length; zc++) {
      var el = zone.children[zc];
      if (el?.classList?.contains('tb-canvas-child')) kids.push(el);
    }
    var n = kids.length;
    var i;
    for (i = 0; i < n; i++) {
      var r = kids[i].getBoundingClientRect();
      var mid = r.top + r.height * 0.5;
      if (clientY < mid) {
        return { el: kids[i], slot: i };
      }
    }
    return { el: null, slot: n };
  }

  function tbApplyChildDropPreview(zone, clientY, fromSi, fromPc, fromIx) {
    if (!zone) return;
    fromSi = typeof fromSi === 'number' ? fromSi : -1;
    fromPc = typeof fromPc === 'number' ? fromPc : -1;
    fromIx = typeof fromIx === 'number' ? fromIx : -1;
    var toSi = Number.parseInt(zone.dataset.sidx, 10);
    var inner = zone.classList.contains('tb-canvas-block-inner');
    var toPc = inner ? Number.parseInt(zone.dataset.pcidx, 10) : -1;
    var ti = tbFindChildInsertBefore(zone, clientY);
    if (fromSi >= 0 && fromIx >= 0 && toSi === fromSi) {
      if (inner && fromPc === toPc) {
        if (ti.slot === fromIx || ti.slot === fromIx + 1) return;
      }
      if (!inner && fromPc < 0 && toPc < 0) {
        if (ti.slot === fromIx || ti.slot === fromIx + 1) return;
      }
    }
    if (ti.el) ti.el.classList.add('tb-canvas-child--drop-before');
    else if (inner) zone.classList.add('tb-canvas-block-inner--drop-append');
    else zone.classList.add('tb-canvas-children--drop-append');
  }

  /** Default builder span (12ths) from registry widgetGroup — matches dashboard CSS grids (#cards, #forensic-cards, …). */
  function tbPoolDefaultSpanForChart(reg, chartId) {
    if (!chartId) return 6;
    var sid = String(chartId);
    if (!reg?.findChart) {
      if (sid.startsWith('health-finding-')) return 2;
      if (sid.startsWith('health-kpi-')) return 4;
      if (sid.startsWith('token-stats-kpi-')) return 2;
      if (sid.startsWith('budget-kpi-')) return 2;
      if (sid.startsWith('proxy-kpi-')) return 2;
      if (sid.startsWith('forensic-card-')) return 4;
      if (sid === 'intel-saturation' || sid === 'intel-health' || sid === 'intel-quota-eta') return 4;
      return 6;
    }
    var d = reg.findChart(chartId);
    var wg = d?.widgetGroup;
    if (wg === 'kernbefunde') return 2;
    if (wg === 'health-kpis') return 4;
    if (wg === 'token-stats-kpis') return 2;
    if (wg === 'budget-kpis') return 2;
    if (wg === 'proxy-kpis') return 2;
    if (wg === 'forensic-cards') return 4;
    if (wg === 'intel-scores') return 4;
    return 6;
  }

  /** Registry charts for a section + nested child sections (e.g. efficiency-range under economic), minus hiddenCharts. */
  function tbVisibleRegistryChartsForSection(sectionId, ignoreHidden) {
    var reg = getRegistry();
    if (!reg?.findSection) return [];
    var hidden = ignoreHidden ? [] : (_prefs && Array.isArray(_prefs.hiddenCharts) ? _prefs.hiddenCharts : []);
    var parts = [];
    var sec = reg.findSection(sectionId);
    if (sec) parts.push(sec);
    for (var rSec of reg.sections) {
      if (rSec.parentSection === sectionId) parts.push(rSec);
    }
    var out = [];
    for (var part of parts) {
      var ordered = getOrderedChartsForSection(part);
      for (var ch of ordered) {
        if (ch.visible === false) continue;
        if (hidden.includes(ch.id)) continue;
        out.push({ id: ch.id, span: tbPoolDefaultSpanForChart(reg, ch.id) });
      }
    }
    return out;
  }

  /** Flat prefs/template widgets[] → nested builder model (sections + all visible chart/chip children). */
  function tbFlatWidgetsToNestedModel(flatWidgets) {
    var reg = getRegistry();
    var result = [];
    if (!flatWidgets?.length) return result;
    for (var i = 0; i < flatWidgets.length; i++) {
      var w = flatWidgets[i];
      var wType = w.type || 'section';
      if (wType === 'chart') {
        if (w.section) continue;
        if (result.length) {
          result[result.length - 1].children.push({ id: w.id, span: w.span || 6 });
        }
        continue;
      }
      var children = [];
      var k = i + 1;
      while (k < flatWidgets.length) {
        var nx = flatWidgets[k];
        var nxt = nx.type || 'section';
        if (nxt === 'section') break;
        if (nxt === 'layout') {
          if (nx.section !== w.id) break;
          var spL = nx.span || 12;
          if (spL < 1) spL = 1;
          if (spL > 12) spL = 12;
          var normNested = [];
          var nestedIn = nx.nested;
          if (nestedIn?.length) {
            var ni;
            for (ni = 0; ni < nestedIn.length; ni++) {
              var ne = nestedIn[ni];
              if (ne?.id) normNested.push({ id: ne.id, span: ne.span || 6 });
            }
          }
          children.push({ type: 'block', span: spL, bid: nx.bid || nx.id || 'tbblk_r' + k, children: normNested });
          k++;
          continue;
        }
        if (nxt !== 'chart') break;
        if (nx.section !== w.id) break;
        children.push({ id: nx.id, span: nx.span || 6 });
        k++;
      }
      if (!children.length) {
        children = tbVisibleRegistryChartsForSection(w.id, false);
      } else {
        tbMigrateLooseChartsAfterBlocksIntoNested(children);
      }
      result.push({ id: w.id, span: w.span || 12, children: children });
      if (k > i + 1) i = k - 1;
    }
    return result;
  }

  /**
   * Prefs/widgets[] persist mostly ECharts rows — chips/HTML stay in the registry only.
   * Reconcile each builder section with tbVisibleRegistryChartsForSection (order + ids),
   * keeping spans from the flat model when ids match; append flat-only ids at the end.
   */
  function tbAugmentBuilderChildrenFromRegistry(nested) {
    if (!nested?.length) return;
    for (var row of nested) {
      var flatKids = row.children || [];
      var hasBlock = false;
      for (var fk of flatKids) {
        if (tbIsLayoutBlock(fk)) {
          hasBlock = true;
          break;
        }
      }
      if (hasBlock) {
        var usedB = {};
        var spanByIdB = {};
        var hb;
        for (hb = 0; hb < flatKids.length; hb++) {
          var fk0 = flatKids[hb];
          if (tbIsLayoutBlock(fk0)) {
            var in0 = fk0.children || [];
            var hi;
            for (hi = 0; hi < in0.length; hi++) {
              if (in0[hi].id) {
                usedB[in0[hi].id] = true;
                spanByIdB[in0[hi].id] = in0[hi].span || 6;
              }
            }
          } else if (fk0.id) {
            usedB[fk0.id] = true;
            spanByIdB[fk0.id] = fk0.span || 6;
          }
        }
        var fullB = tbVisibleRegistryChartsForSection(row.id, false);
        var lastBlk = null;
        for (hb = flatKids.length - 1; hb >= 0; hb--) {
          if (tbIsLayoutBlock(flatKids[hb])) {
            lastBlk = flatKids[hb];
            break;
          }
        }
        if (lastBlk) {
          if (!lastBlk.children) lastBlk.children = [];
          for (hb = 0; hb < fullB.length; hb++) {
            var cidB = fullB[hb].id;
            if (usedB[cidB]) continue;
            lastBlk.children.push({ id: cidB, span: spanByIdB[cidB] !== undefined ? spanByIdB[cidB] : 6 });
            usedB[cidB] = true;
          }
        }
        var newTop = [];
        for (hb = 0; hb < flatKids.length; hb++) {
          if (!tbIsLayoutBlock(flatKids[hb]) && flatKids[hb].id) continue;
          newTop.push(flatKids[hb]);
        }
        row.children = newTop;
        continue;
      }
      var full = tbVisibleRegistryChartsForSection(row.id, false);
      var spanById = {};
      var fi;
      for (fi = 0; fi < flatKids.length; fi++) {
        if (!tbIsLayoutBlock(flatKids[fi]) && flatKids[fi].id) spanById[flatKids[fi].id] = flatKids[fi].span || 6;
      }
      var merged = [];
      var seen = {};
      for (fi = 0; fi < full.length; fi++) {
        var cid = full[fi].id;
        merged.push({ id: cid, span: spanById[cid] !== undefined ? spanById[cid] : 6 });
        seen[cid] = true;
      }
      for (fi = 0; fi < flatKids.length; fi++) {
        fk = flatKids[fi];
        if (tbIsLayoutBlock(fk)) continue;
        if (!seen[fk.id]) {
          merged.push({ id: fk.id, span: fk.span || 6 });
          seen[fk.id] = true;
        }
      }
      row.children = merged;
    }
  }

  /** Top-level registry sections (sorted), each with all default-visible widgets (inkl. KPI/HTML). */
  function tbRegistryDefaultNestedModel() {
    var reg = getRegistry();
    if (!reg || typeof reg.getSectionsSorted !== 'function') {
      return ALL_SECTION_IDS.map(function (id) { return { id: id, span: 12, children: tbVisibleRegistryChartsForSection(id, true) }; });
    }
    var secs = reg.getSectionsSorted();
    var out = [];
    for (var sec of secs) {
      if (sec.parentSection) continue;
      out.push({ id: sec.id, span: 12, children: tbVisibleRegistryChartsForSection(sec.id, true) });
    }
    return out;
  }

  /**
   * DOM order of #layout-grid (tpl/dashboard.html) + rough inner row widths as 12-col spans.
   * Each section: layout DIV rows with charts in block.children (incl. chips; efficiency-range merged into economic).
   * Optional slotChartIds (same length as blocks): per row an array of chart ids in DOM order (only ids present in
   * tbVisibleRegistryChartsForSection are kept); leftover registry rows append to the last block.
   * Optional slotWidgetGroups (same length as blocks): string = registry widgetGroup for that row (e.g. #cards KPI grid);
   * null = fill from remaining charts by span-weight partition across all null slots. slotChartIds wins when set.
   */
  var TB_PAGE_SCAFFOLD_PLAN = [
    {
      id: 'health',
      blocks: [12, 12],
      slotWidgetGroups: ['health-kpis', 'kernbefunde']
    },
    {
      id: 'forensic',
      blocks: [12, 12, 6, 6],
      slotChartIds: [
        ['forensic-card-code', 'forensic-card-impl', 'forensic-card-budget'],
        ['forensic-hitlimit'],
        ['forensic-signals'],
        ['forensic-service']
      ]
    },
    {
      id: 'economic',
      blocks: [4, 8, 12, 12],
      slotChartIds: [
        ['econ-cumulative'],
        ['econ-explosion'],
        ['econ-budget-drain'],
        ['eff-efficiency-timeline', 'eff-monthly-butterfly', 'eff-day-comparison']
      ]
    },
    {
      id: 'token-stats',
      blocks: [12, 6, 6, 12],
      slotWidgetGroups: ['token-stats-kpis', null, null, null]
    },
    {
      id: 'user-profile',
      blocks: [4, 4, 4],
      slotChartIds: [['user-versions'], ['user-entrypoints'], ['user-release-stability']]
    },
    {
      id: 'budget',
      blocks: [12, 12, 6, 6],
      slotChartIds: [
        [
          'budget-kpi-output',
          'budget-kpi-overhead',
          'budget-kpi-cache-miss',
          'budget-kpi-lost',
          'budget-kpi-outage',
          'budget-kpi-truncated'
        ],
        ['budget-sankey'],
        ['budget-trend'],
        ['budget-quota']
      ]
    },
    {
      id: 'proxy',
      blocks: [12, 4, 4, 4, 6, 6, 6, 6, 12],
      slotChartIds: [
        [
          'proxy-kpi-requests',
          'proxy-kpi-latency',
          'proxy-kpi-cache-ratio',
          'proxy-kpi-models',
          'proxy-kpi-quota-5h',
          'proxy-kpi-quota-7d',
          'proxy-kpi-ttl-tier',
          'proxy-kpi-peak-hours',
          'proxy-kpi-saturation',
          'proxy-kpi-health'
        ],
        ['proxy-tokens'],
        ['proxy-models'],
        ['proxy-hourly'],
        ['proxy-latency'],
        ['proxy-hourly-latency'],
        ['proxy-error-trend'],
        ['proxy-cache-trend'],
        ['proxy-ttl-history']
      ]
    }
    // anthropic-status excluded: domId=null, lives in top-bar, not in #layout-grid
  ];

  /** Inner 12-col spans for scaffold block.children (builder canvas); aligns chip rows with dashboard grids. */
  function tbScaffoldApplyInnerSpans(sectionId, blockIndex, picked) {
    if (!picked?.length) return;
    var n = picked.length;
    var i;
    if (sectionId === 'forensic' && blockIndex === 0 && n === 3) {
      for (i = 0; i < n; i++) picked[i] = { id: picked[i].id, span: 4 };
    } else if (sectionId === 'intelligence' && blockIndex === 0 && n === 3) {
      for (i = 0; i < n; i++) picked[i] = { id: picked[i].id, span: 4 };
    } else if (sectionId === 'budget' && blockIndex === 0 && n >= 6) {
      for (i = 0; i < n; i++) picked[i] = { id: picked[i].id, span: 2 };
    } else if (sectionId === 'proxy' && blockIndex === 0) {
      for (i = 0; i < n; i++) picked[i] = { id: picked[i].id, span: 2 };
    } else if (sectionId === 'economic' && blockIndex === 3 && n === 3) {
      for (i = 0; i < n; i++) picked[i] = { id: picked[i].id, span: 4 };
    } else if (n === 1) {
      picked[0] = { id: picked[0].id, span: 12 };
    } else {
      var each = Math.max(1, Math.floor(12 / n));
      for (i = 0; i < n; i++) picked[i] = { id: picked[i].id, span: each };
    }
  }

  /** Assign registry rows to scaffold blocks; optional slotWidgetGroups on plan entry (see TB_PAGE_SCAFFOLD_PLAN). */
  function tbFillScaffoldBlockChildren(p, children, regs) {
    var blocks = p.blocks || [];
    var reg = getRegistry();
    var regList = [];
    var r0;
    for (r0 = 0; r0 < regs.length; r0++) {
      regList.push({ id: regs[r0].id, span: regs[r0].span || 6 });
    }
    var sci = p.slotChartIds;
    var bi;
    if (sci && sci.length === blocks.length) {
      var regIdSet = {};
      for (r0 = 0; r0 < regList.length; r0++) {
        regIdSet[regList[r0].id] = regList[r0];
      }
      var placedSci = {};
      for (bi = 0; bi < children.length; bi++) {
        var rowIds = sci[bi];
        var pickedSci = [];
        var rj;
        if (rowIds?.length) {
          for (rj = 0; rj < rowIds.length; rj++) {
            var cid = rowIds[rj];
            var entSci = regIdSet[cid];
            if (!entSci) continue;
            pickedSci.push({ id: entSci.id, span: entSci.span || 6 });
            placedSci[cid] = true;
          }
        }
        tbScaffoldApplyInnerSpans(p.id, bi, pickedSci);
        children[bi].children = pickedSci;
      }
      var orphanSci = [];
      for (r0 = 0; r0 < regList.length; r0++) {
        if (!placedSci[regList[r0].id]) orphanSci.push(regList[r0]);
      }
      if (orphanSci.length && children.length) {
        var lastIx = children.length - 1;
        var mergeSci = (children[lastIx].children || []).slice();
        var oi;
        for (oi = 0; oi < orphanSci.length; oi++) {
          mergeSci.push({ id: orphanSci[oi].id, span: orphanSci[oi].span || 6 });
        }
        children[lastIx].children = mergeSci;
      }
      return;
    }
    var slots = p.slotWidgetGroups;
    if (slots && slots.length === blocks.length) {
      var used = {};
      for (bi = 0; bi < children.length; bi++) {
        var slotSpec = slots[bi];
        if (typeof slotSpec === 'string' && slotSpec.length) {
          var picked = [];
          var ri;
          for (ri = 0; ri < regList.length; ri++) {
            var ent = regList[ri];
            if (used[ent.id]) continue;
            var cd = reg?.findChart ? reg.findChart(ent.id) : null;
            var wg = cd?.widgetGroup;
            if (wg === slotSpec) {
              picked.push({ id: ent.id, span: ent.span });
              used[ent.id] = true;
            }
          }
          if (slotSpec === 'token-stats-kpis' && picked.length) {
            for (var ps = 0; ps < picked.length; ps++) {
              picked[ps] = { id: picked[ps].id, span: 2 };
            }
          }
          if (slotSpec === 'health-kpis' && picked.length) {
            for (var ph = 0; ph < picked.length; ph++) {
              picked[ph] = { id: picked[ph].id, span: 4 };
            }
          }
          if (slotSpec === 'kernbefunde' && picked.length) {
            for (var pk = 0; pk < picked.length; pk++) {
              picked[pk] = { id: picked[pk].id, span: 2 };
            }
          }
          children[bi].children = picked;
        }
      }
      var remaining = [];
      for (ri = 0; ri < regList.length; ri++) {
        var ent2 = regList[ri];
        if (!used[ent2.id]) remaining.push(ent2);
      }
      var nullIndices = [];
      var nullSpans = [];
      for (bi = 0; bi < slots.length; bi++) {
        if (slots[bi] == null || slots[bi] === '') {
          nullIndices.push(bi);
          nullSpans.push(blocks[bi] || 12);
        }
      }
      if (remaining.length && nullIndices.length) {
        var parts = tbPartitionChartsIntoBlocks(nullSpans, remaining);
        var ni;
        for (ni = 0; ni < nullIndices.length; ni++) {
          var bix = nullIndices[ni];
          var extra = parts[ni] || [];
          var cur = children[bix].children || [];
          var mergedList = cur.slice();
          var ej;
          for (ej = 0; ej < extra.length; ej++) mergedList.push(extra[ej]);
          children[bix].children = mergedList;
        }
      }
      return;
    }
    var parts0 = tbPartitionChartsIntoBlocks(blocks, regList);
    for (bi = 0; bi < children.length; bi++) {
      children[bi].children = parts0[bi] ? parts0[bi].slice() : [];
    }
  }

  function tbNestedModelFromPageScaffold() {
    var reg = getRegistry();
    var out = [];
    for (var p of TB_PAGE_SCAFFOLD_PLAN) {
      if (!reg?.findSection?.(p.id)) continue;
      var children = [];
      var bi;
      for (bi = 0; bi < p.blocks.length; bi++) {
        children.push(tbNewLayoutBlock(p.blocks[bi]));
      }
      var regs = tbVisibleRegistryChartsForSection(p.id, true);
      tbFillScaffoldBlockChildren(p, children, regs);
      out.push({ id: p.id, span: 12, children: children });
    }
    return out;
  }

  function tbLoadDefaultIntoBuilder() {
    var overlay = document.getElementById('tb-overlay');
    if (!overlay) return;
    var tplSelect = document.getElementById('tb-template-select');
    var val = tplSelect ? tplSelect.value : '';
    if (val) {
      var all = getAllTemplates();
      for (var tplItem of all) {
        if (tplItem.name === val) {
          _tbWidgets = tbLoadTemplateIntoBuilder(tplItem);
          renderBuilderRows();
          return;
        }
      }
    }
    _tbWidgets = tbNestedModelFromPageScaffold();
    renderBuilderRows();
  }

  /**
   * Load a template (or prefs) into the builder model.
   * For section-only templates (v2 builtins): enriches with scaffold blocks in template order.
   * For v3 templates with layout blocks: loads as-is.
   * Returns the nested _tbWidgets array.
   */
  function tbLoadTemplateIntoBuilder(tpl) {
    var widgets = tpl?.widgets;
    if (!widgets?.length) return tbNestedModelFromPageScaffold();
    // Check if template has layout/chart blocks
    var hasBlocks = false;
    for (var wChk of widgets) {
      if (wChk.type === 'layout' || wChk.type === 'chart') {
        hasBlocks = true; break;
      }
    }
    if (hasBlocks) {
      var result = tbFlatWidgetsToNestedModel(widgets);
      tbAugmentBuilderChildrenFromRegistry(result);
      return result;
    }
    // Section-only: enrich with scaffold blocks in template order
    var scaffoldNested = tbNestedModelFromPageScaffold();
    var scaffoldById = {};
    for (var scSec of scaffoldNested) {
      scaffoldById[scSec.id] = scSec;
    }
    var out = [];
    for (var pw of widgets) {
      if ((pw.type || 'section') !== 'section') continue;
      var scaffSec = scaffoldById[pw.id];
      if (scaffSec) {
        out.push({ id: pw.id, span: pw.span || 12, children: scaffSec.children || [] });
      } else {
        out.push({ id: pw.id, span: pw.span || 12, children: [] });
      }
    }
    return out;
  }

  function openTemplateBuilder(baseTpl) {
    var overlay = document.getElementById('tb-overlay');
    if (!overlay) return;
    var nameInput = document.getElementById('tb-name-input');
    var titleEl = document.getElementById('tb-title');
    if (titleEl) titleEl.textContent = _t('tbTitle');
    if (nameInput) nameInput.placeholder = _t('tbNamePlaceholder');

    console.info('[TB open] baseTpl=%s, _prefs.widgets=%s', !!baseTpl, _prefs?.widgets ? _prefs.widgets.length : 'null');
    if (baseTpl?.widgets) {
      console.info('[TB open] → baseTpl path');
      _tbWidgets = tbLoadTemplateIntoBuilder(baseTpl);
      if (nameInput) nameInput.value = baseTpl.builtin ? '' : (baseTpl.name || '');
    } else if (_prefs?.widgets?.length) {
      console.info('[TB open] → _prefs path, sections:', _prefs.widgets.filter(function(w){return (w.type||'section')==='section'}).map(function(w){return w.id}));
      _tbWidgets = tbLoadTemplateIntoBuilder(_prefs);
      if (nameInput) nameInput.value = '';
    } else {
      _tbWidgets = tbNestedModelFromPageScaffold();
      if (nameInput) nameInput.value = '';
    }

    // Populate template select dropdown
    var tplSelect = document.getElementById('tb-template-select');
    if (tplSelect) {
      var all = getAllTemplates();
      tplSelect.innerHTML = '<option value="">— Template laden —</option>';
      for (var tplOpt of all) {
        var opt = document.createElement('option');
        opt.value = tplOpt.name;
        opt.textContent = tplOpt.name + (tplOpt.builtin ? '' : ' *');
        tplSelect.appendChild(opt);
      }
    }

    renderBuilderRows();
    bindCanvasEvents();
    bindPoolEvents();
    var scSum = document.getElementById('tb-scaffold-summary');
    var scPre = document.getElementById('tb-scaffold-pipe');
    if (scSum) scSum.textContent = _t('tbScaffoldSummary');
    if (scPre) {
      var sk = tbGetDesktopPageScaffold();
      scPre.textContent =
        sk.divGeruestAscii +
        '\n\n--- pipe ---\n' +
        sk.fullPipe +
        '\n\n--- shallow ---\n' +
        sk.toShallowDivPipe();
    }
    overlay.classList.add('is-open');
    document.body.style.overflow = 'hidden';
  }

  function closeTemplateBuilder() {
    var overlay = document.getElementById('tb-overlay');
    if (!overlay) return;
    overlay.classList.remove('is-open');
    document.body.style.overflow = '';
    _tbWidgets = [];
  }

  function getUsedIds() {
    var used = {};
    for (var tw of _tbWidgets) used[tw.id] = true;
    return used;
  }

  function getAvailableSections() {
    var used = getUsedIds();
    var reg = getRegistry();
    if (!reg) return [];
    var avail = [];
    for (var s of reg.sections) {
      if (!used[s.id]) avail.push(s);
    }
    return avail;
  }

  // ── Template Builder v2: Nested Grid Canvas + Widget Pool ───────
  //
  // Data model: _tbWidgets = [ { id, span, children: [ {id,span} | { type:'block', span, bid, children:[{id,span}] } ] }, ... ]
  // Sections are containers; layout blocks hold nested chart rows in block.children.

  function tbName(reg, id, type) {
    if (type === 'chart') {
      var ch = reg.findChart(id);
      return ch ? _t(ch.titleKey) : id;
    }
    var sec = reg.findSection(id);
    return sec ? _t(sec.titleKey) : id;
  }

  /** Same rule as pool: ECharts canvas chart vs KPI/HTML/chip (dashed meta pool); block = layout row. */
  function tbCanvasChildKind(reg, child) {
    if (tbIsLayoutBlock(child)) return 'layout';
    var chartId = child?.id;
    if (!reg || typeof reg.findChart !== 'function') return 'meta';
    var ch = reg.findChart(chartId);
    if (!ch) return 'meta';
    if (ch.engine === 'echarts' && ch.kind !== 'chip') return 'chart';
    return 'meta';
  }

  function tbGetAllUsedIds() {
    var used = {};
    for (var tw of _tbWidgets) {
      used[tw.id] = true;
      var ch = tw.children || [];
      for (var ent of ch) {
        if (tbIsLayoutBlock(ent)) {
          var inn = ent.children || [];
          for (var innEnt of inn) {
            if (innEnt.id) used[innEnt.id] = true;
          }
          continue;
        }
        if (ent.id) used[ent.id] = true;
      }
    }
    return used;
  }

  function renderCanvas() {
    var canvas = document.getElementById('tb-canvas');
    if (!canvas) return;
    var reg = getRegistry();
    if (!reg) return;
    var prevOpen = tbSnapshotSectionOpenState(canvas);
    var html = '';
    for (var i = 0; i < _tbWidgets.length; i++) {
      var w = _tbWidgets[i];
      var isOpen = prevOpen[w.id] === true;
      html +=
        '<details class="tb-canvas-section"' +
        (isOpen ? ' open' : '') +
        ' data-sidx="' +
        i +
        '" data-section-id="' +
        escT(w.id) +
        '" draggable="true" style="grid-column:span ' +
        (w.span || 12) +
        '">';
      html += '<summary class="tb-canvas-section-head" title="' + escT(_t('tbSectionToggleTitle')) + '">';
      html += '<span class="tb-canvas-drag">&#x2630;</span>';
      html += '<span class="tb-canvas-name">' + tbName(reg, w.id, 'section') + '</span>';
      html += '<span class="tb-canvas-span">' + (w.span || 12) + '</span>';
      html += '<button type="button" class="tb-canvas-remove" data-sidx="' + i + '">&times;</button>';
      html += '<span class="tb-canvas-resize" data-sidx="' + i + '"></span>';
      html += '</summary>';
      html += '<div class="tb-canvas-section-body">';
      html += '<div class="tb-canvas-layout-bar" data-sidx="' + i + '">';
      for (var spb = 12; spb >= 1; spb--) {
        html +=
          '<button type="button" class="tb-canvas-add-block" data-sidx="' +
          i +
          '" data-span="' +
          spb +
          '" title="' +
          escT(_t('tbAddLayoutBlockTitle')) +
          '">' +
          spb +
          '</button>';
      }
      html += '</div>';
      // Children sub-grid
      var children = w.children || [];
      html += '<div class="tb-canvas-children" data-sidx="' + i + '">';
      for (var ci = 0; ci < children.length; ci++) {
        var c = children[ci];
        var ck = tbCanvasChildKind(reg, c);
        var cspan = c.span || (tbIsLayoutBlock(c) ? 12 : 6);
        var cname = tbIsLayoutBlock(c) ? _t('tbLayoutBlockLabel') + ' ' + String(cspan) + '/12' : tbName(reg, c.id, 'chart');
        if (tbIsLayoutBlock(c)) {
          html += '<div class="tb-canvas-child tb-canvas-child--' + ck + '" data-sidx="' + i + '" data-cidx="' + ci + '" draggable="true" style="grid-column:span ' + cspan + '">';
          html += '<div class="tb-canvas-layout-row">';
          html += '<span class="tb-canvas-drag">&#x2630;</span>';
          html += '<span class="tb-canvas-name">' + cname + '</span>';
          html += '<span class="tb-canvas-span">' + cspan + '</span>';
          html += '<button type="button" class="tb-canvas-child-remove" data-sidx="' + i + '" data-cidx="' + ci + '">&times;</button>';
          html += '<span class="tb-canvas-child-resize" data-sidx="' + i + '" data-cidx="' + ci + '"></span>';
          html += '</div>';
          var inners = c.children || [];
          html +=
            '<div class="tb-canvas-block-inner" data-sidx="' +
            i +
            '" data-pcidx="' +
            ci +
            '" data-inner-cols="' +
            cspan +
            '" style="grid-template-columns:repeat(' +
            cspan +
            ',1fr)">';
          var ii;
          for (ii = 0; ii < inners.length; ii++) {
            var ic = inners[ii];
            var ick = tbCanvasChildKind(reg, ic);
            var icspan = ic.span || 6;
            if (icspan < 1) icspan = 1;
            if (icspan > cspan) icspan = cspan;
            var icname = tbName(reg, ic.id, 'chart');
            html +=
              '<div class="tb-canvas-child tb-canvas-child--' +
              ick +
              '" data-sidx="' +
              i +
              '" data-pcidx="' +
              ci +
              '" data-icc="' +
              ii +
              '" draggable="true" style="grid-column:span ' +
              icspan +
              '">';
            html += '<span class="tb-canvas-drag">&#x2630;</span>';
            html += '<span class="tb-canvas-name">' + icname + '</span>';
            html += '<span class="tb-canvas-span">' + icspan + '</span>';
            html +=
              '<button type="button" class="tb-canvas-child-remove" data-sidx="' +
              i +
              '" data-pcidx="' +
              ci +
              '" data-icc="' +
              ii +
              '">&times;</button>';
            html += '<span class="tb-canvas-child-resize" data-sidx="' + i + '" data-pcidx="' + ci + '" data-icc="' + ii + '"></span>';
            html += '</div>';
          }
          if (!inners.length) {
            html +=
              '<div class="tb-canvas-child-placeholder tb-canvas-child-placeholder--inner" data-sidx="' +
              i +
              '" data-pcidx="' +
              ci +
              '">+ Charts hierher ziehen</div>';
          }
          html += '</div></div>';
          continue;
        }
        html += '<div class="tb-canvas-child tb-canvas-child--' + ck + '" data-sidx="' + i + '" data-cidx="' + ci + '" draggable="true" style="grid-column:span ' + cspan + '">';
        html += '<span class="tb-canvas-drag">&#x2630;</span>';
        html += '<span class="tb-canvas-name">' + cname + '</span>';
        html += '<span class="tb-canvas-span">' + cspan + '</span>';
        html += '<button type="button" class="tb-canvas-child-remove" data-sidx="' + i + '" data-cidx="' + ci + '">&times;</button>';
        html += '<span class="tb-canvas-child-resize" data-sidx="' + i + '" data-cidx="' + ci + '"></span>';
        html += '</div>';
      }
      if (!children.length) {
        html += '<div class="tb-canvas-child-placeholder" data-sidx="' + i + '">+ Charts hierher ziehen</div>';
      }
      html += '</div>';
      html += '</div>';
      html += '</details>';
    }
    if (!_tbWidgets.length) {
      html += '<div class="tb-canvas-placeholder">' + _t('tbDropHere') + '</div>';
    }
    canvas.innerHTML = html;
  }

  /** ECharts canvas children for template row: nested registry section includes parent charts first. */
  function tbMetaDefaultChartChildren(reg, gs) {
    var out = [];
    var seen = {};
    function pushFrom(sec) {
      if (!sec?.charts) return;
      for (var ch of sec.charts) {
        if (ch.kind === 'chip' || ch.engine !== 'echarts') continue;
        if (!seen[ch.id]) {
          seen[ch.id] = true;
          out.push({ id: ch.id, span: 6 });
        }
      }
    }
    if (gs.parentSection) {
      var par = reg.findSection(gs.parentSection);
      pushFrom(par);
    }
    pushFrom(gs);
    return out;
  }

  function renderPool() {
    var elCharts = document.getElementById('tb-pool-charts');
    var elMeta = document.getElementById('tb-pool-meta');
    var elSections = document.getElementById('tb-pool-sections');
    var headL = document.getElementById('tb-pool-left-head');
    var headR = document.getElementById('tb-pool-right-head');
    var labSec = document.getElementById('tb-pool-sections-label');
    if (!elCharts || !elMeta || !elSections) return;
    var reg = getRegistry();
    if (!reg) return;
    var used = tbGetAllUsedIds();

    if (headL) headL.textContent = _t('tbPoolLeftTitle');
    if (headR) headR.textContent = _t('tbPoolRightTitle');
    if (labSec) labSec.textContent = _t('tbPoolSections');

    var htmlSec = '';
    for (var sec of reg.sections) {
      if (sec.parentSection) continue;
      var clsS = 'tb-pool-chip' + (used[sec.id] ? ' is-used' : '');
      htmlSec += '<div class="' + clsS + '" data-pool-id="' + sec.id + '" data-pool-type="section" draggable="' + (used[sec.id] ? 'false' : 'true') + '">';
      htmlSec += _t(sec.titleKey);
      htmlSec += '</div>';
    }
    elSections.innerHTML = htmlSec;

    var htmlCharts = '';
    for (var gs of reg.sections) {
      if (!gs.charts?.length) continue;
      var hasCanvas = false;
      for (var chx of gs.charts) {
        if (chx.engine === 'echarts' && chx.kind !== 'chip') {
          hasCanvas = true;
          break;
        }
      }
      if (!hasCanvas) continue;
      var innerCharts = '';
      for (var rc of gs.charts) {
        var isCanvasChart = rc.engine === 'echarts' && rc.kind !== 'chip';
        if (!isCanvasChart) continue;
        if (used[rc.id]) continue;
        var label = _t(rc.titleKey);
        innerCharts += '<div class="tb-pool-chip tb-pool-chip--chart" data-pool-id="' + rc.id + '" data-pool-type="chart" data-pool-section="' + gs.id + '" draggable="true">';
        innerCharts += label;
        innerCharts += '</div>';
      }
      if (!innerCharts) continue;
      htmlCharts += '<details class="tb-pool-group tb-pool-group--fold">';
      htmlCharts += '<summary class="tb-pool-group-title">' + _t(gs.titleKey) + '</summary>';
      htmlCharts += '<div class="tb-pool-chips">';
      htmlCharts += innerCharts;
      htmlCharts += '</div></details>';
    }
    if (!htmlCharts) htmlCharts = '<div class="tb-pool-empty">' + _t('tbPoolLeftEmpty') + '</div>';
    elCharts.innerHTML = htmlCharts;

    var htmlMeta = '';
    for (var g2 of reg.sections) {
      if (!g2.charts?.length) continue;
      var hasMeta = false;
      for (var cx of g2.charts) {
        if (!(cx.engine === 'echarts' && cx.kind !== 'chip')) {
          hasMeta = true;
          break;
        }
      }
      if (!hasMeta) continue;
      var innerMeta = '';
      for (var r2 of g2.charts) {
        var isCv = r2.engine === 'echarts' && r2.kind !== 'chip';
        if (isCv) continue;
        if (used[r2.id]) continue;
        var lab2 = _t(r2.titleKey);
        var metaSub = r2.kind === 'chip' ? _t('tbPoolChipKindChip') : (r2.type === 'table' ? _t('tbPoolChipKindTable') : _t('tbPoolChipKindOther'));
        innerMeta += '<div class="tb-pool-chip tb-pool-chip--meta" data-pool-id="' + r2.id + '" data-pool-section="' + g2.id + '" draggable="false" role="button" tabindex="0">';
        innerMeta += '<span class="tb-pool-meta-main">' + lab2 + '</span><span class="tb-pool-meta-sub">' + metaSub + '</span></div>';
      }
      if (!innerMeta) continue;
      htmlMeta += '<details class="tb-pool-group tb-pool-group--fold">';
      htmlMeta += '<summary class="tb-pool-group-title">' + _t(g2.titleKey) + '</summary>';
      htmlMeta += '<div class="tb-pool-chips">';
      htmlMeta += innerMeta;
      htmlMeta += '</div></details>';
    }
    if (!htmlMeta) htmlMeta = '<div class="tb-pool-empty">' + _t('tbPoolRightEmpty') + '</div>';
    elMeta.innerHTML = htmlMeta;
  }

  function renderBuilderRows() {
    renderCanvas();
    renderPool();
    renderGridRuler();
  }

  function renderGridRuler() {
    var ruler = document.querySelector('.tb-grid-ruler');
    if (!ruler || ruler.children.length) return;
    for (var ri = 0; ri < 12; ri++) {
      var col = document.createElement('div');
      col.className = 'tb-grid-ruler-col';
      col.setAttribute('data-col', String(ri + 1));
      ruler.appendChild(col);
    }
  }

  function bindCanvasEvents() {
    var canvas = document.getElementById('tb-canvas');
    if (!canvas || canvas.dataset.bound) return;
    var regCanvas = getRegistry();
    canvas.dataset.bound = '1';
    var dropHost = canvas.parentElement?.classList.contains('tb-canvas-wrap') ? canvas.parentElement : canvas;

    // Remove section or child
    canvas.addEventListener('click', function (e) {
      var addBlk = e.target.closest('.tb-canvas-add-block');
      if (addBlk) {
        var sbi = Number.parseInt(addBlk.dataset.sidx, 10);
        var spb = Number.parseInt(addBlk.dataset.span, 10);
        if (_tbWidgets[sbi]) {
          if (!_tbWidgets[sbi].children) _tbWidgets[sbi].children = [];
          _tbWidgets[sbi].children.push(tbNewLayoutBlock(spb));
          renderBuilderRows();
        }
        return;
      }
      var rmChild = e.target.closest('.tb-canvas-child-remove');
      if (rmChild) {
        var si = Number.parseInt(rmChild.dataset.sidx, 10);
        if (rmChild.dataset.pcidx !== undefined && rmChild.dataset.pcidx !== '') {
          var pcR = Number.parseInt(rmChild.dataset.pcidx, 10);
          var iccR = Number.parseInt(rmChild.dataset.icc, 10);
          var blkR = _tbWidgets[si]?.children?.[pcR];
          if (blkR?.children && !Number.isNaN(iccR)) {
            blkR.children.splice(iccR, 1);
          }
        } else {
          var ci = Number.parseInt(rmChild.dataset.cidx, 10);
          if (_tbWidgets[si]?.children) {
            _tbWidgets[si].children.splice(ci, 1);
          }
        }
        renderBuilderRows();
        return;
      }
      var rmSec = e.target.closest('.tb-canvas-remove');
      if (rmSec) {
        e.stopPropagation();
        var idx = Number.parseInt(rmSec.dataset.sidx, 10);
        _tbWidgets.splice(idx, 1);
        renderBuilderRows();
      }
    });

    // Drag canvas child row vs section (child is inside section — must test child first)
    canvas.addEventListener('dragstart', function (e) {
      var ch = e.target.closest('.tb-canvas-child');
      if (ch) {
        var siD = Number.parseInt(ch.dataset.sidx, 10);
        var pcD = ch.dataset.pcidx !== undefined && ch.dataset.pcidx !== '' ? Number.parseInt(ch.dataset.pcidx, 10) : -1;
        var ixD = pcD >= 0 ? Number.parseInt(ch.dataset.icc, 10) : Number.parseInt(ch.dataset.cidx, 10);
        _tbDrag = { kind: 'tbchild', si: siD, pc: pcD, ix: ixD };
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', 'tbchild:' + siD + ':' + pcD + ':' + ixD);
        ch.classList.add('is-dragging');
        return;
      }
      var sec = e.target.closest('.tb-canvas-section');
      if (!sec) return;
      _tbDrag = { kind: 'section', fromIdx: Number.parseInt(sec.dataset.sidx, 10) };
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', 'section:' + sec.dataset.sidx);
      sec.classList.add('is-dragging');
    });

    dropHost.addEventListener('dragover', function (e) {
      e.preventDefault();
      var eff = e.dataTransfer.effectAllowed;
      if (eff === 'move' || eff === 'linkMove') {
        e.dataTransfer.dropEffect = 'move';
      } else {
        e.dataTransfer.dropEffect = 'copy';
      }
      if (!dropHost.contains(e.target)) return;
      tbClearCanvasDropUi();
      if (!_tbDrag) return;

      if (_tbDrag.kind === 'pool' && _tbDrag.poolType === 'section') {
        tbApplySectionDropPreview(canvas, e.clientY, -1);
        return;
      }
      if (_tbDrag.kind === 'section') {
        tbApplySectionDropPreview(canvas, e.clientY, _tbDrag.fromIdx);
        return;
      }
      if (_tbDrag.kind === 'pool' && _tbDrag.poolType === 'chart') {
        var innerP = e.target.closest('.tb-canvas-block-inner');
        var cz = e.target.closest('.tb-canvas-children');
        var sec = e.target.closest('.tb-canvas-section');
        var zone = innerP || cz || (sec?.querySelector('.tb-canvas-children'));
        if (zone) {
          tbApplyChildDropPreview(zone, e.clientY, -1, -1, -1);
        } else {
          var secs = canvas.querySelectorAll('.tb-canvas-section');
          if (secs.length) {
            var lastZ = secs[secs.length - 1].querySelector('.tb-canvas-children');
            if (lastZ) lastZ.classList.add('tb-canvas-children--drop-append');
          } else {
            var ph0 = canvas.querySelector('.tb-canvas-placeholder');
            if (ph0) ph0.classList.add('tb-canvas-placeholder--drop-here');
          }
        }
        return;
      }
      if (_tbDrag.kind === 'tbchild') {
        var innerZ = e.target.closest('.tb-canvas-block-inner');
        var cz2 = e.target.closest('.tb-canvas-children');
        var sec2 = e.target.closest('.tb-canvas-section');
        var zone2 = innerZ || cz2 || (sec2?.querySelector('.tb-canvas-children'));
        if (zone2) {
          tbApplyChildDropPreview(zone2, e.clientY, _tbDrag.si, _tbDrag.pc, _tbDrag.ix);
        }
      }
    });

    dropHost.addEventListener('dragleave', function (e) {
      if (!dropHost.contains(e.relatedTarget)) {
        tbClearCanvasDropUi();
      }
    });

    dropHost.addEventListener('drop', function (e) {
      e.preventDefault();
      tbClearCanvasDropUi();
      _tbDrag = null;

      var data = e.dataTransfer.getData('text/plain') || '';
      var childZone = e.target.closest('.tb-canvas-children');
      var targetSec = e.target.closest('.tb-canvas-section');

      // Reorder / move a chart or chip row on the canvas (section-level or inside layout block)
      if (data.startsWith('tbchild:')) {
        var rest = data.slice(8).split(':');
        var fromSi = Number.parseInt(rest[0], 10);
        var fromPc = -1;
        var fromIx = 0;
        if (rest.length >= 3) {
          fromPc = Number.parseInt(rest[1], 10);
          fromIx = Number.parseInt(rest[2], 10);
        } else {
          fromIx = Number.parseInt(rest[1], 10);
        }
        var srcList = tbGetChildListByParent(fromSi, fromPc);
        if (!srcList || fromIx < 0 || fromIx >= srcList.length) {
          renderBuilderRows();
          return;
        }
        var innerDrop = e.target.closest('.tb-canvas-block-inner');
        var cz = e.target.closest('.tb-canvas-children');
        var ts = e.target.closest('.tb-canvas-section');
        var zone = innerDrop || cz || (ts?.querySelector('.tb-canvas-children'));
        if (!zone) {
          renderBuilderRows();
          return;
        }
        var toSi = Number.parseInt(zone.dataset.sidx, 10);
        var toPc = innerDrop ? Number.parseInt(zone.dataset.pcidx, 10) : -1;
        var ti = tbFindChildInsertBefore(zone, e.clientY);
        var toIx = ti.slot;
        if (Number.isNaN(toIx)) toIx = 0;
        var moved = srcList.splice(fromIx, 1)[0];
        var tgtList = tbGetChildListByParent(toSi, toPc);
        if (!tgtList) {
          srcList.splice(fromIx, 0, moved);
          renderBuilderRows();
          return;
        }
        if (fromSi === toSi && fromPc === toPc && fromIx < toIx) {
          toIx--;
        }
        if (toIx < 0) toIx = 0;
        if (toIx > tgtList.length) toIx = tgtList.length;
        tgtList.splice(toIx, 0, moved);
        renderBuilderRows();
        return;
      }

      // Drop from pool (copy): chart into a section, or add empty section
      if (data.startsWith('pool:')) {
        var parts = data.slice(5).split('|');
        var poolId = parts[0];
        var poolType = parts[1] || 'section';
        var poolSectionId = parts[2] || '';
        if (poolType === 'chart') {
          var innerPool = e.target.closest('.tb-canvas-block-inner');
          if (innerPool) {
            var siIn = Number.parseInt(innerPool.dataset.sidx, 10);
            var pcIn = Number.parseInt(innerPool.dataset.pcidx, 10);
            var listIn = tbGetChildListByParent(siIn, pcIn);
            if (listIn) {
              var tiIn = tbFindChildInsertBefore(innerPool, e.clientY);
              var slotIn = tiIn.slot;
              if (Number.isNaN(slotIn)) slotIn = 0;
              if (slotIn < 0) slotIn = 0;
              if (slotIn > listIn.length) slotIn = listIn.length;
              listIn.splice(slotIn, 0, { id: poolId, span: tbPoolDefaultSpanForChart(regCanvas, poolId) });
            }
            renderBuilderRows();
            return;
          }
          var cz2 = e.target.closest('.tb-canvas-children');
          var ts2 = e.target.closest('.tb-canvas-section');
          var zone2 = cz2 || (ts2?.querySelector('.tb-canvas-children'));
          var sidx = -1;
          var toCi2 = 0;
          if (zone2) {
            sidx = Number.parseInt(zone2.dataset.sidx, 10);
            var ti2 = tbFindChildInsertBefore(zone2, e.clientY);
            toCi2 = ti2.slot;
            if (Number.isNaN(toCi2)) toCi2 = 0;
          } else if (_tbWidgets.length > 0) {
            sidx = _tbWidgets.length - 1;
            var allSecEls = canvas.querySelectorAll('.tb-canvas-section');
            var lastSecEl = allSecEls.length ? allSecEls[allSecEls.length - 1] : null;
            var lz = lastSecEl ? lastSecEl.querySelector('.tb-canvas-children') : null;
            if (lz) {
              var ti3 = tbFindChildInsertBefore(lz, e.clientY);
              toCi2 = ti3.slot;
            } else {
              toCi2 = _tbWidgets[sidx].children ? _tbWidgets[sidx].children.length : 0;
            }
            if (Number.isNaN(toCi2)) toCi2 = 0;
          }
          if (sidx >= 0 && _tbWidgets[sidx]) {
            if (!_tbWidgets[sidx].children) _tbWidgets[sidx].children = [];
            if (toCi2 < 0) toCi2 = 0;
            if (toCi2 > _tbWidgets[sidx].children.length) toCi2 = _tbWidgets[sidx].children.length;
            _tbWidgets[sidx].children.splice(toCi2, 0, { id: poolId, span: tbPoolDefaultSpanForChart(regCanvas, poolId) });
          } else {
            var newSecId = poolSectionId || 'custom';
            _tbWidgets.push({
              id: newSecId,
              span: 12,
              children: [{ id: poolId, span: tbPoolDefaultSpanForChart(regCanvas, poolId) }]
            });
          }
          renderBuilderRows();
          return;
        }
        if (poolType === 'section') {
          var tiS = tbFindSectionInsertBefore(canvas, e.clientY);
          var insS = tiS.slot;
          _tbWidgets.splice(insS, 0, { id: poolId, span: 12, children: [] });
        }
        renderBuilderRows();
        return;
      }

      // Reorder sections within canvas
      if (data.startsWith('section:')) {
        var fromIdx = Number.parseInt(data.slice(8), 10);
        if (fromIdx < 0 || fromIdx >= _tbWidgets.length) {
          renderBuilderRows();
          return;
        }
        var tiM = tbFindSectionInsertBefore(canvas, e.clientY);
        if (tiM.slot === fromIdx || tiM.slot === fromIdx + 1) {
          renderBuilderRows();
          return;
        }
        var item = _tbWidgets.splice(fromIdx, 1)[0];
        var insM = tiM.slot;
        if (fromIdx < insM) insM--;
        _tbWidgets.splice(insM, 0, item);
        renderBuilderRows();
      }
    });

    canvas.addEventListener('dragend', function () {
      _tbDrag = null;
      tbClearCanvasDropUi();
      var marks = canvas.querySelectorAll('.is-dragging');
      for (var mk of marks) mk.classList.remove('is-dragging');
    });

    // Resize section
    var _resizeTarget = null;
    var _resizeStartX = 0;
    var _resizeStartSpan = 0;
    var _colWidth = 0;

    canvas.addEventListener('mousedown', function (e) {
      var handle = e.target.closest('.tb-canvas-resize');
      var childHandle = e.target.closest('.tb-canvas-child-resize');
      if (childHandle) {
        var si = Number.parseInt(childHandle.dataset.sidx, 10);
        if (childHandle.dataset.pcidx !== undefined && childHandle.dataset.pcidx !== '') {
          var pcH = Number.parseInt(childHandle.dataset.pcidx, 10);
          var ixH = Number.parseInt(childHandle.dataset.icc, 10);
          _resizeTarget = { type: 'childInner', si: si, pc: pcH, ix: ixH, maxSpan: 12 };
          var blkH = _tbWidgets[si]?.children?.[pcH];
          var rowH = blkH?.children?.[ixH];
          _resizeStartSpan = rowH ? rowH.span : 6;
        } else {
          var ci = Number.parseInt(childHandle.dataset.cidx, 10);
          _resizeTarget = { type: 'child', si: si, ci: ci };
          _resizeStartSpan = (_tbWidgets[si]?.children?.[ci]) ? _tbWidgets[si].children[ci].span : 6;
        }
        var childGrid = childHandle.closest('.tb-canvas-block-inner') || childHandle.closest('.tb-canvas-children');
        var gridCols = 12;
        if (childGrid?.classList.contains('tb-canvas-block-inner')) {
          var icd = Number.parseInt(childGrid.getAttribute('data-inner-cols'), 10);
          if (!Number.isNaN(icd) && icd >= 1 && icd <= 12) gridCols = icd;
        }
        _colWidth = childGrid ? childGrid.offsetWidth / gridCols : canvas.offsetWidth / 12;
        if (_resizeTarget.type === 'childInner') _resizeTarget.maxSpan = gridCols;
      } else if (handle) {
        var idx = Number.parseInt(handle.dataset.sidx, 10);
        _resizeTarget = { type: 'section', si: idx };
        _resizeStartSpan = _tbWidgets[idx] ? _tbWidgets[idx].span : 12;
        _colWidth = canvas.offsetWidth / 12;
      } else {
        return;
      }
      e.preventDefault();
      _resizeStartX = e.clientX;
      document.body.classList.add('tb-resizing');
    });

    window.addEventListener('mousemove', function (e) {
      if (!_resizeTarget || !_colWidth) return;
      var dx = e.clientX - _resizeStartX;
      var colDelta = Math.round(dx / _colWidth);
      var maxSpanClamp = 12;
      if (_resizeTarget.type === 'childInner' && _resizeTarget.maxSpan) maxSpanClamp = _resizeTarget.maxSpan;
      var newSpan = Math.max(1, Math.min(maxSpanClamp, _resizeStartSpan + colDelta));
      if (_resizeTarget.type === 'section') {
        if (_tbWidgets[_resizeTarget.si] && _tbWidgets[_resizeTarget.si].span !== newSpan) {
          _tbWidgets[_resizeTarget.si].span = newSpan;
          renderCanvas();
        }
      } else if (_resizeTarget.type === 'childInner') {
        var chI = _tbWidgets[_resizeTarget.si]?.children;
        var blkI = chI?.[_resizeTarget.pc];
        var rowI = blkI?.children?.[_resizeTarget.ix];
        if (rowI && rowI.span !== newSpan) {
          rowI.span = newSpan;
          renderCanvas();
        }
      } else {
        var ch = _tbWidgets[_resizeTarget.si]?.children;
        if (ch?.[_resizeTarget.ci] && ch[_resizeTarget.ci].span !== newSpan) {
          ch[_resizeTarget.ci].span = newSpan;
          renderCanvas();
        }
      }
    });

    window.addEventListener('mouseup', function () {
      if (_resizeTarget) {
        _resizeTarget = null;
        document.body.classList.remove('tb-resizing');
        renderPool();
      }
    });
  }

  function bindPoolEvents() {
    var host = document.getElementById('tb-body');
    if (!host || host.dataset.tbPoolBound) return;
    host.dataset.tbPoolBound = '1';

    // Click: sections add to canvas, charts add to last section (or first); meta chips add layout section + default charts
    host.addEventListener('click', function (e) {
      var chip = e.target.closest('.tb-pool-chip');
      if (!chip || chip.classList.contains('is-used')) return;

      if (chip.classList.contains('tb-pool-chip--meta')) {
        var poolSec = chip.dataset.poolSection;
        var regM = getRegistry();
        if (!poolSec || !regM) return;
        var gsM = regM.findSection(poolSec);
        if (!gsM) return;
        var layoutSecId = gsM.parentSection || poolSec;
        var newKids = tbMetaDefaultChartChildren(regM, gsM);
        var wi = -1;
        for (var wj = 0; wj < _tbWidgets.length; wj++) {
          if (_tbWidgets[wj].id === layoutSecId) {
            wi = wj;
            break;
          }
        }
        if (wi >= 0) {
          if (!_tbWidgets[wi].children) _tbWidgets[wi].children = [];
          var seenC = {};
          var zk;
          for (zk = 0; zk < _tbWidgets[wi].children.length; zk++) {
            var rowEnt = _tbWidgets[wi].children[zk];
            if (tbIsLayoutBlock(rowEnt)) {
              var zc = rowEnt.children || [];
              var zi;
              for (zi = 0; zi < zc.length; zi++) {
                if (zc[zi].id) seenC[zc[zi].id] = true;
              }
            } else if (rowEnt.id) {
              seenC[rowEnt.id] = true;
            }
          }
          var lastBlk = null;
          for (zk = _tbWidgets[wi].children.length - 1; zk >= 0; zk--) {
            if (tbIsLayoutBlock(_tbWidgets[wi].children[zk])) {
              lastBlk = _tbWidgets[wi].children[zk];
              break;
            }
          }
          var targetList = lastBlk ? (lastBlk.children || (lastBlk.children = [])) : _tbWidgets[wi].children;
          for (var nk of newKids) {
            if (!seenC[nk.id]) {
              targetList.push(nk);
              seenC[nk.id] = true;
            }
          }
        } else {
          _tbWidgets.push({ id: layoutSecId, span: 12, children: newKids });
        }
        renderBuilderRows();
        return;
      }

      var id = chip.dataset.poolId;
      var type = chip.dataset.poolType || 'section';
      if (type === 'section') {
        _tbWidgets.push({ id: id, span: 12, children: [] });
      } else {
        var regPoolClick = getRegistry();
        var dropSp = tbPoolDefaultSpanForChart(regPoolClick, id);
        // Add chart to last section, or create one
        if (!_tbWidgets.length) {
          var secId = chip.dataset.poolSection || 'custom';
          _tbWidgets.push({ id: secId, span: 12, children: [] });
        }
        var last = _tbWidgets[_tbWidgets.length - 1];
        if (!last.children) last.children = [];
        var blkLast = null;
        var qq;
        for (qq = last.children.length - 1; qq >= 0; qq--) {
          if (tbIsLayoutBlock(last.children[qq])) {
            blkLast = last.children[qq];
            break;
          }
        }
        if (blkLast) {
          if (!blkLast.children) blkLast.children = [];
          blkLast.children.push({ id: id, span: dropSp });
        } else {
          last.children.push({ id: id, span: dropSp });
        }
      }
      renderBuilderRows();
    });

    host.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      var meta = e.target.closest('.tb-pool-chip--meta');
      if (!meta || meta.classList.contains('is-used')) return;
      e.preventDefault();
      meta.click();
    });

    // Drag from pool
    host.addEventListener('dragstart', function (e) {
      var chip = e.target.closest('.tb-pool-chip');
      if (!chip) return;
      if (chip.classList.contains('is-used') || chip.classList.contains('tb-pool-chip--meta')) {
        e.preventDefault();
        return;
      }
      _tbDrag = {
        kind: 'pool',
        poolId: chip.dataset.poolId,
        poolType: chip.dataset.poolType || 'section',
        poolSection: chip.dataset.poolSection || ''
      };
      e.dataTransfer.effectAllowed = 'copyMove';
      e.dataTransfer.setData('text/plain', 'pool:' + chip.dataset.poolId + '|' + (chip.dataset.poolType || 'section') + '|' + (chip.dataset.poolSection || ''));
    });

    host.addEventListener('dragend', function () {
      _tbDrag = null;
      tbClearCanvasDropUi();
    });
  }

  /** ECharts canvas chart (not chip / HTML) — gets clone-or-render preview path. */
  function tbPreviewIsCanvasChart(def) {
    return !!(def?.engine === 'echarts' && def?.kind !== 'chip');
  }

  /** KPI / HTML / table: clone live DOM from #canvasId so preview matches dashboard chips. */
  /** Adapt cloned KPI chip grids to preview container width (simulates @media breakpoints). */
  function tbPreviewAdaptChipGrid(pvEl) {
    var w = pvEl.offsetWidth || 0;
    if (!w) return;
    // Grid selectors and their column rules at various widths
    var gridSels = ['.grid', '.health-grid', '.key-findings-grid'];
    for (var gSel of gridSels) {
      var grids = pvEl.querySelectorAll(gSel);
      for (var g of grids) {
        var isHealth = gSel === '.health-grid';
        var cols;
        if (w > 580) cols = isHealth ? 3 : 6;
        else if (w > 400) cols = isHealth ? 2 : 4;
        else if (w > 250) cols = isHealth ? 2 : 3;
        else if (w > 150) cols = 2;
        else cols = 1;
        g.style.gridTemplateColumns = 'repeat(' + cols + ', minmax(0, 1fr))';
      }
    }
    // Font scaling for narrow containers
    if (w < 300) {
      var vals = pvEl.querySelectorAll('.value, .health-badge-value');
      for (var val of vals) val.style.fontSize = '0.85rem';
      var labs = pvEl.querySelectorAll('.label, .health-badge-label');
      for (var lab of labs) lab.style.fontSize = '0.6rem';
      var subs = pvEl.querySelectorAll('.sub, .health-badge-sub');
      for (var sub of subs) sub.style.fontSize = '0.6rem';
    }
  }

  /** Map widgetGroup → live DOM container that holds all chips of that group. */
  var _chipGroupContainers = {
    'health-kpis': 'health-score',
    'kernbefunde': 'key-findings',
    'token-stats-kpis': 'cards'
  };

  function tbPreviewCloneHtmlMeta(slot) {
    var pvEl = document.getElementById(slot.pvId);
    if (!pvEl || !slot.def) return;
    var def = slot.def;
    pvEl.innerHTML = '';
    pvEl.style.width = '100%';
    pvEl.style.height = 'auto';
    pvEl.style.minHeight = '0';
    var origEl = def.canvasId ? document.getElementById(def.canvasId) : null;
    console.debug('[preview-clone] canvasId=%s found=%s group=%s', def.canvasId, !!origEl, def.widgetGroup || '-');
    // If individual chip not found, try cloning the whole group container
    if (!origEl && def.widgetGroup && _chipGroupContainers[def.widgetGroup]) {
      // Only clone the group once — skip if this pvEl's section already has a group clone
      var secBody = pvEl.closest('.tb-pv-section-body') || pvEl.closest('.tb-pv-layout-charts');
      if (secBody?.querySelector('[data-tb-group-clone="' + def.widgetGroup + '"]')) {
        pvEl.style.display = 'none';
        return;
      }
      var groupEl = document.getElementById(_chipGroupContainers[def.widgetGroup]);
      if (groupEl?.children.length) {
        origEl = groupEl;
      }
    }
    if (origEl) {
      var clone = origEl.cloneNode(true);
      clone.removeAttribute('id');
      clone.setAttribute('data-tb-preview-clone', '1');
      if (def.widgetGroup && _chipGroupContainers[def.widgetGroup]) {
        clone.dataset.tbGroupClone = def.widgetGroup;
      }
      var walk = clone.querySelectorAll('[id]');
      var wi;
      for (wi = 0; wi < walk.length; wi++) {
        walk[wi].removeAttribute('id');
      }
      pvEl.appendChild(clone);
      tbPreviewAdaptChipGrid(pvEl);
      return;
    }
    pvEl.innerHTML =
      '<div class="tb-pv-meta-fallback">' + escT(_t('tbPreviewNotRendered')) + '</div>';
  }

  /** Preview one builder slot: ECharts clone/render or HTML/chip clone. */
  function tbPreviewRenderSlot(slot) {
    if (!slot?.def) return;
    if (tbPreviewIsCanvasChart(slot.def)) {
      tbPreviewCloneOrRender(slot);
    } else {
      tbPreviewCloneHtmlMeta(slot);
    }
  }

  /** Preview: clone live ECharts option, or temp-ID-swap and invoke the chart renderFn. */
  function tbPreviewCloneOrRender(slot) {
    var pvEl = document.getElementById(slot.pvId);
    if (!pvEl || typeof echarts === 'undefined') return;
    var def = slot.def;
    if (!def?.canvasId) return;

    var origEl = document.getElementById(def.canvasId);
    var origInst = origEl ? echarts.getInstanceByDom(origEl) : null;
    if (origInst) {
      try {
        var ex0 = echarts.getInstanceByDom(pvEl);
        if (ex0) ex0.dispose();
        var inst0 = echarts.init(pvEl, null, { renderer: 'canvas' });
        var opts0 = origInst.getOption();
        if (opts0) inst0.setOption(opts0, true);
      } catch (error) { /* intentional */ }
      return;
    }

    var rfName = def.renderFn;
    var rf = rfName && global[rfName];
    if (typeof rf !== 'function') return;

    var realEl = origEl;
    var stashed = false;
    var realOldId = '';
    if (realEl && realEl !== pvEl) {
      realOldId = realEl.id;
      realEl.id = '__tb_pv_stash_' + def.canvasId;
      stashed = true;
    }
    var pvOldId = pvEl.id;
    pvEl.id = def.canvasId;

    function restoreIds() {
      pvEl.id = pvOldId;
      if (stashed && realEl) realEl.id = realOldId;
    }

    try {
      try {
        var ex1 = echarts.getInstanceByDom(pvEl);
        if (ex1) ex1.dispose();
      } catch (error) { /* intentional */ }

      if (String(rfName).startsWith('renderProxy_')) {
        var dataP = global.__lastUsageData;
        if (dataP && typeof global._computeProxyCtx === 'function') global._computeProxyCtx(dataP);
        if (global.__sectionCtx_proxy) rf(global.__sectionCtx_proxy);
      } else if (rfName === 'renderIntel_seasonality') {
        rf();
      } else if (String(rfName).startsWith('renderStatus_')) {
        rf();
      } else if (String(rfName).startsWith('renderForensic_')) {
        var fctx = global.__sectionCtx_forensic;
        if (fctx) rf(fctx);
      } else if (String(rfName).startsWith('renderUserProfile_')) {
        var uctx = global.__sectionCtx_userProfile;
        if (uctx) rf(uctx);
      } else if (String(rfName).startsWith('renderBudget_')) {
        var bctx = global.__sectionCtx_budget;
        if (!bctx && global.__lastUsageData && typeof global._computeBudgetCtx === 'function') {
          bctx = global._computeBudgetCtx(global.__lastUsageData);
        }
        if (bctx) rf(bctx);
      } else if (
        rfName === 'renderWasteCurve' ||
        rfName === 'renderCacheExplosion' ||
        rfName === 'renderBudgetDrain' ||
        rfName === 'renderEfficiencyTimeline' ||
        rfName === 'renderMonthlyButterfly' ||
        rfName === 'renderDayComparison'
      ) {
        var uDataE = global.__lastUsageData;
        var eDaysE = [];
        if (uDataE?.days?.length) {
          eDaysE =
            typeof global.getFilteredDays === 'function'
              ? global.getFilteredDays(uDataE.days)
              : uDataE.days.slice();
        }
        var stEcon = global._econData;
        if (rfName === 'renderMonthlyButterfly') {
          rf(eDaysE);
        } else if (rfName === 'renderDayComparison') {
          rf(eDaysE);
        } else if (rfName === 'renderEfficiencyTimeline') {
          if (stEcon) rf(stEcon);
        } else if (rfName === 'renderBudgetDrain') {
          if (stEcon) rf(stEcon, global._econQdData || undefined);
        } else if (rfName === 'renderWasteCurve' || rfName === 'renderCacheExplosion') {
          var sessEl = document.getElementById('econ-session-picker');
          var selV = sessEl ? sessEl.value : '';
          var sessE = null;
          if (stEcon && typeof global.findSession === 'function') {
            sessE = global.findSession(stEcon, selV);
          }
          if (sessE) rf(sessE);
        }
      }
    } finally {
      restoreIds();
    }
  }

  function saveTemplateFromBuilder() {
    var nameInput = document.getElementById('tb-name-input');
    var name = nameInput ? nameInput.value.trim() : '';
    if (!name) {
      name = prompt(_t('tbNamePrompt'));
      if (!name?.trim()) return;
      name = name.trim();
    }
    // Flatten nested model back to v3 format (only ECharts canvas rows: chips stay in section DOM / hiddenCharts)
    var flatW = [];
    var regSv = getRegistry();
    for (var tbSec of _tbWidgets) {
      flatW.push({ id: tbSec.id, span: tbSec.span || 12 });
      var ch = tbSec.children || [];
      for (var ci = 0; ci < ch.length; ci++) {
        var chEnt = ch[ci];
        if (tbIsLayoutBlock(chEnt)) {
          var nestedOut = [];
          var innSv = chEnt.children || [];
          for (var innItem of innSv) {
            var idef = regSv?.findChart ? regSv.findChart(innItem.id) : null;
            if (idef && (idef.kind === 'chip' || idef.engine !== 'echarts')) continue;
            nestedOut.push({ id: innItem.id, span: innItem.span || 6 });
          }
          // Skip empty layout blocks (chips-only rows)
          if (nestedOut.length) {
            flatW.push({
              type: 'layout',
              span: chEnt.span || 12,
              section: tbSec.id,
              bid: chEnt.bid || chEnt.id || 'tbblk_s' + ci,
              nested: nestedOut
            });
          }
          continue;
        }
        var cdef = regSv?.findChart ? regSv.findChart(chEnt.id) : null;
        if (cdef && (cdef.kind === 'chip' || cdef.engine !== 'echarts')) continue;
        flatW.push({ id: chEnt.id, span: chEnt.span || 6, type: 'chart', section: tbSec.id });
      }
    }
    var tpl = { name: name, version: 3, widgets: flatW };
    var userTpls = loadTemplates();
    var found = false;
    for (var i = 0; i < userTpls.length; i++) {
      if (userTpls[i].name === name) {
        userTpls[i] = tpl;
        found = true;
        break;
      }
    }
    if (!found) userTpls.push(tpl);
    saveTemplates(userTpls);
    applyTemplate(tpl);
    renderTemplatesSection();
    closeTemplateBuilder();
  }

  function openBuilderPreview() {
    var overlay = document.getElementById('tb-preview-overlay');
    var body = document.getElementById('tb-preview-body');
    if (!overlay || !body) return;
    var reg = getRegistry();
    if (!reg) return;

    // Build DOM with real chart containers
    var html = '<div class="tb-pv-grid">';
    var chartSlots = []; // {chartDef, domId} to render after innerHTML
    for (var pvSec of _tbWidgets) {
      var secDef = reg.findSection(pvSec.id);
      var secName = secDef ? _t(secDef.titleKey) : pvSec.id;
      html += '<div class="tb-pv-section" style="grid-column:span ' + (pvSec.span || 12) + '">';
      html += '<div class="tb-pv-section-head">' + secName + ' <span style="opacity:.4;font-weight:400">(' + (pvSec.span || 12) + '/12)</span></div>';
      html += '<div class="tb-pv-section-body">';
      var children = pvSec.children || [];
      if (children.length) {
        for (var ci = 0; ci < children.length; ci++) {
          var c = children[ci];
          if (tbIsLayoutBlock(c)) {
            var bspPv = c.span || 12;
            if (bspPv < 1) bspPv = 1;
            if (bspPv > 12) bspPv = 12;
            html +=
              '<div class="tb-pv-layout" style="grid-column:span ' +
              bspPv +
              ';min-width:0;max-width:100%"><div class="tb-pv-layout-inner">' +
              escT(_t('tbLayoutBlockLabel')) +
              ' ' +
              String(bspPv) +
              '/12</div><div class="tb-pv-layout-charts" data-inner-cols="' +
              bspPv +
              '" style="grid-template-columns:repeat(' +
              bspPv +
              ',minmax(0,1fr))">';
            var inPv = c.children || [];
            var pi;
            for (pi = 0; pi < inPv.length; pi++) {
              var icp = inPv[pi];
              var chDefIn = reg.findChart(icp.id);
              var pvIdIn = 'tb-pv-' + pvSec.id + '-' + icp.id + '-b' + ci + '-' + pi;
              var isCanvasIn = tbPreviewIsCanvasChart(chDefIn);
              var icSpPv = icp.span || 6;
              if (icSpPv < 1) icSpPv = 1;
              if (icSpPv > bspPv) icSpPv = bspPv;
              // At narrow section spans, force meta chips to full block width
              if (!isCanvasIn && (pvSec.span || 12) <= 6) icSpPv = bspPv;
              html +=
                '<div class="tb-pv-chart' +
                (isCanvasIn ? '' : ' tb-pv-chart--meta') +
                '" style="grid-column:span ' +
                icSpPv +
                '">';
              // chart label omitted — breaks layout at narrow spans
              html +=
                '<div class="tb-pv-chart-container' +
                (isCanvasIn ? '' : ' tb-pv-chart-container--html') +
                '" id="' +
                pvIdIn +
                '" style="width:100%;' +
                (isCanvasIn ? 'height:200px' : 'height:auto') +
                '"></div>';
              html += '</div>';
              if (chDefIn) chartSlots.push({ def: chDefIn, pvId: pvIdIn });
            }
            html += '</div></div>';
            continue;
          }
          var chDef = reg.findChart(c.id);
          var pvId = 'tb-pv-' + pvSec.id + '-' + c.id;
          var isCanvas = tbPreviewIsCanvasChart(chDef);
          var directSpan = c.span || 6;
          // At narrow section spans, force meta chips to full width
          if (!isCanvas && (pvSec.span || 12) <= 6) directSpan = 12;
          html +=
            '<div class="tb-pv-chart' +
            (isCanvas ? '' : ' tb-pv-chart--meta') +
            '" style="grid-column:span ' +
            directSpan +
            '">';
          // chart label omitted — breaks layout at narrow spans
          html +=
            '<div class="tb-pv-chart-container' +
            (isCanvas ? '' : ' tb-pv-chart-container--html') +
            '" id="' +
            pvId +
            '" style="width:100%;' +
            (isCanvas ? 'height:200px' : 'height:auto') +
            '"></div>';
          html += '</div>';
          if (chDef) chartSlots.push({ def: chDef, pvId: pvId });
        }
      } else {
        html += '<div style="grid-column:span 12;text-align:center;color:#475569;font-size:.65rem;padding:12px">(' + _t('tbNoCharts') + ')</div>';
      }
      html += '</div></div>';
    }
    html += '</div>';
    body.innerHTML = html;
    overlay.classList.add('is-open');

    // Render charts after DOM is ready (clone live options or paint via renderFn + temp id swap)
    setTimeout(function () {
      for (var slot of chartSlots) {
        tbPreviewRenderSlot(slot);
      }
      // Adapt all cloned KPI chip grids to their actual container width
      var pvSections = body.querySelectorAll('.tb-pv-section');
      for (var pvs of pvSections) {
        var metaEls = pvs.querySelectorAll('.tb-pv-chart-container--html');
        for (var metaEl of metaEls) {
          tbPreviewAdaptChipGrid(metaEl);
        }
      }
    }, 150);
  }

  function closeBuilderPreview() {
    var overlay = document.getElementById('tb-preview-overlay');
    var body = document.getElementById('tb-preview-body');
    if (overlay) overlay.classList.remove('is-open');
    // Dispose ECharts instances to free memory
    if (body && typeof echarts !== 'undefined') {
      var containers = body.querySelectorAll('.tb-pv-chart-container');
      for (var ctr of containers) {
        var inst = echarts.getInstanceByDom(ctr);
        if (inst) try { inst.dispose(); } catch (error) { /* intentional */ }
      }
    }
    // Preview may have repainted via temp canvas id swap — repaint core charts without full-page coalesce.
    if (typeof global.renderDashboardCore === 'function' && global.__lastUsageData) {
      try { global.renderDashboardCore(global.__lastUsageData); } catch (error) { /* intentional */ }
    }
  }

  function bindTemplateBuilder() {
    var buildBtn = document.getElementById('sidebar-build-template');
    // Template Builder only in DEV_MODE
    if (buildBtn && !buildBtn.dataset.bound) {
      buildBtn.dataset.bound = '1';
      buildBtn.style.display = '';
      buildBtn.textContent = _t('tbBuild');
      buildBtn.addEventListener('click', function () { openTemplateBuilder(); });
    }
    var saveBtn = document.getElementById('tb-save');
    if (saveBtn && !saveBtn.dataset.bound) {
      saveBtn.dataset.bound = '1';
      saveBtn.addEventListener('click', saveTemplateFromBuilder);
    }
    var closeBtn = document.getElementById('tb-close');
    if (closeBtn && !closeBtn.dataset.bound) {
      closeBtn.dataset.bound = '1';
      closeBtn.addEventListener('click', closeTemplateBuilder);
    }
    var overlay = document.getElementById('tb-overlay');
    if (overlay && !overlay.dataset.bound) {
      overlay.dataset.bound = '1';
      overlay.addEventListener('click', function (e) {
        if (e.target === overlay) closeTemplateBuilder();
      });
    }
    var loadDefBtn = document.getElementById('tb-load-default');
    if (loadDefBtn && !loadDefBtn.dataset.bound) {
      loadDefBtn.dataset.bound = '1';
      loadDefBtn.textContent = _t('tbLoadDefault');
      loadDefBtn.addEventListener('click', tbLoadDefaultIntoBuilder);
    }
    var tplSelect = document.getElementById('tb-template-select');
    if (tplSelect && !tplSelect.dataset.bound) {
      tplSelect.dataset.bound = '1';
      tplSelect.addEventListener('change', function () {
        var val = tplSelect.value;
        if (!val) return;
        var all = getAllTemplates();
        for (var tplSel of all) {
          if (tplSel.name === val) {
            var tpl = tplSel;
            _tbWidgets = tbLoadTemplateIntoBuilder(tpl);
            var nameInput = document.getElementById('tb-name-input');
            if (nameInput) nameInput.value = tpl.builtin ? '' : (tpl.name || '');
            renderBuilderRows();
            break;
          }
        }
      });
    }
    var previewBtn = document.getElementById('tb-preview');
    if (previewBtn && !previewBtn.dataset.bound) {
      previewBtn.dataset.bound = '1';
      previewBtn.addEventListener('click', openBuilderPreview);
    }
    var pvCloseBtn = document.getElementById('tb-preview-close');
    if (pvCloseBtn && !pvCloseBtn.dataset.bound) {
      pvCloseBtn.dataset.bound = '1';
      pvCloseBtn.addEventListener('click', closeBuilderPreview);
    }
    var pvOverlay = document.getElementById('tb-preview-overlay');
    if (pvOverlay && !pvOverlay.dataset.bound) {
      pvOverlay.dataset.bound = '1';
      pvOverlay.addEventListener('click', function (e) {
        if (e.target === pvOverlay) closeBuilderPreview();
      });
    }
    bindCanvasEvents();
    bindPoolEvents();
  }

  function renderExportSection() {
    // Export buttons are already in HTML, just add click handlers
    var jsonlBtn = document.getElementById('sidebar-export-jsonl');
    if (jsonlBtn && !jsonlBtn.dataset.bound) {
      jsonlBtn.dataset.bound = '1';
      jsonlBtn.addEventListener('click', function () {
        // JSONL export — trigger download of cached data
        var data = global.__lastUsageData;
        if (!data) return;
        var blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url;
        a.download = 'claude-usage-' + new Date().toISOString().slice(0, 10) + '.json';
        a.click();
        URL.revokeObjectURL(url);
      });
    }
    var templateExBtn = document.getElementById('sidebar-export-template');
    if (templateExBtn && !templateExBtn.dataset.bound) {
      templateExBtn.dataset.bound = '1';
      templateExBtn.addEventListener('click', function () {
        var prefs = getPrefs();
        var blob = new Blob([JSON.stringify(prefs, null, 2)], { type: 'application/json' });
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url;
        a.download = 'cud-layout-' + new Date().toISOString().slice(0, 10) + '.json';
        a.click();
        URL.revokeObjectURL(url);
      });
    }
    var templateImBtn = document.getElementById('sidebar-import-template');
    if (templateImBtn && !templateImBtn.dataset.bound) {
      templateImBtn.dataset.bound = '1';
      templateImBtn.addEventListener('click', function () {
        var input = document.createElement('input');
        input.type = 'file';
        input.accept = '.json';
        input.addEventListener('change', function () {
          if (!this.files?.[0]) return;
          var reader = new FileReader();
          reader.onload = function (ev) {
            try {
              var imported = JSON.parse(ev.target.result);
              var okImp = tryAcceptPrefsPayload(imported);
              if (okImp) {
                _prefs = okImp;
                migrateHiddenChartsLegacy();
                if (!_prefs.widgets && _prefs.order) {
                  var mig = migrateTemplateV1toV2({ order: _prefs.order, hiddenSections: _prefs.hiddenSections });
                  _prefs.widgets = mig.widgets;
                }
                if (_prefs.widgets?.length) {
                  syncPrefsOrderFromWidgets();
                }
                savePrefs();
                applyGridLayout();
                expandVisibleSectionPanels();
                applyVisibility();
                applyAllChartVisibility();
                renderWidgetTree();
                setTimeout(function () {
                  resizeAll();
                }, 280);
              }
            } catch (e) { /* invalid JSON */ }
          };
          reader.readAsText(this.files[0]);
        });
        input.click();
      });
    }
  }

  // ── i18n helper (safe fallback) ─────────────────────────────────

  function _t(key) {
    // Try dashboard.client.js t() first
    if (typeof global.t === 'function') return global.t(key);
    // Fallback: read directly from inline i18n bundles
    var bundles = global.__I18N_BUNDLES;
    if (bundles) {
      var lang = document.documentElement.lang || 'en';
      var o = bundles[lang] || bundles.en || {};
      if (o[key] !== undefined && o[key] !== '') return o[key];
      var en = bundles.en || {};
      if (en[key] !== undefined) return en[key];
    }
    return key;
  }

  // ── Enhanced Init ───────────────────────────────────────────────

  function initFull() {
    init();
    bindSidebarEvents();
    // Sidebar title + section titles via i18n (set once DOM is ready)
    var titleEl = document.getElementById('sidebar-title');
    if (titleEl) titleEl.textContent = _t('settingsTitle');
    var titles = {
      'sidebar-layout-title': 'settingsLayoutTitle',
      'sidebar-templates-title': 'settingsTemplatesTitle',
      'sidebar-settings-title': 'settingsSettingsTitle',
      'sidebar-tools-title': 'settingsToolsTitle',
      'sidebar-open-explorer': 'settingsOpenExplorer',
      'sidebar-export-title': 'settingsExportTitle',
      'sidebar-layout-edit': 'settingsEditLayout',
      'sidebar-layout-reset': 'settingsResetLayout',
      'sidebar-export-jsonl': 'settingsExportJsonl',
      'sidebar-export-template': 'settingsExportTemplate',
      'sidebar-import-template': 'settingsImportTemplate',
      'settings-nav-btn': 'settingsBtnTitle',
      'sidebar-open-user-settings': 'settingsUserSettings',
      'sidebar-build-template': 'tbBuild'
    };
    for (var id in titles) {
      var el = document.getElementById(id);
      if (el) {
        if (el.tagName === 'BUTTON' && id === 'settings-nav-btn') el.title = _t(titles[id]);
        else el.textContent = _t(titles[id]);
      }
    }
    // Filter bar toggle
    var filterBtn = document.getElementById('filter-toggle-btn');
    var filterBar = document.getElementById('filter-bar');
    if (filterBtn && filterBar && !filterBtn.dataset.bound) {
      filterBtn.dataset.bound = '1';
      filterBtn.textContent = _t('filterToggle');
      filterBtn.addEventListener('click', function () {
        filterBar.classList.toggle('is-open');
        filterBtn.classList.toggle('is-active');
      });
    }
    // Bind template builder (modal buttons + sidebar button)
    bindTemplateBuilder();
    // Edit layout: Bearbeiten -> Speichern while editing; Save persists and exits edit mode
    var editBtn = document.getElementById('sidebar-layout-edit');
    if (editBtn && !editBtn.dataset.bound) {
      editBtn.dataset.bound = '1';
      editBtn.addEventListener('click', function () {
        var tree = document.querySelector('.widget-tree');
        if (!tree) return;
        var wasEdit = tree.classList.contains('widget-tree--edit');
        var secLis = tree.querySelectorAll(':scope > li.widget-tree-item[data-section]');
        var si;
        if (wasEdit) {
          savePrefs();
          _layoutTreeEditMode = false;
          tree.classList.remove('widget-tree--edit');
          editBtn.classList.remove('is-active');
          editBtn.textContent = _t('settingsEditLayout');
          for (si = 0; si < secLis.length; si++) secLis[si].setAttribute('draggable', 'false');
        } else {
          _layoutTreeEditMode = true;
          tree.classList.add('widget-tree--edit');
          editBtn.classList.add('is-active');
          editBtn.textContent = _t('settingsSaveLayout');
          for (si = 0; si < secLis.length; si++) secLis[si].setAttribute('draggable', 'true');
        }
        applyWidgetTreeCheckboxLock(tree, _layoutTreeEditMode);
      });
    }
    // Version — set immediately from inline global
    var verEl = document.getElementById('sidebar-version');
    if (verEl && global.__APP_VERSION) {
      verEl.textContent = global.__APP_VERSION;
    }
    // Release Notes button
    var relBtn = document.getElementById('sidebar-release-btn');
    if (relBtn && !relBtn.dataset.bound) {
      relBtn.dataset.bound = '1';
      relBtn.addEventListener('click', function () {
        var origBtn = document.getElementById('live-rel-expand-btn');
        if (origBtn) origBtn.click();
      });
    }
  }

  /**
   * Static model of the real desktop page shell (tpl/dashboard.html + dashboard.css).
   * Only #layout-grid is a 12-column CSS grid for top-level rows; inner blocks use 2/3-col grids, flex, or auto-fit.
   * Template builder can use this to document or mirror structure instead of assuming everything is 12-col.
   */
  function tbGetDesktopPageScaffold() {
    var topChromePipe =
      'body > header.top-bar[flex] | body > div#filter-bar.filter-bar[collapsible]';
    var layoutRoot = '#layout-grid.layout-grid';
    var layoutGridPipe =
      layoutRoot +
      '[css:grid;12×1fr;gap row/col;children use data-span 1–12;@media max900px → each child span 12]';
    var sections = [
      {
        id: 'health-collapse',
        tag: 'details',
        summaryClass: 'health-collapse-summary',
        innerPipe:
          'div.health-collapse-inner stacked: (1) div#health-score > div#health-grid[3-col KPI chips; 900→2;520→1] (2) div#key-findings > div#key-findings-grid[responsive 6→4→3→2→1 col; minmax(0,1fr)]'
      },
      {
        id: 'forensic-collapse',
        tag: 'details',
        innerPipe:
          'div.forensic-inner > div#forensic-cards.grid[3→2→1 col minmax(0,1fr)] + div#forensic-charts-stack > (details.forensic-chart-disclosure > …) + div.forensic-charts-pair[grid 2×1fr;720→1col]'
      },
      {
        id: 'economic-collapse',
        tag: 'details',
        innerPipe:
          'div.forensic-inner > div.forensic-charts-stack > flex-rows (inline flex 1:2 waste/explosion) + flex drain + details#econ-range-collapse (inner flex triple charts)'
      },
      {
        id: 'report-modal-overlay',
        tag: 'div',
        innerPipe: 'modal overlay (fixed-style panel; not a chart grid)'
      },
      { id: 'day-picker-row', tag: 'div', innerPipe: 'row controls' },
      { id: 'main-charts-scope-wrap', tag: 'div', innerPipe: 'hidden scope chips (display none in css)' },
      {
        id: 'token-stats-collapse',
        tag: 'details',
        innerPipe:
          'div.forensic-inner > div#cards.grid[KPI 6→4→3→2→1 col] + div#main-charts-wrap > div#charts.charts[2 or 3 col] + div#charts-host-sub.charts-pair[3 col / 2 if no-host] + div#token-stats-daily-detail.chart-box'
      },
      {
        id: 'user-profile-collapse',
        tag: 'details',
        innerPipe: 'div.forensic-inner > div#user-profile-charts.charts.has-session-row[3×1fr responsive]'
      },
      {
        id: 'budget-collapse',
        tag: 'details',
        innerPipe:
          'div.forensic-inner > #budget-cards.grid[6→4→3→2→1 col] + details budget-sankey + div#budget-trend-row.charts[2 col]'
      },
      {
        id: 'proxy-collapse',
        tag: 'details',
        innerPipe:
          'div.forensic-inner.proxy-inner > #proxy-cards.grid[KPI 6→4→3→2→1 col] + div.proxy-charts-grid-3[3 col→2→1] + div.proxy-charts-grid[2 col]×2 rows + chart-box full + efficiency-small-multiples[3 col subgrid]'
      }
    ];
    var childPipe = sections
      .map(function (s) {
        return s.tag + '#' + s.id;
      })
      .join(' | ');
    var fullPipe =
      topChromePipe +
      ' || ' +
      layoutGridPipe +
      ' :: ' +
      childPipe;
    var divGeruestAscii = [
      '+------------------------------------------------------------------+',
      '| body                                                             |',
      '+------------------------------------------------------------------+',
      '  |',
      '  +-- header.top-bar',
      '  +-- div#filter-bar',
      '  +-- div#layout-grid ................ [CSS grid: 12 x 1fr tracks]',
      '        |',
      '        +-- details#health-collapse',
      '        |     +-- div.health-collapse-inner (stacked full-width rows)',
      '        |           +-- div#health-score',
      '        |           |     +-- div#health-grid .... [each KPI in own cell; 3 col]',
      '        |           +-- div#key-findings',
      '        |                 +-- div#key-findings-grid [each finding in own cell]',
      '        +-- details#intelligence-collapse',
      '        |     +-- div.intelligence-inner',
      '        |           +-- div#intelligence-scores .. [3→2→1 col]',
      '        |           +-- div#intelligence-narrative',
      '        |           +-- div#intelligence-rootcause',
      '        |           +-- div#intelligence-seasonality',
      '        +-- details#forensic-collapse',
      '        |     +-- div.forensic-inner',
      '        |           +-- div#forensic-cards ....... [3→2→1 col; minmax(0,1fr)]',
      '        |           +-- div#forensic-charts-stack',
      '        |                 +-- div (flex/pair rows, chart shells)',
      '        +-- details#economic-collapse',
      '        |     +-- div.forensic-inner',
      '        |           +-- div.forensic-charts-stack [flex 1:2 rows etc]',
      '        +-- div#report-modal-overlay',
      '        +-- div#day-picker-row',
      '        +-- div#main-charts-scope-wrap',
      '        +-- details#token-stats-collapse',
      '        |     +-- div.forensic-inner',
      '        |           +-- div#cards ............. [KPI 6→4→3→2→1 col; token-stats-kpis]',
      '        |           +-- div#main-charts-wrap',
      '        |           |     +-- div#charts ....... [2-3 col charts]',
      '        |           |     +-- div#charts-host-sub [charts-pair]',
      '        |           +-- div#token-stats-daily-detail',
      '        +-- details#user-profile-collapse',
      '        |     +-- div.forensic-inner',
      '        |           +-- div#user-profile-charts [3-col charts row]',
      '        +-- details#budget-collapse',
      '        |     +-- div.forensic-inner',
      '        |           +-- div#budget-cards ....... [6→4→3→2→1 col]',
      '        |           +-- div#budget-charts / div#budget-trend-row',
      '        +-- details#proxy-collapse',
      '              +-- div.forensic-inner.proxy-inner',
      '                    +-- div#proxy-cards ......... [6→4→3→2→1 col]',
      '                    +-- div.proxy-charts-grid-3',
      '                    +-- div.proxy-charts-grid (x2 rows)',
      '                    +-- div.chart-box (efficiency block)',
      '                    +-- div.efficiency-small-multiples [3 col]',
      '+------------------------------------------------------------------+',
      '| (Modals / slideouts / template builder live outside this tree)  |',
      '+------------------------------------------------------------------+'
    ].join('\n');
    var layoutSpanPalette = [];
    for (var ps = 12; ps >= 1; ps--) layoutSpanPalette.push(ps);
    return {
      version: 1,
      /** All valid grid-column spans for builder layout rows (12-col CSS grid). */
      layoutSpanPalette: layoutSpanPalette,
      divGeruestAscii: divGeruestAscii,
      topChromePipe: topChromePipe,
      layoutGrid: {
        selector: '#layout-grid',
        className: 'layout-grid',
        outerGridColumns: 12,
        cssNote:
          'grid-template-columns: repeat(12,1fr); children [data-span] use --span; max-width 900px forces span 12 per child'
      },
      layoutGridChildrenPipe: childPipe,
      /** Single-line pipe overview for logs / builder legend */
      fullPipe: fullPipe,
      sections: sections,
      templateBuilderNote:
        '#tb-canvas uses a uniform 12-col sub-grid per section; the live dashboard mixes grids (2/3/auto-fit) and flex inside each details block.',
      /** Same row widths as TB_PAGE_SCAFFOLD_PLAN (builder load / Load layout). */
      scaffoldPlan: TB_PAGE_SCAFFOLD_PLAN,
      /** Flatten to tag|tag|… for quick copy (top chrome + each layout-grid direct child id) */
      toShallowDivPipe: function () {
        return (
          'header|div#filter-bar|div#layout-grid>' +
          sections
            .map(function (s) {
              return s.tag + '#' + s.id;
            })
            .join('|')
        );
      }
    };
  }

  global.__widgetDispatcher = {
    init: initFull,
    dispatchRender: dispatchRender,
    resizeAll: resizeAll,
    toggleSidebar: toggleSidebar,
    setVisibility: setVisibility,
    setChartVisibility: setChartVisibility,
    setOrder: setOrder,
    getPrefs: getPrefs,
    resetPrefs: resetPrefs,
    shouldRender: shouldRender,
    isSectionVisible: isSectionVisible,
    isChartVisible: isChartVisible,
    renderWidgetTree: renderWidgetTree,
    applyGridLayout: applyGridLayout,
    applyAllChartVisibility: applyAllChartVisibility,
    getOrderedChartsForSection: getOrderedChartsForSection,
    getDesktopPageScaffold: tbGetDesktopPageScaffold,
    buildScaffoldTemplate: tbNestedModelFromPageScaffold
  };

  // Bind sidebar toggle immediately (don't wait for data/init)
  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', function () { bindSidebarEvents(); });
    } else {
      bindSidebarEvents();
    }
  }
})(typeof window !== 'undefined' ? window : this);
