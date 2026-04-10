# Overview

[← Contents](README.md)

Standalone Node server for **Claude Code**: token usage analysis, anomaly detection, and proxy monitoring. Reads **`~/.claude/projects/**/*.jsonl`** and presents usage, heuristic limits, and forensics in a web UI. Only **`claude-*`** models are counted (no `<synthetic>`).

## Features (summary)

### Health Score (traffic light)

- **14 indicators** with green/yellow/red: Quota 5 h, Thinking Gap, Cache Health, Error Rate, Hit Limits, Latency, Interrupts, Cold Starts, Retries, False 429 (B3), Truncations (B5), Context Resets (B4), Tokens/1 % Quota, anomalous Stops
- **Score 0–10** with trend chart across all days
- **Key findings** — automatically computed hints (Thinking Gap, Overhead, Cache Paradox, etc.)
- **ArkNill Bugs** B1–B8 (e.g. False 429, Context Stripping, Tool Truncation)
- Collapsible: compact traffic-light row

### Proxy Analytics

- Transparent HTTPS proxy with NDJSON logging
- Stat cards, token costs (Cache Read / Creation / Output), latency, model distribution, hourly load
- Cold starts, SSE `stop_reason`, JSONL vs. Proxy comparison (thinking duplication)

### Status & Incidents

- Outage hours, hit limits, extension updates (Marketplace + GitHub)
- Live **Anthropic** badge in the top bar

### Token Stats

- Cards and four main charts (daily usage, Cache:Output, Output/hour, Subagent Cache)
- Section collapsible

### Forensics

- Hit limits from JSONL, session signals, service impact vs. working hours, cache-read correlation, Markdown report

### Multi-Host

- Multiple sources (`HOST-*`), host filter, auto-discovery, optional HTTP sync of logs

### Navigation

- Date range, day for cards/table, scope All Days / 24 h, source Total per host

## Architecture

```
start.js (dashboard | both | proxy | forensics)
  ├── scripts/dashboard-server.js    # HTTP + SSE + Parsing
  ├── scripts/dashboard-http.js
  ├── scripts/anthropic-proxy-cli.js # Proxy → NDJSON
  ├── scripts/usage-scan-roots.js
  ├── scripts/service-logger.js
  ├── tpl/dashboard.html
  ├── tpl/de/ui.tpl + tpl/en/ui.tpl  # i18n (JSON)
  ├── public/js/dashboard.client.js
  └── public/css/dashboard.css
```

Helpers: `scripts/extract-dashboard-assets.js`, CLI `scripts/token-forensics.js`; root alias `claude-usage-dashboard.js` → `server.js`.

## Repository notes

The repo uses a **whitelist** [`.gitignore`](../../.gitignore) (ignore everything, then `!`-unignore). **`docs/`**, **`k8s/`**, Dockerfiles, and **`images/`** are tracked when present. Do **not** commit secrets (**`.env`**, tokens, `HOST-*` copies containing personal paths).

## References

- [Claude Code Hidden Problem Analysis](https://github.com/ArkNill/claude-code-hidden-problem-analysis) — basis for anomalies (B1–B8)
- Quota benchmark: ~1 % ≈ 1.5–2.1 M visible tokens (ArkNill)
