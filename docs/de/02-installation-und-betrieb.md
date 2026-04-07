# Installation und Betrieb

[← Inhaltsverzeichnis](README.md)

## Start

```bash
node server.js
```

Oder:

```bash
node start.js                    # Default: dashboard
node start.js both               # Dashboard :3333 + Proxy :8080
node start.js dashboard
node start.js proxy
node start.js forensics
```

**Dashboard + Proxy in einem Terminal:** `node start.js both` — Ports **3333** bzw. **`ANTHROPIC_PROXY_PORT`** (Standard **8080**).

## CLI-Optionen

```bash
node server.js --port=4444 --refresh=300
node server.js --log-level=debug --log-file=$HOME/.claude/usage-dashboard-server.log
```

- **`--port`**: HTTP-Port (Standard `3333`).
- **`--log-level`**, **`--log-file`**: siehe Server-Logging; entspricht `CLAUDE_USAGE_LOG_*`.
- **`--refresh`**: Sekunden bis zum nächsten Vollscan + SSE — **Minimum 60**, Standard **180**. Überschreibt optional `CLAUDE_USAGE_SCAN_INTERVAL_SEC` (≥ 60).

## Server-Logging

Ausgabe auf stderr, optional Datei: **`CLAUDE_USAGE_LOG_LEVEL`** = `error` | `warn` | `info` (Standard) | `debug` | `none`. Datei: **`CLAUDE_USAGE_LOG_FILE`**. CLI: **`--log-level=…`**, **`--log-file=…`**.

Themen: **`scan`/`parse`**, **`cache`**, **`outage`**, **`releases`**, **`marketplace`**, **`github`**, **`i18n`**, **`server`**.

## Live-Updates

- Beim Öffnen: `fetch('/api/usage')` + **SSE** (`/api/stream`).
- Grüner Punkt = verbunden; rot = Reconnect.
- Erster Scan: partielle Ergebnisse über SSE (`scan_progress`); Charts werden im Browser debounced (ca. **420 ms**). Optional **`CLAUDE_USAGE_SCAN_FILES_PER_TICK`** (Standard **20**, Bereich **1–80**).

## Schneller Start / Hintergrund-Scan

- Server lauscht sofort; erster Parse blockiert nicht vor `listen`.
- JSONL in Batches (`setImmediate` zwischen Dateigruppen).
- Bis zum ersten Scan: Stub `scanning: true` + Hinweis in der UI.

## Tages-Cache

- Datei: **`~/.claude/usage-dashboard-days.json`**
- Bei passender **Cache-Version**, **Scan-Wurzeln** und **`.jsonl`-Anzahl**: Vortage aus Datei, nur **heute** voll neu gezählt. Kalenderlücken ohne Nutzung erzwingen keinen Vollscan.
- **`hosts`** ab Version **3**; Version **4** einmalige Invalidierung; Version **5** ergänzt **`session_signals`**.
- Optional **`CLAUDE_USAGE_SKIP_IDENTICAL_SCAN=1`**: bei unveränderten mtimes Vollscan überspringen.
- **Vollscan erzwingen:** `CLAUDE_USAGE_NO_CACHE=1`, Cache löschen, andere `.jsonl`-Anzahl, geänderte Wurzeln / `CLAUDE_USAGE_EXTRA_BASES`.

Pfade zu Cache-, Release-, Marketplace- und Outage-JSONs: **Meta-Panel** (aufklappen).

## GitHub API (Releases)

- Ohne Token: ~**60 Requests/h pro IP**. Bei Limit: **`GITHUB_TOKEN`** oder **`GH_TOKEN`** (Classic PAT für öffentliches Repo reicht).
- **Kein periodischer Fetch:** Netz nur wenn **`~/.claude/claude-code-releases.json`** fehlt oder leer — sonst Disk-Cache.
- Manuell: **`POST /api/github-releases-refresh`**; optional **`CLAUDE_USAGE_ADMIN_TOKEN`** mit `Authorization: Bearer`.
- Start: **`CLAUDE_USAGE_GITHUB_RELEASES_FETCH=1`**.
- **UI:** Meta aufklappen, PAT eingeben → nur **`sessionStorage`** dieses Tabs; Browser sendet **`X-GitHub-Token`** (hat Vorrang für Server-GitHub-Calls).

## Docker

**`docker compose`** und Images: siehe [Kapitel 7 — Docker & CI](07-umgebung-api-deployment-dev.md#docker).
