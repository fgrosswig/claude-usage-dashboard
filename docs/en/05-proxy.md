# Anthropic Monitor Proxy

[← Contents](README.md)

Implementation: **`scripts/anthropic-proxy-core.js`**, **`scripts/anthropic-proxy-cli.js`**. Optional **HTTP forward proxy** with no additional npm dependencies in the script: requests to **`https://api.anthropic.com`** (or **`--upstream`**).

## Start

```bash
node start.js proxy --port=8080
```

Root equivalent: `node anthropic-proxy.js --port=8080`.

## Pointing Claude at the Proxy

Locally:

```bash
ANTHROPIC_BASE_URL=http://127.0.0.1:8080 claude
```

Over the network / deployment (placeholder only — adjust scheme and port to match your ingress):

```bash
ANTHROPIC_BASE_URL=http://proxy.host.domain.tld:8080 claude
```

The **dashboard** typically runs under a **different** hostname URL, e.g. **`https://dashboard.host.domain.tld`** (web UI on **3333** or HTTPS); the **proxy** is at **`proxy.host.domain.tld:8080`** — two separate entry points or one host with path routing, depending on the installation.

## Logging (NDJSON)

Every completed upstream response: **one line** in **`~/.claude/anthropic-proxy-logs/proxy-YYYY-MM-DD.ndjson`** (override: **`ANTHROPIC_PROXY_LOG_DIR`**).

Key fields: **`ts_start`/`ts_end`**, **`duration_ms`**, **`path`**, **`upstream_status`**, **`usage`** (incl. `cache_read_input_tokens`, `cache_creation_input_tokens`), **`cache_read_ratio`**, **`cache_health`**:

- **`healthy`:** cache read share of (Read + Creation) ≥ **80 %**
- **`affected`:** share **< 40 %** with existing cache traffic (much creation, little read)
- **`mixed`**, **`na`**, **`unknown`** depending on the case

**Rate Limits & Metadata:** **`request_meta`**, **`response_anthropic_headers`** (e.g. `anthropic-ratelimit-*`, `request-id`, `cf-ray`).

## Subagents, Tools, JSONL Alignment

- The proxy sees HTTP (e.g. `tools`, `tool_use` / `tool_result`); **`request_hints`** / **`response_hints`**.
- Subagent sessions are often identifiable by **JSONL paths** (`subagent`).
- With **`ANTHROPIC_PROXY_ALIGN_JSONL=1`**: assignment to the nearest JSONL line → **`jsonl_alignment`** incl. **`is_subagent_path`**.

Additional variables: **`ANTHROPIC_PROXY_LOG_STDOUT=1`**, **`ANTHROPIC_PROXY_LOG_BODIES=1`** (caution: may expose secrets), **`ANTHROPIC_PROXY_JSONL_ROOTS`**, **`ANTHROPIC_PROXY_BIND`**.

Help: `node start.js proxy -- --help` or `node anthropic-proxy.js --help`.

## Behind a Reverse Proxy / in Containers

Typically **`ANTHROPIC_PROXY_BIND=0.0.0.0`**, port **8080**, and an externally reachable service — same parameters as local, only networking/exposure is an operational concern (not part of the `docs/` repo documentation).
