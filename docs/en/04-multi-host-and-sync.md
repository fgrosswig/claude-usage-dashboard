# Multi-host and sync

[← Contents](README.md)

**`CLAUDE_USAGE_EXTRA_BASES`**: `;`-separated paths, or `true`/`auto`/… to add every **`HOST-*`** child under **`CLAUDE_USAGE_EXTRA_BASES_ROOT`** (default CWD). Labels = last path segment. Same absolute path counted once. API **`hosts`** per day; UI adds rows, stacked bars, subagent cache %.

## HTTP upload to the dashboard (remote / container)

If **`~/.claude/projects`** is not readable on the server host (e.g. app runs in Kubernetes):

- **`POST /api/claude-data-sync`**: body = **gzip-compressed tar**.
- Header **`Authorization: Bearer <token>`** — must match **`CLAUDE_USAGE_SYNC_TOKEN`** in the server process.
- Only **`projects/**`** and **`anthropic-proxy-logs/**`** are extracted.
- Max size: **`CLAUDE_USAGE_SYNC_MAX_MB`** (default **512**).
- Client helper: **`scripts/claude-data-sync-client.js`**. Ingest: **`scripts/claude-data-ingest.js`**.

### Kubernetes: token from a Secret (not in Git)

In **`k8s/base/deployment.yml`**, **`CLAUDE_USAGE_SYNC_TOKEN`** is loaded from Secret **`claude-usage-dashboard-app`**, key **`sync-token`** (`optional: true`). Create and rotate the secret as described in **`k8s/README.md`**. Do **not** set the token as plaintext `env` on the Deployment (merge issues and leaks).

To read the same token on your laptop for **`CLAUDE_SYNC_TOKEN`** (requires **`kubectl`** access to the cluster):

- **`scripts/print-claude-sync-token.ps1`** (PowerShell)
- **`scripts/print-claude-sync-token.sh`** (bash; needs **`base64`**)

Override defaults with **`CLAUDE_SYNC_K8S_NAMESPACE`** (default **`claude`**) and **`CLAUDE_SYNC_K8S_SECRET`** (default **`claude-usage-dashboard-app`**).

**Example (PowerShell, NodePort):**

```powershell
$env:CLAUDE_SYNC_TOKEN = (& pwsh -NoProfile -File .\scripts\print-claude-sync-token.ps1).Trim()
$env:CLAUDE_SYNC_URL = "http://NODE_IP:31333"
node scripts/claude-data-sync-client.js
```

More multi-host examples: [04-multi-host-und-datensync.md](../de/04-multi-host-und-datensync.md).
