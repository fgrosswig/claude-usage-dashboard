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
  var PREFS_KEY = 'cud_widget_prefs';
  var PREFS_VERSION = 1;

  var _initialized = false;
  var _prefs = null;
  var _wtreeDragGhost = null;
  var _wtreeDragSrc = null;
  var _wtreeDropState = null;
  var _sidebarEventsBound = false;
  var _sidebarRestoreScheduled = false;

  function wtreeNextSectionLi(li) {
    if (!li || !li.parentNode) return null;
    var n = li.nextSibling;
    while (n) {
      if (n.nodeType === 1 && n.matches && n.matches('li.widget-tree-item[data-section]')) return n;
      n = n.nextSibling;
    }
    return null;
  }

  function wtreePrevSectionLi(li) {
    if (!li || !li.parentNode) return null;
    var n = li.previousSibling;
    while (n) {
      if (n.nodeType === 1 && n.matches && n.matches('li.widget-tree-item[data-section]')) return n;
      n = n.previousSibling;
    }
    return null;
  }

  function clearWtreeDropUi(ul) {
    if (!ul) return;
    var marks = ul.querySelectorAll(
      '.widget-tree-item--drop-before,.widget-tree-item--drop-after,.widget-tree-item--drop-gap-up,.widget-tree-item--drop-gap-down'
    );
    for (var mi = 0; mi < marks.length; mi++) {
      marks[mi].classList.remove(
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
    for (var i = 0; i < items.length; i++) arr.push(items[i]);
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

  function normalizePrefsShape(p) {
    if (!p || typeof p !== 'object') return p;
    if (!Array.isArray(p.hiddenSections)) p.hiddenSections = [];
    if (!Array.isArray(p.hiddenCharts)) p.hiddenCharts = [];
    return p;
  }

  /** Re-read hiddenSections / hiddenCharts from localStorage so the sidebar matches saved prefs. */
  function syncVisibilityPrefsFromLocalStorage() {
    if (!_prefs) return;
    try {
      var raw = localStorage.getItem(PREFS_KEY);
      if (!raw) return;
      var o = JSON.parse(raw);
      if (!o || o.v !== PREFS_VERSION) return;
      normalizePrefsShape(o);
      if (Array.isArray(o.hiddenCharts)) _prefs.hiddenCharts = o.hiddenCharts.slice();
      if (Array.isArray(o.hiddenSections)) _prefs.hiddenSections = o.hiddenSections.slice();
    } catch (e) {}
  }

  function loadPrefs() {
    // Primary: localStorage
    try {
      var raw = localStorage.getItem(PREFS_KEY);
      if (raw) {
        var p = JSON.parse(raw);
        if (p && p.v === PREFS_VERSION) return normalizePrefsShape(p);
      }
    } catch (e) {}
    // Fallback: server (sync XHR, only when localStorage empty)
    try {
      var xhr = new XMLHttpRequest();
      xhr.open('GET', '/api/layout', false);
      xhr.send();
      if (xhr.status === 200 && xhr.responseText && xhr.responseText !== 'null') {
        var sp = JSON.parse(xhr.responseText);
        if (sp && sp.v === PREFS_VERSION) {
          try { localStorage.setItem(PREFS_KEY, JSON.stringify(sp)); } catch (e2) {}
          return normalizePrefsShape(sp);
        }
      }
    } catch (e) { /* server unreachable */ }
    return defaultPrefs();
  }

  function savePrefs() {
    if (!_prefs) return;
    var json = JSON.stringify(_prefs);
    try { localStorage.setItem(PREFS_KEY, json); } catch (e) {}
    // Async server sync (fire and forget)
    try {
      var xhr = new XMLHttpRequest();
      xhr.open('PUT', '/api/layout', true);
      xhr.setRequestHeader('Content-Type', 'application/json');
      xhr.send(json);
    } catch (e) { /* offline or error — localStorage is primary */ }
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

  function getSortedSections() {
    var reg = getRegistry();
    if (!reg) return [];
    if (_prefs && _prefs.order && _prefs.order.length > 0) {
      var byId = {};
      for (var si = 0; si < reg.sections.length; si++) {
        byId[reg.sections[si].id] = reg.sections[si];
      }
      var result = [];
      for (var oi = 0; oi < _prefs.order.length; oi++) {
        if (byId[_prefs.order[oi]]) {
          result.push(byId[_prefs.order[oi]]);
          delete byId[_prefs.order[oi]];
        }
      }
      var remaining = Object.keys(byId).sort(function (a, b) {
        return (byId[a].order || 0) - (byId[b].order || 0);
      });
      for (var ri = 0; ri < remaining.length; ri++) {
        result.push(byId[remaining[ri]]);
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
    var secDef = reg && reg.findSection ? reg.findSection(sectionId) : null;
    // Sections without a layout <details> host (e.g. anthropic-status in the top bar) are not
    // listed in widgets[] — they must stay "visible" so chart visibility only uses hiddenCharts.
    if (secDef && secDef.domId === null && secDef.reorderable === false) {
      return true;
    }
    if (secDef && secDef.parentSection) {
      if (hs.indexOf(sectionId) !== -1) return false;
      return isSectionVisible(secDef.parentSection);
    }
    if (hs.indexOf(sectionId) !== -1) return false;
    if (_prefs.widgets && _prefs.widgets.length) {
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
    if (reg && reg.sections) {
      for (var sxi = 0; sxi < reg.sections.length; sxi++) {
        var charts = reg.sections[sxi].charts || [];
        for (var cxi = 0; cxi < charts.length; cxi++) {
          if (charts[cxi].id === chartId) {
            secId = reg.sections[sxi].id;
            break;
          }
        }
        if (secId) break;
      }
    }
    if (secId && !isSectionVisible(secId)) return false;
    var h = _prefs.hiddenCharts;
    if (!Array.isArray(h)) return true;
    return h.indexOf(chartId) === -1;
  }

  function getWidgetSpan(sectionId) {
    if (!_prefs || !_prefs.widgets) return null;
    for (var i = 0; i < _prefs.widgets.length; i++) {
      if (_prefs.widgets[i].id === sectionId) return _prefs.widgets[i].span;
    }
    return null;
  }

  /** When v2 widgets[] drives the grid, _prefs.order must match or sidebar and page diverge. */
  function syncPrefsOrderFromWidgets() {
    if (!_prefs || !_prefs.widgets || !_prefs.widgets.length) return false;
    var ids = [];
    for (var i = 0; i < _prefs.widgets.length; i++) ids.push(_prefs.widgets[i].id);
    var changed = false;
    if (!_prefs.order || _prefs.order.length !== ids.length) changed = true;
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
    if (!_prefs || !_prefs.widgets || !_prefs.widgets.length) return false;
    var inDrag = {};
    for (var di = 0; di < orderedIds.length; di++) inDrag[orderedIds[di]] = true;
    var before = _prefs.widgets;
    var extras = [];
    for (var j = 0; j < before.length; j++) {
      if (!inDrag[before[j].id]) extras.push({ id: before[j].id, span: before[j].span });
    }
    var newW = [];
    for (var oi = 0; oi < orderedIds.length; oi++) {
      var oid = orderedIds[oi];
      var span = 12;
      for (var k = 0; k < before.length; k++) {
        if (before[k].id === oid) {
          span = before[k].span;
          break;
        }
      }
      newW.push({ id: oid, span: span });
    }
    for (var e = 0; e < extras.length; e++) newW.push(extras[e]);
    _prefs.widgets = newW;
    return true;
  }

  // ── Visibility ──────────────────────────────────────────────────

  function applyVisibility() {
    var sections = getSortedSections();
    for (var si = 0; si < sections.length; si++) {
      var sec = sections[si];
      if (!sec.domId) continue;
      var el = document.getElementById(sec.domId);
      if (!el) continue;
      var vis = isSectionVisible(sec.id);
      el.style.display = vis ? '' : 'none';
      // Hide companion elements too
      var companions = sec.companionIds || [];
      for (var ci = 0; ci < companions.length; ci++) {
        var comp = document.getElementById(companions[ci]);
        if (comp) comp.style.display = vis ? '' : 'none';
      }
    }
  }

  // ── DOM Reorder ─────────────────────────────────────────────────

  function applyOrder() {
    if (!_prefs || !_prefs.order || !_prefs.order.length) return;
    var sections = getSortedSections();
    // Find the parent container of sections
    var firstSec = null;
    for (var fi = 0; fi < sections.length; fi++) {
      if (sections[fi].domId) {
        firstSec = document.getElementById(sections[fi].domId);
        if (firstSec) break;
      }
    }
    if (!firstSec || !firstSec.parentNode) return;
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

  function resizeAll() {
    var reg = getRegistry();
    if (!reg || typeof echarts === 'undefined') return;
    var sections = reg.sections;
    for (var si = 0; si < sections.length; si++) {
      var sec = sections[si];
      if (!isSectionVisible(sec.id)) continue;
      if (sec.domId) {
        var det = document.getElementById(sec.domId);
        if (det && det.tagName === 'DETAILS' && !det.open) continue;
      }
      var charts = sec.charts || [];
      for (var ci = 0; ci < charts.length; ci++) {
        var ch = charts[ci];
        if (!isChartVisible(ch.id)) continue;
        var el = document.getElementById(ch.canvasId);
        if (!el) continue;
        var inst = echarts.getInstanceByDom(el);
        if (inst && typeof inst.resize === 'function') {
          try { inst.resize(); } catch (e) { /* detached */ }
        }
      }
    }
  }

  // ── Render Dispatch ─────────────────────────────────────────────

  function dispatchRender(data, days) {
    var sections = getSortedSections();
    for (var si = 0; si < sections.length; si++) {
      var sec = sections[si];
      if (!isSectionVisible(sec.id)) continue;
      if (!sec.sectionRenderFn) continue;
      var fn = global[sec.sectionRenderFn];
      if (typeof fn !== 'function') continue;

      if (sec.dataSource === '/api/session-turns') {
        // Lazy sections manage their own fetch — just trigger them
        fn(data, days);
      } else {
        fn(data, days);
      }
    }
  }

  // ── Disclosure Toggle Auto-Binding ──────────────────────────────

  function bindDisclosureToggles() {
    var reg = getRegistry();
    if (!reg) return;
    var sections = reg.sections;
    for (var si = 0; si < sections.length; si++) {
      var sec = sections[si];
      if (!sec.domId) continue;
      var det = document.getElementById(sec.domId);
      if (!det || det.tagName !== 'DETAILS') continue;
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

  /** Keep hiddenSections aligned with widgets[] so JSON and sidebar checkboxes match the grid. */
  function reconcileHiddenSectionsWithWidgets() {
    if (!_prefs || !_prefs.widgets || !_prefs.widgets.length) return false;
    var reg = getRegistry();
    if (!reg) return false;
    var inW = {};
    for (var ii = 0; ii < _prefs.widgets.length; ii++) inW[_prefs.widgets[ii].id] = true;
    var next = [];
    for (var jj = 0; jj < reg.sections.length; jj++) {
      var s = reg.sections[jj];
      if (s.reorderable === false || s.parentSection) continue;
      if (!inW[s.id]) next.push(s.id);
    }
    next.sort();
    var cur = (_prefs.hiddenSections || []).slice().sort();
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

  function init() {
    if (_initialized) return;
    _initialized = true;
    _prefs = loadPrefs();
    if (migrateHiddenChartsLegacy()) savePrefs();
    // Migrate prefs to v2 if needed
    if (!_prefs.widgets && _prefs.order) {
      var migrated = migrateTemplateV1toV2({ order: _prefs.order, hiddenSections: _prefs.hiddenSections });
      _prefs.widgets = migrated.widgets;
    }
    if (_prefs.widgets && _prefs.widgets.length) {
      if (syncPrefsOrderFromWidgets()) savePrefs();
      if (reconcileHiddenSectionsWithWidgets()) savePrefs();
      applyGridLayout();
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
    // Sync v2 widgets array
    if (_prefs.widgets) {
      if (!visible) {
        _prefs.widgets = _prefs.widgets.filter(function (w) { return w.id !== id; });
        if (_prefs.order) {
          var oix = _prefs.order.indexOf(id);
          if (oix >= 0) _prefs.order.splice(oix, 1);
        }
      } else {
        var found = false;
        for (var wi = 0; wi < _prefs.widgets.length; wi++) {
          if (_prefs.widgets[wi].id === id) { found = true; break; }
        }
        if (!found) {
          _prefs.widgets.push({ id: id, span: 12 });
          if (!_prefs.order) _prefs.order = [];
          if (_prefs.order.indexOf(id) === -1) _prefs.order.push(id);
        }
      }
    }
    savePrefs();
    if (_prefs.widgets && _prefs.widgets.length) applyGridLayout();
    else applyVisibility();
  }

  /** Show/hide all charts in a widgetGroup in one prefs write (leaves stay individually toggleable). */
  function setGroupChartsVisibility(childIds, visible) {
    if (!childIds || !childIds.length) return;
    if (!_prefs) _prefs = defaultPrefs();
    if (!Array.isArray(_prefs.hiddenCharts)) _prefs.hiddenCharts = [];
    for (var gi = 0; gi < childIds.length; gi++) {
      var cid = childIds[gi];
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
    for (var hk = 0; hk < childIds.length; hk++) {
      var id0 = childIds[hk];
      if (!id0) continue;
      if (id0.indexOf('health-kpi-') === 0 || id0.indexOf('health-finding-') === 0) {
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
    if (!leafCb || !leafCb.parentNode) return;
    var li = leafCb.closest('li.widget-tree-item');
    if (!li) return;
    var groupUl = li.parentNode;
    if (!groupUl || !groupUl.classList || !groupUl.classList.contains('widget-tree-group-charts')) return;
    var cluster = groupUl.closest('li.widget-tree-group-cluster');
    if (!cluster) return;
    var head = cluster.querySelector('.widget-tree-group-head');
    if (!head) return;
    var groupCb = head.querySelector('input[data-type="chart-group"]');
    if (!groupCb) return;
    var checks = groupUl.querySelectorAll('.widget-tree-check[data-type="chart"]');
    var total = 0;
    var checked = 0;
    for (var ci = 0; ci < checks.length; ci++) {
      total++;
      if (checks[ci].checked) checked++;
    }
    groupCb.checked = total > 0 && checked === total;
    groupCb.indeterminate = checked > 0 && checked < total;
  }

  function syncAllWidgetTreeGroupCheckboxes(root) {
    if (!root) return;
    var heads = root.querySelectorAll('.widget-tree-group-head input[data-type="chart-group"]');
    for (var hi = 0; hi < heads.length; hi++) {
      var gcb = heads[hi];
      var cluster = gcb.closest('li.widget-tree-group-cluster');
      if (!cluster) continue;
      var ul = cluster.querySelector(':scope > ul.widget-tree-group-charts');
      if (!ul) continue;
      var checks = ul.querySelectorAll('.widget-tree-check[data-type="chart"]');
      var total = 0;
      var checked = 0;
      for (var cj = 0; cj < checks.length; cj++) {
        total++;
        if (checks[cj].checked) checked++;
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
      chartId.indexOf('health-kpi-') === 0 ||
      chartId.indexOf('health-finding-') === 0
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
    for (var si = 0; si < reg.sections.length; si++) {
      var charts = reg.sections[si].charts || [];
      for (var ci = 0; ci < charts.length; ci++) {
        var ch = charts[ci];
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
    if (_prefs.hiddenCharts.indexOf('ts-kpis') !== -1) {
      var merged = [];
      for (var tsi = 0; tsi < _prefs.hiddenCharts.length; tsi++) {
        var tid = _prefs.hiddenCharts[tsi];
        if (tid === 'ts-kpis') {
          for (var tsj = 0; tsj < tsKpisAll.length; tsj++) {
            if (merged.indexOf(tsKpisAll[tsj]) === -1) merged.push(tsKpisAll[tsj]);
          }
          changedTs = true;
        } else if (merged.indexOf(tid) === -1) merged.push(tid);
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
    for (var i = 0; i < _prefs.hiddenCharts.length; i++) {
      var id = _prefs.hiddenCharts[i];
      var c = mapLegacyToCanon[id];
      if (c) {
        set[c] = true;
        changed = true;
      } else {
        set[id] = true;
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
    for (var si = 0; si < reg.sections.length; si++) {
      var charts = reg.sections[si].charts || [];
      for (var ci = 0; ci < charts.length; ci++) {
        var cid = charts[ci].canvasId;
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
    if (_prefs.widgets && _prefs.widgets.length) {
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
    _prefs = defaultPrefs();
    try { localStorage.removeItem(PREFS_KEY); } catch (e) {}
    applyVisibility();
    applyOrder();
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
      initDevSection();
      bindToolsSection();
      renderExportSection();
      bindUserSettingsModal();
      bindTemplateBuilder();
      // Resize charts after layout shift
      setTimeout(function () { resizeAll(); }, 250);
    }
    // Original filters hidden via CSS (body.sidebar-open selector)
    try { localStorage.setItem('cud_sidebar_open', _sidebarOpen ? '1' : '0'); } catch (e) {}
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
    } catch (e) {}
  }

  // ── Widget Tree (Layout section) ────────────────────────────────

  function renderWidgetTree() {
    var body = document.getElementById('sidebar-layout-body');
    if (!body) return;
    syncVisibilityPrefsFromLocalStorage();
    var reg = getRegistry();
    if (!reg) return;
    var sections = getSortedSections();
    var html = '<ul class="widget-tree">';
    for (var si = 0; si < sections.length; si++) {
      var sec = sections[si];
      if (sec.reorderable === false) continue;
      var secVis = isSectionVisible(sec.id);
      var hasCharts = sec.charts && sec.charts.length > 0;
      var spanVal = getWidgetSpan(sec.id);
      var spanDisp = spanVal || 12;
      html += '<li class="widget-tree-item" data-section="' + sec.id + '" draggable="true">';
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
        var type = cb.dataset.type;
        var id = cb.dataset.id;
        if (type === 'section') setVisibility(id, cb.checked);
        else if (type === 'chart-group') {
          var raw = cb.getAttribute('data-child-ids') || '';
          var ids = raw.split('|');
          var clean = [];
          for (var ii = 0; ii < ids.length; ii++) {
            if (ids[ii]) clean.push(ids[ii]);
          }
          setGroupChartsVisibility(clean, cb.checked);
          var cluster = cb.closest('li.widget-tree-group-cluster');
          if (cluster) {
            var leafChecks = cluster.querySelectorAll('.widget-tree-group-charts .widget-tree-check[data-type="chart"]');
            for (var qi = 0; qi < leafChecks.length; qi++) {
              leafChecks[qi].checked = cb.checked;
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
        _wtreeDragSrc = item;
        _wtreeDropState = null;
        item.classList.add('is-dragging');
        e.dataTransfer.effectAllowed = 'move';
        if (_wtreeDragGhost && _wtreeDragGhost.parentNode) {
          _wtreeDragGhost.parentNode.removeChild(_wtreeDragGhost);
        }
        _wtreeDragGhost = null;
        try {
          var ghost = item.cloneNode(true);
          ghost.classList.add('widget-tree-drag-ghost');
          ghost.removeAttribute('draggable');
          var ghostCtrls = ghost.querySelectorAll('input,button');
          for (var gix = 0; gix < ghostCtrls.length; gix++) {
            ghostCtrls[gix].parentNode.removeChild(ghostCtrls[gix]);
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
        for (var j = 0; j < newItems.length; j++) newOrder.push(newItems[j].dataset.section);
        setOrder(newOrder);
      });
      body.addEventListener('dragend', function () {
        var ul = body.querySelector('.widget-tree');
        if (ul) clearWtreeDropUi(ul);
        if (_wtreeDragSrc) _wtreeDragSrc.classList.remove('is-dragging');
        _wtreeDragSrc = null;
        _wtreeDropState = null;
        if (_wtreeDragGhost && _wtreeDragGhost.parentNode) {
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
        resetPrefs();
        renderWidgetTree();
      });
    }
    var editBtnLbl = document.getElementById('sidebar-layout-edit');
    if (editBtnLbl) {
      editBtnLbl.textContent = _t('settingsEditLayout');
      editBtnLbl.classList.remove('is-active');
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
      for (var vi = 0; vi < days.length; vi++) {
        var dv = days[vi].versions;
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
      for (var ei = 0; ei < days.length; ei++) {
        var de = days[ei].entrypoints;
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
      for (var ri = 0; ri < relStab.length; ri++) {
        var r = relStab[ri];
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
        // Wire cloned buttons
        var btns = clone.querySelectorAll('.lang-btn');
        for (var i = 0; i < btns.length; i++) {
          btns[i].addEventListener('click', function () {
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
    for (var ti = 0; ti < all.length; ti++) {
      if (all[ti].name !== name) continue;
      if (all[ti].sectionWidgets && typeof all[ti].sectionWidgets === 'object') return all[ti].sectionWidgets;
      return getBuiltinSectionWidgetsMap();
    }
    return getBuiltinSectionWidgetsMap();
  }

  function getOrderedChartsForSection(sec) {
    if (!sec || !sec.charts || !sec.charts.length) return [];
    var charts = sec.charts.slice();
    var sw = getActiveTemplateSectionWidgets();
    var orderIds = sw && sw[sec.id] ? sw[sec.id] : null;
    if (!orderIds || !orderIds.length) {
      charts.sort(function (a, b) {
        return (a.order || 0) - (b.order || 0);
      });
      return charts;
    }
    var byId = {};
    for (var ci = 0; ci < charts.length; ci++) {
      byId[charts[ci].id] = charts[ci];
    }
    var out = [];
    for (var oi = 0; oi < orderIds.length; oi++) {
      if (byId[orderIds[oi]]) out.push(byId[orderIds[oi]]);
    }
    for (var cj = 0; cj < charts.length; cj++) {
      var cid = charts[cj].id;
      var found = false;
      for (var ok = 0; ok < orderIds.length; ok++) {
        if (orderIds[ok] === cid) {
          found = true;
          break;
        }
      }
      if (!found) out.push(charts[cj]);
    }
    return out;
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
        { id: 'anthropic-status', span: 12 },
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
        { id: 'health', span: 4 },
        { id: 'token-stats', span: 4 },
        { id: 'budget', span: 4 },
        { id: 'forensic', span: 6 },
        { id: 'proxy', span: 6 }
      ]
    }
  ];

  /** Migrate v1 template (order/hiddenSections) to v2 (widgets[]) */
  function migrateTemplateV1toV2(tpl) {
    if (tpl.version === 2) return tpl;
    var order = tpl.order && tpl.order.length ? tpl.order : ALL_SECTION_IDS;
    var hidden = tpl.hiddenSections || [];
    var widgets = [];
    for (var i = 0; i < order.length; i++) {
      if (hidden.indexOf(order[i]) === -1) {
        widgets.push({ id: order[i], span: 12 });
      }
    }
    // Add any sections not in order and not hidden
    for (var j = 0; j < ALL_SECTION_IDS.length; j++) {
      var sid = ALL_SECTION_IDS[j];
      if (order.indexOf(sid) === -1 && hidden.indexOf(sid) === -1) {
        widgets.push({ id: sid, span: 12 });
      }
    }
    var outTpl = { name: tpl.name, builtin: tpl.builtin || false, version: 2, widgets: widgets };
    if (tpl.sectionWidgets && typeof tpl.sectionWidgets === 'object') outTpl.sectionWidgets = tpl.sectionWidgets;
    return outTpl;
  }

  function loadTemplates() {
    try {
      var raw = localStorage.getItem(TEMPLATES_KEY);
      if (raw) return JSON.parse(raw);
    } catch (e) {}
    return [];
  }

  function saveTemplates(list) {
    try { localStorage.setItem(TEMPLATES_KEY, JSON.stringify(list)); } catch (e) {}
  }

  function getActiveTemplateName() {
    try { return localStorage.getItem(ACTIVE_TPL_KEY) || ''; } catch (e) { return ''; }
  }

  function setActiveTemplateName(name) {
    try { localStorage.setItem(ACTIVE_TPL_KEY, name); } catch (e) {}
  }

  function getAllTemplates() {
    return BUILTIN_TEMPLATES.concat(loadTemplates());
  }

  function applyTemplate(tpl) {
    var t2 = migrateTemplateV1toV2(tpl);
    if (!_prefs) _prefs = defaultPrefs();
    // Derive v1 fields from v2 for backward compat
    var order = [];
    var widgetIds = {};
    for (var i = 0; i < t2.widgets.length; i++) {
      order.push(t2.widgets[i].id);
      widgetIds[t2.widgets[i].id] = true;
    }
    var hidden = [];
    for (var j = 0; j < ALL_SECTION_IDS.length; j++) {
      if (!widgetIds[ALL_SECTION_IDS[j]]) hidden.push(ALL_SECTION_IDS[j]);
    }
    _prefs.order = order;
    _prefs.hiddenSections = hidden;
    _prefs.hiddenCharts = (tpl.hiddenCharts || []).slice();
    migrateHiddenChartsLegacy();
    _prefs.widgets = t2.widgets.slice();
    savePrefs();
    setActiveTemplateName(tpl.name);
    applyGridLayout();
    applyAllChartVisibility();
    renderWidgetTree();
  }

  /** Render sections into a 12-column CSS grid based on widgets[] */
  function applyGridLayout() {
    var widgets = _prefs && _prefs.widgets;
    if (!widgets || !widgets.length) {
      applyVisibility();
      applyOrder();
      return;
    }
    var reg = getRegistry();
    if (!reg) return;

    var gridEl = document.getElementById('layout-grid');
    if (!gridEl) return;

    // Collect all direct children that are NOT sections (table, day-picker, etc.)
    var nonSectionNodes = [];
    var children = gridEl.children;
    for (var ni = children.length - 1; ni >= 0; ni--) {
      var child = children[ni];
      if (!child.id || !child.id.match(/-collapse$/)) {
        nonSectionNodes.push(child);
      }
    }

    var placed = {};

    // Move sections into grid in widget order
    for (var i = 0; i < widgets.length; i++) {
      var w = widgets[i];
      var sec = reg.findSection(w.id);
      if (!sec || !sec.domId) continue;
      // Skip nested sections — they stay inside their parent
      if (sec.parentSection) continue;
      var el = document.getElementById(sec.domId);
      if (!el) continue;

      el.setAttribute('data-span', String(w.span || 12));
      el.style.display = '';
      gridEl.appendChild(el);
      placed[w.id] = true;
      // If this section has child sections, mark them as placed too
      for (var cs = 0; cs < reg.sections.length; cs++) {
        if (reg.sections[cs].parentSection === w.id) placed[reg.sections[cs].id] = true;
      }

      // Move companions after their section
      if (sec.companionIds) {
        for (var ci = 0; ci < sec.companionIds.length; ci++) {
          var comp = document.getElementById(sec.companionIds[ci]);
          if (comp) {
            comp.setAttribute('data-span', String(w.span || 12));
            comp.style.display = '';
            gridEl.appendChild(comp);
          }
        }
      }
    }

    // Append non-section elements at the end (table, day-picker, etc.)
    for (var ri = nonSectionNodes.length - 1; ri >= 0; ri--) {
      var node = nonSectionNodes[ri];
      node.setAttribute('data-span', '12');
      gridEl.appendChild(node);
    }

    // Hide sections not in the template (skip nested)
    for (var si = 0; si < reg.sections.length; si++) {
      var s = reg.sections[si];
      if (!s.domId || placed[s.id] || s.parentSection) continue;
      var hEl = document.getElementById(s.domId);
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
    html += '<button type="button" class="sidebar-btn-sm" id="tpl-save-current">' + _t('settingsTemplateSaveCurrent') + '</button>';
    html += '</div>';
    body.innerHTML = html;

    // Delegated click handler
    if (!body.dataset.bound) {
      body.dataset.bound = '1';
      body.addEventListener('click', function (e) {
        var btn = e.target.closest('[data-tpl-action]');
        if (!btn) return;
        var action = btn.dataset.tplAction;
        var idx = parseInt(btn.dataset.tplIdx, 10);
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

    // Save current layout as template
    var saveBtn = document.getElementById('tpl-save-current');
    if (saveBtn) {
      saveBtn.addEventListener('click', function () {
        var name = prompt(_t('settingsTemplateNamePrompt'));
        if (!name || !name.trim()) return;
        name = name.trim();
        var userTpls = loadTemplates();
        // Overwrite if same name exists
        var found = false;
        for (var j = 0; j < userTpls.length; j++) {
          if (userTpls[j].name === name) {
            userTpls[j] = { name: name, order: (_prefs.order || []).slice(), hiddenSections: (_prefs.hiddenSections || []).slice(), hiddenCharts: (_prefs.hiddenCharts || []).slice() };
            found = true;
            break;
          }
        }
        if (!found) {
          userTpls.push({ name: name, order: (_prefs.order || []).slice(), hiddenSections: (_prefs.hiddenSections || []).slice(), hiddenCharts: (_prefs.hiddenCharts || []).slice() });
        }
        saveTemplates(userTpls);
        setActiveTemplateName(name);
        renderTemplatesSection();
      });
    }
  }

  function escT(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // ── Export Section ──────────────────────────────────────────────

  // ── DEV Section (only in DEV_MODE) ──────────────────────────────

  function initDevSection() {
    var devPanel = document.getElementById('sidebar-dev');
    if (!devPanel) return;
    // Check if dev mode is active (dev-overlay exists = dev bar was created)
    var devBar = document.getElementById('dev-overlay');
    if (!devBar) return;
    devPanel.style.display = '';

    // Source
    var srcEl = document.getElementById('sidebar-dev-source');
    if (srcEl) {
      var origSrc = devBar.querySelector('.dev-overlay-muted');
      if (origSrc) srcEl.textContent = origSrc.textContent;
    }

    // Badge
    var badge = document.getElementById('sidebar-dev-badge');
    if (badge) {
      var origBrand = devBar.querySelector('.dev-overlay-brand');
      if (origBrand) badge.textContent = origBrand.textContent;
    }

    // Sync button
    var syncBtn = document.getElementById('sidebar-dev-sync');
    if (syncBtn && !syncBtn.dataset.bound) {
      syncBtn.dataset.bound = '1';
      syncBtn.addEventListener('click', function () {
        var origSync = document.getElementById('dev-sync-btn');
        if (origSync) origSync.click();
        var st = document.getElementById('sidebar-dev-sync-status');
        if (st) st.textContent = 'syncing...';
        setTimeout(function () { pullSidebarDevStatus(); }, 2000);
        setTimeout(function () { pullSidebarDevStatus(); }, 5000);
      });
    }

    // Benchmark button
    var benchBtn = document.getElementById('sidebar-dev-bench');
    if (benchBtn && !benchBtn.dataset.bound) {
      benchBtn.dataset.bound = '1';
      benchBtn.addEventListener('click', function () {
        var days = parseInt(document.getElementById('sidebar-dev-bench-days').value || '8', 10);
        if (isNaN(days) || days < 1) days = 8;
        if (days > 31) days = 31;
        var st = document.getElementById('sidebar-dev-bench-status');
        if (st) st.textContent = 'running...';
        benchBtn.disabled = true;
        var xhr = new XMLHttpRequest();
        xhr.open('POST', '/api/debug/benchmark-session-turns', true);
        xhr.setRequestHeader('Content-Type', 'application/json');
        xhr.onload = function () {
          benchBtn.disabled = false;
          if (!st) return;
          if (xhr.status !== 200) { st.textContent = 'failed'; return; }
          try {
            var out = JSON.parse(xhr.responseText);
            st.textContent = out.total_s.toFixed(2) + 's';
            st.style.color = '#22c55e';
          } catch (e) { st.textContent = 'error'; }
        };
        xhr.onerror = function () { benchBtn.disabled = false; };
        xhr.send(JSON.stringify({ days_back: days }));
      });
    }

    // Cache rebuild buttons
    function wireRebuild(btnId, url, metaId) {
      var btn = document.getElementById(btnId);
      if (!btn || btn.dataset.bound) return;
      btn.dataset.bound = '1';
      btn.addEventListener('click', function () {
        btn.disabled = true;
        var xhr = new XMLHttpRequest();
        xhr.open('POST', url, true);
        xhr.onload = function () {
          btn.disabled = false;
          setTimeout(function () { pullSidebarDevStatus(); }, 1000);
          setTimeout(function () { pullSidebarDevStatus(); }, 4000);
        };
        xhr.onerror = function () { btn.disabled = false; };
        xhr.send();
      });
    }
    wireRebuild('sidebar-dev-rebuild-jsonl', '/api/debug/rebuild-jsonl-cache', 'sidebar-dev-jsonl-at');
    wireRebuild('sidebar-dev-rebuild-proxy', '/api/debug/rebuild-proxy-cache', 'sidebar-dev-proxy-at');

    // Initial status pull
    pullSidebarDevStatus();
  }

  function pullSidebarDevStatus() {
    var xhr = new XMLHttpRequest();
    xhr.open('GET', '/api/debug/status', true);
    xhr.onload = function () {
      if (xhr.status !== 200) return;
      try {
        var info = JSON.parse(xhr.responseText);
        var jsonlAt = document.getElementById('sidebar-dev-jsonl-at');
        var proxyAt = document.getElementById('sidebar-dev-proxy-at');
        var lastSync = document.getElementById('sidebar-dev-last-sync');
        if (jsonlAt && info.jsonl_cache_at) jsonlAt.textContent = 'last: ' + new Date(info.jsonl_cache_at).toLocaleTimeString();
        if (proxyAt && info.proxy_cache_at) proxyAt.textContent = 'last: ' + new Date(info.proxy_cache_at).toLocaleTimeString();
        if (lastSync && info.last_remote_sync) lastSync.textContent = 'Last sync: ' + new Date(info.last_remote_sync).toLocaleTimeString();
      } catch (e) {}
    };
    xhr.send();
  }

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
    for (var i = 0; i < langs.length; i++) {
      var l = langs[i];
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
      for (var j = 0; j < all.length; j++) all[j].classList.remove('active');
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
        for (var i = 0; i < charts.length; i++) {
          var inst = typeof echarts !== 'undefined' ? echarts.getInstanceByDom(charts[i]) : null;
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
    if (data && data.versionTimeline && data.versionTimeline.marketplace_fetched_at) {
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

  var _tbWidgets = []; // working copy: [{id, span}]

  function openTemplateBuilder(baseTpl) {
    var overlay = document.getElementById('tb-overlay');
    if (!overlay) return;
    var nameInput = document.getElementById('tb-name-input');
    var titleEl = document.getElementById('tb-title');
    if (titleEl) titleEl.textContent = _t('tbTitle');
    if (nameInput) nameInput.placeholder = _t('tbNamePlaceholder');

    // Init from base template or current prefs
    if (baseTpl && baseTpl.widgets) {
      _tbWidgets = baseTpl.widgets.map(function (w) { return { id: w.id, span: w.span }; });
      if (nameInput) nameInput.value = baseTpl.builtin ? '' : (baseTpl.name || '');
    } else if (_prefs && _prefs.widgets) {
      _tbWidgets = _prefs.widgets.map(function (w) { return { id: w.id, span: w.span }; });
      if (nameInput) nameInput.value = '';
    } else {
      _tbWidgets = ALL_SECTION_IDS.map(function (id) { return { id: id, span: 12 }; });
      if (nameInput) nameInput.value = '';
    }

    renderBuilderRows();
    bindPreviewResize();
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
    for (var i = 0; i < _tbWidgets.length; i++) used[_tbWidgets[i].id] = true;
    return used;
  }

  function getAvailableSections() {
    var used = getUsedIds();
    var reg = getRegistry();
    if (!reg) return [];
    var avail = [];
    for (var i = 0; i < reg.sections.length; i++) {
      var s = reg.sections[i];
      if (!used[s.id]) avail.push(s);
    }
    return avail;
  }

  function updateBuilderPreview() {
    var container = document.getElementById('tb-rows');
    if (!container) return;
    var preview = container.querySelector('.tb-preview-grid');
    if (!preview) return;
    var reg = getRegistry();
    if (!reg) return;
    var html = '';
    for (var i = 0; i < _tbWidgets.length; i++) {
      var w = _tbWidgets[i];
      var sec = reg.findSection(w.id);
      var name = sec ? _t(sec.titleKey) : w.id;
      html += '<div class="tb-preview-cell" data-pidx="' + i + '" style="grid-column:span ' + (w.span || 12) + '">';
      html += '<span class="tb-preview-name">' + name + '</span>';
      html += '<span class="tb-preview-span">' + (w.span || 12) + '</span>';
      html += '<span class="tb-resize-handle" data-pidx="' + i + '"></span>';
      html += '</div>';
    }
    preview.innerHTML = html;
    // Sync select dropdowns in widget list
    var selects = container.querySelectorAll('.tb-span-select');
    for (var si = 0; si < selects.length; si++) {
      var idx = parseInt(selects[si].dataset.idx, 10);
      if (_tbWidgets[idx]) selects[si].value = String(_tbWidgets[idx].span);
    }
  }

  function bindPreviewResize() {
    var container = document.getElementById('tb-rows');
    if (!container || container.dataset.resizeBound) return;
    container.dataset.resizeBound = '1';
    var _resizeIdx = -1;
    var _resizeStartX = 0;
    var _resizeStartSpan = 0;
    var _colWidth = 0;

    container.addEventListener('mousedown', function (e) {
      var handle = e.target.closest('.tb-resize-handle');
      if (!handle) return;
      e.preventDefault();
      _resizeIdx = parseInt(handle.dataset.pidx, 10);
      _resizeStartX = e.clientX;
      _resizeStartSpan = _tbWidgets[_resizeIdx] ? _tbWidgets[_resizeIdx].span : 12;
      // Calculate 1 grid column width from the preview container
      var grid = container.querySelector('.tb-preview-grid');
      if (grid) _colWidth = grid.offsetWidth / 12;
      document.body.classList.add('tb-resizing');
    });

    window.addEventListener('mousemove', function (e) {
      if (_resizeIdx < 0 || !_colWidth) return;
      var dx = e.clientX - _resizeStartX;
      var colDelta = Math.round(dx / _colWidth);
      var newSpan = Math.max(1, Math.min(12, _resizeStartSpan + colDelta));
      if (_tbWidgets[_resizeIdx] && _tbWidgets[_resizeIdx].span !== newSpan) {
        _tbWidgets[_resizeIdx].span = newSpan;
        updateBuilderPreview();
      }
    });

    window.addEventListener('mouseup', function () {
      if (_resizeIdx >= 0) {
        _resizeIdx = -1;
        document.body.classList.remove('tb-resizing');
      }
    });
  }

  function renderBuilderRows() {
    var container = document.getElementById('tb-rows');
    var unusedEl = document.getElementById('tb-unused');
    if (!container) return;
    var reg = getRegistry();
    if (!reg) return;

    // Grid preview
    var html = '<div class="tb-preview"><div class="tb-preview-grid">';
    for (var pi = 0; pi < _tbWidgets.length; pi++) {
      var pw = _tbWidgets[pi];
      var psec = reg.findSection(pw.id);
      var pname = psec ? _t(psec.titleKey) : pw.id;
      html += '<div class="tb-preview-cell" style="grid-column:span ' + (pw.span || 12) + '">';
      html += '<span class="tb-preview-name">' + pname + '</span>';
      html += '<span class="tb-preview-span">' + (pw.span || 12) + '</span>';
      html += '</div>';
    }
    html += '</div></div>';

    // Widget list
    html += '<div class="tb-list-title">' + _t('tbWidgets') + '</div>';
    for (var i = 0; i < _tbWidgets.length; i++) {
      var w = _tbWidgets[i];
      var sec = reg.findSection(w.id);
      var name = sec ? _t(sec.titleKey) : w.id;
      html += '<div class="tb-row" data-idx="' + i + '" draggable="true">';
      html += '<div class="tb-row-header">';
      html += '<span class="tb-row-drag">&#x2630;</span>';
      html += '<span>' + name + '</span>';
      html += '<div class="tb-cell-span">';
      html += '<label>span</label>';
      html += '<select class="tb-span-select" data-idx="' + i + '">';
      var spanOptions = [3, 4, 6, 8, 12];
      for (var si = 0; si < spanOptions.length; si++) {
        var sv = spanOptions[si];
        html += '<option value="' + sv + '"' + (w.span === sv ? ' selected' : '') + '>' + sv + '/12';
        if (sv === 4) html += ' (1/3)';
        else if (sv === 6) html += ' (1/2)';
        else if (sv === 8) html += ' (2/3)';
        else if (sv === 12) html += ' (full)';
        else if (sv === 3) html += ' (1/4)';
        html += '</option>';
      }
      html += '</select>';
      html += '</div>';
      html += '<button type="button" class="tb-row-remove" data-idx="' + i + '" title="Remove">&times;</button>';
      html += '</div>';
      html += '</div>';
    }
    container.innerHTML = html;

    // Available widgets (unused)
    var avail = getAvailableSections();
    var uHtml = '';
    if (avail.length) {
      uHtml += '<div class="tb-unused-title">' + _t('tbUnused') + '</div>';
      uHtml += '<div class="tb-unused-chips">';
      for (var ai = 0; ai < avail.length; ai++) {
        uHtml += '<button type="button" class="tb-unused-chip" data-id="' + avail[ai].id + '">+ ' + _t(avail[ai].titleKey) + '</button>';
      }
      uHtml += '</div>';
    }
    if (unusedEl) unusedEl.innerHTML = uHtml;

    // Event delegation
    if (!container.dataset.bound) {
      container.dataset.bound = '1';
      container.addEventListener('change', function (e) {
        var sel = e.target.closest('.tb-span-select');
        if (!sel) return;
        var idx = parseInt(sel.dataset.idx, 10);
        if (_tbWidgets[idx]) {
          _tbWidgets[idx].span = parseInt(sel.value, 10);
          updateBuilderPreview();
        }
      });
      container.addEventListener('click', function (e) {
        var rmBtn = e.target.closest('.tb-row-remove');
        if (rmBtn) {
          var idx = parseInt(rmBtn.dataset.idx, 10);
          _tbWidgets.splice(idx, 1);
          renderBuilderRows();
        }
      });
      // Drag & drop reorder
      var _dragIdx = -1;
      container.addEventListener('dragstart', function (e) {
        var row = e.target.closest('.tb-row');
        if (!row) return;
        _dragIdx = parseInt(row.dataset.idx, 10);
        row.classList.add('is-dragging');
        e.dataTransfer.effectAllowed = 'move';
      });
      container.addEventListener('dragover', function (e) {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
      });
      container.addEventListener('drop', function (e) {
        e.preventDefault();
        var row = e.target.closest('.tb-row');
        if (!row || _dragIdx < 0) return;
        var dropIdx = parseInt(row.dataset.idx, 10);
        if (_dragIdx === dropIdx) return;
        var item = _tbWidgets.splice(_dragIdx, 1)[0];
        _tbWidgets.splice(dropIdx, 0, item);
        _dragIdx = -1;
        renderBuilderRows();
      });
      container.addEventListener('dragend', function () { _dragIdx = -1; });
    }
    if (unusedEl && !unusedEl.dataset.bound) {
      unusedEl.dataset.bound = '1';
      unusedEl.addEventListener('click', function (e) {
        var chip = e.target.closest('.tb-unused-chip');
        if (!chip) return;
        _tbWidgets.push({ id: chip.dataset.id, span: 12 });
        renderBuilderRows();
      });
    }
  }

  function saveTemplateFromBuilder() {
    var nameInput = document.getElementById('tb-name-input');
    var name = nameInput ? nameInput.value.trim() : '';
    if (!name) {
      name = prompt(_t('tbNamePrompt'));
      if (!name || !name.trim()) return;
      name = name.trim();
    }
    var tpl = { name: name, version: 2, widgets: _tbWidgets.slice() };
    // Save to user templates
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
    // Apply immediately
    applyTemplate(tpl);
    renderTemplatesSection();
    closeTemplateBuilder();
  }

  function bindTemplateBuilder() {
    var buildBtn = document.getElementById('sidebar-build-template');
    if (buildBtn && !buildBtn.dataset.bound) {
      buildBtn.dataset.bound = '1';
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
    var addRowBtn = document.getElementById('tb-add-row');
    if (addRowBtn && !addRowBtn.dataset.bound) {
      addRowBtn.dataset.bound = '1';
      addRowBtn.textContent = _t('tbAddRow');
      addRowBtn.addEventListener('click', function () {
        var avail = getAvailableSections();
        if (!avail.length) {
          addRowBtn.textContent = _t('tbAddRow') + ' (all used)';
          setTimeout(function () { addRowBtn.textContent = _t('tbAddRow'); }, 1500);
          return;
        }
        _tbWidgets.push({ id: avail[0].id, span: 12 });
        renderBuilderRows();
      });
    }
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
          if (!this.files || !this.files[0]) return;
          var reader = new FileReader();
          reader.onload = function (ev) {
            try {
              var imported = JSON.parse(ev.target.result);
              if (imported && imported.v === PREFS_VERSION) {
                _prefs = normalizePrefsShape(imported);
                migrateHiddenChartsLegacy();
                savePrefs();
                applyVisibility();
                applyOrder();
                renderWidgetTree();
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
        if (wasEdit) {
          savePrefs();
          tree.classList.remove('widget-tree--edit');
          editBtn.classList.remove('is-active');
          editBtn.textContent = _t('settingsEditLayout');
        } else {
          tree.classList.add('widget-tree--edit');
          editBtn.classList.add('is-active');
          editBtn.textContent = _t('settingsSaveLayout');
        }
      });
    }
    var editBtnAfterTitles = document.getElementById('sidebar-layout-edit');
    var treeAfterTitles = document.querySelector('.widget-tree');
    if (editBtnAfterTitles && treeAfterTitles && treeAfterTitles.classList.contains('widget-tree--edit')) {
      editBtnAfterTitles.textContent = _t('settingsSaveLayout');
      editBtnAfterTitles.classList.add('is-active');
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
    applyAllChartVisibility: applyAllChartVisibility,
    getOrderedChartsForSection: getOrderedChartsForSection
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
