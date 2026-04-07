**[English](README.en.md)** · Deutsch

[![Woodpecker CI — Branch main](https://ci.grosswig-it.de/api/badges/3/status.svg?branch=main)](https://ci.grosswig-it.de/repos/3)

## Claude Usage Dashboard (`server.js` / `start.js`)

Standalone Node-Server fuer **Claude Code** Token-Nutzungs-Analyse, Anomalie-Erkennung und Proxy-Monitoring. Liest **`~/.claude/projects/**/*.jsonl`** und zeigt Token-Nutzung, Limits (heuristisch) und Forensik in einer Web-UI. Nur **`claude-*`**-Modelle werden gezaehlt (kein `<synthetic>`).

**Live:** [https://claude-usage.grosswig-it.de/](https://claude-usage.grosswig-it.de/)

### Features

#### Health Score Ampel
- **14 Indikatoren** mit Gruen/Gelb/Rot Schwellwerten: Quota 5h, Thinking Gap, Cache Health, Error Rate, Hit Limits, Latenz, Interrupts, Cold Starts, Retries, False 429 (B3), Truncations (B5), Context Resets (B4), Tokens/1% Quota, Anomale Stops
- **Score 0-10** mit farbcodiertem Trend-Chart ueber alle Tage
- **Kernbefunde** — 8 auto-berechnete Findings (Thinking Token Gap, Overhead, Cache-Paradox etc.)
- **ArkNill Bug Detection** — automatische Erkennung der 7 bekannten Claude Code Bugs (B1-B8)
- Collapsible Section: Ampel-Badges im zugeklappten Zustand

#### Proxy Analytics (Anthropic Monitor Proxy)
- Transparenter HTTPS-Proxy fuer die Anthropic API mit NDJSON-Logging
- **6 Stat-Cards** (Requests, Latenz, Cache Ratio, Models, 5h-Quota, 7d-Quota mit Farbcodierung)
- **Token Cost Attribution** (Stacked Bar: Cache Read / Creation / Output)
- **Latenz-Chart** (Avg + Min Trend, Outlier-bereinigt)
- **Modell-Verteilung** (Requests + Latenz pro Modell, dual-axis)
- **Hourly Heatmap** (Requests pro Stunde, Intensitaets-Faerbung)
- **Cold-Start Erkennung** (Requests mit <50% Cache-Ratio)
- **SSE stop_reason Extraktion** (end_turn, tool_use, max_tokens aus Streaming-Responses)
- **JSONL vs Proxy Vergleich** (Thinking Token Duplication Ratio)

#### Anthropic Status & Incidents
- **Incident-Chart** (Outage-Stunden + Incident-Punkte pro Tag)
- **Hit Limits Trend** (Korrelation Ausfaelle vs Rate-Limits)
- **Extension-Updates** Timeline (Claude Code Versionen)
- Live Anthropic Status Badge in der Top-Bar

#### Token Stats (collapsible)
- **Stat-Cards** mit Tag-Output, Cache Read, Total, Hit Limits, Overhead, Peak, Gesamt, Session-Signale
- **4 Main-Charts** (Token-Verbrauch, Cache:Output, Output/Stunde, Subagent-Cache)
- Collapsible Section mit Summary-Zeile

#### Forensic Analyse
- Hit-Limit Erkennung aus JSONL-Logs
- Session-Signale (continue/resume/retry/interrupt/truncated)
- Service Impact Chart (Arbeitszeit vs Ausfall) — nebeneinander mit Session-Signale
- Cache Read Korrelation
- Forensic Report (Markdown-Export)
- HiDPI Chart-Rendering (devicePixelRatio)

#### Multi-Host Support
- Mehrere Maschinen als separate Quellen (HOST-B, HOST-C, HOST-D etc.)
- Host-Filter (Chips bei <=5 Hosts, Multi-Select ab 6+)
- Auto-Discovery via `CLAUDE_USAGE_EXTRA_BASES=auto`
- JSONL-Sync von Remote-Maschinen (`POST /api/claude-data-sync`)

#### Filter & Navigation
- **Datumsbereich-Filter** (Start/End als Select-Dropdowns)
- **Host-Filter** (filtert alle Charts)
- **Scope-Umschalter** (Alle Tage / 24h)
- **Tag-Picker** (Karten & Tabelle)
- Top-Bar mit Live, Anthropic, Meta Badges

### Architektur

```
start.js (both)
  ├── scripts/dashboard-server.js    # HTTP + SSE + Parsing
  ├── scripts/anthropic-proxy-cli.js # Transparenter Proxy → NDJSON
  ├── scripts/usage-scan-roots.js    # JSONL + NDJSON Discovery
  ├── scripts/service-logger.js      # Strukturierte Logs
  ├── tpl/dashboard.html             # HTML Template
  ├── tpl/de/ui.tpl + tpl/en/ui.tpl  # i18n (JSON)
  ├── public/js/dashboard.client.js  # Browser-Logik (Chart.js)
  └── public/css/dashboard.css       # Styles (Dark Theme)
```

### UI-Texte (DE/EN, dynamisch)

- Alle Beschriftungen liegen als **JSON** unter **`tpl/de/ui.tpl`** und **`tpl/en/ui.tpl`** (Dateiendung `.tpl`, Inhalt gueltiges JSON).
- **`/`** nutzt einen **In-Memory-Cache** (invalidiert sich bei **mtime**-Aenderung): kein Einlesen/String-Replace pro Request. Texte aendern → Datei speichern → **Seite neu laden**.
- **`GET /api/i18n-bundles`** liefert dieselben Bundles (ebenfalls aus dem Cache).
- Schluessel sind flache String-IDs (z.B. `chartDailyToken`); Platzhalter wie `{n}` oder `{files}` werden im Client ersetzt.

### Start

```bash
node server.js
```

Oder mit dem generischen Starter (Dashboard ist der Default):

```bash
node start.js
```

**Dashboard + Anthropic-Proxy in einem Terminal** (Dashboard Port **3333**, Proxy **8080** bzw. **`ANTHROPIC_PROXY_PORT`**):

```bash
node start.js both
```

### Optionen

```bash
node server.js --port=4444 --refresh=300
node server.js --log-level=debug --log-file=$HOME/.claude/usage-dashboard-server.log
```

- **`--port`**: HTTP-Port (Standard `3333`).
- **`--log-level`**, **`--log-file`**: Diagnose-Logging (siehe **Server-Logging** unten); identisch mit `CLAUDE_USAGE_LOG_*` Umgebungsvariablen.
- **`--refresh`**: Sekunden bis zum naechsten **Vollscan** (alle JSONL) + SSE-Push — **Minimum `60`**, Standard **`180`**. Oder **`CLAUDE_USAGE_SCAN_INTERVAL_SEC`** setzen (≥ 60); `--refresh` hat Vorrang.

### Server-Logging

Ausgabe auf stderr, optional in Datei: **`CLAUDE_USAGE_LOG_LEVEL`** = `error` | `warn` | `info` (Standard) | `debug` | `none`. Datei: **`CLAUDE_USAGE_LOG_FILE`**. CLI: **`--log-level=…`**, **`--log-file=…`**. Themen: **`scan`/`parse`**, **`cache`**, **`outage`**, **`releases`**, **`marketplace`**, **`github`**, **`i18n`**, **`server`**.

### Live-Updates

- Beim Oeffnen: **`fetch('/api/usage')`** fuer den aktuellen Cache, parallel **SSE** (`/api/stream`).
- Gruener Punkt oben rechts = verbunden; Daten aktualisieren sich ohne manuellen Reload.
- Rot = Verbindungsabbruch, Browser versucht erneut.

### Schneller Start / Scan im Hintergrund

- Der Server **lauscht sofort**; der erste Parse laeuft **nicht** blockierend vor `listen`.
- JSONL werden **in Batches** verarbeitet (`setImmediate` zwischen Dateigruppen), damit HTTP/SSE bedienbar bleibt.
- Vor dem ersten Scan: Stub mit `scanning: true` und Hinweistext in der UI.

### Tages-Cache (Vortage in einer JSON)

- Datei: **`~/.claude/usage-dashboard-days.json`**
- Wenn **Cache-Version**, **Scan-Wurzeln** und **`.jsonl`-Dateianzahl** passen, werden Vortage aus der Datei geladen und nur der lokale Kalendertag „heute" voll gezaehlt. **Kalender-Luecken** ohne Log-Nutzung erzwingen keinen Vollscan. Pro-Tag-**`hosts`** ab Cache-Version **3**; **Version 4** invalidiert aeltere Caches einmalig; **Version 5** ergaenzt **`session_signals`** (JSONL-Heuristiken: continue/resume/retry/interrupt).
- Optional **`CLAUDE_USAGE_SKIP_IDENTICAL_SCAN=1`**: bei unveraenderten JSONL-mtimes wird ein wiederholter Vollscan uebersprungen (Fingerprint).
- Im **Meta**-Panel werden Pfade fuer **Day-Cache**, **Releases**, **Marketplace** und **Outage**-JSON angezeigt.
- **Vollscan** erzwingen: **`CLAUDE_USAGE_NO_CACHE=1`** (oder `true`), Cache-Datei loeschen, neue/entfernte `.jsonl` (andere Dateianzahl), oder andere **`CLAUDE_USAGE_EXTRA_BASES`** / Scan-Wurzeln.

### Weitere Rechner / importierte Logs (`CLAUDE_USAGE_EXTRA_BASES`)

Du kannst z.B. von einem anderen Host kopiertes **`projects`**-Baumwerk irgendwo ablegen — sinnvoll z.B. als Ordner **`HOST-B`** — und zusaetzlich einscannen:

- Umgebungsvariable **`CLAUDE_USAGE_EXTRA_BASES`**: ein oder mehrere Verzeichnisse, **mit `;` getrennt**.
- **Kurzform:** `true`, `1`, `yes`, `auto` oder `on` — dann werden unter **`CLAUDE_USAGE_EXTRA_BASES_ROOT`** (falls leer: CWD beim Start) alle Unterordner mit **`HOST-`**-Prefix eingebunden.
- Pfade duerfen **`~`** am Anfang nutzen oder absolut sein.
- **Label in der UI** = letzter Pfadbestandteil (z.B. `HOST-B`).
- Alle Quellen werden in **dieselben Tages-Aggregate** gemischt. **Doppelte** Dateipfade nur einmal gezaehlt.
- **Pro Host:** In der API hat jeder Tag ein Objekt **`hosts`** mit Total, Output, Calls, Hit-Limit, Sub-Cache usw. Bei mehreren Wurzeln erscheinen zusaetzliche Karten, Tabellenzeilen und ein gestapeltes Balkendiagramm pro Host.
- **Tagesdetail:** Klick auf Host-Unterzeile zeigt nur diesen Host. Zurueck: „Alle Hosts" oder anderer Tag im Dropdown.

Beispiel:

```bash
export CLAUDE_USAGE_EXTRA_BASES="$HOME/.claude/imports/HOST-B"
node server.js
```

Mehrere Ordner:

```bash
export CLAUDE_USAGE_EXTRA_BASES="$HOME/sync/win-projects;$HOME/.claude/imports/HOST-B"
```

Unterordner `HOST-*` automatisch (Root = CWD):

```bash
export CLAUDE_USAGE_EXTRA_BASES=true
cd /pfad/zu/parent-mit-HOST-B-und-HOST-C
node /pfad/zu/server.js
```

Eigener Parent-Ordner (Windows PowerShell):

```powershell
$env:CLAUDE_USAGE_EXTRA_BASES = "true"
$env:CLAUDE_USAGE_EXTRA_BASES_ROOT = "C:\Temp"
node server.js
```

### Meta-Zeile & Legende (einklappbar)

- Unter der Hauptueberschrift: **aufklappbarer** Block fuer Modell-Hinweis, Parse-/Statuszeile, Limit-/Datenquelle und Scan-Quellen.
- **Zugeklappt**: kurze Summary (Anzahl Log-Dateien, Refresh-Intervall).
- **Aufgeklappt**: kleinerer Text, damit Karten schneller ins Blickfeld ruecken.
- Status in **`sessionStorage`** als **`usageMetaDetailsOpen`**.

### UI: Tag waehlen (Karten & Tabelle)

- **Dropdown**: alle Tage mit Daten (neueste oben).
- **Karten** und **Tagesdetail-Tabelle**: gewaehlter Tag. **Diagramme** und **Forensic-Chart**: alle Tage.
- Auswahl in **`sessionStorage`** als **`usageDashboardDay`**.
- Kalender-„heute" mit 0 Tokens: kurzer Hinweis.

### GitHub API (Releases)

Unauthentifiziertes Limit: nur **~60 Requests/Stunde pro IP**. Bei *Rate-Limit*: **`GITHUB_TOKEN`** oder **`GH_TOKEN`** setzen (Classic PAT reicht fuer oeffentliches Repo). **Kein periodischer Fetch:** Netzwerk nur wenn **`~/.claude/claude-code-releases.json`** fehlt oder leer — sonst Disk-Cache. Manuell: **`POST /api/github-releases-refresh`**; optional **`CLAUDE_USAGE_ADMIN_TOKEN`** mit `Authorization: Bearer`. Beim Start erzwingen: **`CLAUDE_USAGE_GITHUB_RELEASES_FETCH=1`**. **Optional im UI:** Meta-Bereich aufklappen, PAT eingeben — nur in diesem Tab's `sessionStorage`.

### Limits & Forensic (nur Heuristik)

- **Datenquelle** in der UI: generisch **`~/.claude/projects`** (keine absoluten Pfade mit Benutzernamen).
- **Hit Limit (rot in Charts):** Zaehlt JSONL-Zeilen mit typischen Rate-/Limit-Mustern — kein direkter API-Nachweis.
- **Forensic** (einklappbar): Codes **`?`** (sehr hoher Cache-Read), **`HIT`** (Limit-Zeilen), **`<<P`** (strenger Peak-Vergleich). Nicht gleichbedeutend mit der Claude-UI „90% / 100%".
- **Forensic Session-Signale** (separates Chart): pro Tag gestapelte Balken (continue, resume, retry, interrupt), dann **Outage-Stunden** oben. **Lila Linie** = Cache Read (separate rechte Achse).

### CLI-Forensik (`scripts/token-forensics.js`)

Separates Analyse-Tool mit **automatischer Peak- und Limit-Erkennung** (keine hardcodierten Daten). Nutzt **dieselben Scan-Wurzeln** wie das Dashboard und **Day-Cache Version 5**.

```bash
node start.js forensics
```

(Identisch mit `node scripts/token-forensics.js` oder `node token_forensics.js` im Repo-Root.)

**Automatische Erkennung:**

- **Peak-Tag:** Tag mit dem hoechsten Gesamtverbrauch.
- **Limit-Tage:** Tage mit >= 50 Rate-/Limit-Zeilen in JSONL oder Cache-Read >= 500M.
- **Fazit-Vergleich:** Letzter Limit-Tag mit signifikanter Aktivitaet (>= 50 Calls, >= 2h aktiv).

**7 Abschnitte:**

1. **Tagesuebersicht** — Cache:Output-Ratio, aktive Stunden, Limit-Label, Outage-Marker.
2. **Effizienz-Kollaps** — Overhead (Tokens pro Output-Token), Output/h, Subagent-Anteil.
3. **Subagent-Analyse** — Cache-Multiplikator: Subagent-Cache als Anteil am Gesamt-Cache.
4. **Budget-Schaetzung** — Impliziertes Cap (`total/0.9`) pro Limit-Tag, Trend, Median-Bereich. Outage-Tage werden separiert (*OUT*-Markierung).
5. **Stuendliche Analyse** — Stundengenaue Aufschluesselung des letzten aussagekraeftigen Limit-Tags.
6. **Fazit** — Vergleich Peak-Tag vs. Limit-Tag: Budget-Reduktion, geschaetzte Minuten bis Limit.
7. **Visuell** — ASCII-Balkendiagramm mit Peak-/Limit-/Outage-Markierungen.

**Rueckschluesse fuer MAX-Plaene:** Peak/Limit-Vergleich zeigt ob sich das Session-Budget veraendert hat. Die `Cache:Output`-Ratio zeigt Effizienz — weniger Subagents = weniger Overhead = laengere Arbeit bis Limit.

### Anthropic Monitor Proxy (`start.js proxy` / `anthropic-proxy.js`)

Implementierung: **`scripts/anthropic-proxy-core.js`** und **`scripts/anthropic-proxy-cli.js`**. Optionaler **HTTP-Forward-Proxy** (keine npm-Pakete): nimmt Anthropic-kompatible Requests entgegen und leitet sie an **`https://api.anthropic.com`** (oder `--upstream`) weiter. Damit lassen sich **Traffic loggen** und **Cache-Metriken** aus API-Responses neben den JSONL unter `~/.claude/projects` erfassen.

**Start:**

```bash
node start.js proxy --port=8080
```

**Claude auf den Proxy zeigen:**

```bash
ANTHROPIC_BASE_URL=http://127.0.0.1:8080 claude
```

**Logging:** Jede abgeschlossene Upstream-Response erzeugt **eine NDJSON-Zeile** unter **`~/.claude/anthropic-proxy-logs/proxy-YYYY-MM-DD.ndjson`** (ueberschreibbar mit **`ANTHROPIC_PROXY_LOG_DIR`**). Felder: **`ts_start`/`ts_end`**, **`duration_ms`**, **`path`**, **`upstream_status`**, **`usage`** (inkl. `cache_read_input_tokens`, `cache_creation_input_tokens`), **`cache_read_ratio`**, **`cache_health`**:

- **`healthy`:** Cache-Read-Anteil an (Read + Creation) >= 80%.
- **`affected`:** Anteil < 40% bei vorhandenem Cache-Traffic (starke Creation, wenig Read = Cache-Churn).
- **`mixed`**, **`na`**, **`unknown`** je nach Situation.

**Rate Limits & Metadaten:** Jede Zeile enthaelt **`request_meta`** und **`response_anthropic_headers`** (z.B. `anthropic-ratelimit-*`, `request-id`, `cf-ray`).

### Daten ins Dashboard laden (remote / Container)

Wenn der Server **`~/.claude/projects`** nicht direkt lesen kann:

- **`POST /api/claude-data-sync`**: Request-Body = **gzip-komprimiertes tar**. Header **`Authorization: Bearer <CLAUDE_USAGE_SYNC_TOKEN>`**.
- Nur Pfade unter **`projects/**`** und **`anthropic-proxy-logs/**`** werden extrahiert.
- Max Upload: **`CLAUDE_USAGE_SYNC_MAX_MB`** (Standard **512**).
- Helper: **`scripts/claude-data-sync-client.js`**.

### Extension-Updates (Service Impact Chart & Report)

- **Marker-Daten:** Primaer **VS Code Marketplace** ([Version History](https://marketplace.visualstudio.com/items?itemName=anthropic.claude-code&ssr=false#version-history)): `lastUpdated`, neueste Version per Semver. Daten auf **UTC-Kalendertag** ausgerichtet. Gecacht unter **`~/.claude/claude-code-marketplace-versions.json`**.
- **Changelog-Zeilen:** **GitHub Releases** (bis 100 Eintraege pro Fetch), gecacht unter **`~/.claude/claude-code-releases.json`**. **Datumsquellen:** Merge Marketplace + GitHub (Marketplace-Datum hat Vorrang); dann JSONL-Fallback.
- **Version aus JSONL:** Normalisiert auf **`major.minor.patch`** fuer Fallback und Analytics.

### Deployment

```bash
# Docker / K8s
node start.js both          # Dashboard (3333) + Proxy (8080)
node start.js dashboard     # Nur Dashboard
node start.js proxy         # Nur Proxy

# K8s mit Kustomize
kubectl apply -k k8s/overlays/dev

# JSONL-Sync von anderem Rechner
~/.claude/sync-to-dashboard.sh
```

### Umgebungsvariablen

| Variable | Default | Beschreibung |
|----------|---------|--------------|
| `ANTHROPIC_PROXY_BIND` | `127.0.0.1` | Proxy Bind-Adresse |
| `ANTHROPIC_PROXY_PORT` | `8080` | Proxy Port |
| `ANTHROPIC_PROXY_LOG_DIR` | `~/.claude/anthropic-proxy-logs` | NDJSON Log-Verzeichnis |
| `CLAUDE_USAGE_EXTRA_BASES` | — | `auto` oder `;`-getrennte Pfade |
| `CLAUDE_USAGE_EXTRA_BASES_ROOT` | `cwd` | Root fuer HOST-* Auto-Discovery |
| `CLAUDE_USAGE_SYNC_TOKEN` | — | Token fuer `/api/claude-data-sync` |
| `CLAUDE_USAGE_SYNC_MAX_MB` | `512` | Max Upload-Groesse |
| `CLAUDE_USAGE_SCAN_INTERVAL_SEC` | `180` | Scan-Intervall (Min. 60) |
| `CLAUDE_USAGE_NO_CACHE` | — | `1` oder `true` erzwingt Vollscan |
| `CLAUDE_USAGE_LOG_LEVEL` | `info` | `error`/`warn`/`info`/`debug`/`none` |
| `CLAUDE_USAGE_LOG_FILE` | — | Log-Datei (zusaetzlich zu stderr) |
| `GITHUB_TOKEN` / `GH_TOKEN` | — | GitHub PAT fuer Releases (>60 req/h) |
| `CLAUDE_USAGE_ADMIN_TOKEN` | — | Bearer-Token fuer Admin-Endpoints |
| `DEBUG_API` | — | `1` aktiviert `/api/debug/proxy-logs` Endpoint |
| `DEV_PROXY_SOURCE` | — | URL des Remote-Dashboards fuer Dev-Testing |
| `DEV_MODE` | — | `proxy` (nur Proxy remote) oder `full` (alles remote) |

### API (kurz)

- **`GET /`**: HTML-Dashboard.
- **`GET /api/usage`**: JSON mit `days` (pro Tag `hosts`, `session_signals`, `outage_hours`, `cache_read`, …), `host_labels`, `calendar_today`, `day_cache_mode`, `scanning`, `parsed_files`, `scanned_files`, `scan_sources`, `forensic_*`.
- **`POST /api/claude-data-sync`**: JSONL-Upload (gzip tar).
- **`POST /api/github-releases-refresh`**: Releases manuell aktualisieren.

### Lokales Dev-Testing

Dashboard lokal mit echten Remote-Daten testen (Cluster braucht `DEBUG_API=1`):

```powershell
# PowerShell — alles vom Remote (kein lokaler Scan)
$env:DEV_PROXY_SOURCE="https://claude-usage.grosswig-it.de"; $env:DEV_MODE="full"; node start.js dashboard

# PowerShell — nur Proxy vom Remote, JSONL lokal
$env:DEV_PROXY_SOURCE="https://claude-usage.grosswig-it.de"; $env:DEV_MODE="proxy"; node start.js dashboard
```

```bash
# bash — alles vom Remote
DEV_PROXY_SOURCE=https://claude-usage.grosswig-it.de DEV_MODE=full node start.js dashboard
```

- **DEV FULL Banner** oben mit Sync-Button + Last-Sync-Timestamp
- Auto-Sync alle 180s, `node start.js both` blockiert im Dev-Mode
- Siehe `k8s/README.md` fuer Mermaid-Flowchart

### Referenzen

- [Claude Code Hidden Problem Analysis](https://github.com/ArkNill/claude-code-hidden-problem-analysis) — Grundlage fuer Anomalie-Erkennung (B1-B8)
- Bug Detection im Health Panel: B3 False Rate Limiter, B4 Context Stripping, B5 Tool Truncation
- Quota-Benchmark: 1% ≈ 1.5-2.1M sichtbare Tokens (ArkNill-Referenz)
- SSE stop_reason Extraktion fuer Stop-Anomalie-Erkennung

### Screenshots

![alt text](images/forensic.png)
![alt text](images/image.png)
![alt text](images/image2.png)
![alt text](images/image3.png)
