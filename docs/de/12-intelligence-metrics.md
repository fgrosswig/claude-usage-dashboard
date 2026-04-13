# Wirtschaftliche Analyse und Compaction-Forensik

[← Inhaltsverzeichnis](README.md)

## Ueberblick

Die Economic-Usage-Sektion liefert eine tiefgehende Analyse der Session-Kostendynamik, Compaction-Auswirkungen und Quota-Effizienz. Sie deckt versteckte Kosten auf, die Standard-Analytics nicht zeigen: progressive Rebuild-Strafen, Quota-Burn-Anomalien und die wahren Kosten langer Sessions.

## Cache Explosion — Kosten pro Turn

Das primaere Chart zeigt den Token-Verbrauch pro Turn mit Zonenanalyse.

### Oberes Grid (Scatter)

Jeder Punkt ist ein API-Turn. Gesamtkosten = `input + output + cache_read + cache_creation`.

- **Gruene Zone** (≤ 1.5× Baseline): Warmup — Cache baut sich auf, Kosten niedrig
- **Gelbe Zone** (≤ 3× Baseline): Linear — gleichmaessiges Wachstum
- **Rote Zone** (> 3× Baseline): Drain — quadratisches Wachstum dominiert
- **Lila Punkte**: Compaction-Events (vergroessert)

Overlay-Linien:

- **Quadratischer Fit** (gelb gestrichelt): `a·t² + b·t + c` Least-Squares auf Per-Turn-Kosten
- **Context Size** (blau gepunktet): Cache-Health-Ratio `cache_read / (cache_read + cache_creation)`
- **Kostenfaktor** (pink): `cost[t] / cost[0]` — Multiplikator vs. erster Turn

Baseline = Median der ersten 50 Turns.

### Unteres Grid — Toggle

Zwei Modi ueber Toggle-Buttons unterhalb des Charts:

#### Context-Verlust (Standard)

Step-Linie die den akkumulierten Token-Verlust durch Compaction-Events zeigt. Jeder Compaction-Marker zeigt:

- Token-Drop-Betrag und Prozentsatz (z.B. "Lost 160.8K (77%)")
- Vertikale Linien an jeder Compaction-Position

Nur sichtbar wenn die Session Compaction-Events hat.

#### Kumulativ

Zwei Linien von Turn 1 bis Session-Ende:

- **Graue Linie (Tatsaechlich)**: reales `cache_read` pro Turn — Saegezahn-Muster mit Drops bei Compaction-Events
- **Gruene Linie (Envelope)**: was `cache_read` ohne Compaction-Drops waere, gewichtet mit **M_real**
- **Rote Flaeche**: die Luecke zwischen beiden = realer Rebuild-Overhead
- **Lila Badges**: an jedem Compaction-Event mit `Real_Cost (M_real×)`
- **Zonen-Baender**: Safe (gruen), Linear (gelb), Drain (rot) basierend auf Per-Turn-Fit-Schwellwerten

Der axisPointer ist zwischen oberem und unterem Grid synchronisiert.

## Progressive Compaction Penalty (M_real)

**Empirische Erkenntnis (UDAA-29):** Compaction-Verluste werden progressiv bestraft. Die realen Kosten eines Compaction-Events sind nicht nur der Token-Drop — sie beinhalten die Kosten des Wiederaufbaus zum aktuellen (hoeheren) Preisniveau.

### Formel

```text
Real_Cost = Drop × (1 + M(t))

M(t)     = f(t) / f_avg(t)
f(t)     = a·t² + b·t + c           aktuelle Per-Turn-Kosten an Position t
f_avg(t) = a·t²/3 + b·t/2 + c       Durchschnittskosten aller Turns 0..t (Integral / t)
```

### Warum (1 + M(t))

- **1×** = der Drop selbst (verlorene Tokens)
- **M(t)×** = Rebuild-Kosten (Wiederaufbau zum aktuellen Preis dessen, was urspruenglich guenstiger aufgebaut wurde)

### Konvergenz

| Session-Position | M_real | Bedeutung |
| --- | --- | --- |
| Frueh (Safe Zone) | ~2.0× | Rebuild kostet ungefaehr so viel wie der urspruengliche Aufbau |
| Mitte (Linear Zone) | ~2.5× | Rebuild merklich teurer |
| Spaet (Drain Zone) | ~2.7× | Rebuild deutlich teurer |
| Theoretisches Maximum | →4.0× | Rebuild kostet 3× das Original (1 + 3) |

### Doppelter Effekt

Der Drop selbst wird mit jedem Turn groesser (cache_read steigt, Compaction-Floor bleibt bei ~48K), UND der Multiplikator steigt. Spaet fallen = tiefer fallen × teurer aufbauen.

### Wichtige Eigenschaften

- M_real ist **nie statisch** — abhaengig von Turn-Position, Session-Baseline und Kurvenform (a, b, c)
- Jede Session hat eigene quadratische Fit-Koeffizienten
- Negatives `a` (konkaves Wachstum) begrenzt M_real auf ca. 2.6×
- Positives `a` (echte quadratische Explosion) treibt M_real Richtung 4.0×

### Empirische Daten (12.04.2026)

**Session 9afe9ab1** (927 Turns, 9 Compactions, alle in der Drain Zone):

- M_real Bereich: 2.50–2.67×
- Raw Drop: 2.9M Tokens → Reale Kosten: 7.7M Tokens
- Overhead: 2.8% der Session

**Session c2f4700e** (736 Turns, 12 Compactions, Linear→Drain):

- M_real Bereich: 2.43–2.73×
- Raw Drop: 2.4M Tokens → Reale Kosten: 6.4M Tokens
- Overhead: 4.2% der Session

## Q5 Penalty bei Compaction (UDAA-30)

**Empirische Erkenntnis:** Nach Compaction-Events kollabiert der Q5-Implied-Divisor voruebergehend auf 20–35% seines Medianwerts. Das bedeutet: Anthropic berechnet 3–5× mehr Quota pro Token waehrend der Cache-Rebuild-Phase.

| Cache-Zustand | Avg Q5-Divisor | Kosten pro Token |
| --- | --- | --- |
| Warm (Health > 80%) | ~25 (Median) | Normal |
| Post-Compaction (Health < 30%) | 4–9 | 3–5× teurer |

- **57% aller Q5-Kosten** nahe Compaction-Events sind Penalties
- Erholungszeit: 30–150 Sekunden bis Divisor sich normalisiert
- Gesamter Q5-Ueberschuss: +1.28% pro Tag (~3.8 Minuten verlorene Session-Zeit)

### Zwei unabhaengige Strafmechanismen

Compaction loest Strafen auf zwei separaten Ebenen aus:

1. **Token-Ebene**: M_real = 2.4–2.7× (mehr Tokens fuer Rebuild verbraucht)
2. **Quota-Ebene**: Q5-Divisor-Collapse = 3–5× mehr Quota pro Token waehrend Rebuild

Diese sind **additiv** in ihrem Budget-Impact, nicht multiplikativ.

## Restart-Oekonomie

Analyse optimaler Session-Restart-Intervalle basierend auf marginalen Kosten pro Output-Token.

### Das Problem

Mit wachsender Session verschlechtert sich das Verhaeltnis von produktivem Output zu Gesamtkosten:

| Turn-Bereich | Avg Kosten/Turn | Avg Output/Turn | Effizienz |
| --- | --- | --- | --- |
| 0–99 | 92K | 209 | 0.23% |
| 400–499 | 298K | 117 | 0.04% |
| 900–926 | 481K | 135 | 0.03% |

Bei Turn 900 zahlt man ~500K Tokens fuer ~200 Tokens Output. 99.7% ist Context-Erhalt.

### Break-Even-Analyse

| Strategie | Restarts | Gesamtkosten | vs. kein Restart | Ersparnis |
| --- | --- | --- | --- | --- |
| Kein Restart (927t) | 0 | 270M | Baseline | — |
| Alle 100 Turns | 14 | 119M | 0.44× | **56%** |
| Alle 150 Turns | 7 | 128M | 0.47× | **53%** |
| Alle 250 Turns | 3 | 132M | 0.49× | **51%** |
| Alle 300 Turns | 3 | 174M | 0.65× | **35%** |
| Alle 700 Turns | 1 | 336M | 1.25× | **−25%** |

Restart alle 100–150 Turns spart 53–56%, selbst mit Warmup-Overhead eingerechnet.

**Break-Even-Punkt:** Turn ~183 — ab hier kostet jeder weitere Turn mehr als nach einem Restart.

## Extract-Cache (Performance)

Pre-Extraction-Cache fuer Session-Turns-Berechnung:

- **`scripts/extract-cache.js`** — extrahiert relevante JSONL-Records (~150 Bytes statt 5–50 KB)
- Signal-Erkennung laeuft waehrend der Extraktion
- Datei-Manifest mit mtime+size fuer inkrementellen Sync

| Szenario | Ohne Cache | Mit Cache | Beschleunigung |
| --- | --- | --- | --- |
| Extract-Cache Build | 95s | 169ms | 560× |
| Session-Turns | 38.5s | 7ms | 5.500× |

## Budget Drain — Taeglicher Session-Impact

Sessions-uebergreifende Ansicht des Quota-Verbrauchs ueber den Tag. Zeigt verbleibendes Quota-Prozent pro Turn mit:

- Gradient-Fuellungen pro Session (gruen→rot)
- Session-Grenzmarkierungen (blau = normal, rot = Forced Restart)
- Rebuild-Kosten-Badges bei Forced Restarts
- Cache-Health-Overlay (warm/cooling/cold)
- Compaction-Event-Marker
- Q5 Actual vs Q5 Ideal Overlay (benoetigt Proxy-Daten)

## Datenquellen

| Chart | Quelle | Lazy Loaded |
| --- | --- | --- |
| Cache Explosion | `/api/session-turns` | Ja |
| Budget Drain | `/api/session-turns` + `/api/quota-divisor` | Ja |
| Efficiency Timeline | `/api/session-turns` | Ja |
| Extract-Cache | `scripts/extract-cache.js` Pre-Build | Nein |
