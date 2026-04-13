# UI, Filter und Internationalisierung

[← Inhaltsverzeichnis](README.md)

## UI-Texte (DE/EN)

- Texte als **JSON** in **`tpl/de/ui.tpl`** und **`tpl/en/ui.tpl`** (Endung `.tpl`, Inhalt gültiges JSON).
- **`/`** nutzt **In-Memory-Cache** (invalidiert bei **mtime**-Änderung der `.tpl`-Dateien). Speichern → Seite neu laden.
- **`GET /api/i18n-bundles`** liefert `{ "de": …, "en": … }`.
- Schlüssel: flache IDs (z. B. `chartDailyToken`); Platzhalter `{n}`, `{files}` werden im Client ersetzt.

## Meta-Zeile und Legende

- Unter der Überschrift: aufklappbarer Block mit Modell-Hinweis (**nur `claude-*`**, kein `<synthetic>`), Parse-/Statuszeile, Limit-/Datenquelle, Scan-Quellen.
- Zugeklappt: Kurzsummary (z. B. Log-Dateien, Refresh-Intervall).
- Zustand: **`sessionStorage.usageMetaDetailsOpen`**.

## Tag wählen (Karten und Tabelle)

- Dropdown: alle Tage mit Daten (neueste oben).
- **Karten** und **Tagesdetail-Tabelle**: gewählter Tag. **Diagramme** und **Forensic-Bereich**: in der Regel **alle** Tage (bzw. wie gewählter Zeitraumfilter).
- Auswahl: **`sessionStorage.usageDashboardDay`**.
- Kalender-„heute“ mit 0 Tokens: kurzer Hinweis.

## Filter und Navigation (Top-Bar)

- **Zeitraum** Start/Ende (Dropdowns).
- **Karten & Tabelle**: Tag-Picker.
- **Diagramme**: **Alle Tage** vs. **24 h (gewählter Tag)**.
- **Quelle**: Gesamt oder einzelne Hosts — siehe [Multi-Host](04-multi-host-und-datensync.md).
- Badges: **Live**, **Anthropic**, komprimierte **Meta**-Zeile (Log-Dateien, Refresh).

## Extension-Updates (Service-Impact, Reports)

- **Marker:** primär **VS Code Marketplace** ([Version History](https://marketplace.visualstudio.com/items?itemName=anthropic.claude-code&ssr=false#version-history)) — `lastUpdated`, neueste Semver; auf **UTC-Kalendertag**. Cache: **`~/.claude/claude-code-marketplace-versions.json`**.
- **Changelog:** **GitHub Releases** (bis 100 Einträge), Cache **`~/.claude/claude-code-releases.json`**. Daten: Merge Marketplace ∪ GitHub (Marketplace-Datum hat Vorrang), sonst JSONL-Fallback.
- Version aus JSONL: normalisiert **`major.minor.patch`**. Bei alten Day-Caches mit rohen Keys: einmal Vollscan (`CLAUDE_USAGE_NO_CACHE=1` oder Cache-Datei löschen).

## Chart-Engine (seit v1.8.0)

- Alle Diagramme nutzen **ECharts** (Chart.js komplett entfernt).
- Jede Section hat **standalone Render-Funktionen** (`window.renderXxx()`), die isoliert in beliebige Container gerendert werden koennen.
- Charts sind im **Widget Registry** (`public/js/widget-registry.js`) registriert mit `engine: "echarts"`, `canvasId`, `renderFn`.

## Sections

| Section | Beschreibung |
|---------|-------------|
| Health Score | Gesamt-Score (0-10), KPI-Chips, Kernbefunde |
| Token-Statistiken | Tages-/Stunden-Charts, Overhead, Cache-Ratio |
| Forensische Analyse | Hit-Limit, Signale, Service Impact |
| Benutzerprofil | Versionen, Entrypoints, Release-Stabilitaet |
| Budget-Effizienz | Sankey, Trend, Quota-Verlauf |
| Proxy-Analyse | Tokens, Latenz, Modelle, Fehler-Trend, Cache-Trend |
| Intelligence / Predictive | Saturation, Health Score, Narrative, Seasonality (vorlaeufig) |
| Oekonomische Nutzung | Kumulative Kurve, Cache-Explosion, Budget Drain |
| Anthropic Status | Uptime, Incidents, Outage-Timeline |

## Sidebar-Einstellungen

- **Layout**: Sections ein-/ausblenden, Reihenfolge per Drag aendern, Span (Spaltenbreite) anpassen
- **Vorlagen**: gespeicherte Layouts laden/erstellen
- **Einstellungen**: Sprache, Plan (MAX5/MAX20/Pro/Free/API), Benutzer-Einstellungen
- **Werkzeuge**: Datei-Explorer
- **Export**: JSONL-Export, Template Import/Export

Details zum Widget-System: [Kapitel 11](11-widget-system.md).
