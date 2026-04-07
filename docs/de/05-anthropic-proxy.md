# Anthropic Monitor Proxy

[← Inhaltsverzeichnis](README.md)

Implementierung: **`scripts/anthropic-proxy-core.js`**, **`scripts/anthropic-proxy-cli.js`**. Optionaler **HTTP-Forward-Proxy** ohne zusätzliche npm-Abhängigkeiten im Skript: Requests an **`https://api.anthropic.com`** (oder **`--upstream`**).

## Start

```bash
node start.js proxy --port=8080
```

Root-Äquivalent: `node anthropic-proxy.js --port=8080`.

## Claude auf den Proxy zeigen

Lokal:

```bash
ANTHROPIC_BASE_URL=http://127.0.0.1:8080 claude
```

Über Netzwerk / Deployment (nur **Platzhalter** — Schema und Port an Ingress anpassen):

```bash
ANTHROPIC_BASE_URL=http://proxy.host.domain.tld:8080 claude
```

Das **Dashboard** liegt typischerweise unter einer **anderen** Hostname-URL, z. B. **`https://dashboard.host.domain.tld`** (Web-UI **3333** bzw. HTTPS); der **Proxy** ist **`proxy.host.domain.tld:8080`** — zwei getrennte Eintritte oder ein Host mit Pfadrouting, je nach Installation.

## Logging (NDJSON)

Jede abgeschlossene Upstream-Response: **eine Zeile** in **`~/.claude/anthropic-proxy-logs/proxy-YYYY-MM-DD.ndjson`** (Override: **`ANTHROPIC_PROXY_LOG_DIR`**).

Wesentliche Felder: **`ts_start`/`ts_end`**, **`duration_ms`**, **`path`**, **`upstream_status`**, **`usage`** (inkl. `cache_read_input_tokens`, `cache_creation_input_tokens`), **`cache_read_ratio`**, **`cache_health`**:

- **`healthy`:** Cache-Read-Anteil an (Read + Creation) ≥ **80 %**
- **`affected`:** Anteil **< 40 %** bei vorhandenem Cache-Traffic (viel Creation, wenig Read)
- **`mixed`**, **`na`**, **`unknown`** je nach Fall

**Rate Limits & Metadaten:** **`request_meta`**, **`response_anthropic_headers`** (z. B. `anthropic-ratelimit-*`, `request-id`, `cf-ray`).

## Subagents, Tools, JSONL-Abgleich

- Proxy sieht HTTP (z. B. `tools`, `tool_use` / `tool_result`); **`request_hints`** / **`response_hints`**.
- Subagent-Sessions oft an **JSONL-Pfaden** (`subagent`).
- Mit **`ANTHROPIC_PROXY_ALIGN_JSONL=1`**: Zuordnung zu nahegelegener JSONL-Zeile → **`jsonl_alignment`** inkl. **`is_subagent_path`**.

Weitere Variablen: **`ANTHROPIC_PROXY_LOG_STDOUT=1`**, **`ANTHROPIC_PROXY_LOG_BODIES=1`** (Vorsicht: Geheimnisse), **`ANTHROPIC_PROXY_JSONL_ROOTS`**, **`ANTHROPIC_PROXY_BIND`**.

Hilfe: `node start.js proxy -- --help` oder `node anthropic-proxy.js --help`.

## Hinter Reverse-Proxy / in Containern

Typisch **`ANTHROPIC_PROXY_BIND=0.0.0.0`**, Port **8080**, und einen erreichbaren Service nach außen — gleiche Parameter wie lokal, nur Netzwerk/Exponierung Betriebssache (kein Teil der `docs/`-Repo-Doku).
