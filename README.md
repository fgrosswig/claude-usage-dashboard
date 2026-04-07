**[English](README.en.md)** · Deutsch

[![Woodpecker CI — Branch main](https://ci.grosswig-it.de/api/badges/3/status.svg?branch=main)](https://ci.grosswig-it.de/repos/3)

## Claude Code Usage Dashboard

Standalone Node-Server fuer **Claude Code** Token-Nutzungs-Analyse, Anomalie-Erkennung und Proxy-Monitoring.

### Features

#### Health Score Ampel
- **9 Indikatoren** mit Gruen/Gelb/Rot Schwellwerten: Quota 5h, Thinking Gap, Cache Health, Error Rate, Hit Limits, Latenz, Interrupts, Cold Starts, Retries
- **Score 0-10** mit farbcodiertem Trend-Chart ueber alle Tage
- **Kernbefunde** — 8 auto-berechnete Findings (Thinking Token Gap, Overhead, Cache-Paradox etc.)
- Collapsible Section: Ampel-Badges im zugeklappten Zustand

#### Proxy Analytics (Anthropic Monitor Proxy)
- Transparenter HTTPS-Proxy fuer die Anthropic API mit NDJSON-Logging
- **Rate Limit Gauges** (5h + 7d Doughnut-Charts mit Reset-Countdown)
- **Token Cost Attribution** (Stacked Bar: Cache Read / Creation / Output)
- **Latenz-Charts** (Avg/Min/Max Trend + pro Stunde)
- **Modell-Verteilung** (Requests + Latenz pro Modell, dual-axis)
- **Status-Code Doughnut** (200/401/404/429 farbcodiert)
- **Cold-Start Erkennung** (Requests mit <50% Cache-Ratio)
- **JSONL vs Proxy Vergleich** (Thinking Token Duplication Ratio)

#### Anthropic Status & Incidents
- **Incident-Chart** (Outage-Stunden + Incident-Punkte pro Tag)
- **Hit Limits Trend** (Korrelation Ausfaelle vs Rate-Limits)
- **Extension-Updates** Timeline (Claude Code Versionen)
- Live Anthropic Status Badge in der Top-Bar

#### Forensic Analyse
- Hit-Limit Erkennung aus JSONL-Logs
- Session-Signale (continue/resume/retry/interrupt)
- Service Impact Chart (Arbeitszeit vs Ausfall)
- Cache Read Korrelation
- Forensic Report (Markdown-Export)

#### Multi-Host Support
- Mehrere Maschinen als separate Quellen (HOST-B, HOST-C, HOST-D etc.)
- Host-Filter (Chips bei <=5 Hosts, Multi-Select ab 6+)
- Auto-Discovery via `CLAUDE_USAGE_EXTRA_BASES=auto`
- JSONL-Sync von Remote-Maschinen (`POST /api/claude-data-sync`)

#### Filter & Navigation
- **Datumsbereich-Filter** (Start/End als Select-Dropdowns)
- **Host-Filter** (filtert alle Charts)
- **Scope-Umschalter** (Alle Tage / 24h)
- **Tag-Picker** (Karten & Tabelle)
- Top-Bar mit Live, Anthropic, Meta Badges

### Deployment

```bash
# Docker / K8s
node start.js both          # Dashboard (3333) + Proxy (8080)
node start.js dashboard     # Nur Dashboard
node start.js proxy         # Nur Proxy

# K8s mit Kustomize
kubectl apply -k k8s/overlays/dev

# JSONL-Sync von anderem Rechner
~/.claude/sync-to-dashboard.sh
```

### Umgebungsvariablen

| Variable | Default | Beschreibung |
|----------|---------|--------------|
| `ANTHROPIC_PROXY_BIND` | `127.0.0.1` | Proxy Bind-Adresse |
| `CLAUDE_USAGE_EXTRA_BASES` | — | `auto` oder `;`-getrennte Pfade |
| `CLAUDE_USAGE_EXTRA_BASES_ROOT` | `cwd` | Root fuer HOST-* Auto-Discovery |
| `CLAUDE_USAGE_SYNC_TOKEN` | — | Token fuer `/api/claude-data-sync` |
| `CLAUDE_USAGE_SYNC_MAX_MB` | `512` | Max Upload-Groesse |
| `CLAUDE_USAGE_SCAN_INTERVAL_SEC` | `180` | Scan-Intervall |

### Architektur

```
start.js (both)
  ├── scripts/dashboard-server.js    # HTTP + SSE + Parsing
  ├── scripts/anthropic-proxy-cli.js # Transparenter Proxy → NDJSON
  ├── scripts/usage-scan-roots.js    # JSONL + NDJSON Discovery
  ├── scripts/service-logger.js      # Strukturierte Logs
  ├── tpl/dashboard.html             # HTML Template
  ├── tpl/de/ui.tpl + tpl/en/ui.tpl  # i18n (JSON)
  ├── public/js/dashboard.client.js  # Browser-Logik (Chart.js)
  └── public/css/dashboard.css       # Styles (Dark Theme)
```

### Referenzen

- [Claude Code Hidden Problem Analysis](https://github.com/ArkNill/claude-code-hidden-problem-analysis) — Grundlage fuer Anomalie-Erkennung
- Basiert auf Erkenntnissen zu Thinking Token Blind Spot, Cache-Paradox, False Rate Limiter
