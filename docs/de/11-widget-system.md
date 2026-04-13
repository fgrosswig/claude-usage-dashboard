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

## Template Builder

Visueller Grid-Builder fuer benutzerdefinierte Dashboard-Layouts. Oeffnen ueber **"Template erstellen"** in der Sidebar.

### Aufbau (3-Spalten-Layout)

```text
┌──────────────┬────────────────────────────┬──────────────┐
│  CHART POOL  │       CANVAS (12-Grid)     │  CHIP / HTML │
│              │                            │     POOL     │
│  ECharts-    │  Sections (aufklappbar)    │  KPI-Karten  │
│  Diagramme   │    └─ Layout-Bloecke       │  Health-     │
│  per Drag    │       └─ Charts (span)     │  Badges      │
│  ins Canvas  │                            │  Meta-Grids  │
│  ziehen      │  Resize-Handles (1-12)     │              │
│              │  Drag-Reorder              │              │
└──────────────┴────────────────────────────┴──────────────┘
```

- **Links — Chart Pool**: alle ECharts-Diagramme aus der Registry, per Drag-and-Drop ins Canvas ziehbar
- **Mitte — Canvas**: 12-Spalten Grid mit aufklappbaren Sections. Jede Section enthaelt Layout-Bloecke (Zeilen) mit Charts darin. Sections und Charts haben Resize-Handles (span 1-12) und koennen per Drag umsortiert werden
- **Rechts — Chip/HTML Pool**: KPI-Karten, Health-Badges und andere HTML-Widgets (nicht-ECharts)

### Bedienung

1. **Template waehlen**: im Dropdown (Header) ein Built-in oder eigenes Template auswaehlen
2. **"Layout uebernehmen"**: laedt das gewaehlte Template in den Canvas
3. **Sections hinzufuegen**: aus dem Sections-Strip oberhalb des Canvas
4. **Charts platzieren**: aus dem linken Pool per Drag in Layout-Bloecke ziehen
5. **Layout-Bloecke**: ueber die Span-Buttons (1-12) unter jeder Section neue Zeilen anlegen
6. **Resize**: Spaltenbreite per Klick auf die Span-Anzeige aendern (Section oder Chart)
7. **Preview**: Vorschau mit echten ECharts-Diagrammen und KPI-Chips (responsive)
8. **Save**: speichert als benanntes Template und wendet es sofort auf das Dashboard an

### Templates

- **Built-in**: Full (alle Sections), Performance (Forensic + Economic + Token-Stats), Cost (Economic + Budget + Proxy), Compact (6 Sections, gemischte Spans)
- **Eigene Templates**: beim Speichern wird ein Name vergeben; erscheinen in der Sidebar unter "Vorlagen" und im Builder-Dropdown (mit `*` markiert)
- **Persistence**: Templates werden serverseitig in der Layout-Datei (`~/.claude/usage-dashboard-layout.json`) unter dem Key `templates` persistiert (localStorage als Fallback)

### Scaffold-Plan

Beim ersten Besuch (keine Layout-Datei vorhanden) generiert `buildDefaultWidgetsFromScaffold()` automatisch ein Layout aus dem **Scaffold-Plan** (`TB_PAGE_SCAFFOLD_PLAN`). Dieser definiert pro Section die Layout-Bloecke (Zeilen mit 12-Spalten-Spans) und die Chart-Zuordnung. Der Scaffold dient auch als Basis wenn Built-in Templates in den Builder geladen werden.

## Standalone Chart-Funktionen

Seit v1.8.0 hat jede Section standalone `window.*` Render-Funktionen:

- `renderTokenStats_c1_daily()`, `renderTokenStats_c2_daily()`, etc.
- `renderForensic_main()`, `renderForensic_signals()`, `renderForensic_service()`
- `renderProxy_tokens()`, `renderProxy_latency()`, etc.
- `renderBudget_sankey()`, `renderBudget_trend()`, `renderBudget_quota()`

Jede Funktion nutzt einen gecachten Section-Context (`window.__sectionCtx_xxx`), der von `_computeXxxCtx()` berechnet wird. So koennen Charts isoliert in beliebige Container gerendert werden.
