# Widget-System und Template Builder

[← Inhaltsverzeichnis](README.md)

## Architektur

Das Widget-System besteht aus drei Schichten:

1. **Widget Registry** (`public/js/widget-registry.js`) — zentrales Manifest aller Sections und Charts
2. **Widget Dispatcher** (`public/js/widget-dispatcher.js`) — Orchestrierung: Render-Dispatch, Sichtbarkeit, Reihenfolge, Grid-Layout
3. **Layout-Datei** (`~/.claude/usage-dashboard-layout.json`) — persistierte Benutzereinstellungen

## Widget Registry

Jede Section und jeder Chart hat einen Eintrag mit:

- `id` — eindeutiger Bezeichner (z. B. `proxy`, `ts-c1`)
- `titleKey` — i18n-Schluessel fuer den Anzeigenamen
- `domId` — ID des `<details>`-Elements im DOM
- `sectionRenderFn` — Name der globalen Render-Funktion (`window[fnName]`)
- `reorderable` — ob die Section per Drag verschiebbar ist
- `charts[]` — Liste der Charts in der Section mit `canvasId`, `engine`, `renderFn`

Registry-Version: **v3** mit Layer 1 (visible, order, tags) und Layer 2 (domId, sectionRenderFn, companionIds).

### Chart-Typen

- `kind: "chip"` — KPI-Karten (HTML, kein ECharts)
- `engine: "echarts"` — ECharts-Diagramme (alle Charts seit v1.8.0)
- `type` — Darstellungstyp: `bar`, `line`, `mixed`, `sankey`, `scatter`, etc.

## 12-Spalten Grid Layout

Das Dashboard nutzt ein CSS-Grid mit 12 Spalten (`#layout-grid`). Jede Section bekommt ein `data-span`-Attribut (1-12) das die Breite steuert.

### Layout-Datei

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

- **`widgets[]`** steuert Reihenfolge und Spaltenbreite
- **`hiddenSections[]`** / **`hiddenCharts[]`** steuern Sichtbarkeit
- **Datei = Single Source of Truth** — wird beim Laden priorisiert, localStorage dient als Fallback
- **Speichern**: synchroner PUT an `/api/layout`

### Sidebar-Steuerung

- **Layout-Bereich**: Checkboxen fuer Sichtbarkeit, Drag-Reorder im Edit-Modus
- **Reset**: erstellt Default-Widgets (alle Sections, span 12) und reloaded
- Sidebar oeffnet sich automatisch wenn `cud_sidebar_open` in localStorage gesetzt ist

## Template Builder (geplant, DEV_MODE)

> **Status:** experimentell, nur im DEV_MODE sichtbar. Visueller Grid-Builder fuer benutzerdefinierte Layouts — wird in einer zukuenftigen Version fuer alle Nutzer freigegeben.

- 12-Spalten Canvas mit Drag-and-Drop fuer Sections und Charts
- Widget Pool mit allen verfuegbaren Sections und Charts
- Resize-Handles fuer Spaltenbreite (1-12)
- Live Preview mit echten ECharts-Diagrammen
- Templates werden in `localStorage` unter `cud_templates` gespeichert

## Standalone Chart-Funktionen

Seit v1.8.0 hat jede Section standalone `window.*` Render-Funktionen:

- `renderTokenStats_c1_daily()`, `renderTokenStats_c2_daily()`, etc.
- `renderForensic_main()`, `renderForensic_signals()`, `renderForensic_service()`
- `renderProxy_tokens()`, `renderProxy_latency()`, etc.
- `renderBudget_sankey()`, `renderBudget_trend()`, `renderBudget_quota()`

Jede Funktion nutzt einen gecachten Section-Context (`window.__sectionCtx_xxx`), der von `_computeXxxCtx()` berechnet wird. So koennen Charts isoliert in beliebige Container gerendert werden.
