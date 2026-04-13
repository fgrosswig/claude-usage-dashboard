**[Deutsch](README.md)** · **[한국어](README.ko.md)** · English

## Claude Usage Dashboard

[![Docker build](https://github.com/fgrosswig/claude-usage-dashboard/actions/workflows/docker.yml/badge.svg?branch=main)](https://github.com/fgrosswig/claude-usage-dashboard/actions/workflows/docker.yml)
[![Quality Gate](https://192.168.1.171:30188/api/project_badges/measure?project=claude-usage-dashboard&metric=alert_status&token=XXX)](https://192.168.1.171:30188/dashboard?id=claude-usage-dashboard)
[![Bugs](https://192.168.1.171:30188/api/project_badges/measure?project=claude-usage-dashboard&metric=bugs&token=XXX)](https://192.168.1.171:30188/dashboard?id=claude-usage-dashboard)
[![Vulnerabilities](https://192.168.1.171:30188/api/project_badges/measure?project=claude-usage-dashboard&metric=vulnerabilities&token=XXX)](https://192.168.1.171:30188/dashboard?id=claude-usage-dashboard)
[![Security Rating](https://192.168.1.171:30188/api/project_badges/measure?project=claude-usage-dashboard&metric=security_rating&token=XXX)](https://192.168.1.171:30188/dashboard?id=claude-usage-dashboard)

### Summary

**Anthropic and Claude Code monitoring:** A **self-hosted web dashboard** and an optional **transparent HTTP proxy** for the **Anthropic API** — to visualize **token flow**, heuristic limits, **forensics**, and proxy metrics. **Motivation:** In practice, **Anthropic usage** (Claude Code, Max/session windows, etc.) often leads to **rapid "usage drains"**; the official display does not always explain **why** the counter depletes so quickly. Data sources: **`~/.claude/projects/**/_.jsonl`** and — with the proxy — **NDJSON** per request (latency, cache, and **rate-limit-relevant headers** among others). Only **`claude-_`** models are counted (no `<synthetic>`). Runs **locally** or in **Docker/Kubernetes** — no centralized SaaS.

### References and Context

- **Measured background work (proxy idea):** **[Claude Code Hidden Problem Analysis](https://github.com/ArkNill/claude-code-hidden-problem-analysis)** by **ArkNill** — documented analysis of cache bugs, **5h/7d quota**, and proxy-captured headers (including **cc-relay**-like measurements). **This project adopts the proxy/NDJSON idea** into the dashboard and pipeline; the **depth of findings** is in **his** repo.
- **GitHub issue discussion (Claude Code):** **[anthropics/claude-code#38335](https://github.com/anthropics/claude-code/issues/38335)** — covering **abnormally fast** exhaustion of Max/session windows (discussion as of March 2026, among others). **fgrosswig** joined with **forensics/measurements**; **all comments, issues, and sub-discussions linked there** belong to the **same topic spectrum** (usage, regression, community measurements) and serve as **reading references** — a complete URL inventory would exceed the scope here.

- **Q5 Quota Validation and Interceptor Interop:** **[claude-code-cache-fix](https://github.com/cnighswonger/claude-code-cache-fix)** by **cnighswonger** (Veritas Super AI Solutions) — independent replication of forced-restart findings, proof that the **cache_read 90% discount is still active** (8.8x ratio), and **quota divisor hypothesis** (API-cost to Q5% mapping is not fixed). From v1.7.0 with **NDJSON adapter** (`usage-to-dashboard-ndjson.mjs`) that writes directly into the dashboard proxy format — zero config interop. The joint analysis led to the discovery of the **Large Cache Read Penalty**: 93% of large Q5 jumps come from normal turns with large cache, not from compaction.

**Direct URLs:** [https://github.com/anthropics/claude-code/issues/38335](https://github.com/anthropics/claude-code/issues/38335) · [https://github.com/ArkNill/claude-code-hidden-problem-analysis](https://github.com/ArkNill/claude-code-hidden-problem-analysis) · [https://github.com/cnighswonger/claude-code-cache-fix](https://github.com/cnighswonger/claude-code-cache-fix)

Tech, UI, environment variables, and API: **[Documentation](docs/README.md)**.

### Documentation

The **complete** description is in **[docs/](docs/README.md)** with sub-pages (architecture, UI, proxy, forensics, environment variables, API).

- **Deutsch:** [docs/de/README.md](docs/de/README.md)
- **English:** [docs/en/README.md](docs/en/README.md)

### Quick Start

```bash
node server.js              # Dashboard :3333
node start.js both          # Dashboard + Proxy :8080
node start.js forensics     # CLI analysis
```

Options, logging, cache, multi-host, and sync: see the **[Documentation](docs/en/README.md)**.

### Docker

Two images: **`Dockerfile.base`** (npm deps) → **`Dockerfile`** (app). Locally e.g. `docker build -f Dockerfile.base -t claude-base:local .` then **`BASE_IMAGE=claude-base BASE_TAG=local docker compose build`**. **`docker compose up`** = **`node start.js both`** (3333 / 8080); additional modes: see headers in **`docker-compose.yml`**. CI: **`docker-compose.ci.yml`**, **`.github/workflows/docker.yml`**.

### Gitea and GitHub (Routine after merge to `main`)

Primary work is on **Gitea** (branch e.g. **`feat/proxy-logs`** → PR → **`main`**). **GitHub** serves as the public mirror; the branch there is currently usually **`feat/proxy-analytics`** → PR → **`main`** ([Repo](https://github.com/fgrosswig/claude-usage-dashboard)).

**One-time — add second remote:**

```bash
git remote add github https://github.com/fgrosswig/claude-usage-dashboard.git   # name is your choice
git fetch github
```

**A) After merge to Gitea `main` — sync GitHub `main`**

```bash
git checkout main
git pull origin main                    # origin = Gitea
git push github main                   # github remote: update main
```

**B) Upload feature for GitHub PR (align branch names)**

From the same state as the Gitea feature branch, but push under the GitHub branch name (so the open PR there gets updated):

```bash
git checkout feat/proxy-logs
git pull origin feat/proxy-logs
git push github feat/proxy-logs:feat/proxy-analytics
```

On GitHub: create PR **"feat/proxy-analytics" → `main`** or check the existing PR (shows the new push).  
Optionally local: **`gh pr create`** / **`gh pr sync`** with [GitHub CLI](https://cli.github.com/) installed, if you don't work exclusively in the web UI.

**Automatic mirror:** After merge to Gitea `main`, **`.gitea/workflows/mirror-github.yml`** pushes a sanitized snapshot to **GitHub `main`** (internally everything stays unchanged; domains and `.woodpecker`/`.gitea` do not appear publicly). The `git push github` examples above are only needed on demand (e.g. without the workflow or for a separate GitHub feature branch).

### Server and CLI Options

- **`--port`**: HTTP port (default `3333`).
- **`--log-level`**, **`--log-file`**: Diagnostic logging (see **Server Logging** below); identical to `CLAUDE_USAGE_LOG_*` environment variables.
- **`--refresh`**: Seconds until the next **full scan** (all JSONL) + SSE push — **minimum `60`**, default **`180`**. Or set **`CLAUDE_USAGE_SCAN_INTERVAL_SEC`** (≥ 60); `--refresh` takes precedence.

### Server Logging

Output to stderr, optionally to file: **`CLAUDE_USAGE_LOG_LEVEL`** = `error` | `warn` | `info` (default) | `debug` | `none`. File: **`CLAUDE_USAGE_LOG_FILE`**. CLI: **`--log-level=…`**, **`--log-file=…`**. Topics: **`scan`/`parse`**, **`cache`**, **`outage`**, **`releases`**, **`marketplace`**, **`github`**, **`i18n`**, **`server`**.

### Live Updates

- On open: **`fetch('/api/usage')`** for the current cache, plus **SSE** (`/api/stream`) in parallel.
- Green dot top right = connected; data updates without manual reload.
- Red = connection lost, browser retries automatically.

### Fast Startup / Background Scan

- The server **listens immediately**; the first parse does **not** block before `listen`.
- JSONL files are processed **in batches** (`setImmediate` between file groups) so HTTP/SSE remains responsive.
- Before the first scan: stub with `scanning: true` and a notice in the UI.

### Day Cache (Previous Days in a Single JSON)

- File: **`~/.claude/usage-dashboard-days.json`**
- If **cache version**, **scan roots**, and **`.jsonl` file count** match, previous days are loaded from the file and only the local calendar day "today" is fully counted. **Calendar gaps** without log activity do not force a full scan. Per-day **`hosts`** since cache version **3**; **version 4** invalidates older caches once; **version 5** adds **`session_signals`** (JSONL heuristics: continue/resume/retry/interrupt).
- Optional **`CLAUDE_USAGE_SKIP_IDENTICAL_SCAN=1`**: if JSONL mtimes are unchanged, a repeated full scan is skipped (fingerprint).
- The **Meta** panel shows paths for **day cache**, **releases**, **marketplace**, and **outage** JSON.
- **Force full scan:** **`CLAUDE_USAGE_NO_CACHE=1`** (or `true`), delete the cache file, add/remove `.jsonl` files (different file count), or change **`CLAUDE_USAGE_EXTRA_BASES`** / scan roots.

### Additional Machines / Imported Logs (`CLAUDE_USAGE_EXTRA_BASES`)

You can place a copied **`projects`** tree from another host somewhere — e.g. in a folder called **`HOST-B`** — and include it in the scan:

- Environment variable **`CLAUDE_USAGE_EXTRA_BASES`**: one or more directories, **separated by `;`**.
- **Short form:** `true`, `1`, `yes`, `auto`, or `on` — then all subdirectories with a **`HOST-`** prefix under **`CLAUDE_USAGE_EXTRA_BASES_ROOT`** (if empty: CWD at startup) are included.
- Paths may use **`~`** at the start or be absolute.
- **Label in the UI** = last path component (e.g. `HOST-B`).
- All sources are mixed into **the same daily aggregates**. **Duplicate** file paths are counted only once.
- **Per host:** In the API each day has a **`hosts`** object with total, output, calls, hit-limit, sub-cache, etc. With multiple roots, additional cards, table rows, and a stacked bar chart per host appear.
- **Day detail:** Click on a host sub-row to show only that host. Back: "All Hosts" or another day in the dropdown.

Example:

```bash
export CLAUDE_USAGE_EXTRA_BASES="$HOME/.claude/imports/HOST-B"
node server.js
```

Multiple directories:

```bash
export CLAUDE_USAGE_EXTRA_BASES="$HOME/sync/win-projects;$HOME/.claude/imports/HOST-B"
```

Auto-discover `HOST-*` subdirectories (root = CWD):

```bash
export CLAUDE_USAGE_EXTRA_BASES=true
cd /pfad/zu/parent-mit-HOST-B-und-HOST-C
node /pfad/zu/server.js
```

Custom parent directory (Windows PowerShell):

```powershell
$env:CLAUDE_USAGE_EXTRA_BASES = "true"
$env:CLAUDE_USAGE_EXTRA_BASES_ROOT = "C:\Temp"
node server.js
```

### Meta Line & Legend (Collapsible)

- Below the main heading: **collapsible** block for model notice, parse/status line, limit/data source, and scan sources.
- **Collapsed**: short summary (number of log files, refresh interval).
- **Expanded**: smaller text so cards come into view faster.
- State stored in **`sessionStorage`** as **`usageMetaDetailsOpen`**.

### UI: Select Day (Cards & Table)

- **Dropdown**: all days with data (newest first).
- **Cards** and **day detail table**: selected day. **Charts** and **forensic chart**: all days.
- Selection stored in **`sessionStorage`** as **`usageDashboardDay`**.
- Calendar "today" with 0 tokens: brief notice.

### GitHub API (Releases)

Unauthenticated limit: only **~60 requests/hour per IP**. On _rate limit_: set **`GITHUB_TOKEN`** or **`GH_TOKEN`** (a classic PAT is sufficient for a public repo). **No periodic fetch:** network only when **`~/.claude/claude-code-releases.json`** is missing or empty — otherwise disk cache. Manual: **`POST /api/github-releases-refresh`**; optionally **`CLAUDE_USAGE_ADMIN_TOKEN`** with `Authorization: Bearer`. Force on startup: **`CLAUDE_USAGE_GITHUB_RELEASES_FETCH=1`**. **Optional in the UI:** expand the meta area, enter PAT — stored only in this tab's `sessionStorage`.

### Limits & Forensic (Heuristic Only)

- **Data source** in the UI: generic **`~/.claude/projects`** (no absolute paths with usernames).
- **Hit Limit (red in charts):** Counts JSONL lines with typical rate/limit patterns — no direct API proof.
- **Forensic** (collapsible): Codes **`?`** (very high cache read), **`HIT`** (limit lines), **`<<P`** (strict peak comparison). Not equivalent to the Claude UI "90% / 100%".
- **Forensic session signals** (separate chart): per-day stacked bars (continue, resume, retry, interrupt), then **outage hours** on top. **Purple line** = cache read (separate right axis).

### CLI Forensics (`scripts/token-forensics.js`)

Separate analysis tool with **automatic peak and limit detection** (no hard-coded data). Uses the **same scan roots** as the dashboard and **day cache version 5**.

```bash
node start.js forensics
```

(Identical to `node scripts/token-forensics.js` or `node token_forensics.js` in the repo root.)

**Automatic detection:**

- **Peak day:** Day with the highest total consumption.
- **Limit days:** Days with >= 50 rate/limit lines in JSONL or cache read >= 500M.
- **Conclusion comparison:** Last limit day with significant activity (>= 50 calls, >= 2h active).

**7 sections:**

1. **Daily overview** — cache:output ratio, active hours, limit label, outage marker.
2. **Efficiency collapse** — overhead (tokens per output token), output/h, subagent share.
3. **Subagent analysis** — cache multiplier: subagent cache as a proportion of total cache.
4. **Budget estimate** — implied cap (`total/0.9`) per limit day, trend, median range. Outage days are separated (_OUT_ marker).
5. **Hourly analysis** — hour-by-hour breakdown of the last meaningful limit day.
6. **Conclusion** — comparison peak day vs. limit day: budget reduction, estimated minutes until limit.
7. **Visual** — ASCII bar chart with peak/limit/outage markers.

**Takeaways for MAX plans:** The peak/limit comparison shows whether the session budget has changed. The `cache:output` ratio indicates efficiency — fewer subagents = less overhead = longer work until limit.

### Anthropic Monitor Proxy (`start.js proxy` / `anthropic-proxy.js`)

Implementation: **`scripts/anthropic-proxy-core.js`** and **`scripts/anthropic-proxy-cli.js`**. Optional **HTTP forward proxy** (no npm packages): accepts Anthropic-compatible requests and forwards them to **`https://api.anthropic.com`** (or `--upstream`). This allows **logging traffic** and capturing **cache metrics** from API responses alongside the JSONL under `~/.claude/projects`.

**Start:**

```bash
node start.js proxy --port=8080
```

**Point Claude to the proxy:**

```bash
ANTHROPIC_BASE_URL=http://127.0.0.1:8080 claude
```

**Logging:** Each completed upstream response produces **one NDJSON line** under **`~/.claude/anthropic-proxy-logs/proxy-YYYY-MM-DD.ndjson`** (overridable with **`ANTHROPIC_PROXY_LOG_DIR`**). Fields: **`ts_start`/`ts_end`**, **`duration_ms`**, **`path`**, **`upstream_status`**, **`usage`** (incl. `cache_read_input_tokens`, `cache_creation_input_tokens`), **`cache_read_ratio`**, **`cache_health`**:

- **`healthy`:** Cache read share of (read + creation) >= 80%.
- **`affected`:** Share < 40% with existing cache traffic (heavy creation, low read = cache churn).
- **`mixed`**, **`na`**, **`unknown`** depending on the situation.

**Rate Limits & Metadata:** Each line contains **`request_meta`** and **`response_anthropic_headers`** (e.g. `anthropic-ratelimit-*`, `request-id`, `cf-ray`).

### Loading Data into the Dashboard (Remote / Container)

When the server **cannot read `~/.claude/projects` directly**:

- **`POST /api/claude-data-sync`**: request body = **gzip-compressed tar**. Header **`Authorization: Bearer <CLAUDE_USAGE_SYNC_TOKEN>`**.
- Only paths under **`projects/**`** and **`anthropic-proxy-logs/**`** are extracted.
- Max upload: **`CLAUDE_USAGE_SYNC_MAX_MB`** (default **512**).
- Helper: **`scripts/claude-data-sync-client.js`**.

### Extension Updates (Service Impact Chart & Report)

- **Marker data:** Primarily **VS Code Marketplace** ([Version History](https://marketplace.visualstudio.com/items?itemName=anthropic.claude-code&ssr=false#version-history)): `lastUpdated`, latest version by semver. Data aligned to **UTC calendar day**. Cached under **`~/.claude/claude-code-marketplace-versions.json`**.
- **Changelog lines:** **GitHub Releases** (up to 100 entries per fetch), cached under **`~/.claude/claude-code-releases.json`**. **Date sources:** Merge marketplace + GitHub (marketplace date takes precedence); then JSONL fallback.
- **Version from JSONL:** Normalized to **`major.minor.patch`** for fallback and analytics.

### Deployment

```bash
# Docker / K8s
node start.js both          # Dashboard (3333) + Proxy (8080)
node start.js dashboard     # Dashboard only
node start.js proxy         # Proxy only

# K8s with Kustomize
kubectl apply -k k8s/overlays/dev

# JSONL sync from another machine
~/.claude/sync-to-dashboard.sh
```

### Environment Variables

| Variable                         | Default                          | Description                                           |
| -------------------------------- | -------------------------------- | ----------------------------------------------------- |
| `ANTHROPIC_PROXY_BIND`           | `127.0.0.1`                      | Proxy bind address                                    |
| `ANTHROPIC_PROXY_PORT`           | `8080`                           | Proxy port                                            |
| `ANTHROPIC_PROXY_LOG_DIR`        | `~/.claude/anthropic-proxy-logs` | NDJSON log directory                                  |
| `CLAUDE_USAGE_EXTRA_BASES`       | —                                | `auto` or `;`-separated paths                         |
| `CLAUDE_USAGE_EXTRA_BASES_ROOT`  | `cwd`                            | Root for HOST-\* auto-discovery                       |
| `CLAUDE_USAGE_SYNC_TOKEN`        | —                                | Token for `/api/claude-data-sync`                     |
| `CLAUDE_USAGE_SYNC_MAX_MB`       | `512`                            | Max upload size                                       |
| `CLAUDE_USAGE_SCAN_INTERVAL_SEC` | `180`                            | Scan interval (min. 60)                               |
| `CLAUDE_USAGE_NO_CACHE`          | —                                | `1` or `true` forces full scan                        |
| `CLAUDE_USAGE_LOG_LEVEL`         | `info`                           | `error`/`warn`/`info`/`debug`/`none`                  |
| `CLAUDE_USAGE_LOG_FILE`          | —                                | Log file (in addition to stderr)                      |
| `GITHUB_TOKEN` / `GH_TOKEN`      | —                                | GitHub PAT for releases (>60 req/h)                   |
| `CLAUDE_USAGE_ADMIN_TOKEN`       | —                                | Bearer token for admin endpoints                      |
| `DEBUG_API`                      | —                                | `1` enables `/api/debug/proxy-logs` endpoint          |
| `DEV_PROXY_SOURCE`               | —                                | URL of the remote dashboard for dev testing           |
| `DEV_MODE`                       | —                                | `proxy` (only proxy remote) or `full` (all remote)    |

### API (Brief)

- **`GET /`**: HTML dashboard.
- **`GET /api/usage`**: JSON with `days` (per day `hosts`, `session_signals`, `outage_hours`, `cache_read`, …), `host_labels`, `calendar_today`, `day_cache_mode`, `scanning`, `parsed_files`, `scanned_files`, `scan_sources`, `forensic_*`.
- **`POST /api/claude-data-sync`**: JSONL upload (gzip tar).
- **`POST /api/github-releases-refresh`**: Manually refresh releases.

### Local Dev Testing

Test the dashboard locally with real remote data (cluster needs `DEBUG_API=1`):

```powershell
# PowerShell — everything from remote (no local scan)
$env:DEV_PROXY_SOURCE="https://claude-usage.grosswig-it.de"; $env:DEV_MODE="full"; node start.js dashboard

# PowerShell — only proxy from remote, JSONL local
$env:DEV_PROXY_SOURCE="https://claude-usage.grosswig-it.de"; $env:DEV_MODE="proxy"; node start.js dashboard
```

```bash
# bash — everything from remote
DEV_PROXY_SOURCE=https://claude-usage.grosswig-it.de DEV_MODE=full node start.js dashboard
```

- **DEV FULL banner** at the top with sync button + last-sync timestamp
- Auto-sync every 180s, `node start.js both` blocks in dev mode
- See `k8s/README.md` for Mermaid flowchart

### UDAA Field Study — Anonymized Session Export

The dashboard includes an **exporter** for the UDAA field study (Usage Drain Anomalies Audit). It exports **anonymized** session data (token counts, time deltas, model ID only) — no prompts, no paths, no hostnames.

```bash
node scripts/udaa-fieldstudy-export.js              # Export all sessions
node scripts/udaa-fieldstudy-export.js --dry-run     # Preview without writing files
node scripts/udaa-fieldstudy-export.js --out ./data  # Custom output directory
```

Share data: Upload exported JSON files via [file.io](https://www.file.io) (one-time download), [catbox.moe](https://catbox.moe), or [temp.sh](https://temp.sh).

Details: **[docs/en/10-udaa-field-study.md](docs/en/10-udaa-field-study.md)** | **[Deutsch](docs/de/10-udaa-feldstudie.md)** | **[한국어](docs/ko/10-udaa-field-study.md)**

### References

- [Claude Code Hidden Problem Analysis](https://github.com/ArkNill/claude-code-hidden-problem-analysis) — basis for anomaly detection (B1-B8)
- Bug detection in the health panel: B3 false rate limiter, B4 context stripping, B5 tool truncation
- Quota benchmark: 1% ≈ 1.5-2.1M visible tokens (ArkNill reference)
- SSE stop_reason extraction for stop anomaly detection

### Screenshots

**Token overview** (dashboard) and **proxy analytics** — more in [docs/en/08-screenshots.md](docs/en/08-screenshots.md).

![Token overview / main charts](images/main_overview_statistics.png)

![Anthropic monitor proxy / proxy analytics](images/proxy_statistics.png)
