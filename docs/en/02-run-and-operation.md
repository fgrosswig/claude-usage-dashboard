# Run and operation

[← Contents](README.md)

```bash
node server.js
node start.js              # default: dashboard
node start.js both         # dashboard :3333 + proxy :8080
node start.js forensics
```

```bash
node server.js --port=4444 --refresh=300
node server.js --log-level=debug --log-file=$HOME/.claude/usage-dashboard-server.log
```

- **`--refresh`**: full scan + SSE interval — **min 60**, default **180**; overrides `CLAUDE_USAGE_SCAN_INTERVAL_SEC` (≥ 60).

## Server logging

**`CLAUDE_USAGE_LOG_LEVEL`**: `error` | `warn` | `info` (default) | `debug` | `none`. **`CLAUDE_USAGE_LOG_FILE`**: optional file. Topics: **`scan`/`parse`**, **`cache`**, **`outage`**, **`releases`**, **`marketplace`**, **`github`**, **`i18n`**, **`server`**.

## Live updates

`fetch('/api/usage')` + **SSE** `/api/stream`. First scan streams **`scan_progress`**; client debounces chart redraws (~**420 ms**). **`CLAUDE_USAGE_SCAN_FILES_PER_TICK`** (default **20**, range **1–80**).

## Fast startup

Listen immediately; JSONL parsed in batches. Until done: `scanning: true` stub.

## Day cache

**`~/.claude/usage-dashboard-days.json`**: past days reused when version, roots, and `.jsonl` count match; **today** fully re-counted. **`CLAUDE_USAGE_SKIP_IDENTICAL_SCAN=1`** skips redundant full scans. **`CLAUDE_USAGE_NO_CACHE=1`** or file / root / count changes force rescan. **`hosts`** from v3; **`session_signals`** from v5.

## GitHub (releases)

~**60 req/h** unauthenticated; set **`GITHUB_TOKEN`** / **`GH_TOKEN`** when limited. Disk cache **`~/.claude/claude-code-releases.json`**; network only if missing/empty. **`POST /api/github-releases-refresh`** with optional **`CLAUDE_USAGE_ADMIN_TOKEN`**. UI PAT → **`sessionStorage`**, sent as **`X-GitHub-Token`** (overrides env for server calls).

## Docker

**`docker compose`** and images: see [chapter 7 — Docker & CI](07-config-api-deployment.md#docker).
