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

  // ── Preferences (localStorage) ──────────────────────────────────

  function loadPrefs() {
    try {
      var raw = localStorage.getItem(PREFS_KEY);
      if (!raw) return defaultPrefs();
      var p = JSON.parse(raw);
      if (!p || p.v !== PREFS_VERSION) return defaultPrefs();
      return p;
    } catch (e) {
      return defaultPrefs();
    }
  }

  function savePrefs() {
    if (!_prefs) return;
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify(_prefs));
    } catch (e) { /* quota exceeded or private mode */ }
  }

  function defaultPrefs() {
    return {
      v: PREFS_VERSION,
      order: [],
      hiddenSections: [],
      hiddenCharts: []
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
    return _prefs.hiddenSections.indexOf(sectionId) === -1;
  }

  function isChartVisible(chartId) {
    if (!_prefs) return true;
    return _prefs.hiddenCharts.indexOf(chartId) === -1;
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

  // ── Init ────────────────────────────────────────────────────────

  function init() {
    if (_initialized) return;
    _initialized = true;
    _prefs = loadPrefs();
    applyVisibility();
    applyOrder();
    bindDisclosureToggles();
  }

  // ── Public API ──────────────────────────────────────────────────

  function setVisibility(id, visible) {
    if (!_prefs) _prefs = defaultPrefs();
    var idx = _prefs.hiddenSections.indexOf(id);
    if (visible && idx >= 0) {
      _prefs.hiddenSections.splice(idx, 1);
    } else if (!visible && idx === -1) {
      _prefs.hiddenSections.push(id);
    }
    savePrefs();
    applyVisibility();
  }

  function setChartVisibility(chartId, visible) {
    if (!_prefs) _prefs = defaultPrefs();
    var idx = _prefs.hiddenCharts.indexOf(chartId);
    if (visible && idx >= 0) {
      _prefs.hiddenCharts.splice(idx, 1);
    } else if (!visible && idx === -1) {
      _prefs.hiddenCharts.push(chartId);
    }
    savePrefs();
  }

  function setOrder(orderedIds) {
    if (!_prefs) _prefs = defaultPrefs();
    _prefs.order = orderedIds;
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

  global.__widgetDispatcher = {
    init: init,
    dispatchRender: dispatchRender,
    resizeAll: resizeAll,
    setVisibility: setVisibility,
    setChartVisibility: setChartVisibility,
    setOrder: setOrder,
    getPrefs: getPrefs,
    resetPrefs: resetPrefs,
    shouldRender: shouldRender,
    isSectionVisible: isSectionVisible,
    isChartVisible: isChartVisible
  };
})(typeof window !== 'undefined' ? window : this);
