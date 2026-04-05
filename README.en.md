**[Deutsch](README.md)** · English

## Claude Usage Dashboard (`claude-usage-dashboard.js`)

Standalone Node server (no npm dependencies in the script itself). Reads **Claude Code** logs under **`~/.claude/projects/**/*.jsonl`** and shows token usage, limits (heuristic), and forensics in a web UI. Only **`claude-*`** models are counted (no `<synthetic>`).

### UI strings (DE/EN, editable)

- Dashboard copy lives as **JSON** in **`tpl/de/ui.tpl`** and **`tpl/en/ui.tpl`** (`.tpl` extension, content is valid JSON).
- **`/`** uses an **in-memory cache** (invalidates when **mtime** of `tpl/de/ui.tpl` or `tpl/en/ui.tpl` changes), so templates are not re-read on every request. Edit a file, save, **reload the page**.
- **`GET /api/i18n-bundles`** returns `{ "de": {…}, "en": {…} }` (same bundle cache as `/`).
- **First data scan:** The server pushes **partial results over SSE** (`scan_progress`: files read / total); cards and charts **fill in gradually** (chart redraw is debounced in the browser ~**420 ms** to avoid jank). Optional **`CLAUDE_USAGE_SCAN_FILES_PER_TICK`** — more JSONL per tick (default **20**, range **1–80**; too high can stutter HTTP/SSE during scan).
- Keys are flat string IDs (e.g. `chartDailyToken`); placeholders like `{n}` or `{files}` are substituted in the browser.

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
- If **cache version**, **scan roots**, and **`.jsonl` file count** match, **past days** are loaded from that file and only the **local calendar “today”** is fully re-counted from logs (faster refreshes). Per-day **`hosts`** are stored from cache version **3** onward.
- Force a **full scan**: set **`CLAUDE_USAGE_NO_CACHE=1`** (or `true`), **or** delete the cache file, **or** add/remove `.jsonl` files (different count), **or** change **`CLAUDE_USAGE_EXTRA_BASES`** / scan roots (the cache stores `scan_roots_key`).

### Other machines / imported logs (`CLAUDE_USAGE_EXTRA_BASES`)

Paths differ between Linux and Windows. You can copy another host’s **`projects`** tree (or just the `.jsonl` folders you care about) somewhere on disk — e.g. a folder named **`HOST-B`** — and scan it in addition to the default root:

- Environment variable **`CLAUDE_USAGE_EXTRA_BASES`**: one or more directories, separated by **`;`** (same separator on Linux and Windows).
- **Shortcut:** `true`, `1`, `yes`, `auto`, or `on` — then every **subdirectory** under **`CLAUDE_USAGE_EXTRA_BASES_ROOT`** (if unset: Node’s **current working directory** at startup) whose name starts with **`HOST-`** (e.g. `HOST-B`, `HOST-C`) is added as an extra root (sorted alphabetically).
- Paths may start with **`~`** or be absolute.
- **UI label** for each entry = the last path segment (e.g. `HOST-B` for `.../imports/HOST-B`).
- All sources are **merged into the same daily totals**. The same absolute file path is only counted **once** (e.g. an identical copy under two roots).
- **Per host:** Each day in the API includes a **`hosts`** object (keys = labels, e.g. `local`, `HOST-B`) with total, output, calls, hit-limit, **`sub_cache`** / **`sub_cache_pct`**, etc. With **multiple roots**, the UI adds **extra cards** and **table rows** per host (selected day) plus a **stacked bar chart** “total tokens per day by host” (stack height matches the full day, same idea as the existing daily token chart).
- **Subagent cache %:** With multiple roots, bars are **stacked**: each segment is **that host’s subagent cache read / the whole day’s cache read** (percent); **stack height** matches the daily **subagent cache % of total cache** (sum of segments; tiny differences only from rounding).
- **Daily detail:** Click a **host sub-row** (`└ HOST-…`) to show only that host in the table (heading includes the name). Reset with **“All hosts”** or by clicking the **single** filtered row. Picking a **different day** in the dropdown clears the host filter.

Example:

```bash
export CLAUDE_USAGE_EXTRA_BASES="$HOME/.claude/imports/HOST-B"
node claude-usage-dashboard.js
```

Multiple folders:

```bash
export CLAUDE_USAGE_EXTRA_BASES="$HOME/sync/win-projects;$HOME/.claude/imports/HOST-B"
```

Auto-pick `HOST-*` subfolders (parent = current directory):

```bash
export CLAUDE_USAGE_EXTRA_BASES=true
cd /path/to/parent-containing-HOST-B-and-HOST-C
node /path/to/claude-usage-dashboard.js
```

Custom parent (Windows PowerShell):

```powershell
$env:CLAUDE_USAGE_EXTRA_BASES = "true"
$env:CLAUDE_USAGE_EXTRA_BASES_ROOT = "C:\Temp"
node claude-usage-dashboard.js
```

### Meta line & legend (collapsible)

- Below the main title: a **collapsible** block (`<details>`) for the model note (**`claude-*` only**, no `<synthetic>`), the **full parse/status line** (including cache mode and cards-vs-charts hint), **limit/data-source** text, and **scan sources** (when multiple roots).
- **Collapsed:** a **short summary** only (e.g. log file count and refresh interval).
- **Expanded:** smaller typography so cards move up visually.
- Open/closed state is stored in **`sessionStorage`** as **`usageMetaDetailsOpen`** (survives reload).

### UI: pick a day (cards & table)

- **Dropdown** “Karten & Tabelle (Tag wählen)”: all days with data (newest first).
- **Cards** and the **daily detail** table use the **selected** day; **charts** and the **forensic** chart still cover **all** days.
- The choice is stored in **`sessionStorage`** as **`usageDashboardDay`**.
- If **calendar “today”** has **0 tokens** in the logs, a short hint suggests picking an older day.

### Repository & `.gitignore`

- The repo ignores e.g. **`/HOST*/`** (local log imports), **`test_node*.js`**, **`node_modules/`**, **`.env` / `.env.*`** (with an optional **`.env.example`** exception). See **`.gitignore`** to avoid committing imports or secrets by mistake.

### Limits & forensic (heuristic only)

- **Data source** in the UI: generic **`~/.claude/projects`** (no absolute paths with usernames in the UI/API).
- **Hit limit (red in charts):** counts JSONL lines matching typical rate/limit patterns — **not** a direct Anthropic API proof.
- **Forensic** (collapsible): codes **`?`** (very high cache read), **`HIT`** (limit-like lines in logs), **`<<P`** (strict peak comparison with minimum output/calls). **Not** the same as the Claude UI “90% / 100%”.
- Deeper **CLI forensics** remain in **`token_forensics.js`** (run separately).

### API (short)

- **`GET /`**: HTML dashboard.
- **`GET /api/usage`**: JSON including `days` (each day has `hosts`), `host_labels`, `calendar_today`, `day_cache_mode`, `scanning`, `parsed_files`, `scanned_files`, `scan_sources`, `forensic_*`, etc.

### Screenshots

![alt text](images/image.png)
![alt text](images/image2.png)
![alt text](images/image3.png)
