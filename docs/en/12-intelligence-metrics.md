# Economic Analysis and Compaction Forensics

[← Table of Contents](README.md)

## Overview

The Economic Usage section provides deep analysis of session cost dynamics, compaction impact, and quota efficiency. It reveals hidden costs that standard analytics do not surface: progressive rebuild penalties, quota burn anomalies, and the true cost of long sessions.

## Cache Explosion — Cost per Turn

The primary chart showing per-turn token consumption with zone analysis.

### Upper Grid (Scatter)

Each dot represents one API turn. Total cost = `input + output + cache_read + cache_creation`.

- **Green zone** (≤ 1.5× baseline): Warmup — cache is building, costs are low
- **Yellow zone** (≤ 3× baseline): Linear — steady-state growth
- **Red zone** (> 3× baseline): Drain — quadratic growth dominates
- **Purple dots**: Compaction events (enlarged)

Overlay lines:
- **Quadratic Fit** (yellow dashed): `a·t² + b·t + c` least-squares fit on per-turn cost
- **Context Size** (blue dotted): cache health ratio `cache_read / (cache_read + cache_creation)`
- **Cost Factor** (pink): `cost[t] / cost[0]` — multiplier vs first turn

Baseline = median of first 50 turns.

### Lower Grid — Toggle

Two modes accessible via toggle buttons below the chart:

#### Context Loss (default)

Step-line showing accumulated token loss from compaction events. Each compaction marker shows:
- Token drop amount and percentage (e.g. "Lost 160.8K (77%)")
- Vertical lines at each compaction position

Only visible when the session has compaction events.

#### Cumulative

Two lines from turn 1 to session end:

- **Gray line (Actual)**: real `cache_read` per turn — saw-tooth pattern with drops at compaction events
- **Green line (Envelope)**: what `cache_read` would be without compaction drops, weighted by **M_real**
- **Red area**: the gap between them = real rebuild overhead
- **Purple badges**: at each compaction event showing `Real_Cost (M_real×)`
- **Zone markAreas**: Safe (green), Linear (yellow), Drain (red) based on per-turn fit thresholds

The axisPointer is synchronized between upper and lower grids — hover on a turn in one chart highlights the same position in the other.

## Progressive Compaction Penalty (M_real)

**Empirical finding (UDAA-29):** Compaction losses are progressively punished. The real cost of a compaction event is not just the token drop — it includes the cost of rebuilding at the current (higher) price level.

### Formula

```
Real_Cost = Drop × (1 + M(t))

M(t)     = f(t) / f_avg(t)
f(t)     = a·t² + b·t + c           current per-turn cost at position t
f_avg(t) = a·t²/3 + b·t/2 + c       average cost of all turns 0..t (integral / t)
```

### Why (1 + M(t))

- **1×** = the drop itself (tokens lost)
- **M(t)×** = rebuild cost (rebuilding at current price what was originally built cheaper)

### Convergence

| Session position | M_real | Meaning |
|------------------|--------|---------|
| Early (Safe zone) | ~2.0× | Rebuild costs roughly the same as the original build |
| Middle (Linear zone) | ~2.5× | Rebuild noticeably more expensive |
| Late (Drain zone) | ~2.7× | Rebuild significantly more expensive |
| Theoretical max (quadratic dominates) | →4.0× | Rebuild costs 3× the original (1 + 3) |

### Double effect

The drop itself grows larger with each turn (cache_read increases, compaction floor stays at ~48K), AND the multiplier increases. Late compaction = deeper fall × more expensive rebuild.

### Key properties

- M_real is **never static** — it depends on turn position, session baseline, and curve shape (a, b, c)
- Each session has its own quadratic fit coefficients
- Negative `a` (concave growth) caps M_real around 2.6×
- Positive `a` (true exponential explosion) pushes M_real toward 4.0×

### Empirical data (2026-04-12)

**Session 9afe9ab1** (927 turns, 9 compactions, all in Drain zone):
- M_real range: 2.50–2.67×
- Raw drop: 2.9M tokens → Real cost: 7.7M tokens
- Overhead: 2.8% of session

**Session c2f4700e** (736 turns, 12 compactions, Linear→Drain):
- M_real range: 2.43–2.73×
- Raw drop: 2.4M tokens → Real cost: 6.4M tokens
- Overhead: 4.2% of session

## Q5 Penalty at Compaction (UDAA-30)

**Empirical finding:** After compaction events, the Q5 implied divisor temporarily collapses to 20–35% of its median value. This means Anthropic charges 3–5× more quota per token during the cache rebuild phase.

| Cache state | Avg Q5 divisor | Cost per token |
|-------------|---------------|----------------|
| Warm (health > 80%) | ~25 (median) | Normal |
| Post-compaction (health < 30%) | 4–9 | 3–5× more expensive |

- **57% of Q5 costs** near compaction events are penalties
- Recovery time: 30–150 seconds until divisor normalizes
- Total excess Q5: +1.28% per day (~3.8 minutes lost session time)

### Two independent penalty mechanisms

Compaction triggers penalties on two separate layers:
1. **Token layer**: M_real = 2.4–2.7× (more tokens consumed for rebuild)
2. **Quota layer**: Q5 divisor collapse = 3–5× more quota per token during rebuild

These are **additive** in their budget impact, not multiplicative.

## Restart Economics

Analysis of optimal session restart intervals based on marginal cost per output token.

### The problem

As sessions grow, the ratio of productive output to total cost degrades:

| Turn range | Avg cost/turn | Avg output/turn | Efficiency |
|------------|--------------|----------------|------------|
| 0–99 | 92K | 209 | 0.23% |
| 400–499 | 298K | 117 | 0.04% |
| 900–926 | 481K | 135 | 0.03% |

At turn 900, you pay ~500K tokens to get ~200 tokens of output. 99.7% is context maintenance.

### Break-even analysis

Comparing marginal cost per output token (rolling 20-turn window) against the steady-state cost after a fresh restart (turns 50–200):

| Strategy | Restarts | Total cost | vs no restart | Saving |
|----------|----------|------------|---------------|--------|
| No restart (927t) | 0 | 270M | baseline | — |
| Every 100 turns | 14 | 119M | 0.44× | **56%** |
| Every 150 turns | 7 | 128M | 0.47× | **53%** |
| Every 250 turns | 3 | 132M | 0.49× | **51%** |
| Every 300 turns | 3 | 174M | 0.65× | **35%** |
| Every 700 turns | 1 | 336M | 1.25× | **−25%** |

Restarting every 100–150 turns saves 53–56% even with warmup overhead included.

**Break-even point:** Turn ~183 — beyond this, every additional turn costs more than it would after a restart.

## Extract-Cache (Performance)

Pre-extraction cache for session-turns computation:

- **`scripts/extract-cache.js`** — extracts relevant JSONL records (~150 bytes vs 5–50 KB)
- Signal detection runs during extraction
- File manifest with mtime+size for incremental sync

| Scenario | Without cache | With cache | Speedup |
|----------|--------------|------------|---------|
| Extract-Cache build | 95s | 169ms | 560× |
| Session-Turns | 38.5s | 7ms | 5,500× |

## Budget Drain — Daily Session Impact

Cross-session view of quota consumption across the day. Shows remaining quota percentage per turn with:

- Per-session gradient fill (green→red)
- Session boundary markers (blue = normal, red = forced restart)
- Rebuild cost badges at forced restarts
- Cache health overlay (warm/cooling/cold)
- Compaction event markers
- Q5 Actual vs Q5 Ideal overlay (requires proxy data)

## Data Sources

| Chart | Source | Lazy loaded |
|-------|--------|-------------|
| Cache Explosion | `/api/session-turns` | Yes |
| Budget Drain | `/api/session-turns` + `/api/quota-divisor` | Yes |
| Efficiency Timeline | `/api/session-turns` | Yes |
| Extract-Cache | `scripts/extract-cache.js` pre-build | No |
