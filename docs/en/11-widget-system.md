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

## Template Builder (planned, DEV_MODE)

> **Status:** experimental, only visible in DEV_MODE. Visual grid builder for custom layouts — will be released for all users in a future version.

- 12-column canvas with drag-and-drop for sections and charts
- Widget pool with all available sections and charts
- Resize handles for column width (1-12)
- Live preview with real ECharts diagrams
- Templates are stored in `localStorage` under `cud_templates`

## Standalone Chart Functions

Since v1.8.0, each section has standalone `window.*` render functions:

- `renderTokenStats_c1_daily()`, `renderTokenStats_c2_daily()`, etc.
- `renderForensic_main()`, `renderForensic_signals()`, `renderForensic_service()`
- `renderProxy_tokens()`, `renderProxy_latency()`, etc.
- `renderBudget_sankey()`, `renderBudget_trend()`, `renderBudget_quota()`

Each function uses a cached section context (`window.__sectionCtx_xxx`) computed by `_computeXxxCtx()`. This allows charts to be rendered in isolation into any container.
