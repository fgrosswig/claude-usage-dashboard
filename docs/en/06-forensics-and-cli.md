# Forensics and CLI

[← Contents](README.md)

Heuristic only: **Hit limit** = JSONL pattern count, not proof. Codes **`?`**, **`HIT`**, **`<<P`** — not the Claude UI 90 %/100 %. Session chart: stacked signals + outage hours on top; purple line = same-day cache read (right axis), not causation.

```bash
node start.js forensics
# or: node scripts/token-forensics.js — same as node token_forensics.js in repo root
```

Same scan roots as the dashboard; day cache **v5**. Seven report sections (overview, efficiency, subagents, budget `total/0.9`, hourly, conclusion, ASCII chart). Peak vs limit day for **MAX** planning.
