# Intelligence Section und Metrics Engine

[← Inhaltsverzeichnis](README.md)

> **Status:** erste Implementierung. Gewichtungen, Score-Formeln und Schwellwerte sind vorlaeufig und muessen anhand realer Nutzungsdaten validiert und kalibriert werden.

## Uebersicht

Die Intelligence Section bietet predictive Metriken und automatisierte Analyse der API-Nutzung. Sie basiert auf der **Metrics Engine** (`public/js/metrics-engine.js`) — 7 unabhaengige, pure-function Module.

## Metrics Engine Module

### 1. Saturation Score

Gewichteter Composite-Score (0-100) aus vier Faktoren:

| Faktor | Gewicht |
|--------|---------|
| Latenz | 30% |
| Fehlerrate | 20% |
| Cache-Miss | 15% |
| Quota-Auslastung | 35% |

Hoher Wert = System unter Druck.

### 2. Quota ETA

Geschaetzte Restzeit bis Quota-Erschoepfung. Berechnung:

- **Primaer**: Burn-Rate aus `q5_samples` (5h-Fenster Proxy-Daten)
- **Fallback**: Durchschnitt aus aktiven Stunden

### 3. EWMA (Exponentially Weighted Moving Average)

- `ewma(prevValue, newValue, alpha)` — einzelner Wert
- `ewmaArray(values, alpha)` — Array-Glaettung
- Verwendet fuer Trend-Erkennung in Latenz und Fehlerrate

### 4. Health Score

Invertierter Composite-Score (0-100, hoeher = besser):

| Dimension | Gewicht |
|-----------|---------|
| Reliability | 35% |
| Capacity | 30% |
| Efficiency | 35% |

### 5. Root Cause Detection

Top-5 Faktoren die am meisten zum aktuellen Zustand beitragen, mit Delta-Prozent gegenueber dem Durchschnitt.

### 6. Narrative Summary

Human-readable Statuszeilen mit farbigen Dots:
- Gruen: normal
- Gelb: erhoehte Aufmerksamkeit
- Rot: kritisch

### 7. Seasonality Baseline

Durchschnittliche Requests und Latenz pro Stunde (0-23h) — zeigt typische Tagesmuster.

## Intelligence Section UI

Die Section zeigt:

- **3 KPI-Cards**: Saturation Score, Health Score, Quota ETA
- **Narrative Box**: automatisch generierte Statusbeschreibung
- **Root Cause Panel**: Top-Faktoren mit Prozent-Abweichung
- **Seasonality Chart**: ECharts-Balkendiagramm (Requests pro Stunde)

## Datenquellen

- **Proxy-Daten**: Latenz, Fehlerrate, Cache-Hit-Ratio, Quota-Samples
- **JSONL-Daten**: Requests pro Stunde, Token-Verbrauch
- **Berechnete Werte**: alle Scores werden client-seitig in Echtzeit berechnet

## Extract-Cache (Performance)

Fuer die Session-Turns-Berechnung (Oekonomische Nutzung) wurde ein Pre-Extraction-Cache eingefuehrt:

- **`scripts/extract-cache.js`** — extrahiert relevante JSONL-Records (~150 Bytes statt 5-50 KB pro Record)
- Signal-Detection (classifySignals, scanLineHitLimit) laeuft waehrend der Extraktion
- File-Manifest mit mtime+size fuer inkrementellen Sync

### Performance

| Szenario | Ohne Cache | Mit Cache | Faktor |
|----------|-----------|-----------|--------|
| Extract-Cache Build | 95s | 169ms | 560x |
| Session-Turns | 38.5s | 7ms | 5500x |

Die `session-turns-core.js` nutzt `pass1FromExtractCache()` und `buildSessionTurnsFromCache()` fuer den schnellen Pfad.
