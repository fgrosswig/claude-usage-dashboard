# Datenformate

[← Inhaltsverzeichnis](README.md)

Das Dashboard verarbeitet **zwei unterschiedliche Datenquellen**, jede mit eigenem Dateiformat und Schreibpfad:

1. **JSONL-Session-Logs** — geschrieben von Claude Code (CLI, VS Code Extension, JetBrains Plugin)
2. **Proxy-NDJSON-Logs** — geschrieben vom mitgelieferten `scripts/anthropic-proxy-core.js`

Dieses Kapitel dokumentiert beide Formate Feld für Feld, damit externe Quellen (Community-Forscher, Enterprise-Setups, alternative Proxy-Implementierungen) kompatible Daten erzeugen und ins Dashboard einspeisen koennen, ohne den Kern-Code zu aendern.

Zusammenhang: Issue **#167** trackt die gesamte Log-Format-Adapter-Roadmap (eingebaute Adapter, Converter-CLI, Live-Adapter im Dashboard-Server).

---

## 1. JSONL-Session-Logs

### Quelle und Ablage

Claude Code schreibt eine JSONL-Datei pro Session:

```
~/.claude/projects/<project-slug>/<session-uuid>.jsonl
```

- Ein JSON-Objekt pro Zeile, **append-only**
- Chronologisch angehaengt waehrend die Session laeuft
- Nach Schreiben nie veraendert oder truncated
- Mehrere Sessions pro Tag → mehrere Dateien
- `<project-slug>` wird aus dem Arbeitsverzeichnis abgeleitet
- `<session-uuid>` ist eine UUID v4

### Record-Typen

Jede Zeile repraesentiert ein **Ereignis** in der Session. Das Dashboard zaehlt nur Records mit vorhandenem `message.usage` (also Assistant-Turns mit Upstream-API-Response). Uebliche `type`-Werte:

| `type` | Bedeutung | Relevant? |
|---|---|---|
| `user` | User-Turn (Prompt, Tool-Result, etc.) | Nein — Token-Counts kommen von Assistant-Turns |
| `assistant` | Assistant-Turn mit Upstream-Response | **Ja** — traegt `message.usage`, `message.model`, `message.stop_reason` |
| `system` | Systemnachricht / Kontext-Update | Optional — fuer Entrypoint-Erkennung |
| `summary` | Auto-generierte Session-Zusammenfassung | Nein |

### Vom Dashboard verwendete Felder

| Feldpfad | Typ | Pflicht? | Zweck |
|---|---|---|---|
| `timestamp` | ISO-8601 String | **ja** | Tag/Stunden-Bucketing |
| `type` | String | ja | Assistant-Turns filtern |
| `message.model` | String | ja | Model-Breakdown, `isClaudeModel()` Filter |
| `message.usage.input_tokens` | Integer | ja | Daily-Token-Chart |
| `message.usage.output_tokens` | Integer | ja | Daily-Token-Chart |
| `message.usage.cache_read_input_tokens` | Integer | optional | Cache-Trend, Budget-Efficiency |
| `message.usage.cache_creation_input_tokens` | Integer | optional | Cache-Trend, Budget-Efficiency |
| `message.stop_reason` | String | optional | Stop-Reason-Chart |
| `version` oder `cli_version` oder `claude_code_version` oder `extension_version` | String | optional | Version-Health, Release-Stability |
| `message.cli_version` / `message.extension_version` / `message.client_version` / `message.claude_code_version` / `message.version` | String | optional | Version-Health (Fallback-Positionen) |
| `entrypoint` | String | optional | Entrypoint-Verteilung (`cli`, `vscode`, `intellij`, `web`, ...) |
| `sessionId` / `uuid` / `parentUuid` | String | optional | Session-Signale (Interrupts, Retries) |

### Semantische Hinweise

- **Token-Counts sind per Request, nicht per Session.** Jeder Assistant-Turn der die API traf hat seinen eigenen Usage-Block.
- **Cache-Felder sind optional.** Bei Cold Start (erster Request ohne Cache) ist `cache_read_input_tokens = 0` und `cache_creation_input_tokens` oft hoch. Bei warmen Turns uebersteigen beide Cache-Felder ueblicherweise `input_tokens`.
- **`message.model` filtert auf Claude-Modelle.** Records mit Nicht-Claude-Modellen (z.B. Embedding-Models) werden via `isClaudeModel()` in `scripts/dashboard-server.js` uebersprungen.
- **Versions-Erkennung ist nachgiebig.** Sechs verschiedene Feldpfade werden in Priority-Reihenfolge geprueft (`rec.version`, `rec.cli_version`, `rec.claude_code_version`, `rec.extension_version`, `rec.message.*`). Der erste nicht-leere Semver-Wert gewinnt.
- **`hit_limit`-Erkennung** scannt den Roh-Zeilentext nach Rate-Limit-Keywords (unabhaengig von `message.usage`).

### Beispiel-Zeile (anonymisiert)

```json
{"type":"assistant","timestamp":"2026-04-07T14:23:11.482Z","sessionId":"e1a2...","uuid":"b3c4...","parentUuid":"a1b2...","version":"2.1.96","entrypoint":"vscode","message":{"id":"msg_01...","type":"message","role":"assistant","model":"claude-opus-4-6","stop_reason":"end_turn","usage":{"input_tokens":1204,"output_tokens":487,"cache_read_input_tokens":85203,"cache_creation_input_tokens":0}}}
```

### Datenschutz-Warnung

**JSONL-Session-Logs enthalten den kompletten Prompt- und Response-Inhalt** (`message.content` Arrays). Das sind persoenliche Daten. **JSONL-Dateien niemals ohne Redaction teilen oder hochladen.** Das Dashboard liest nur die oben aufgefuehrten Metadata-Felder — Nachrichteninhalte werden nie angezeigt oder persistiert — aber die Dateien selbst auf der Platte sind sensibel.

---

## 2. Proxy-NDJSON-Logs

### Quelle und Ablage

`scripts/anthropic-proxy-core.js` schreibt eine NDJSON-Datei pro Kalendertag:

```
~/.claude/anthropic-proxy-logs/proxy-YYYY-MM-DD.ndjson
```

- Pfad-Override via `ANTHROPIC_PROXY_LOG_DIR` Umgebungsvariable
- Ein JSON-Objekt pro Zeile, **append-only**
- Eine Zeile pro **abgeschlossener Upstream-Response** (Erfolg oder Fehler)
- Fehler ohne Response-Body werden uebersprungen (`rec.error && !rec.ts_end`)

### Vom Dashboard verwendete Felder

| Feldpfad | Typ | Pflicht? | Zweck |
|---|---|---|---|
| `ts_start` | ISO-8601 String | optional | Request-Start |
| `ts_end` | ISO-8601 String | **ja** | Tag/Stunden-Bucketing (Fallback: `ts_start`) |
| `duration_ms` | Zahl | ja | Latency-Chart, Per-Hour-Heatmap |
| `upstream_status` | Integer (HTTP-Code) | ja | Error-Rate, Status-Code-Breakdown, False-429-Erkennung |
| `usage.input_tokens` | Integer | ja | Token-Summen pro Tag |
| `usage.output_tokens` | Integer | ja | Token-Summen pro Tag |
| `usage.cache_read_input_tokens` | Integer | optional | Cache-Read-Ratio, Budget-Efficiency |
| `usage.cache_creation_input_tokens` | Integer | optional | Cache-Creation, Budget-Efficiency |
| `cache_read_ratio` | Float 0-1 | optional | Cold-Start-Erkennung (< 0.5) |
| `cache_health` | `healthy` \| `mixed` \| `affected` \| `na` | optional | Cache-Health-Breakdown |
| `request_hints.model` | String | optional | Model-Breakdown |
| `response_hints.stop_reason` | String | optional | Stop-Reason-Chart |
| `response_anthropic_headers["anthropic-ratelimit-unified-5h-utilization"]` | String (Dezimal 0-1) | optional | 5h-Quota-Gauge, Budget-Efficiency |
| `response_anthropic_headers["anthropic-ratelimit-unified-7d-utilization"]` | String (Dezimal 0-1) | optional | 7d-Quota-Gauge |
| `response_anthropic_headers["anthropic-ratelimit-unified-fallback-percentage"]` | String (Dezimal 0-1) | optional | Fallback-Alert-Banner, Capacity-Reduction-Signal |
| `response_anthropic_headers["anthropic-ratelimit-unified-overage-status"]` | String (`accepted` \| `rejected` \| ...) | optional | Capacity-Alert-Details |
| `response_anthropic_headers["anthropic-ratelimit-unified-representative-claim"]` | String (z.B. `five_hour`) | optional | Capacity-Alert-Details |
| `response_anthropic_headers["cf-ray"]` | String | optional | False-429-Erkennung: ein 429 ohne `cf-ray` ist client-generiert, nicht von Anthropic |

### Semantische Hinweise

- **Rate-Limit-Header sind Fraktionen (0-1), keine Prozente.** Der String `"0.03"` bedeutet 3% utilisiert. Das Dashboard multipliziert mit 100 fuer die Anzeige.
- **`cache_health` berechnet der Proxy** mit diesen Schwellen:
  - `healthy`: Cache-Read-Anteil an (Read + Creation) ≥ 80%
  - `affected`: Anteil < 40% bei vorhandenem Cache-Traffic (viel Creation, wenig Read)
  - `mixed`: zwischen beiden Schwellen
  - `na` / `unknown`: kein Cache-Traffic oder unbestimmt
- **`cold_starts` Counter** wird bei `cache_read_ratio < 0.5` auf 200er-Responses inkrementiert — Heuristik fuer Cache-Miss-Bursts
- **`context_resets` Counter** erkennt das B4-Pattern: ein Cache-Creation-Spike nach einer High-Cache-Read-Phase
- **`false_429s` Counter** erkennt das B3-Pattern: HTTP-429-Responses ohne `cf-ray` Header (erzeugt von zwischengeschalteter Middleware, nicht Anthropics Rate-Limiter)
- **Rate-Limit-Snapshots werden pro Tag behalten, last-seen gewinnt** (`dd.rate_limit_snapshots = [snap]` in `parseProxyNdjsonFiles`). Fuer kumulativen Quota-Verbrauch (`visible_tokens_per_pct`) sammelt der Server zusaetzlich alle q5-Samples chronologisch und summiert positive Deltas in `computeQ5Consumption()`.

### Beispiel-Zeile (anonymisiert)

```json
{"ts_start":"2026-04-07T14:23:11.200Z","ts_end":"2026-04-07T14:23:14.680Z","duration_ms":3480,"path":"/v1/messages","upstream_status":200,"usage":{"input_tokens":1204,"output_tokens":487,"cache_read_input_tokens":85203,"cache_creation_input_tokens":0},"cache_read_ratio":0.986,"cache_health":"healthy","request_hints":{"model":"claude-opus-4-6"},"response_hints":{"stop_reason":"end_turn"},"response_anthropic_headers":{"anthropic-ratelimit-unified-5h-utilization":"0.03","anthropic-ratelimit-unified-7d-utilization":"0.01","anthropic-ratelimit-unified-fallback-percentage":"1","cf-ray":"8a1b2c3d4e5f"}}
```

### Datenschutz

Proxy-NDJSON-Logs **enthalten keine Request- oder Response-Bodies**, nur Header und daraus abgeleitete Metadaten. Sicherer zu teilen als JSONL-Session-Logs, enthalten aber immer noch:

- Quota-Status des authentifizierten Accounts (via Rate-Limit-Header)
- Request-Pfade (welche Endpoints getroffen werden)
- Timing-Muster die einen Nutzer fingerprinten koennten

Vor dem Veroeffentlichen `response_anthropic_headers["cf-ray"]` und interne Pfad-Details entfernen.

---

## 3. Cross-Format-Mapping-Referenz

Fuer Adapter-Autoren (Issue #167): diese Tabelle zeigt, wie jedes semantische Konzept in die jeweiligen Formate gemappt wird und welches Dashboard-Feature es verarbeitet.

| Konzept | JSONL-Pfad | Proxy-NDJSON-Pfad | Dashboard-Feature |
|---|---|---|---|
| Timestamp | `timestamp` | `ts_end` | Tag/Stunden-Bucketing |
| Input-Tokens | `message.usage.input_tokens` | `usage.input_tokens` | Daily-Tokens, Budget-Efficiency |
| Output-Tokens | `message.usage.output_tokens` | `usage.output_tokens` | Daily-Tokens, Budget-Efficiency |
| Cache-Read | `message.usage.cache_read_input_tokens` | `usage.cache_read_input_tokens` | Cache-Trend, Budget-Efficiency |
| Cache-Creation | `message.usage.cache_creation_input_tokens` | `usage.cache_creation_input_tokens` | Cache-Trend, Budget-Efficiency |
| Modell | `message.model` | `request_hints.model` | Model-Breakdown |
| Stop-Reason | `message.stop_reason` | `response_hints.stop_reason` | Stop-Reason-Chart |
| Dauer | — (implizit im Turn-Abstand) | `duration_ms` | Latency-Chart, Per-Hour-Heatmap |
| HTTP-Status | — (impliziter Erfolg) | `upstream_status` | Error-Rate, Status-Code-Breakdown |
| 5h-Quota-Utilization | — | `response_anthropic_headers["anthropic-ratelimit-unified-5h-utilization"]` | 5h-Fuel-Gauge, Budget-Efficiency |
| 7d-Quota-Utilization | — | `response_anthropic_headers["anthropic-ratelimit-unified-7d-utilization"]` | 7d-Fuel-Gauge |
| Quota-Fallback | — | `response_anthropic_headers["anthropic-ratelimit-unified-fallback-percentage"]` | Capacity-Alert-Banner |
| Rate-Limit-Event | `hit_limit` Keyword-Scan | `upstream_status == 429` | Rate-Limit-Counter |
| False-429 | — | `upstream_status == 429 && !response_anthropic_headers["cf-ray"]` | B3-False-429-Counter |
| CLI-Version | `version` oder `cli_version` oder `claude_code_version` oder `extension_version` | — | Version-Health, Release-Stability |
| Entrypoint | `entrypoint` | — | Entrypoint-Verteilung |
| Cold-Start | — | `cache_read_ratio < 0.5 && upstream_status == 200` | Cold-Start-Counter |

### Minimum-Viable-Record

Fuer einen externen Adapter der **Proxy-NDJSON** erzeugt, ist das absolute Minimum, damit das Dashboard einen Record zaehlt:

```json
{
  "ts_end": "2026-04-07T14:23:14.680Z",
  "duration_ms": 3480,
  "upstream_status": 200,
  "usage": {
    "input_tokens": 1204,
    "output_tokens": 487
  },
  "request_hints": {
    "model": "claude-opus-4-6"
  }
}
```

Das produziert Eintraege in: Daily-Token-Chart, Daily-Call-Count, Latency-Chart, Model-Breakdown. Ohne Rate-Limit-Header bleiben die 5h/7d-Quota-Gauges und die Budget-Efficiency-Section fuer diese Tage leer.

---

## 4. Adapter- / Converter-Leitfaden

Das volle Adapter-Framework wird in Issue **#167** getrackt. Bis es landet, koennen externe Quellen kompatible Dateien mit einem kleinen Konvertierungs-Script erzeugen.

### Beispiel: LiteLLM-Logs → Proxy-NDJSON

LiteLLM schreibt ein JSON-Objekt pro Call mit Feldern wie `model`, `response_time`, `usage`, `status_code`. Ein minimaler Converter:

```bash
# litellm-to-proxy.sh — One-Shot-Konverter
jq -c 'select(.model | startswith("claude-")) | {
  ts_end: .end_time,
  ts_start: .start_time,
  duration_ms: (.response_time * 1000 | round),
  upstream_status: (.status_code // 200),
  usage: {
    input_tokens: .usage.prompt_tokens,
    output_tokens: .usage.completion_tokens,
    cache_read_input_tokens: (.usage.cache_read_input_tokens // 0),
    cache_creation_input_tokens: (.usage.cache_creation_input_tokens // 0)
  },
  request_hints: { model: .model },
  response_hints: { stop_reason: (.response.choices[0].finish_reason // "unknown") }
}' litellm-log.jsonl > ~/.claude/anthropic-proxy-logs/proxy-2026-04-07.ndjson
```

Resultierende Datei ins Proxy-Log-Verzeichnis des Dashboards ablegen, und der naechste Scan (oder `POST /api/debug/cache-reset`) greift sie auf.

### Validierung

Vor dem Einspeisen externer Daten in Production jede Zeile als eigenstaendiges JSON-Objekt validieren:

```bash
# Sanity-Check — jede Zeile sollte parsen und Pflichtfelder haben
while read -r line; do
  echo "$line" | jq -e '.ts_end and .upstream_status and .usage.input_tokens != null' > /dev/null || echo "bad: $line"
done < proxy-2026-04-07.ndjson
```

---

## 5. Stabilitaet und Versionierung

Keines der beiden Formate ist formal versioniert. Feld-Additions sind backward-compatible; Feld-Removals wuerden das Dashboard brechen. Wenn Issue #167 Phase 2 landet, bekommt der kanonische interne Record ein explizites Version-Feld (`schema_version: 1`), sodass Adapter ein fixes Schema ansprechen koennen.

Bis dahin: **Format als "current main branch" behandeln**. Wer jetzt einen Adapter baut, sollte auf einen bestimmten Claude-Usage-Dashboard-Tag pinnen (z.B. `v1.2.0`) und beim Upgrade neu verifizieren.

---

## Layout-Datei

**Pfad:** `~/.claude/usage-dashboard-layout.json`

Steuert Section-Reihenfolge, Sichtbarkeit und Spaltenbreite im 12-Spalten Grid. Wird ueber `GET/PUT /api/layout` gelesen/geschrieben.

```json
{
  "v": 1,
  "order": ["health", "token-stats", "forensic", ...],
  "hiddenSections": [],
  "hiddenCharts": ["health-kpi-false429"],
  "widgets": [
    { "id": "health", "span": 12 },
    { "id": "token-stats", "span": 12 },
    { "id": "proxy", "span": 6 },
    { "id": "budget", "span": 6 }
  ]
}
```

- `widgets[]` ist die primaere Quelle fuer Reihenfolge und Span
- `order[]` wird aus `widgets[]` synchronisiert (Kompatibilitaet)
- `hiddenSections[]` / `hiddenCharts[]` steuern Sichtbarkeit unabhaengig von der Reihenfolge

Details: [Kapitel 11 — Widget-System](11-widget-system.md)

## Extract-Cache

**Pfad:** `~/.claude/usage-dashboard-extract-cache/`

Pre-extrahierte JSONL-Records (~150 Bytes statt 5-50 KB pro Record) fuer schnelle Session-Turns-Berechnung.

- `*.jsonl` — extrahierte Records pro Quelldatei
- `manifest.json` — mtime + size pro Datei fuer inkrementellen Sync
- Erzeugt von `scripts/extract-cache.js`
- Genutzt von `scripts/session-turns-core.js` (`pass1FromExtractCache`, `buildSessionTurnsFromCache`)

## Referenzen

- Wahrheits-Quelle (JSONL-Konsum): `scripts/dashboard-server.js` Funktionen `parseAllUsageIncremental`, `extractCliVersion`, `extractEntrypoint`, `classifyJsonlSessionSignals`
- Wahrheits-Quelle (Proxy-Schreiben): `scripts/anthropic-proxy-core.js` Funktion `extractAnthropicPolicyHeaders` und der NDJSON-Writer
- Wahrheits-Quelle (Proxy-Konsum): `scripts/dashboard-server.js` Funktionen `parseProxyNdjsonFiles`, `computeQ5Consumption`, `emptyProxyDayBucket`
- Zusammenhang: Issue **#167** (Log-Format-Adapter / Converter Roadmap)
- Zusammenhang: Kapitel [05 — Anthropic Monitor Proxy](05-anthropic-proxy.md) fuer Proxy-Verhalten und Cache-Health-Semantik
