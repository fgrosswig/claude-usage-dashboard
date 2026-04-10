# Multi-Host and Data Synchronization

[← Contents](README.md)

## Additional Scan Roots (`CLAUDE_USAGE_EXTRA_BASES`)

Place the project tree from another machine as e.g. **`HOST-B`** and scan it alongside the local data:

- Variable **`CLAUDE_USAGE_EXTRA_BASES`**: one or more directories, **`;`-separated** (Windows and Linux).
- **Short form:** `true`, `1`, `yes`, `auto`, `on` — all subdirectories under **`CLAUDE_USAGE_EXTRA_BASES_ROOT`** (default: **CWD** at startup) whose name starts with **`HOST-`**.
- Paths: **`~`** or absolute.
- **UI label** = last path segment (e.g. `HOST-B`).
- All sources are merged into the **same daily aggregates**; identical absolute paths are counted only once.

**Per host:** API field **`hosts`** per day (Total, Output, Calls, Hit-Limit, Sub-Cache …). UI: additional cards, table rows, stacked "Tokens per day by host" chart, subagent cache %.

**Day detail:** click **`└ HOST-…`** to filter the table to that host only; return via **All Hosts** or by selecting another day.

### Examples

```bash
export CLAUDE_USAGE_EXTRA_BASES="$HOME/.claude/imports/HOST-B"
node server.js
```

```bash
export CLAUDE_USAGE_EXTRA_BASES="$HOME/sync/win-projects;$HOME/.claude/imports/HOST-B"
```

```bash
export CLAUDE_USAGE_EXTRA_BASES=true
cd /path/to/parent-with-HOST-B-and-HOST-C
node /path/to/server.js
```

**Windows PowerShell:**

```powershell
$env:CLAUDE_USAGE_EXTRA_BASES = "true"
$env:CLAUDE_USAGE_EXTRA_BASES_ROOT = "C:\Temp"
node server.js
```

## HTTP Data Upload to the Dashboard (Remote / Container)

If **`~/.claude/projects`** is not directly readable on the server:

- **`POST /api/claude-data-sync`**: body = **gzip-compressed tar**.
- Header **`Authorization: Bearer <CLAUDE_USAGE_SYNC_TOKEN>`**.
- Only **`projects/**`** and **`anthropic-proxy-logs/**`** are extracted.
- Max size: **`CLAUDE_USAGE_SYNC_MAX_MB`** (default **512**).
- Client helper: **`scripts/claude-data-sync-client.js`**.

### Kubernetes: Token from a Secret (not in Git)

In **`k8s/base/deployment.yml`**, **`CLAUDE_USAGE_SYNC_TOKEN`** comes from Secret **`claude-usage-dashboard-app`**, key **`sync-token`** (`optional: true`). Create/rotate: see **`k8s/README.md`**. No plaintext `env` on the Deployment.

**Read the same token locally for `CLAUDE_SYNC_TOKEN`** (with **`kubectl`** access to the cluster):

- **`scripts/print-claude-sync-token.ps1`** (PowerShell)
- **`scripts/print-claude-sync-token.sh`** (bash; needs **`base64`**)

Optional overrides: **`CLAUDE_SYNC_K8S_NAMESPACE`** (default **`claude`**), **`CLAUDE_SYNC_K8S_SECRET`** (default **`claude-usage-dashboard-app`**).

**Example (PowerShell, NodePort):**

```powershell
$env:CLAUDE_SYNC_TOKEN = (& pwsh -NoProfile -File .\scripts\print-claude-sync-token.ps1).Trim()
$env:CLAUDE_SYNC_URL = "http://NODE_IP:31333"
node scripts/claude-data-sync-client.js
```
