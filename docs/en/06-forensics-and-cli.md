# Limits, Forensics, and CLI

[← Contents](README.md)

## Heuristics Only

- **Data source** in the UI: generically **`~/.claude/projects`** (no user paths containing names).
- **Hit Limit (red in charts):** JSONL lines matching typical rate/limit patterns — **no** direct API proof.
- **Forensic codes:** **`?`** (very high cache read), **`HIT`** (limit-like lines), **`<<P`** (strict peak comparison). **Not** equivalent to the Claude UI "90 % / 100 %" indicator.
- **Session signals chart:** stacked bars (continue, resume, retry, interrupt), **outage hours** on top; **purple line** = cache read (right axis) — daily heuristic, no causation implied.

## CLI Forensics

**`scripts/token-forensics.js`** — same scan roots as the dashboard, day cache **version 5**.

```bash
node start.js forensics
# or: node scripts/token-forensics.js / node token_forensics.js
```

**Automatic selection:** peak day (highest total usage); limit days (≥ 50 rate/limit lines in JSONL **or** cache read ≥ 500 M); comparison with the last meaningful limit day (≥ 50 calls, ≥ 2 h active).

**Seven output sections:** daily overview, efficiency collapse, subagent analysis, budget estimate (`total/0.9`), hourly analysis, conclusion (peak vs. limit), ASCII visualization.

**MAX plans:** peak/limit shows whether the session budget has shifted; **Cache:Output** shows efficiency (fewer subagents → less overhead).
