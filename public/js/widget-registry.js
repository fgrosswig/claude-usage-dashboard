/**
 * Widget Registry — Central manifest of all dashboard sections and charts.
 *
 * Every chart in the dashboard has an entry here. The registry serves as:
 *   1. Migration tracker (Chart.js → ECharts)
 *   2. Foundation for the widget builder (drag & drop layout)
 *   3. Data-source dependency map (which API feeds which chart)
 *
 * engine: "chartjs" = legacy, "echarts" = migrated, "google" = Google Charts
 *
 * Layer 1 (registry v2): every section and chart gets
 *   visible (boolean), order (number), tags (string[])
 * via normalizeWidgetRegistryLayer1() — defaults can be overridden on literals later.
 *
 * Layer 2 (registry v3): every section gets dispatcher fields:
 *   domId (string|null)      — <details> element ID for visibility/reorder
 *   sectionRenderFn (string) — global function name called by dispatcher
 *   companionIds (string[])  — sibling DOM elements that move with the section
 *   reorderable (boolean)    — false for popup/nested sections
 *
 * Usage:
 *   window.__widgetRegistry.sections  — all section definitions
 *   window.__widgetRegistry.findChart("ts-c1")  — lookup by chart ID (token stats main chart)
 *   window.__widgetRegistry.findSection("proxy")  — lookup by section ID
 *   window.__widgetRegistry.getSectionsSorted()  — sections by order
 *   window.__widgetRegistry.getChartsSorted("proxy")  — charts in section by order
 */
'use strict';

(function () {
  /**
   * Assigns visible, order, tags to each section/chart if missing.
   * Section order follows SECTION_ORDER; chart order is a global sequence (gaps of 10).
   */
  function normalizeWidgetRegistryLayer1(reg) {
    var sectionOrderIds = [
      'health',
      'token-stats',
      'forensic',
      'user-profile',
      'budget',
      'proxy',
      'anthropic-status',
      'economic',
      'efficiency-range'
    ];
    var sectionTagsById = {
      health: ['overview'],
      'token-stats': ['usage', 'tokens', 'performance'],
      forensic: ['usage', 'forensics'],
      'user-profile': ['usage', 'profile'],
      budget: ['cost', 'budget'],
      proxy: ['proxy', 'performance'],
      'anthropic-status': ['status', 'reliability'],
      economic: ['cost', 'sessions'],
      'efficiency-range': ['performance', 'range']
    };
    var chartTagOverrides = {
      'proxy-hourly-latency': ['proxy', 'latency'],
      'proxy-latency': ['proxy', 'latency'],
      'econ-budget-drain': ['cost', 'budget', 'sessions'],
      'eff-heatmap': ['performance', 'proxy']
    };
    var orderPos = {};
    for (var oi = 0; oi < sectionOrderIds.length; oi++) {
      orderPos[sectionOrderIds[oi]] = (oi + 1) * 10;
    }
    var globalChartOrder = 0;
    for (var si = 0; si < reg.sections.length; si++) {
      var sec = reg.sections[si];
      if (sec.visible === undefined) sec.visible = true;
      if (sec.order === undefined) {
        sec.order = orderPos[sec.id] != null ? orderPos[sec.id] : (si + 1) * 100;
      }
      if (sec.tags === undefined) {
        sec.tags = (sectionTagsById[sec.id] || []).slice();
      }
      var charts = sec.charts || [];
      for (var ci = 0; ci < charts.length; ci++) {
        var ch = charts[ci];
        if (ch.visible === undefined) ch.visible = true;
        if (ch.order === undefined) {
          globalChartOrder += 10;
          ch.order = globalChartOrder;
        }
        if (ch.tags === undefined) {
          ch.tags = chartTagOverrides[ch.id]
            ? chartTagOverrides[ch.id].slice()
            : sec.tags.slice();
        }
      }
    }
  }

  var registry = {
    version: 3,
    sections: [
      // ── Health Score ────────────────────────────────────────────
      {
        id: 'health',
        titleKey: 'healthScoreTitle',
        domId: 'health-collapse',
        sectionRenderFn: 'renderHealthScore',
        reorderable: true,
        defaultOpen: false,
        dataSource: '/api/usage',
        requires: ['usage'],
        charts: []
      },

      // ── Token Stats ────────────────────────────────────────────
      {
        id: 'token-stats',
        titleKey: 'sectionTokenStats',
        domId: 'token-stats-collapse',
        sectionRenderFn: 'renderTokenStatsSection',
        companionIds: ['day-picker-row', 'main-charts-scope-wrap'],
        reorderable: true,
        defaultOpen: true,
        dataSource: '/api/usage',
        requires: ['usage'],
        charts: [
          {
            id: 'ts-kpis',
            titleKey: 'tokenStatsKpiCards',
            type: 'cards',
            engine: 'html',
            canvasId: 'cards',
            size: { cols: 1, minHeight: 0 },
            renderFn: 'renderTokenStatsSection'
          },
          {
            id: 'ts-c1',
            titleKey: 'tokenStatsChartC1',
            type: 'bar-stacked',
            engine: 'echarts',
            canvasId: 'c1',
            size: { cols: 1, minHeight: 260 },
            renderFn: 'renderTokenStats_c1_daily'
          },
          {
            id: 'ts-c2',
            titleKey: 'tokenStatsChartC2',
            type: 'line',
            engine: 'echarts',
            canvasId: 'c2',
            size: { cols: 1, minHeight: 260 },
            renderFn: 'renderTokenStats_c2_daily'
          },
          {
            id: 'ts-c3',
            titleKey: 'tokenStatsChartC3',
            type: 'bar',
            engine: 'echarts',
            canvasId: 'c3',
            size: { cols: 1, minHeight: 260 },
            renderFn: 'renderTokenStats_c3_daily'
          },
          {
            id: 'ts-c4',
            titleKey: 'tokenStatsChartC4',
            type: 'bar-stacked',
            engine: 'echarts',
            canvasId: 'c4',
            size: { cols: 1, minHeight: 260 },
            renderFn: 'renderTokenStats_c4_hourly'
          },
          {
            id: 'ts-hosts',
            titleKey: 'chartTokenHosts',
            type: 'bar-stacked',
            engine: 'echarts',
            canvasId: 'c1-hosts',
            size: { cols: 1, minHeight: 260 },
            renderFn: 'renderTokenStats_c1hosts'
          }
        ]
      },

      // ── Forensic Analysis ──────────────────────────────────────
      {
        id: 'forensic',
        titleKey: 'sectionForensic',
        domId: 'forensic-collapse',
        sectionRenderFn: 'renderForensicSection',
        reorderable: true,
        defaultOpen: true,
        dataSource: '/api/usage',
        requires: ['usage'],
        charts: [
          {
            id: 'forensic-hitlimit',
            titleKey: 'chartForensicHitLimit',
            type: 'mixed',
            engine: 'echarts',
            canvasId: 'c-forensic',
            size: { cols: 1, minHeight: 260 },
            renderFn: 'renderForensic_main'
          },
          {
            id: 'forensic-signals',
            titleKey: 'chartForensicSignals',
            type: 'bar-stacked',
            engine: 'echarts',
            canvasId: 'c-forensic-signals',
            size: { cols: 1, minHeight: 260 },
            renderFn: 'renderForensic_signals'
          },
          {
            id: 'forensic-service',
            titleKey: 'chartForensicService',
            type: 'bar-stacked',
            engine: 'echarts',
            canvasId: 'c-service',
            size: { cols: 1, minHeight: 260 },
            renderFn: 'renderForensic_service'
          }
        ]
      },

      // ── User Profile ───────────────────────────────────────────
      {
        id: 'user-profile',
        titleKey: 'sectionUserProfile',
        domId: 'user-profile-collapse',
        sectionRenderFn: 'renderUserProfileCharts',
        reorderable: true,
        defaultOpen: false,
        dataSource: '/api/usage',
        requires: ['usage'],
        charts: [
          {
            id: 'user-versions',
            titleKey: 'chartUserVersions',
            type: 'bar-horizontal',
            engine: 'echarts',
            canvasId: 'c-user-versions',
            size: { cols: 1, minHeight: 300 },
            renderFn: 'renderUserProfile_versions'
          },
          {
            id: 'user-entrypoints',
            titleKey: 'chartUserEntrypoints',
            type: 'bar-horizontal',
            engine: 'echarts',
            canvasId: 'c-user-entrypoints',
            size: { cols: 1, minHeight: 300 },
            renderFn: 'renderUserProfile_entrypoints'
          },
          {
            id: 'user-release-stability',
            titleKey: 'chartUserReleaseStability',
            type: 'bar-horizontal',
            engine: 'echarts',
            canvasId: 'c-user-release-stability',
            size: { cols: 1, minHeight: 300 },
            renderFn: 'renderUserProfile_releaseStability'
          }
        ]
      },

      // ── Budget Efficiency ──────────────────────────────────────
      {
        id: 'budget',
        titleKey: 'sectionBudget',
        domId: 'budget-collapse',
        sectionRenderFn: 'renderBudgetEfficiency',
        reorderable: true,
        defaultOpen: false,
        dataSource: '/api/usage',
        requires: ['usage'],
        charts: [
          {
            id: 'budget-sankey',
            titleKey: 'chartBudgetSankey',
            type: 'sankey',
            engine: 'echarts',
            canvasId: 'budget-sankey-container',
            size: { cols: 2, minHeight: 350 },
            renderFn: 'renderBudget_sankey'
          },
          {
            id: 'budget-trend',
            titleKey: 'chartBudgetTrend',
            type: 'line',
            engine: 'echarts',
            canvasId: 'c-budget-trend',
            size: { cols: 1, minHeight: 260 },
            renderFn: 'renderBudget_trend'
          },
          {
            id: 'budget-quota',
            titleKey: 'chartBudgetQuota',
            type: 'line',
            engine: 'echarts',
            canvasId: 'c-budget-quota',
            size: { cols: 1, minHeight: 260 },
            renderFn: 'renderBudget_quota'
          }
        ]
      },

      // ── Proxy Analytics ────────────────────────────────────────
      {
        id: 'proxy',
        titleKey: 'sectionProxy',
        domId: 'proxy-collapse',
        sectionRenderFn: 'renderProxyAnalysis',
        reorderable: true,
        defaultOpen: false,
        dataSource: '/api/usage',
        requires: ['usage'],
        charts: [
          {
            id: 'proxy-tokens',
            titleKey: 'proxyTokenChartTitle',
            type: 'bar-stacked',
            engine: 'echarts',
            canvasId: 'c-proxy-tokens',
            size: { cols: 1, minHeight: 260 },
            renderFn: 'renderProxy_tokens'
          },
          {
            id: 'proxy-latency',
            titleKey: 'proxyLatencyChartTitle',
            type: 'line',
            engine: 'echarts',
            canvasId: 'c-proxy-latency',
            size: { cols: 1, minHeight: 260 },
            renderFn: 'renderProxy_latency'
          },
          {
            id: 'proxy-hourly',
            titleKey: 'proxyHourlyTitle',
            type: 'bar',
            engine: 'echarts',
            canvasId: 'c-proxy-hourly',
            size: { cols: 1, minHeight: 200 },
            renderFn: 'renderProxy_hourly'
          },
          {
            id: 'proxy-models',
            titleKey: 'proxyModelTitle',
            type: 'mixed',
            engine: 'echarts',
            canvasId: 'c-proxy-models',
            size: { cols: 1, minHeight: 260 },
            renderFn: 'renderProxy_models'
          },
          {
            id: 'proxy-hourly-latency',
            titleKey: 'proxyHourlyLatencyTitle',
            type: 'bar',
            engine: 'echarts',
            canvasId: 'c-proxy-hourly-latency',
            size: { cols: 1, minHeight: 200 },
            renderFn: 'renderProxy_hourlyLatency'
          },
          {
            id: 'proxy-error-trend',
            titleKey: 'proxyErrorTrendTitle',
            type: 'line',
            engine: 'echarts',
            canvasId: 'c-proxy-error-trend',
            size: { cols: 1, minHeight: 200 },
            renderFn: 'renderProxy_errorTrend'
          },
          {
            id: 'proxy-cache-trend',
            titleKey: 'proxyCacheTrendTitle',
            type: 'mixed',
            engine: 'echarts',
            canvasId: 'c-proxy-cache-trend',
            size: { cols: 1, minHeight: 200 },
            renderFn: 'renderProxy_cacheTrend'
          }
        ]
      },

      // ── Anthropic Status ───────────────────────────────────────
      {
        id: 'anthropic-status',
        titleKey: 'sectionAnthropicStatus',
        domId: null,
        reorderable: false,
        defaultOpen: false,
        dataSource: '/api/usage',
        requires: ['usage', 'status'],
        charts: [
          {
            id: 'status-uptime',
            titleKey: 'chartStatusUptime',
            type: 'bar-stacked',
            engine: 'echarts',
            canvasId: 'c-uptime-chart',
            size: { cols: 1, minHeight: 260 },
            renderFn: 'renderStatus_uptime'
          },
          {
            id: 'status-incidents',
            titleKey: 'chartStatusIncidents',
            type: 'mixed',
            engine: 'echarts',
            canvasId: 'c-incident-history',
            size: { cols: 1, minHeight: 260 },
            renderFn: 'renderStatus_incidents'
          },
          {
            id: 'status-outage-scatter',
            titleKey: 'chartStatusOutageScatter',
            type: 'mixed',
            engine: 'echarts',
            canvasId: 'c-anthropic-incidents',
            size: { cols: 1, minHeight: 260 },
            renderFn: 'renderStatus_outageScatter'
          },
          {
            id: 'status-outage-timeline',
            titleKey: 'chartStatusOutageTimeline',
            type: 'bar-stacked',
            engine: 'echarts',
            canvasId: 'c-outage-timeline',
            size: { cols: 1, minHeight: 260 },
            renderFn: 'renderStatus_outageTimeline'
          }
        ]
      },

      // ── Economic Usage (already ECharts) ───────────────────────
      {
        id: 'economic',
        titleKey: 'sectionEconomic',
        domId: 'economic-collapse',
        sectionRenderFn: 'renderEconomicSection',
        reorderable: true,
        defaultOpen: false,
        lazy: true,
        dataSource: '/api/session-turns',
        requires: ['sessions'],
        charts: [
          {
            id: 'econ-cumulative',
            titleKey: 'econWasteTitle',
            type: 'line',
            engine: 'echarts',
            canvasId: 'chart-shell-econ-waste',
            size: { cols: 1, minHeight: 350 },
            renderFn: 'renderWasteCurve'
          },
          {
            id: 'econ-explosion',
            titleKey: 'econExplosionTitle',
            type: 'scatter',
            engine: 'echarts',
            canvasId: 'chart-shell-econ-explosion',
            size: { cols: 2, minHeight: 350 },
            renderFn: 'renderCacheExplosion'
          },
          {
            id: 'econ-budget-drain',
            titleKey: 'econBudgetDrainTitle',
            type: 'mixed',
            engine: 'echarts',
            canvasId: 'chart-shell-econ-drain',
            size: { cols: 3, minHeight: 400 },
            renderFn: 'renderBudgetDrain'
          },
        ]
      },

      // ── Efficiency Range (nested in Economic, already ECharts) ─
      {
        id: 'efficiency-range',
        titleKey: 'sectionEfficiencyRange',
        domId: 'econ-range-collapse',
        reorderable: false,
        defaultOpen: false,
        parentSection: 'economic',
        dataSource: '/api/session-turns',
        requires: ['sessions'],
        charts: [
          {
            id: 'eff-efficiency-timeline',
            titleKey: 'econEfficiencyTitle',
            type: 'bar',
            engine: 'echarts',
            canvasId: 'chart-shell-econ-efficiency',
            size: { cols: 1, minHeight: 300 },
            renderFn: 'renderEfficiencyTimeline'
          },
          {
            id: 'eff-monthly-butterfly',
            titleKey: 'econWasteMonthTitle',
            type: 'bar',
            engine: 'echarts',
            canvasId: 'chart-shell-econ-waste-month',
            size: { cols: 1, minHeight: 300 },
            renderFn: 'renderMonthlyButterfly'
          },
          {
            id: 'eff-day-comparison',
            titleKey: 'econDayCompTitle',
            type: 'mixed',
            engine: 'echarts',
            canvasId: 'chart-shell-econ-daycompare',
            size: { cols: 1, minHeight: 300 },
            renderFn: 'renderDayComparison'
          }
        ]
      }
    ],

    // ── Lookup helpers ──────────────────────────────────────────
    findChart: function (chartId) {
      for (var si = 0; si < this.sections.length; si++) {
        var charts = this.sections[si].charts;
        for (var ci = 0; ci < charts.length; ci++) {
          if (charts[ci].id === chartId) return charts[ci];
        }
      }
      return null;
    },

    findSection: function (sectionId) {
      for (var si = 0; si < this.sections.length; si++) {
        if (this.sections[si].id === sectionId) return this.sections[si];
      }
      return null;
    },

    getSectionsSorted: function () {
      var out = this.sections.slice();
      out.sort(function (a, b) {
        return (a.order || 0) - (b.order || 0);
      });
      return out;
    },

    /**
     * @param {string|object} sectionOrId  section id or section object from findSection
     * @returns {object[]} chart defs sorted by order (mutates nothing)
     */
    getChartsSorted: function (sectionOrId) {
      var sec = typeof sectionOrId === 'string' ? this.findSection(sectionOrId) : sectionOrId;
      if (!sec || !sec.charts) return [];
      var arr = sec.charts.slice();
      arr.sort(function (a, b) {
        return (a.order || 0) - (b.order || 0);
      });
      return arr;
    },

    allCharts: function () {
      var result = [];
      for (var si = 0; si < this.sections.length; si++) {
        var charts = this.sections[si].charts;
        for (var ci = 0; ci < charts.length; ci++) {
          var c = charts[ci];
          c.section = this.sections[si].id;
          result.push(c);
        }
      }
      return result;
    },

    stats: function () {
      var all = this.allCharts();
      var engines = { chartjs: 0, echarts: 0, google: 0 };
      for (var i = 0; i < all.length; i++) {
        engines[all[i].engine] = (engines[all[i].engine] || 0) + 1;
      }
      var visibleSections = 0;
      var visibleCharts = 0;
      for (var sj = 0; sj < this.sections.length; sj++) {
        if (this.sections[sj].visible !== false) visibleSections++;
        var chs = this.sections[sj].charts || [];
        for (var cj = 0; cj < chs.length; cj++) {
          if (chs[cj].visible !== false) visibleCharts++;
        }
      }
      return {
        version: this.version,
        sections: this.sections.length,
        charts: all.length,
        visibleSections: visibleSections,
        visibleCharts: visibleCharts,
        engines: engines
      };
    }
  };

  normalizeWidgetRegistryLayer1(registry);
  window.__widgetRegistry = registry;
})();
