# Overview

[← Contents](README.md)

Standalone Node server for **Claude Code** token analysis, anomaly hints, and proxy monitoring. Reads **`~/.claude/projects/**/*.jsonl`**. Only **`claude-*`** models (no `<synthetic>`).

**Entry:** `server.js` loads **`scripts/dashboard-server.js`**, **`scripts/dashboard-http.js`**, **`scripts/usage-scan-roots.js`**, **`scripts/service-logger.js`**. UI: **`tpl/dashboard.html`**, **`public/css/dashboard.css`**, **`public/js/dashboard.client.js`** (Chart.js from CDN). **`start.js`**: `dashboard` | `both` | `proxy` | `forensics`. Helper: **`scripts/extract-dashboard-assets.js`**. **`claude-usage-dashboard.js`** aliases **`server.js`**.

## Feature summary

- **Health score:** up to **14** traffic-light indicators, score **0–10**, key findings, ArkNill **B1–B8** hints.
- **Proxy analytics:** NDJSON logging, quotas, token breakdown, latency, models, cold starts, JSONL vs proxy comparison.
- **Status:** outages, hit limits, extension timeline (Marketplace + GitHub).
- **Token stats:** cards + four main charts (daily use, cache:output, output/h, subagent cache).
- **Forensics:** JSONL hit limits, session signals, service impact, Markdown report.
- **Multi-host:** extra roots, host filter, optional tar sync.

See the German **[architecture diagram](../de/01-ueberblick.md#architektur)** for the file tree (identical layout).

## References

- [claude-code-hidden-problem-analysis](https://github.com/ArkNill/claude-code-hidden-problem-analysis)
- ~**1 % quota** ≈ **1.5–2.1 M** visible tokens (ArkNill)

## Repository notes

This tree uses a **whitelist** [`.gitignore`](../../.gitignore) (ignore all, then `!`-unignore paths). **`docs/`**, **`k8s/`**, Dockerfiles, and **`images/`** are tracked when present. Do not commit secrets (**`.env`**, tokens, `HOST-*` copies with personal data); keep local-only paths out of the index.
