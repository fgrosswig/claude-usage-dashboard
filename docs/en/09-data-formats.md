# Data Formats

[← Table of contents](README.md)

The dashboard ingests **two distinct data sources**, each with its own file format and write path:

1. **JSONL session logs** — written by Claude Code (CLI, VS Code extension, JetBrains plugin)
2. **Proxy NDJSON logs** — written by the bundled `scripts/anthropic-proxy-core.js`

This chapter documents both formats field-by-field so that external sources (community researchers, enterprise setups, alternative proxy implementations) can produce compatible data and feed it into the dashboard without modifying core code.

Related: issue **#167** tracks the full log-format-adapter roadmap (built-in adapters, converter CLI, live adapter in the dashboard server).

---

## 1. JSONL Session Logs

### Source and location

Claude Code writes one JSONL file per session:

```
~/.claude/projects/<project-slug>/<session-uuid>.jsonl
```

- One JSON object per line, **append-only**
- Appended in chronological order as the session progresses
- Never edited or truncated after write
- Multiple sessions per day → multiple files
- `<project-slug>` is derived from the current working directory
- `<session-uuid>` is a UUID v4

### Record types

Each line represents one **event** in the session. The dashboard only counts records where `message.usage` is present (i.e. assistant turns with an upstream API response). Common `type` values:

| `type` | Meaning | Relevant to dashboard? |
|---|---|---|
| `user` | User turn (prompt, tool result, etc.) | No — token counts come from assistant turns |
| `assistant` | Assistant turn with upstream response | **Yes** — carries `message.usage`, `message.model`, `message.stop_reason` |
| `system` | System message / context update | Optional — used for entrypoint detection |
| `summary` | Auto-generated session summary | No |

### Fields consumed by the dashboard

| Field path | Type | Required? | Purpose |
|---|---|---|---|
| `timestamp` | ISO-8601 string | **yes** | Day/hour bucketing |
| `type` | string | yes | Filter assistant turns |
| `message.model` | string | yes | Model breakdown, filter `isClaudeModel()` |
| `message.usage.input_tokens` | integer | yes | Daily token chart |
| `message.usage.output_tokens` | integer | yes | Daily token chart |
| `message.usage.cache_read_input_tokens` | integer | optional | Cache trend, Budget Efficiency |
| `message.usage.cache_creation_input_tokens` | integer | optional | Cache trend, Budget Efficiency |
| `message.stop_reason` | string | optional | Stop-reason chart |
| `version` or `cli_version` or `claude_code_version` or `extension_version` | string | optional | Version Health chart, Release Stability chart |
| `message.cli_version` / `message.extension_version` / `message.client_version` / `message.claude_code_version` / `message.version` | string | optional | Version Health chart (fallback locations) |
| `entrypoint` | string | optional | Entrypoint distribution chart (`cli`, `vscode`, `intellij`, `web`, ...) |
| `sessionId` / `uuid` / `parentUuid` | string | optional | Session signal tracking (interrupts, retries) |

### Semantic notes

- **Token counts are per-request, not per-session.** Each assistant turn that hit the API has its own usage block.
- **Cache fields are optional.** On a cold start (first request in a cache-miss scenario), `cache_read_input_tokens = 0` and `cache_creation_input_tokens` may be high. On a warm turn both cache fields usually dwarf the raw `input_tokens`.
- **`message.model` is used to filter Claude models only.** Records with non-Claude models (e.g. embedding models) are skipped via `isClaudeModel()` in `scripts/dashboard-server.js`.
- **Version detection is forgiving.** Six different field locations are tried in priority order (`rec.version`, `rec.cli_version`, `rec.claude_code_version`, `rec.extension_version`, `rec.message.*`). Any non-empty semver-shaped string wins.
- **`hit_limit` detection** scans the raw line text for rate-limit keywords (separate from `message.usage`).

### Example line (sanitized)

```json
{"type":"assistant","timestamp":"2026-04-07T14:23:11.482Z","sessionId":"e1a2...","uuid":"b3c4...","parentUuid":"a1b2...","version":"2.1.96","entrypoint":"vscode","message":{"id":"msg_01...","type":"message","role":"assistant","model":"claude-opus-4-6","stop_reason":"end_turn","usage":{"input_tokens":1204,"output_tokens":487,"cache_read_input_tokens":85203,"cache_creation_input_tokens":0}}}
```

### Privacy warning

**JSONL session logs contain the full prompt and response content** (`message.content` arrays). They are personal data. **Do not share or upload JSONL files without redaction.** The dashboard only reads metadata fields listed above — it never displays or persists message bodies — but the files themselves on disk are sensitive.

---

## 2. Proxy NDJSON Logs

### Source and location

`scripts/anthropic-proxy-core.js` writes one NDJSON file per calendar day:

```
~/.claude/anthropic-proxy-logs/proxy-YYYY-MM-DD.ndjson
```

- Override path via `ANTHROPIC_PROXY_LOG_DIR` environment variable
- One JSON object per line, **append-only**
- One line per **completed upstream response** (successful or error)
- Errors without a response body are skipped (`rec.error && !rec.ts_end`)

### Fields consumed by the dashboard

| Field path | Type | Required? | Purpose |
|---|---|---|---|
| `ts_start` | ISO-8601 string | optional | Request start |
| `ts_end` | ISO-8601 string | **yes** | Day/hour bucketing (fallback: `ts_start`) |
| `duration_ms` | number | yes | Latency chart, per-hour heatmap |
| `upstream_status` | integer (HTTP code) | yes | Error rate, status-code breakdown, false-429 detection |
| `usage.input_tokens` | integer | yes | Token totals per day |
| `usage.output_tokens` | integer | yes | Token totals per day |
| `usage.cache_read_input_tokens` | integer | optional | Cache Read ratio, Budget Efficiency |
| `usage.cache_creation_input_tokens` | integer | optional | Cache Creation, Budget Efficiency |
| `cache_read_ratio` | float 0-1 | optional | Cold-start detection (< 0.5) |
| `cache_health` | `healthy` \| `mixed` \| `affected` \| `na` | optional | Cache health breakdown |
| `request_hints.model` | string | optional | Model breakdown |
| `response_hints.stop_reason` | string | optional | Stop-reason chart |
| `response_anthropic_headers["anthropic-ratelimit-unified-5h-utilization"]` | string (decimal 0-1) | optional | 5h quota fuel gauge, Budget Efficiency |
| `response_anthropic_headers["anthropic-ratelimit-unified-7d-utilization"]` | string (decimal 0-1) | optional | 7d quota fuel gauge |
| `response_anthropic_headers["anthropic-ratelimit-unified-fallback-percentage"]` | string (decimal 0-1) | optional | Fallback alert banner, capacity reduction signal |
| `response_anthropic_headers["anthropic-ratelimit-unified-overage-status"]` | string (`accepted` \| `rejected` \| ...) | optional | Capacity alert details |
| `response_anthropic_headers["anthropic-ratelimit-unified-representative-claim"]` | string (e.g. `five_hour`) | optional | Capacity alert details |
| `response_anthropic_headers["cf-ray"]` | string | optional | False-429 detection: a 429 without `cf-ray` is client-generated, not from Anthropic |

### Semantic notes

- **Rate-limit headers are fractions (0-1), not percentages.** The string `"0.03"` means 3% utilized. The dashboard multiplies by 100 to display.
- **`cache_health` is computed by the proxy** using these thresholds:
  - `healthy`: cache-read share of (read + creation) ≥ 80%
  - `affected`: share < 40% with cache traffic present (lots of creation, little read)
  - `mixed`: between the two thresholds
  - `na` / `unknown`: no cache traffic or indeterminate
- **`cold_starts` counter** increments when `cache_read_ratio < 0.5` on a 200 response — heuristic for cache-miss bursts
- **`context_resets` counter** detects B4 pattern: a cache-creation spike following a high cache-read phase
- **`false_429s` counter** detects B3 pattern: HTTP 429 responses without the `cf-ray` header (i.e. generated by intermediate middleware, not Anthropic's rate limiter)
- **Rate-limit snapshots are kept per-day, last-seen wins** (`dd.rate_limit_snapshots = [snap]` in `parseProxyNdjsonFiles`). For cumulative quota consumption (`visible_tokens_per_pct`), the server additionally collects all q5 samples chronologically and sums positive deltas in `computeQ5Consumption()`.

### Example line (sanitized)

```json
{"ts_start":"2026-04-07T14:23:11.200Z","ts_end":"2026-04-07T14:23:14.680Z","duration_ms":3480,"path":"/v1/messages","upstream_status":200,"usage":{"input_tokens":1204,"output_tokens":487,"cache_read_input_tokens":85203,"cache_creation_input_tokens":0},"cache_read_ratio":0.986,"cache_health":"healthy","request_hints":{"model":"claude-opus-4-6"},"response_hints":{"stop_reason":"end_turn"},"response_anthropic_headers":{"anthropic-ratelimit-unified-5h-utilization":"0.03","anthropic-ratelimit-unified-7d-utilization":"0.01","anthropic-ratelimit-unified-fallback-percentage":"1","cf-ray":"8a1b2c3d4e5f"}}
```

### Privacy

Proxy NDJSON logs **do not contain request or response bodies**, only headers and metadata derived from them. They are safer to share than JSONL session logs, but still contain:

- The authenticated account's quota state (via rate-limit headers)
- Request paths (which endpoints are hit)
- Timing patterns that could fingerprint a user

Strip `response_anthropic_headers["cf-ray"]` and internal path details before publishing.

---

## 3. Cross-Format Mapping Reference

For adapter authors (issue #167): this table shows how each semantic concept maps into each format and which dashboard feature consumes it.

| Concept | JSONL path | Proxy NDJSON path | Dashboard feature |
|---|---|---|---|
| Timestamp | `timestamp` | `ts_end` | Day/hour bucketing |
| Input tokens | `message.usage.input_tokens` | `usage.input_tokens` | Daily tokens, Budget Efficiency |
| Output tokens | `message.usage.output_tokens` | `usage.output_tokens` | Daily tokens, Budget Efficiency |
| Cache read | `message.usage.cache_read_input_tokens` | `usage.cache_read_input_tokens` | Cache trend, Budget Efficiency |
| Cache creation | `message.usage.cache_creation_input_tokens` | `usage.cache_creation_input_tokens` | Cache trend, Budget Efficiency |
| Model | `message.model` | `request_hints.model` | Model breakdown |
| Stop reason | `message.stop_reason` | `response_hints.stop_reason` | Stop-reason chart |
| Duration | — (implicit in turn spacing) | `duration_ms` | Latency chart, per-hour heatmap |
| HTTP status | — (implicit success) | `upstream_status` | Error rate, status-code breakdown |
| 5h quota utilization | — | `response_anthropic_headers["anthropic-ratelimit-unified-5h-utilization"]` | 5h fuel gauge, Budget Efficiency |
| 7d quota utilization | — | `response_anthropic_headers["anthropic-ratelimit-unified-7d-utilization"]` | 7d fuel gauge |
| Quota fallback | — | `response_anthropic_headers["anthropic-ratelimit-unified-fallback-percentage"]` | Capacity alert banner |
| Rate-limit event | `hit_limit` keyword scan | `upstream_status == 429` | Rate-limit counter |
| False 429 | — | `upstream_status == 429 && !response_anthropic_headers["cf-ray"]` | B3 false-429 counter |
| CLI version | `version` or `cli_version` or `claude_code_version` or `extension_version` | — | Version Health, Release Stability |
| Entrypoint | `entrypoint` | — | Entrypoint distribution |
| Cold start | — | `cache_read_ratio < 0.5 && upstream_status == 200` | Cold-start counter |

### Minimum viable record

For an external adapter targeting **Proxy NDJSON** output, the bare minimum for the dashboard to count a record is:

```json
{
  "ts_end": "2026-04-07T14:23:14.680Z",
  "duration_ms": 3480,
  "upstream_status": 200,
  "usage": {
    "input_tokens": 1204,
    "output_tokens": 487
  },
  "request_hints": {
    "model": "claude-opus-4-6"
  }
}
```

This produces entries in: daily token chart, daily call count, latency chart, model breakdown. Without rate-limit headers, the 5h/7d quota gauges and Budget Efficiency section will be empty for those days.

---

## 4. Adapter / Converter Guidance

The full adapter framework is tracked in issue **#167**. Until it lands, external sources can produce compatible files using a small conversion script.

### Example: LiteLLM logs → Proxy NDJSON

LiteLLM writes one JSON object per call with fields like `model`, `response_time`, `usage`, `status_code`. A minimal converter:

```bash
# litellm-to-proxy.sh — one-shot converter
jq -c 'select(.model | startswith("claude-")) | {
  ts_end: .end_time,
  ts_start: .start_time,
  duration_ms: (.response_time * 1000 | round),
  upstream_status: (.status_code // 200),
  usage: {
    input_tokens: .usage.prompt_tokens,
    output_tokens: .usage.completion_tokens,
    cache_read_input_tokens: (.usage.cache_read_input_tokens // 0),
    cache_creation_input_tokens: (.usage.cache_creation_input_tokens // 0)
  },
  request_hints: { model: .model },
  response_hints: { stop_reason: (.response.choices[0].finish_reason // "unknown") }
}' litellm-log.jsonl > ~/.claude/anthropic-proxy-logs/proxy-2026-04-07.ndjson
```

Drop the resulting file into the dashboard's proxy log directory and the next scan (or `POST /api/debug/cache-reset`) picks it up.

### Validation

Before feeding external data into production, validate each line as a standalone JSON object:

```bash
# Sanity check — every line should parse and have required fields
while read -r line; do
  echo "$line" | jq -e '.ts_end and .upstream_status and .usage.input_tokens != null' > /dev/null || echo "bad: $line"
done < proxy-2026-04-07.ndjson
```

---

## 5. Stability and Versioning

Neither format is formally versioned. Field additions are backward-compatible; field removals would break the dashboard. When issue #167 Phase 2 lands, the canonical internal record will get an explicit version field (`schema_version: 1`) so that adapters can target a fixed schema.

Until then: **treat the format as "current main branch"**. If you build an adapter now, pin to a specific Claude Usage Dashboard tag (e.g. `v1.2.0`) and re-verify when you upgrade.

---

## Layout File

**Path:** `~/.claude/usage-dashboard-layout.json`

Controls section order, visibility and column width in the 12-column grid. Read/written via `GET/PUT /api/layout`.

```json
{
  "v": 1,
  "order": ["health", "token-stats", "forensic", ...],
  "hiddenSections": [],
  "hiddenCharts": ["health-kpi-false429"],
  "widgets": [
    { "id": "health", "span": 12 },
    { "id": "token-stats", "span": 12 },
    { "id": "proxy", "span": 6 },
    { "id": "budget", "span": 6 }
  ]
}
```

- `widgets[]` is the primary source for order and span
- `order[]` is synchronized from `widgets[]` (compatibility)
- `hiddenSections[]` / `hiddenCharts[]` control visibility independently of order

Details: [Chapter 11 — Widget System](11-widget-system.md)

## Extract-Cache

**Path:** `~/.claude/usage-dashboard-extract-cache/`

Pre-extracted JSONL records (~150 bytes instead of 5-50 KB per record) for fast session-turns computation.

- `*.jsonl` — extracted records per source file
- `manifest.json` — mtime + size per file for incremental sync
- Generated by `scripts/extract-cache.js`
- Used by `scripts/session-turns-core.js` (`pass1FromExtractCache`, `buildSessionTurnsFromCache`)

## References

- Source of truth (JSONL consumption): `scripts/dashboard-server.js` functions `parseAllUsageIncremental`, `extractCliVersion`, `extractEntrypoint`, `classifyJsonlSessionSignals`
- Source of truth (Proxy write path): `scripts/anthropic-proxy-core.js` function `extractAnthropicPolicyHeaders` and the NDJSON writer
- Source of truth (Proxy consumption): `scripts/dashboard-server.js` functions `parseProxyNdjsonFiles`, `computeQ5Consumption`, `emptyProxyDayBucket`
- Related: issue **#167** (log format adapter / converter roadmap)
- Related: chapter [05 — Anthropic Monitor Proxy](05-proxy.md) for proxy behavior and cache-health semantics
