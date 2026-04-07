# Multi-host and sync

[← Contents](README.md)

**`CLAUDE_USAGE_EXTRA_BASES`**: `;`-separated paths, or `true`/`auto`/… to add every **`HOST-*`** child under **`CLAUDE_USAGE_EXTRA_BASES_ROOT`** (default CWD). Labels = last path segment. Same absolute path counted once. API **`hosts`** per day; UI adds rows, stacked bars, subagent cache %.

**`POST /api/claude-data-sync`**: gzip **tar** body, **`Authorization: Bearer <CLAUDE_USAGE_SYNC_TOKEN>`**. Extracts only **`projects/**`** and **`anthropic-proxy-logs/**`**. Max **`CLAUDE_USAGE_SYNC_MAX_MB`** (default 512). Client: **`scripts/claude-data-sync-client.js`**. Ingest: **`scripts/claude-data-ingest.js`**.

Examples match the German doc: [04-multi-host-und-datensync.md](../de/04-multi-host-und-datensync.md).
