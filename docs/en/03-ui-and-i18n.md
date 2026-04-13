# UI, Filters, and Internationalization

[← Contents](README.md)

## UI Texts (DE/EN)

- Strings stored as **JSON** in **`tpl/de/ui.tpl`** and **`tpl/en/ui.tpl`** (file extension `.tpl`, content is valid JSON).
- **`/`** uses an **in-memory cache** (invalidated on **mtime** change of the `.tpl` files). Save → reload the page.
- **`GET /api/i18n-bundles`** returns `{ "de": …, "en": … }`.
- Keys: flat IDs (e.g. `chartDailyToken`); placeholders `{n}`, `{files}` are replaced on the client.

## Meta Line and Legend

- Below the heading: collapsible block with model hint (**only `claude-*`**, no `<synthetic>`), parse/status line, limit/data source, scan sources.
- Collapsed: short summary (e.g. log files, refresh interval).
- State: **`sessionStorage.usageMetaDetailsOpen`**.

## Day Picker (Cards and Table)

- Dropdown: all days with data (newest on top).
- **Cards** and **daily detail table**: selected day. **Charts** and **forensic section**: typically **all** days (or as set by the date-range filter).
- Selection: **`sessionStorage.usageDashboardDay`**.
- Calendar "today" with 0 tokens: brief hint displayed.

## Filters and Navigation (Top Bar)

- **Date range** start/end (dropdowns).
- **Cards & table**: day picker.
- **Charts**: **All days** vs. **24 h (selected day)**.
- **Source**: total or individual hosts — see [Multi-Host](04-multi-host-and-sync.md).
- Badges: **Live**, **Anthropic**, compressed **Meta** line (log files, refresh).

## Extension Updates (Service Impact, Reports)

- **Markers:** primarily **VS Code Marketplace** ([Version History](https://marketplace.visualstudio.com/items?itemName=anthropic.claude-code&ssr=false#version-history)) — `lastUpdated`, latest semver; aligned to **UTC calendar day**. Cache: **`~/.claude/claude-code-marketplace-versions.json`**.
- **Changelog:** **GitHub Releases** (up to 100 entries), cache **`~/.claude/claude-code-releases.json`**. Data: merge Marketplace ∪ GitHub (Marketplace date takes precedence), otherwise JSONL fallback.
- Version from JSONL: normalized to **`major.minor.patch`**. For old day caches with raw keys: run a full rescan (`CLAUDE_USAGE_NO_CACHE=1` or delete the cache file).

## Chart Engine (since v1.8.0)

- All charts use **ECharts** (Chart.js fully removed).
- Each section has **standalone render functions** (`window.renderXxx()`) that can be rendered in isolation into any container.
- Charts are registered in the **Widget Registry** (`public/js/widget-registry.js`) with `engine: "echarts"`, `canvasId`, `renderFn`.

## Sections

| Section | Description |
|---------|-------------|
| Health Score | Overall score (0-10), KPI chips, key findings |
| Token Stats | Daily/hourly charts, overhead, cache ratio |
| Forensic Analysis | Hit limit, signals, service impact |
| User Profile | Versions, entrypoints, release stability |
| Budget Efficiency | Sankey, trend, quota history |
| Proxy Analytics | Tokens, latency, models, error trend, cache trend |
| Intelligence / Predictive | Saturation, health score, narrative, seasonality (preliminary) |
| Economic Usage | Cumulative curve, cache explosion, budget drain |
| Anthropic Status | Uptime, incidents, outage timeline |

## Sidebar Settings

- **Layout**: show/hide sections, drag to reorder, adjust span (column width)
- **Templates**: load/create saved layouts
- **Settings**: language, plan (MAX5/MAX20/Pro/Free/API), user settings
- **Tools**: file explorer
- **Export**: JSONL export, template import/export

Details on the widget system: [Chapter 11](11-widget-system.md).
