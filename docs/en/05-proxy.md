# Anthropic monitor proxy

[← Contents](README.md)

**`scripts/anthropic-proxy-core.js`**, **`scripts/anthropic-proxy-cli.js`**. Forward to **`https://api.anthropic.com`** or **`--upstream`**.

```bash
node start.js proxy --port=8080
ANTHROPIC_BASE_URL=http://127.0.0.1:8080 claude
# deploy (placeholder — adjust scheme/port to your ingress):
# ANTHROPIC_BASE_URL=http://proxy.host.domain.tld:8080 claude
```

Typical split: **dashboard** at **`https://dashboard.host.domain.tld`** (UI) vs **proxy** at **`http://proxy.host.domain.tld:8080`** for **`ANTHROPIC_BASE_URL`** — or one host with path routing, depending on setup.

NDJSON line per response: **`~/.claude/anthropic-proxy-logs/proxy-YYYY-MM-DD.ndjson`** (**`ANTHROPIC_PROXY_LOG_DIR`**). Fields include **`usage`**, **`cache_read_ratio`**, **`cache_health`** (`healthy` ≥80 % read share, `affected` <40 % with traffic), **`request_meta`**, **`response_anthropic_headers`**.

**`ANTHROPIC_PROXY_ALIGN_JSONL=1`**: align to JSONL → **`jsonl_alignment`**, **`is_subagent_path`**. See **`node anthropic-proxy.js --help`**.

Full German section (identical technical detail): [05-anthropic-proxy.md](../de/05-anthropic-proxy.md).
