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
 * Usage:
 *   window.__widgetRegistry.sections  — all section definitions
 *   window.__widgetRegistry.findChart("token-hourly")  — lookup by chart ID
 *   window.__widgetRegistry.findSection("proxy")  — lookup by section ID
 */
'use strict';

(function () {
  var registry = {
    version: 1,
    sections: [
      // ── Health Score ────────────────────────────────────────────
      {
        id: 'health',
        titleKey: 'healthScoreTitle',
        defaultOpen: false,
        dataSource: '/api/usage',
        requires: ['usage'],
        charts: []
      },

      // ── Token Stats ────────────────────────────────────────────
      {
        id: 'token-stats',
        titleKey: 'sectionTokenStats',
        defaultOpen: true,
        dataSource: '/api/usage',
        requires: ['usage'],
        charts: [
          {
            id: 'token-hourly',
            titleKey: 'chartTokenHourly',
            type: 'bar-stacked',
            engine: 'echarts',
            canvasId: 'c1',
            size: { cols: 1, minHeight: 260 },
            renderFn: 'renderTokenStats_c1_hourly'
          },
          {
            id: 'token-daily',
            titleKey: 'chartTokenDaily',
            type: 'bar-stacked',
            engine: 'echarts',
            canvasId: 'c1',
            size: { cols: 1, minHeight: 260 },
            renderFn: 'renderTokenStats_c1_daily'
          },
          {
            id: 'token-hosts',
            titleKey: 'chartTokenHosts',
            type: 'bar-stacked',
            engine: 'echarts',
            canvasId: 'c1-hosts',
            size: { cols: 1, minHeight: 260 },
            renderFn: 'renderTokenStats_c1hosts'
          },
          {
            id: 'cache-ratio-hourly',
            titleKey: 'chartCacheRatioHourly',
            type: 'line',
            engine: 'echarts',
            canvasId: 'c2',
            size: { cols: 1, minHeight: 260 },
            renderFn: 'renderTokenStats_c2_hourly'
          },
          {
            id: 'cache-ratio-daily',
            titleKey: 'chartCacheRatioDaily',
            type: 'line',
            engine: 'echarts',
            canvasId: 'c2',
            size: { cols: 1, minHeight: 260 },
            renderFn: 'renderTokenStats_c2_daily'
          },
          {
            id: 'api-events-hourly',
            titleKey: 'chartApiEventsHourly',
            type: 'bar',
            engine: 'echarts',
            canvasId: 'c3',
            size: { cols: 1, minHeight: 260 },
            renderFn: 'renderTokenStats_c3_hourly'
          },
          {
            id: 'api-events-daily',
            titleKey: 'chartApiEventsDaily',
            type: 'bar',
            engine: 'echarts',
            canvasId: 'c3',
            size: { cols: 1, minHeight: 260 },
            renderFn: 'renderTokenStats_c3_daily'
          },
          {
            id: 'signals-hourly',
            titleKey: 'chartSignalsHourly',
            type: 'bar-stacked',
            engine: 'echarts',
            canvasId: 'c4',
            size: { cols: 1, minHeight: 260 },
            renderFn: 'renderTokenStats_c4_hourly'
          },
          {
            id: 'signals-daily',
            titleKey: 'chartSignalsDaily',
            type: 'bar',
            engine: 'echarts',
            canvasId: 'c4',
            size: { cols: 1, minHeight: 260 },
            renderFn: 'renderTokenStats_c4_daily'
          }
        ]
      },

      // ── Forensic Analysis ──────────────────────────────────────
      {
        id: 'forensic',
        titleKey: 'sectionForensic',
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
            canvasId: 'chart-shell-econ-budget-drain',
            size: { cols: 3, minHeight: 400 },
            renderFn: 'renderBudgetDrain'
          },
          {
            id: 'econ-token-monthly',
            titleKey: 'econWasteMonthTitle',
            type: 'bar',
            engine: 'echarts',
            canvasId: 'chart-shell-econ-waste-month',
            size: { cols: 1, minHeight: 300 },
            renderFn: 'renderMonthlyTokenChart'
          },
          {
            id: 'econ-efficiency',
            titleKey: 'econEfficiencyTitle',
            type: 'bar',
            engine: 'echarts',
            canvasId: 'chart-shell-econ-efficiency',
            size: { cols: 1, minHeight: 300 },
            renderFn: 'renderEfficiencyTimeline'
          }
        ]
      },

      // ── Efficiency Range (nested in Economic, already ECharts) ─
      {
        id: 'efficiency-range',
        titleKey: 'sectionEfficiencyRange',
        defaultOpen: false,
        parentSection: 'economic',
        dataSource: '/api/session-turns',
        requires: ['sessions'],
        charts: [
          {
            id: 'eff-day-comparison',
            titleKey: 'econDayCompTitle',
            type: 'mixed',
            engine: 'echarts',
            canvasId: 'chart-shell-econ-day-comp',
            size: { cols: 1, minHeight: 300 },
            renderFn: 'renderDayComparison'
          },
          {
            id: 'eff-heatmap',
            titleKey: 'proxyEfficiencyTrendTitle',
            type: 'heatmap',
            engine: 'echarts',
            canvasId: 'eff-heatmap',
            size: { cols: 3, minHeight: 300 },
            renderFn: 'renderEfficiencyHeatmap'
          },
          {
            id: 'eff-butterfly',
            titleKey: 'econButterflyTitle',
            type: 'bar',
            engine: 'echarts',
            canvasId: 'chart-shell-econ-butterfly',
            size: { cols: 1, minHeight: 300 },
            renderFn: 'renderButterflyChart'
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
      return {
        sections: this.sections.length,
        charts: all.length,
        engines: engines
      };
    }
  };

  window.__widgetRegistry = registry;
})();
