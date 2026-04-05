**[English](README.en.md)** · Deutsch

## Claude Usage Dashboard (`claude-usage-dashboard.js`)

Standalone Node-Server (ohne npm-Abhängigkeiten im Skript), liest **Claude Code**-Logs unter **`~/.claude/projects/**/*.jsonl`** und zeigt Token-Nutzung, Limits (heuristisch) und Forensics in einer Web-UI. Es werden nur **`claude-*`**-Modelle gezählt (kein `<synthetic>`).

### UI-Texte (DE/EN, dynamisch)

- Alle Beschriftungen der Web-Oberfläche liegen als **JSON** unter **`tpl/de/ui.tpl`** und **`tpl/en/ui.tpl`** (Dateiendung `.tpl`, Inhalt gültiges JSON).
- **`/`** nutzt einen **In-Memory-Cache** (invalidiert sich, wenn sich die **mtime** von `tpl/de/ui.tpl` oder `tpl/en/ui.tpl` ändert): kein erneutes Einlesen/String-Replace pro Request. Texte ändern → Datei speichern → **Seite neu laden**.
- **`GET /api/i18n-bundles`** liefert dieselben Bundles (ebenfalls aus dem Cache, solange mtime gleich).
- **Erster Daten-Scan:** Der Server sendet **Zwischenstände per SSE** (`scan_progress`: gelesene Dateien / Gesamtzahl); Karten und Diagramme **füllen sich schrittweise** (Diagramm-Redraw ca. alle **420 ms** im Browser, damit es nicht ruckelt). Optional **`CLAUDE_USAGE_SCAN_FILES_PER_TICK`** — mehr JSONL pro Tick (Standard **20**, Bereich **1–80**; zu hoch = kurzes Stocken von HTTP/SSE während des Scans).
- Schlüssel sind flache String-IDs (z. B. `chartDailyToken`); Platzhalter wie `{n}` oder `{files}` werden im Client ersetzt.

### Start

```bash
node claude-usage-dashboard.js
```

### Optionen

```bash
node claude-usage-dashboard.js --port=4444 --refresh=15
```

- **`--port`**: HTTP-Port (Standard `3333`).
- **`--refresh`**: Sekunden bis zum nächsten Scan + SSE-Push (Minimum `5`, Standard `30`).

### Live-Updates

- Beim Öffnen der Seite: **`fetch('/api/usage')`** für den aktuellen Cache, parallel **SSE** (`/api/stream`).
- Grüner Punkt oben rechts = verbunden; Daten aktualisieren sich mit dem konfigurierten Intervall ohne manuellen Reload.
- Rot = Verbindungsabbruch, Browser versucht erneut zu verbinden.

### Schneller Start / Scan im Hintergrund

- Der Server **lauscht sofort**; der erste Parse läuft **nicht** blockierend vor `listen`.
- JSONL werden **in Batches** verarbeitet (`setImmediate` zwischen Dateigruppen), damit HTTP/SSE währenddessen bedienbar bleibt.
- Vor dem ersten fertigen Scan: Stub mit `scanning: true` und Hinweistext in der UI.

### Tages-Cache (Vortage in einer JSON)

- Datei: **`~/.claude/usage-dashboard-days.json`**
- Wenn **Cache-Version**, **Scan-Wurzeln** und **Anzahl** der `.jsonl`-Dateien passen, werden **Vortage** aus dieser Datei geladen und aus den Logs nur noch der **lokale Kalendertag „heute“** voll mitgezählt (schnellere Refreshes). Pro-Tag-**`hosts`** sind ab Cache-Version **3** enthalten.
- **Vollscan** erzwingen: Umgebung **`CLAUDE_USAGE_NO_CACHE=1`** (oder `true`), **oder** Cache-Datei löschen, **oder** neue/entfernte `.jsonl` (andere Dateianzahl), **oder** andere **`CLAUDE_USAGE_EXTRA_BASES`** / andere Scan-Wurzeln (Cache enthält `scan_roots_key`).

### Weitere Rechner / importierte Logs (`CLAUDE_USAGE_EXTRA_BASES`)

Unter Linux und Windows unterschiedliche Pfade sind normal. Du kannst z. B. von einem anderen Host kopiertes **`projects`**-Baumwerk (oder nur relevante `.jsonl`-Ordner) irgendwo ablegen — sinnvoll z. B. als Ordner **`HOST-B`** — und zusätzlich einscannen:

- Umgebungsvariable **`CLAUDE_USAGE_EXTRA_BASES`**: ein oder mehrere Verzeichnisse, **mit `;` getrennt** (funktioniert auf Linux und Windows gleich).
- **Kurzform:** `true`, `1`, `yes`, `auto` oder `on` — dann werden unter **`CLAUDE_USAGE_EXTRA_BASES_ROOT`** (falls leer: **aktuelles Arbeitsverzeichnis** beim Start von Node) alle **Unterordner**, deren Name mit **`HOST-`** beginnt (z. B. `HOST-B`, `HOST-C`), als zusätzliche Wurzeln eingebunden (alphabetisch sortiert).
- Pfade dürfen **`~`** am Anfang nutzen oder absolut sein.
- **Label in der UI** = letzter Pfadbestandteil des jeweiligen Eintrags (z. B. `HOST-B` bei `.../imports/HOST-B`).
- Alle Quellen werden in **dieselben Tages-Aggregate** gemischt (eine gemeinsame Nutzungsansicht). **Doppelte** absolute Dateipfade werden nur **einmal** gezählt (z. B. identische Kopie unter zwei Wurzeln).
- **Pro Host:** In der API hat jeder Tag ein Objekt **`hosts`** (Schlüssel = Label, z. B. `local`, `HOST-B`) mit Total, Output, Calls, Hit-Limit, **`sub_cache`** / **`sub_cache_pct`** usw. In der UI erscheinen bei **mehreren Wurzeln** zusätzliche **Karten** und **Tabellenzeilen** pro Host (gewählter Tag) sowie ein **gestapeltes Balkendiagramm** „Total-Tokens pro Tag nach Host“ (Summe aller Hosts = Gesamttag wie das bestehende Token-Chart).
- **Subagent-Cache %:** Bei mehreren Wurzeln sind die Balken **gestapelt**: jedes Segment ist **Subagent-Cache dieses Hosts / Cache-Read des ganzen Tags** (in %); die **Stapelhöhe** entspricht dem Tageswert **Subagent-Cache % vom Gesamt-Cache** (Summe der Segmente; kleine Abweichungen nur durch Rundung).
- **Tagesdetail:** Klick auf eine **Host-Unterzeile** (`└ HOST-…`) zeigt nur noch diesen Host in der Tabelle (Überschrift enthält den Namen). Zurück: Button **„Alle Hosts“** oder Klick auf die **eine** gefilterte Zeile. **Anderer Tag** im Dropdown setzt den Host-Filter zurück.

Beispiel:

```bash
export CLAUDE_USAGE_EXTRA_BASES="$HOME/.claude/imports/HOST-B"
node claude-usage-dashboard.js
```

Mehrere Ordner:

```bash
export CLAUDE_USAGE_EXTRA_BASES="$HOME/sync/win-projects;$HOME/.claude/imports/HOST-B"
```

Unterordner `HOST-*` automatisch (Root = aktuelles Verzeichnis):

```bash
export CLAUDE_USAGE_EXTRA_BASES=true
cd /pfad/zu/parent-mit-HOST-B-und-HOST-C
node /pfad/zu/claude-usage-dashboard.js
```

Eigener Parent-Ordner (Windows PowerShell):

```powershell
$env:CLAUDE_USAGE_EXTRA_BASES = "true"
$env:CLAUDE_USAGE_EXTRA_BASES_ROOT = "C:\Temp"
node claude-usage-dashboard.js
```

### Meta-Zeile & Legende (einklappbar)

- Unter der Hauptüberschrift: **aufklappbarer** Block (`<details>`) für Modell-Hinweis (**nur `claude-*`**, kein `<synthetic>`), die **volle Parse-/Statuszeile** (inkl. Cache-Modus und Hinweis zu Karten vs. Diagrammen), **Limit-/Datenquelle** und **Scan-Quellen** (mehrere Wurzeln).
- **Zugeklappt** siehst du nur eine **kurze Summary** (z. B. Anzahl Log-Dateien und Refresh-Intervall).
- **Aufgeklappt** ist der Text **kleiner** gesetzt, damit die Karten schneller ins Blickfeld rücken.
- Ob der Block offen ist, steuert **`sessionStorage`** unter **`usageMetaDetailsOpen`** (bleibt nach Reload erhalten).

### UI: Tag wählen (Karten & Tabelle)

- **Dropdown** „Karten & Tabelle (Tag wählen)“: alle Tage mit Daten (neueste oben).
- **Karten** und **Tagesdetail-Tabelle** beziehen sich auf den **gewählten** Tag; **Diagramme** und **Forensic-Chart** weiterhin über **alle** Tage.
- Auswahl wird in **`sessionStorage`** unter **`usageDashboardDay`** gespeichert.
- Wenn **Kalender-„heute“** in den Logs **0 Tokens** hat, erscheint ein kurzer Hinweis (älteren Tag wählen).

### Repository & `.gitignore`

- Im Repo u. a.: **`/HOST*/`** (lokale Import-Kopien), **`test_node*.js`**, **`node_modules/`**, **`.env` / `.env.*`** (mit Ausnahme optionaler **`.env.example`**). Details in **`.gitignore`** — verhindert, dass Log-Importe oder Secrets versehentlich committed werden.

### Limits & Forensic (nur Heuristik)

- **Datenquelle** in der UI: generisch **`~/.claude/projects`** (keine absoluten Pfade mit Benutzernamen in der Anzeige/API).
- **Hit Limit (rot in Charts):** Zählt JSONL-Zeilen mit typischen Rate-/Limit-Mustern — **kein** direkter Anthropic-API-Nachweis.
- **Forensic** (einklappbar): Codes **`?`** (sehr hoher Cache-Read), **`HIT`** (Limit-Zeilen in Logs), **`<<P`** (strenger Peak-Vergleich mit Mindest-Output/Calls). **Nicht** gleichbedeutend mit der Claude-UI „90 % / 100 %“.
- Detaillierte **CLI-Forensik** weiterhin in **`token_forensics.js`** (separat ausführen).

### API (Kurz)

- **`GET /`**: HTML-Dashboard.
- **`GET /api/usage`**: JSON mit u. a. `days` (pro Tag `hosts`), `host_labels`, `calendar_today`, `day_cache_mode`, `scanning`, `parsed_files`, `scanned_files`, `scan_sources`, `forensic_*`.

### Screenshots

![alt text](images/image.png)
![alt text](images/image2.png)
![alt text](images/image3.png)
