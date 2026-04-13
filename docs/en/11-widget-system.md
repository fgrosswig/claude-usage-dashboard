# Widget System and Template Builder

[← Table of Contents](README.md)

## Architecture

The widget system consists of three layers:

1. **Widget Registry** (`public/js/widget-registry.js`) — central manifest of all sections and charts
2. **Widget Dispatcher** (`public/js/widget-dispatcher.js`) — orchestration: render dispatch, visibility, ordering, grid layout
3. **Layout File** (`~/.claude/usage-dashboard-layout.json`) — persisted user settings

## Widget Registry

Each section and chart has an entry with:

- `id` — unique identifier (e.g. `proxy`, `ts-c1`)
- `titleKey` — i18n key for the display name
- `domId` — ID of the `<details>` element in the DOM
- `sectionRenderFn` — name of the global render function (`window[fnName]`)
- `reorderable` — whether the section can be reordered via drag
- `charts[]` — list of charts in the section with `canvasId`, `engine`, `renderFn`

Registry version: **v3** with Layer 1 (visible, order, tags) and Layer 2 (domId, sectionRenderFn, companionIds).

### Chart Types

- `kind: "chip"` — KPI cards (HTML, no ECharts)
- `engine: "echarts"` — ECharts diagrams (all charts since v1.8.0)
- `type` — display type: `bar`, `line`, `mixed`, `sankey`, `scatter`, etc.

## 12-Column Grid Layout

The dashboard uses a CSS grid with 12 columns (`#layout-grid`). Each section gets a `data-span` attribute (1-12) controlling its width.

### Layout File

```json
{
  "v": 1,
  "order": ["health", "token-stats", "forensic", ...],
  "hiddenSections": [],
  "hiddenCharts": [],
  "widgets": [
    { "id": "health", "span": 12 },
    { "id": "token-stats", "span": 12 },
    ...
  ]
}
```

- **`widgets[]`** controls order and column width
- **`hiddenSections[]`** / **`hiddenCharts[]`** control visibility
- **File = single source of truth** — prioritized on load, localStorage serves as fallback
- **Save**: synchronous PUT to `/api/layout`

### Sidebar Controls

- **Layout section**: checkboxes for visibility, drag-reorder in edit mode
- **Reset**: creates default widgets (all sections, span 12) and reloads
- Sidebar auto-opens if `cud_sidebar_open` is set in localStorage

## Template Builder

Visual grid builder for custom dashboard layouts. Open via **"Template erstellen"** in the sidebar.

### Layout (3-Column)

```text
┌──────────────┬────────────────────────────┬──────────────┐
│  CHART POOL  │       CANVAS (12-Grid)     │  CHIP / HTML │
│              │                            │     POOL     │
│  ECharts     │  Sections (collapsible)    │  KPI cards   │
│  diagrams    │    └─ Layout blocks        │  Health      │
│  drag into   │       └─ Charts (span)     │  badges      │
│  canvas      │                            │  Meta grids  │
│              │  Resize handles (1-12)     │              │
│              │  Drag reorder              │              │
└──────────────┴────────────────────────────┴──────────────┘
```

- **Left — Chart Pool**: all ECharts diagrams from the registry, drag-and-drop into the canvas
- **Center — Canvas**: 12-column grid with collapsible sections. Each section contains layout blocks (rows) with charts inside. Sections and charts have resize handles (span 1-12) and can be reordered via drag
- **Right — Chip/HTML Pool**: KPI cards, health badges and other HTML widgets (non-ECharts)

### Usage

1. **Select template**: choose a built-in or custom template from the dropdown (header)
2. **"Load layout"**: loads the selected template into the canvas
3. **Add sections**: from the sections strip above the canvas
4. **Place charts**: drag from the left pool into layout blocks
5. **Layout blocks**: create new rows via the span buttons (1-12) below each section
6. **Resize**: change column width by clicking the span indicator (section or chart)
7. **Preview**: preview with real ECharts diagrams and KPI chips (responsive)
8. **Save**: saves as a named template and applies it to the dashboard immediately

### Templates

- **Built-in**: Full (all sections), Performance (Forensic + Economic + Token-Stats), Cost (Economic + Budget + Proxy), Compact (6 sections, mixed spans)
- **Custom templates**: assigned a name on save; appear in the sidebar under "Templates" and in the builder dropdown (marked with `*`)
- **Persistence**: templates are persisted server-side in the layout file (`~/.claude/usage-dashboard-layout.json`) under the `templates` key (localStorage as fallback)

### Scaffold Plan

On first visit (no layout file), `buildDefaultWidgetsFromScaffold()` automatically generates a layout from the **scaffold plan** (`TB_PAGE_SCAFFOLD_PLAN`). This defines per section the layout blocks (rows with 12-column spans) and chart assignments. The scaffold also serves as the base when built-in templates are loaded into the builder.

## Standalone Chart Functions

Since v1.8.0, each section has standalone `window.*` render functions:

- `renderTokenStats_c1_daily()`, `renderTokenStats_c2_daily()`, etc.
- `renderForensic_main()`, `renderForensic_signals()`, `renderForensic_service()`
- `renderProxy_tokens()`, `renderProxy_latency()`, etc.
- `renderBudget_sankey()`, `renderBudget_trend()`, `renderBudget_quota()`

Each function uses a cached section context (`window.__sectionCtx_xxx`) computed by `_computeXxxCtx()`. This allows charts to be rendered in isolation into any container.
