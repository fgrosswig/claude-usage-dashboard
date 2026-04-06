**[Deutsch](README.md)** · English

## Claude Usage Dashboard (`server.js` / `start.js`)

Standalone Node server (no npm dependencies in the script itself). Reads **Claude Code** logs under **`~/.claude/projects/**/*.jsonl`** and shows token usage, limits (heuristic), and forensics in a web UI. Only **`claude-*`** models are counted (no `<synthetic>`).

**Layout:** **`server.js`** loads **`scripts/dashboard-server.js`**, **`scripts/dashboard-http.js`**, **`scripts/usage-scan-roots.js`**, and **`scripts/service-logger.js`** (structured logging). **Web UI:** **`tpl/dashboard.html`**, styles **`public/css/dashboard.css`**, browser logic **`public/js/dashboard.client.js`** (Chart.js from a CDN in the template). Embedding/extraction helper: **`scripts/extract-dashboard-assets.js`**. Use **`start.js`** for **`dashboard`**, **`both`**, **`proxy`**, or **`forensics`**. CLI forensics: **`scripts/token-forensics.js`**. **`claude-usage-dashboard.js`** aliases **`server.js`**.

**Server logging** (stderr, optional file): **`CLAUDE_USAGE_LOG_LEVEL`** = `error` | `warn` | `info` (default) | `debug` | `none`. Append to a file: **`CLAUDE_USAGE_LOG_FILE`**. CLI overrides: **`--log-level=…`**, **`--log-file=…`**. Topics include **`scan`/`parse`**, **`cache`**, **`outage`**, **`releases`**, **`marketplace`**, **`github`**, **`i18n`**, **`server`**.

**GitHub API (releases):** Unauthenticated quota is only **~60 requests/hour per IP**. On *rate limit exceeded*, set **`GITHUB_TOKEN`** or **`GH_TOKEN`** (classic PAT is enough for public repo release metadata). **No periodic fetch:** the network is used only when **`~/.claude/claude-code-releases.json`** is missing or empty — otherwise the disk cache is used. Manual refresh: **`POST /api/github-releases-refresh`**; optionally set **`CLAUDE_USAGE_ADMIN_TOKEN`** and send request header **`Authorization: Bearer`** with that value. Force fetch at startup: **`CLAUDE_USAGE_GITHUB_RELEASES_FETCH=1`**. **Optional in the UI:** expand the meta section and enter a PAT — stored only in this tab’s **`sessionStorage`**; the browser sends **`X-GitHub-Token`** to the dashboard server (takes **precedence** over `GITHUB_TOKEN`/`GH_TOKEN` for server-side GitHub calls once synced).

### UI strings (DE/EN, editable)

- Dashboard copy lives as **JSON** in **`tpl/de/ui.tpl`** and **`tpl/en/ui.tpl`** (`.tpl` extension, content is valid JSON).
- **`/`** uses an **in-memory cache** (invalidates when **mtime** of `tpl/de/ui.tpl` or `tpl/en/ui.tpl` changes), so templates are not re-read on every request. Edit a file, save, **reload the page**.
- **`GET /api/i18n-bundles`** returns `{ "de": {…}, "en": {…} }` (same bundle cache as `/`).
- **First data scan:** The server pushes **partial results over SSE** (`scan_progress`: files read / total); cards and charts **fill in gradually** (chart redraw is debounced in the browser ~**420 ms** to avoid jank). Optional **`CLAUDE_USAGE_SCAN_FILES_PER_TICK`** — more JSONL per tick (default **20**, range **1–80**; too high can stutter HTTP/SSE during scan).
- Keys are flat string IDs (e.g. `chartDailyToken`); placeholders like `{n}` or `{files}` are substituted in the browser.

### Run

```bash
node server.js
```

Or, using the generic starter (dashboard is the default):

```bash
node start.js
```

**Dashboard + Anthropic proxy in one terminal** (dashboard default port **3333**, proxy **8080** or **`ANTHROPIC_PROXY_PORT`**):

```bash
node start.js both
```

### Options

```bash
node server.js --port=4444 --refresh=300
node server.js --log-level=debug --log-file=$HOME/.claude/usage-dashboard-server.log
```

- **`--port`**: HTTP port (default `3333`).
- **`--log-level`**, **`--log-file`**: diagnostic logging (see **Server logging** above); same as `CLAUDE_USAGE_LOG_*` env vars.
- **`--refresh`**: Seconds until the next **full data scan** (all JSONL) + SSE push — **minimum `60`**, default **`180`**. Shorter values re-read everything too often (charts flicker). Or set **`CLAUDE_USAGE_SCAN_INTERVAL_SEC`** (≥ 60); `--refresh` overrides it.

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
- If **cache version**, **scan roots**, and **`.jsonl` file count** match, **past days** are loaded from that file and only the **local calendar “today”** is fully re-counted from logs (faster refreshes). **Calendar gaps with no log usage** no longer force a **full scan** — only a changed **`.jsonl` count**, **roots**, **cache version**, or **`CLAUDE_USAGE_NO_CACHE`** do. Per-day **`hosts`** are stored from cache version **3** onward; **version 4** invalidates older caches once; **version 5** adds **`session_signals`** (JSONL heuristics: continue/resume/retry/interrupt) — day cache is rebuilt once.
- Optional **`CLAUDE_USAGE_SKIP_IDENTICAL_SCAN=1`**: if relevant **JSONL mtimes** are unchanged, a repeated **full** scan may be skipped (fingerprint); handy for frequent refresh with no new logs.
- Expand the **meta** panel to see paths for the **day cache**, **releases**, **marketplace**, and **outage** JSON files.
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
node server.js
```

Multiple folders:

```bash
export CLAUDE_USAGE_EXTRA_BASES="$HOME/sync/win-projects;$HOME/.claude/imports/HOST-B"
```

Auto-pick `HOST-*` subfolders (parent = current directory):

```bash
export CLAUDE_USAGE_EXTRA_BASES=true
cd /path/to/parent-containing-HOST-B-and-HOST-C
node /path/to/server.js
```

Custom parent (Windows PowerShell):

```powershell
$env:CLAUDE_USAGE_EXTRA_BASES = "true"
$env:CLAUDE_USAGE_EXTRA_BASES_ROOT = "C:\Temp"
node server.js
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

- The repo ignores e.g. **`/HOST*/`** (local log imports), **`test_node*.js`**, **`node_modules/`**, **`.env` / `.env.*`** (with an optional **`.env.example`** exception). Depending on checkout, **`k8*`**, **`Dockerfile`**, and **`docker-compose.yml`** may also be ignored (keep Kubernetes/Docker artifacts local until validated). See **`.gitignore`** to avoid committing imports or secrets by mistake.

### Limits & forensic (heuristic only)

- **Data source** in the UI: generic **`~/.claude/projects`** (no absolute paths with usernames in the UI/API).
- **Hit limit (red in charts):** counts JSONL lines matching typical rate/limit patterns — **not** a direct Anthropic API proof.
- **Forensic** (collapsible): codes **`?`** (very high cache read), **`HIT`** (limit-like lines in logs), **`<<P`** (strict peak comparison with minimum output/calls). **Not** the same as the Claude UI “90% / 100%”.
- **Forensic session signals** (separate chart): per calendar day, **stacked bars** — bottom to top continue, resume, retry, interrupt, then **outage hours** on **top** (scaled bar height; tooltip shows real hours; top placement avoids the slice sitting under a large interrupt band). **Purple line** = **cache read** (separate right scale) — same-day heuristic only, not proof of causation.

### CLI forensics (`scripts/token-forensics.js`)

Standalone analysis tool with **automatic peak and limit detection** (no hardcoded dates). Uses the **same scan roots** as the dashboard (**`usage-scan-roots`**, including **`CLAUDE_USAGE_EXTRA_BASES`**) and **day-cache version 5**.

```bash
node start.js forensics
```

(Same as `node scripts/token-forensics.js` or `node token_forensics.js` in the repo root.)

**Automatic detection:**

- **Peak day:** Day with the highest total consumption (input + output + cache read + cache create).
- **Limit days:** Days with ≥ 50 `rate_limit`/`429`/`session limit` lines in JSONL **or** cache read ≥ 500M.
- **Comparison:** For the budget comparison, the most recent limit day with significant activity is chosen (≥ 50 calls, ≥ 2 active hours) to ensure meaningful results.

**7 sections:**

1. **Daily overview** — Cache:output ratio, active hours, automatic limit label per day.
2. **Efficiency collapse** — Overhead (tokens per output token), output/h, subagent share.
3. **Subagent analysis** — Cache multiplier: subagent cache as a share of total cache.
4. **Budget estimate** — Implied cap (`total/0.9`) per limit day, trend arrows (↑↓→), median range across meaningful limit days, ratio to peak. Shows where the token budget approximately lies and whether it has shifted.
5. **Hourly breakdown** — Hour-by-hour detail for the most recent meaningful limit day (or today).
6. **Conclusion** — Peak day vs. limit day comparison: implied budget, effective budget reduction, estimated minutes until limit.
7. **Visual** — ASCII bar chart with peak and limit markers.

**Insights for MAX plans:** The peak/limit comparison helps estimate whether the session budget has changed or whether token weighting (input/output/cache) has shifted. The `cache:output` ratio shows working efficiency — fewer subagents = less cache overhead = longer work until the limit.

### Anthropic monitor proxy (`start.js proxy` / `anthropic-proxy.js`)

Implementation: **`scripts/anthropic-proxy-core.js`** and **`scripts/anthropic-proxy-cli.js`**. Optional **HTTP forward proxy** (no extra npm packages): accepts Anthropic-compatible requests and forwards them to **`https://api.anthropic.com`** (or `--upstream`). Use it to **log traffic** and **cache metrics** from API responses alongside your JSONL under `~/.claude/projects`.

**Start:**

```bash
node start.js proxy --port=8080
```

(Same as `node anthropic-proxy.js --port=8080`.)

**Point Claude (or compatible tooling) at the proxy:**

```bash
ANTHROPIC_BASE_URL=http://127.0.0.1:8080 claude
```

**Continuous logging:** each completed upstream response appends **one NDJSON line** to **`~/.claude/anthropic-proxy-logs/proxy-YYYY-MM-DD.ndjson`** by default (override with **`ANTHROPIC_PROXY_LOG_DIR`**). Records include **`ts_start` / `ts_end`**, **`duration_ms`**, **`path`**, **`upstream_status`**, parsed **`usage`** (including **`cache_read_input_tokens`** and **`cache_creation_input_tokens`**), **`cache_read_ratio`** (= `cache_read / (cache_read + cache_creation)` when that sum &gt; 0), and **`cache_health`**:

- **`healthy`:** share of cache **reads** in (read + creation) ≥ **80%** (strong reuse of cached prompts).
- **`affected`:** that share **&lt; 40%** when there is cache traffic (heavy **creation**, light **read** — cache churn).
- **`mixed`**, **`na`**, or **`unknown`** as appropriate.

**Rate limits & metadata:** each line also includes **`request_meta`** (e.g. `content_length`, `anthropic_version`, `anthropic_beta` from incoming request headers) and **`response_anthropic_headers`** (persisted upstream response headers such as `anthropic-ratelimit-*`, `request-id` / `x-request-id`, `cf-ray`, and other `anthropic-*`).

**Subagents & tools:** the proxy sees **HTTP** (e.g. `tools` in the request JSON, `tool_use` / `tool_result` blocks in JSON responses) and adds **`request_hints`** / **`response_hints`**. **Subagent** sessions are mainly visible in **JSONL file paths** (often containing `subagent`). With **`ANTHROPIC_PROXY_ALIGN_JSONL=1`**, the proxy tries to **match** a response to a nearby JSONL line under `~/.claude/projects` (time window + token similarity) and stores the result in **`jsonl_alignment`** (including **`is_subagent_path`**).

Other env vars: **`ANTHROPIC_PROXY_LOG_STDOUT=1`**, **`ANTHROPIC_PROXY_LOG_BODIES=1`** (careful: may capture secrets), **`ANTHROPIC_PROXY_JSONL_ROOTS`**, **`ANTHROPIC_PROXY_BIND`**. See **`node start.js proxy -- --help`** or **`node anthropic-proxy.js --help`**.

### API (short)

- **`GET /`**: HTML dashboard.
- **`GET /api/usage`**: JSON including `days` (each day has `hosts`, `session_signals`, **`outage_hours`**, **`cache_read`**, …), `host_labels`, `calendar_today`, `day_cache_mode`, `scanning`, `parsed_files`, `scanned_files`, `scan_sources`, `forensic_*`, etc.

### Loading data into the dashboard (remote / container)

When the server **cannot** read `~/.claude/projects` directly, you can push logs over **HTTP**:

- **`POST /api/claude-data-sync`**: request body = **gzip-compressed tar**. Header **`Authorization: Bearer <CLAUDE_USAGE_SYNC_TOKEN>`** (token must be set on the server).
- On extract, only paths under **`projects/**`** and **`anthropic-proxy-logs/**`** are merged into the configured data directory (see **`scripts/claude-data-ingest.js`**).
- Max upload size: **`CLAUDE_USAGE_SYNC_MAX_MB`** (default **512**).
- Helper client: **`scripts/claude-data-sync-client.js`** (build tar, gzip, POST).

### Extension updates (service impact chart & report)

- **Marker dates:** Primarily the **VS Code Marketplace** ([version history](https://marketplace.visualstudio.com/items?itemName=anthropic.claude-code&ssr=false#version-history)): `lastUpdated`, **latest** per semver across platform VSIXes (closer to VS Code’s “Last Updated”; we previously used earliest, which could place the marker one UTC day early). Dates are aligned to **UTC calendar day** `YYYY-MM-DD` (same idea as `timestamp.slice(0,10)` on ISO `Z` logs), not local midnight, so markers line up with usage bars. Cached at **`~/.claude/claude-code-marketplace-versions.json`** (user profile, not your project copy).
- **Changelog lines:** **GitHub Releases** (up to 100 entries per fetch), cached at **`~/.claude/claude-code-releases.json`**. **Dates** use a **merge of Marketplace ∪ GitHub** (Marketplace `lastUpdated` wins when present; GitHub fills in any semver missing from a stale or partial Marketplace cache). Then JSONL fallback. Keep caches under `~/.claude/`.
- **Version from JSONL:** Same fields normalized to **`major.minor.patch`** for fallback and other analytics.
- If older day caches still store **non-normalized** version keys, trigger a **full rescan** once (`CLAUDE_USAGE_NO_CACHE=1` or delete the day cache file).

### Screenshots

![alt text](images/forensic.png)
![alt text](images/image.png)
![alt text](images/image2.png)
![alt text](images/image3.png)
