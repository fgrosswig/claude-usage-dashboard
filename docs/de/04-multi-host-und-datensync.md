# Multi-Host und Datensynchronisation

[← Inhaltsverzeichnis](README.md)

## Weitere Scan-Wurzeln (`CLAUDE_USAGE_EXTRA_BASES`)

Projektbaum von einem anderen Rechner z. B. als **`HOST-B`** ablegen und zusätzlich einscannen:

- Variable **`CLAUDE_USAGE_EXTRA_BASES`**: ein oder mehrere Verzeichnisse, **`;`-getrennt** (Windows und Linux).
- **Kurzform:** `true`, `1`, `yes`, `auto`, `on` — alle Unterordner unter **`CLAUDE_USAGE_EXTRA_BASES_ROOT`** (Standard: **CWD** beim Start), deren Name mit **`HOST-`** beginnt.
- Pfade: **`~`** oder absolut.
- **UI-Label** = letzter Pfadsegment (z. B. `HOST-B`).
- Alle Quellen in **dieselben Tages-Aggregate**; identische absolute Pfade nur einmal gezählt.

**Pro Host:** API-Feld **`hosts`** pro Tag (Total, Output, Calls, Hit-Limit, Sub-Cache …). UI: zusätzliche Karten, Tabellenzeilen, gestapeltes „Tokens pro Tag nach Host“, Subagent-Cache-%.

**Tagesdetail:** Klick auf **`└ HOST-…`**, nur dieser Host in der Tabelle; zurück über **Alle Hosts** oder anderen Tag.

### Beispiele

```bash
export CLAUDE_USAGE_EXTRA_BASES="$HOME/.claude/imports/HOST-B"
node server.js
```

```bash
export CLAUDE_USAGE_EXTRA_BASES="$HOME/sync/win-projects;$HOME/.claude/imports/HOST-B"
```

```bash
export CLAUDE_USAGE_EXTRA_BASES=true
cd /pfad/zu/parent-mit-HOST-B-und-HOST-C
node /pfad/zu/server.js
```

**Windows PowerShell:**

```powershell
$env:CLAUDE_USAGE_EXTRA_BASES = "true"
$env:CLAUDE_USAGE_EXTRA_BASES_ROOT = "C:\Temp"
node server.js
```

## HTTP-Daten ins Dashboard (Remote / Container)

Wenn **`~/.claude/projects`** auf dem Server nicht direkt lesbar ist:

- **`POST /api/claude-data-sync`**: Body = **gzip-komprimiertes tar**.
- Header **`Authorization: Bearer <CLAUDE_USAGE_SYNC_TOKEN>`**.
- Nur **`projects/**`** und **`anthropic-proxy-logs/**`** werden extrahiert.
- Max. Größe: **`CLAUDE_USAGE_SYNC_MAX_MB`** (Standard **512**).
- Client-Hilfe: **`scripts/claude-data-sync-client.js`**.
