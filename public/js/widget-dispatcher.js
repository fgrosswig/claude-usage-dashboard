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
    // Primary: localStorage
    try {
      var raw = localStorage.getItem(PREFS_KEY);
      if (raw) {
        var p = JSON.parse(raw);
        if (p && p.v === PREFS_VERSION) return p;
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
          return sp;
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
    applyAllChartVisibility();
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
    applyChartVisibility(chartId, visible);
  }

  function applyChartVisibility(chartId, visible) {
    var reg = getRegistry();
    if (!reg) return;
    var chartDef = reg.findChart(chartId);
    if (!chartDef) return;
    // Hide the chart container (the .chart-box parent of the canvas)
    var el = document.getElementById(chartDef.canvasId);
    if (!el) return;
    var box = el.closest('.chart-box') || el.parentNode;
    if (box) box.style.display = visible ? '' : 'none';
  }

  function applyAllChartVisibility() {
    var reg = getRegistry();
    if (!reg) return;
    for (var si = 0; si < reg.sections.length; si++) {
      var charts = reg.sections[si].charts || [];
      for (var ci = 0; ci < charts.length; ci++) {
        var ch = charts[ci];
        applyChartVisibility(ch.id, isChartVisible(ch.id));
      }
    }
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

  // ── Sidebar UI ───────────────────────────────────────────────

  var _sidebarOpen = false;

  function toggleSidebar(force) {
    var sb = document.getElementById('sidebar');
    if (!sb) return;
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
      // Resize charts after layout shift
      setTimeout(function () { resizeAll(); }, 250);
    }
    // Original filters hidden via CSS (body.sidebar-open selector)
    try { localStorage.setItem('cud_sidebar_open', _sidebarOpen ? '1' : '0'); } catch (e) {}
  }

  function bindSidebarEvents() {
    var btn = document.getElementById('settings-nav-btn');
    if (btn) btn.addEventListener('click', function () { toggleSidebar(); });
    var close = document.getElementById('sidebar-close');
    if (close) close.addEventListener('click', function () { toggleSidebar(false); });
    // ESC key closes sidebar
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && _sidebarOpen) toggleSidebar(false);
    });
    // Restore sidebar state
    try {
      if (localStorage.getItem('cud_sidebar_open') === '1') {
        setTimeout(function () { toggleSidebar(true); }, 100);
      }
    } catch (e) {}
  }

  // ── Widget Tree (Layout section) ────────────────────────────────

  function renderWidgetTree() {
    var body = document.getElementById('sidebar-layout-body');
    if (!body) return;
    var reg = getRegistry();
    if (!reg) return;
    var sections = getSortedSections();
    var html = '<ul class="widget-tree">';
    for (var si = 0; si < sections.length; si++) {
      var sec = sections[si];
      if (sec.reorderable === false) continue;
      var secVis = isSectionVisible(sec.id);
      var hasCharts = sec.charts && sec.charts.length > 0;
      html += '<li class="widget-tree-item" data-section="' + sec.id + '" draggable="true">';
      html += '<span class="widget-tree-drag" title="Drag to reorder">&#x2630;</span>';
      html += '<input type="checkbox" class="widget-tree-check" data-type="section" data-id="' + sec.id + '"' + (secVis ? ' checked' : '') + '>';
      html += '<span class="widget-tree-label">' + _t(sec.titleKey) + '</span>';
      if (hasCharts) {
        html += '<button type="button" class="widget-tree-expand" data-expand="' + sec.id + '">&#x25BC;</button>';
      }
      html += '</li>';
      if (hasCharts) {
        html += '<ul class="widget-tree-charts" data-charts-for="' + sec.id + '" style="display:none">';
        for (var ci = 0; ci < sec.charts.length; ci++) {
          var ch = sec.charts[ci];
          var chVis = isChartVisible(ch.id);
          html += '<li class="widget-tree-item">';
          html += '<input type="checkbox" class="widget-tree-check" data-type="chart" data-id="' + ch.id + '"' + (chVis ? ' checked' : '') + '>';
          html += '<span class="widget-tree-label">' + _t(ch.titleKey) + '</span>';
          html += '</li>';
        }
        html += '</ul>';
      }
    }
    html += '</ul>';
    body.innerHTML = html;

    // Delegated events
    body.addEventListener('change', function (e) {
      var cb = e.target;
      if (!cb.classList.contains('widget-tree-check')) return;
      var type = cb.dataset.type;
      var id = cb.dataset.id;
      if (type === 'section') setVisibility(id, cb.checked);
      else if (type === 'chart') setChartVisibility(id, cb.checked);
    });
    body.addEventListener('click', function (e) {
      var btn = e.target.closest('.widget-tree-expand');
      if (!btn) return;
      var secId = btn.dataset.expand;
      var charts = body.querySelector('[data-charts-for="' + secId + '"]');
      if (!charts) return;
      var open = charts.style.display !== 'none';
      charts.style.display = open ? 'none' : '';
      btn.innerHTML = open ? '&#x25BC;' : '&#x25B2;';
    });

    // Drag & Drop for section reorder
    var dragSrc = null;
    body.addEventListener('dragstart', function (e) {
      var item = e.target.closest('.widget-tree-item[data-section]');
      if (!item) { e.preventDefault(); return; }
      dragSrc = item;
      item.classList.add('is-dragging');
      e.dataTransfer.effectAllowed = 'move';
    });
    body.addEventListener('dragover', function (e) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
    });
    body.addEventListener('drop', function (e) {
      e.preventDefault();
      var target = e.target.closest('.widget-tree-item[data-section]');
      if (!target || !dragSrc || target === dragSrc) return;
      var ul = body.querySelector('.widget-tree');
      if (!ul) return;
      // Move dragSrc before or after target
      var items = ul.querySelectorAll('.widget-tree-item[data-section]');
      var dragIdx = -1, targetIdx = -1;
      for (var i = 0; i < items.length; i++) {
        if (items[i] === dragSrc) dragIdx = i;
        if (items[i] === target) targetIdx = i;
      }
      if (dragIdx < targetIdx) target.parentNode.insertBefore(dragSrc, target.nextSibling);
      else target.parentNode.insertBefore(dragSrc, target);
      // Update prefs order
      var newItems = ul.querySelectorAll('.widget-tree-item[data-section]');
      var newOrder = [];
      for (var j = 0; j < newItems.length; j++) newOrder.push(newItems[j].dataset.section);
      setOrder(newOrder);
    });
    body.addEventListener('dragend', function () {
      if (dragSrc) dragSrc.classList.remove('is-dragging');
      dragSrc = null;
    });

    // Reset button
    var resetBtn = document.getElementById('sidebar-layout-reset');
    if (resetBtn && !resetBtn.dataset.bound) {
      resetBtn.dataset.bound = '1';
      resetBtn.addEventListener('click', function () {
        resetPrefs();
        renderWidgetTree();
      });
    }
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

  var BUILTIN_TEMPLATES = [
    {
      name: 'Full',
      builtin: true,
      order: [],
      hiddenSections: [],
      hiddenCharts: []
    },
    {
      name: 'Performance',
      builtin: true,
      order: ['token-stats', 'forensic', 'economic', 'efficiency-range'],
      hiddenSections: ['health', 'budget', 'proxy', 'user-profile', 'anthropic-status'],
      hiddenCharts: []
    },
    {
      name: 'Cost',
      builtin: true,
      order: ['budget', 'economic', 'proxy', 'efficiency-range'],
      hiddenSections: ['health', 'token-stats', 'forensic', 'user-profile', 'anthropic-status'],
      hiddenCharts: []
    },
    {
      name: 'Minimal',
      builtin: true,
      order: ['health', 'token-stats', 'budget'],
      hiddenSections: ['forensic', 'proxy', 'user-profile', 'anthropic-status', 'economic', 'efficiency-range'],
      hiddenCharts: []
    }
  ];

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
    if (!_prefs) _prefs = defaultPrefs();
    _prefs.order = (tpl.order || []).slice();
    _prefs.hiddenSections = (tpl.hiddenSections || []).slice();
    _prefs.hiddenCharts = (tpl.hiddenCharts || []).slice();
    savePrefs();
    setActiveTemplateName(tpl.name);
    applyVisibility();
    applyAllChartVisibility();
    applyOrder();
    renderWidgetTree();
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
                _prefs = imported;
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
      'sidebar-layout-reset': 'settingsResetLayout',
      'sidebar-export-jsonl': 'settingsExportJsonl',
      'sidebar-export-template': 'settingsExportTemplate',
      'sidebar-import-template': 'settingsImportTemplate',
      'settings-nav-btn': 'settingsBtnTitle'
    };
    for (var id in titles) {
      var el = document.getElementById(id);
      if (el) {
        if (el.tagName === 'BUTTON' && id === 'settings-nav-btn') el.title = _t(titles[id]);
        else el.textContent = _t(titles[id]);
      }
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
    applyAllChartVisibility: applyAllChartVisibility
  };
})(typeof window !== 'undefined' ? window : this);
