# UDAA Field Study — Anonymized Session Export

## What is UDAA?

**UDAA** (Usage Drain Anomalies Audit) is a forensic analysis framework for Claude Code sessions. It examines how token consumption escalates over a session's lifetime — particularly through cache reprocessing, compaction events, and hidden costs.

## Field Study Export

The dashboard includes an **anonymized exporter** that prepares local session data for the UDAA field study. Only **numeric and temporal fields** are exported — no prompts, no tool content, no file paths, no hostnames.

### What is exported?

Per turn (API call) within a session:

| Field | Description |
|-------|------------|
| `t_delta_ms` | Time offset from the first turn of the session (in ms) |
| `input` | Input tokens |
| `output` | Output tokens |
| `cache_read` | Cache read tokens (reprocessing) |
| `cache_creation` | Cache creation tokens |
| `model_id` | Model ID (normalized, without date suffix) |

Per session:

| Field | Description |
|-------|------------|
| `session_id_hash` | SHA-256 hash of the session ID (non-reversible) |
| `turn_count` | Number of turns |
| `schema_version` | Format version (`1.0`) |
| `client.app_version` | Dashboard version |
| `client.os_family` | Operating system (`win32`, `linux`, `darwin`) |

### What is NOT exported?

- Prompts, responses, tool content
- File paths, hostnames, CWD, git branch
- Real session IDs (SHA-256 hash only)
- Real timestamps (only relative deltas from turn 1)

### Usage

```bash
# Export all sessions
node scripts/udaa-fieldstudy-export.js

# Export to a specific directory
node scripts/udaa-fieldstudy-export.js --out ./my-data

# Preview without writing files
node scripts/udaa-fieldstudy-export.js --dry-run

# Include subagent sidechain sessions (default: skipped)
node scripts/udaa-fieldstudy-export.js --include-sidechain
```

**Output:** One `submission_<nonce>.json` per session under `./out/udaa-fieldstudy/` (or `--out`).

### Requirements

- Sessions with fewer than **2 turns** are skipped (no temporal pattern observable).
- Only `assistant` turns with actual token usage (no synthetic records).

## Sharing Data

If you'd like to contribute session data to the field study, you can share the exported JSON files through any of these services:

| Service | Max Size | Retention | Notes |
|---------|----------|-----------|-------|
| [file.io](https://www.file.io) | 2 GB | One-time download | Link expires after first download |
| [catbox.moe](https://catbox.moe) | 200 MB | No expiry | No account required |
| [temp.sh](https://temp.sh) | 4 GB | 3 days | `curl -T file.json https://temp.sh` |
| [litterbox.catbox.moe](https://litterbox.catbox.moe) | 1 GB | 1h / 12h / 24h / 72h | Selectable retention |

**Recommendation:** [file.io](https://www.file.io) — one-time download ensures only the recipient gets the data.

**Multiple files:** Bundle them first:

```bash
# Linux/Mac
tar czf udaa-export.tar.gz out/udaa-fieldstudy/

# Windows PowerShell
Compress-Archive -Path out\udaa-fieldstudy\* -DestinationPath udaa-export.zip
```

Then upload the single archive.

## Security Notes

- **Before sharing:** Review the exported JSON files. The exporter strips all sensitive content, but verifying never hurts.
- No network calls: The exporter runs **purely local** — reads JSONL, writes JSON.
- The `submission_nonce` (UUID) is randomly generated and not traceable.

## What the Data Enables

The exported sessions support:

- **Cache escalation analysis:** How fast does cost-per-turn grow over a session's lifetime?
- **Compaction detection:** When and how often does cache invalidation occur?
- **Split recommendations:** At which turn does `/clear` become cost-effective?
- **Model comparison:** Token behavior differences between Claude models.
- **Benchmarking:** Comparing usage patterns across multiple participants.
