# Limits, Forensik und CLI

[← Inhaltsverzeichnis](README.md)

## Nur Heuristik

- **Datenquelle** in der UI: generisch **`~/.claude/projects`** (keine Nutzerpfade mit Namen).
- **Hit Limit (rot in Charts):** JSONL-Zeilen mit typischen Rate-/Limit-Mustern — **kein** direkter API-Beweis.
- **Forensic-Codes:** **`?`** (sehr hoher Cache-Read), **`HIT`** (Limit-artige Zeilen), **`<<P`** (strenger Peak-Vergleich). **Nicht** gleichbedeutend mit Claude-UI „90 % / 100 %“.
- **Session-Signale-Chart:** gestapelte Balken (continue, resume, retry, interrupt), **Ausfallstunden** oben; **lila Linie** = Cache Read (rechte Achse) — Tagesheuristik, keine Kausalität.

## CLI-Forensik

**`scripts/token-forensics.js`** — dieselben Scan-Wurzeln wie das Dashboard, Day-Cache **Version 5**.

```bash
node start.js forensics
# bzw. node scripts/token-forensics.js / node token_forensics.js
```

**Automatik:** Peak-Tag (höchster Gesamtverbrauch); Limit-Tage (≥ 50 Rate-/Limit-Zeilen in JSONL **oder** Cache-Read ≥ 500 M); Vergleich mit letztem sinnvollen Limit-Tag (≥ 50 Calls, ≥ 2 h aktiv).

**Sieben Ausgabe-Abschnitte:** Tagesübersicht, Effizienz-Kollaps, Subagent-Analyse, Budget-Schätzung (`total/0.9`), Stundenanalyse, Fazit (Peak vs. Limit), ASCII-Visualisierung.

**MAX-Pläne:** Peak/Limit zeigt, ob sich das Session-Budget verschoben hat; **Cache:Output** zeigt Effizienz (weniger Subagents → weniger Overhead).
