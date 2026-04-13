# Intelligence Section and Metrics Engine

[← Table of Contents](README.md)

> **Status:** initial implementation. Weights, score formulas and thresholds are preliminary and need to be validated and calibrated against real usage data.

## Overview

The Intelligence Section provides predictive metrics and automated analysis of API usage. It is powered by the **Metrics Engine** (`public/js/metrics-engine.js`) — 7 independent, pure-function modules.

## Metrics Engine Modules

### 1. Saturation Score

Weighted composite score (0-100) from four factors:

| Factor | Weight |
|--------|--------|
| Latency | 30% |
| Error Rate | 20% |
| Cache Miss | 15% |
| Quota Usage | 35% |

High value = system under pressure.

### 2. Quota ETA

Estimated time remaining until quota exhaustion. Calculation:

- **Primary**: burn rate from `q5_samples` (5h window proxy data)
- **Fallback**: average from active hours

### 3. EWMA (Exponentially Weighted Moving Average)

- `ewma(prevValue, newValue, alpha)` — single value
- `ewmaArray(values, alpha)` — array smoothing
- Used for trend detection in latency and error rate

### 4. Health Score

Inverted composite score (0-100, higher = better):

| Dimension | Weight |
|-----------|--------|
| Reliability | 35% |
| Capacity | 30% |
| Efficiency | 35% |

### 5. Root Cause Detection

Top 5 factors contributing most to the current state, with delta percentage vs. average.

### 6. Narrative Summary

Human-readable status lines with colored dots:
- Green: normal
- Yellow: elevated attention
- Red: critical

### 7. Seasonality Baseline

Average requests and latency per hour (0-23h) — shows typical daily patterns.

## Intelligence Section UI

The section displays:

- **3 KPI Cards**: Saturation Score, Health Score, Quota ETA
- **Narrative Box**: auto-generated status description
- **Root Cause Panel**: top factors with percentage deviation
- **Seasonality Chart**: ECharts bar chart (requests per hour)

## Data Sources

- **Proxy data**: latency, error rate, cache hit ratio, quota samples
- **JSONL data**: requests per hour, token consumption
- **Computed values**: all scores are calculated client-side in real time

## Extract-Cache (Performance)

For session-turns computation (Economic Usage), a pre-extraction cache was introduced:

- **`scripts/extract-cache.js`** — extracts relevant JSONL records (~150 bytes instead of 5-50 KB per record)
- Signal detection (classifySignals, scanLineHitLimit) runs during extraction
- File manifest with mtime+size for incremental sync

### Performance

| Scenario | Without Cache | With Cache | Factor |
|----------|--------------|------------|--------|
| Extract-Cache Build | 95s | 169ms | 560x |
| Session-Turns | 38.5s | 7ms | 5500x |

`session-turns-core.js` uses `pass1FromExtractCache()` and `buildSessionTurnsFromCache()` for the fast path.
