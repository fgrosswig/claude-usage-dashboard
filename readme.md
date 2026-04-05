**[English](README.en.md)** · Deutsch

## Claude Usage Dashboard (`claude-usage-dashboard.js`)

Standalone Node-Server (ohne npm-Abhängigkeiten im Skript), liest **Claude Code**-Logs unter **`~/.claude/projects/**/*.jsonl`** und zeigt Token-Nutzung, Limits (heuristisch) und Forensics in einer Web-UI. Es werden nur **`claude-*`**-Modelle gezählt (kein `<synthetic>`).

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
- Wenn die **Anzahl** der gefundenen `.jsonl`-Dateien mit dem Cache übereinstimmt, werden **Vortage** aus dieser Datei geladen und aus den Logs nur noch der **lokale Kalendertag „heute“** voll mitgezählt (schnellere Refreshes).
- **Vollscan** erzwingen: Umgebung **`CLAUDE_USAGE_NO_CACHE=1`** (oder `true`), **oder** Cache-Datei löschen, **oder** neue/entfernte `.jsonl` (andere Dateianzahl).

### UI: Tag wählen (Karten & Tabelle)

- **Dropdown** „Karten & Tabelle (Tag wählen)“: alle Tage mit Daten (neueste oben).
- **Karten** und **Tagesdetail-Tabelle** beziehen sich auf den **gewählten** Tag; **Diagramme** und **Forensic-Chart** weiterhin über **alle** Tage.
- Auswahl wird in **`sessionStorage`** unter `usageDashboardDay` gespeichert.
- Wenn **Kalender-„heute“** in den Logs **0 Tokens** hat, erscheint ein kurzer Hinweis (älteren Tag wählen).

### Limits & Forensic (nur Heuristik)

- **Datenquelle** in der UI: generisch **`~/.claude/projects`** (keine absoluten Pfade mit Benutzernamen in der Anzeige/API).
- **Hit Limit (rot in Charts):** Zählt JSONL-Zeilen mit typischen Rate-/Limit-Mustern — **kein** direkter Anthropic-API-Nachweis.
- **Forensic** (einklappbar): Codes **`?`** (sehr hoher Cache-Read), **`HIT`** (Limit-Zeilen in Logs), **`<<P`** (strenger Peak-Vergleich mit Mindest-Output/Calls). **Nicht** gleichbedeutend mit der Claude-UI „90 % / 100 %“.
- Detaillierte **CLI-Forensik** weiterhin in **`token_forensics.js`** (separat ausführen).

### API (Kurz)

- **`GET /`**: HTML-Dashboard.
- **`GET /api/usage`**: JSON mit u. a. `days`, `calendar_today`, `day_cache_mode`, `scanning`, `parsed_files`, `forensic_*`.

### Screenshots

![alt text](images/image.png)
![alt text](images/image2.png)
![alt text](images/image3.png)
