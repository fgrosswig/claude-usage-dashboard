# Überblick

[← Inhaltsverzeichnis](README.md)

Standalone Node-Server für **Claude Code**: Token-Nutzungs-Analyse, Anomalie-Erkennung und Proxy-Monitoring. Liest **`~/.claude/projects/**/*.jsonl`** und zeigt Nutzung, heuristische Limits und Forensik in einer Web-UI. Nur **`claude-*`**-Modelle werden gezählt (kein `<synthetic>`).

## Features (Kurzüberblick)

### Health Score (Ampel)

- **14 Indikatoren** mit Grün/Gelb/Rot: Quota 5h, Thinking Gap, Cache Health, Error Rate, Hit Limits, Latenz, Interrupts, Cold Starts, Retries, False 429 (B3), Truncations (B5), Context Resets (B4), Tokens/1 % Quota, anomale Stops
- **Score 0–10** mit Trend-Chart über alle Tage
- **Kernbefunde** — automatisch berechnete Hinweise (Thinking-Gap, Overhead, Cache-Paradox u. a.)
- **ArkNill-Bugs** B1–B8 (z. B. False 429, Context Stripping, Tool Truncation)
- Einklappbar: kompakte Ampel-Zeile

### Proxy Analytics

- Transparenter HTTPS-Proxy mit NDJSON-Logging
- Stat-Karten, Token-Kosten (Cache Read / Creation / Output), Latenz, Modell-Verteilung, stündliche Last
- Cold-Starts, SSE-`stop_reason`, Vergleich JSONL vs. Proxy (Thinking-Duplikation)

### Status & Incidents

- Ausfall-Stunden, Hit-Limits, Extension-Updates (Marketplace + GitHub)
- Live **Anthropic**-Badge in der Top-Bar

### Token Stats

- Karten und vier Hauptdiagramme (täglicher Verbrauch, Cache:Output, Output/Stunde, Subagent-Cache)
- Abschnitt einklappbar

### Forensik

- Hit-Limits aus JSONL, Session-Signale, Service-Impact vs. Arbeitszeit, Cache-Read-Korrelation, Markdown-Report

### Multi-Host

- Mehrere Quellen (`HOST-*`), Host-Filter, Auto-Discovery, optional HTTP-Sync der Logs

### Navigation

- Datumsbereich, Tag für Karten/Tabelle, Scope Alle Tage / 24 h, Quelle Gesamt pro Host

## Architektur

```
start.js (dashboard | both | proxy | forensics)
  ├── scripts/dashboard-server.js    # HTTP + SSE + Parsing
  ├── scripts/dashboard-http.js
  ├── scripts/anthropic-proxy-cli.js # Proxy → NDJSON
  ├── scripts/usage-scan-roots.js
  ├── scripts/service-logger.js
  ├── tpl/dashboard.html
  ├── tpl/de/ui.tpl + tpl/en/ui.tpl  # i18n (JSON)
  ├── public/js/dashboard.client.js
  └── public/css/dashboard.css
```

Hilfen: `scripts/extract-dashboard-assets.js`, CLI `scripts/token-forensics.js`; Root-Alias `claude-usage-dashboard.js` → `server.js`.

## Repository-Hinweise

Im Repo gilt eine **Whitelist**-[`.gitignore`](../../.gitignore) (alles ignorieren, dann per `!` freigeben). **`docs/`**, **`k8s/`**, Dockerfiles und **`images/`** werden versioniert, wenn vorhanden. **Keine** Secrets committen (**`.env`**, Tokens, `HOST-*`-Kopien mit personenbezogenen Pfaden).

## Referenzen

- [Claude Code Hidden Problem Analysis](https://github.com/ArkNill/claude-code-hidden-problem-analysis) — Basis für Anomalien (B1–B8)
- Quota-Benchmark: ca. 1 % ≈ 1,5–2,1 M sichtbare Tokens (ArkNill)
