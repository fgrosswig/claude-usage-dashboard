**[Deutsch](readme.md)** · English

## Claude Usage Dashboard (`claude-usage-dashboard.js`)

Standalone Node server (no npm dependencies in the script itself). Reads **Claude Code** logs under **`~/.claude/projects/**/*.jsonl`** and shows token usage, limits (heuristic), and forensics in a web UI. Only **`claude-*`** models are counted (no `<synthetic>`).

### Run

```bash
node claude-usage-dashboard.js
```

### Options

```bash
node claude-usage-dashboard.js --port=4444 --refresh=15
```

- **`--port`**: HTTP port (default `3333`).
- **`--refresh`**: Seconds until the next scan + SSE push (minimum `5`, default `30`).

### Live updates

- On page load: **`fetch('/api/usage')`** for the current cache, plus **SSE** (`/api/stream`).
- Green dot (top right) = connected; data refreshes on the configured interval without a manual reload.
- Red = disconnected; the browser retries automatically.

### Fast startup / background scan

- The server **listens immediately**; the first parse does **not** block before `listen`.
- JSONL files are processed in **batches** (`setImmediate` between file groups) so HTTP/SSE stay responsive.
- Until the first scan finishes: stub with `scanning: true` and a short message in the UI.

### Day cache (past days in one JSON)

- File: **`~/.claude/usage-dashboard-days.json`**
- If the **number** of `.jsonl` files matches the cache, **past days** are loaded from that file and only the **local calendar “today”** is fully re-counted from logs (faster refreshes).
- Force a **full scan**: set **`CLAUDE_USAGE_NO_CACHE=1`** (or `true`), **or** delete the cache file, **or** add/remove `.jsonl` files (different count).

### UI: pick a day (cards & table)

- **Dropdown** “Karten & Tabelle (Tag wählen)”: all days with data (newest first).
- **Cards** and the **daily detail** table use the **selected** day; **charts** and the **forensic** chart still cover **all** days.
- The choice is stored in **`sessionStorage`** as `usageDashboardDay`.
- If **calendar “today”** has **0 tokens** in the logs, a short hint suggests picking an older day.

### Limits & forensic (heuristic only)

- **Data source** in the UI: generic **`~/.claude/projects`** (no absolute paths with usernames in the UI/API).
- **Hit limit (red in charts):** counts JSONL lines matching typical rate/limit patterns — **not** a direct Anthropic API proof.
- **Forensic** (collapsible): codes **`?`** (very high cache read), **`HIT`** (limit-like lines in logs), **`<<P`** (strict peak comparison with minimum output/calls). **Not** the same as the Claude UI “90% / 100%”.
- Deeper **CLI forensics** remain in **`token_forensics.js`** (run separately).

### API (short)

- **`GET /`**: HTML dashboard.
- **`GET /api/usage`**: JSON including `days`, `calendar_today`, `day_cache_mode`, `scanning`, `parsed_files`, `forensic_*`, etc.

### Screenshots

![alt text](images/image.png)
![alt text](images/image2.png)
![alt text](images/image3.png)
