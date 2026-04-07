**[English](README.en.md)** · Deutsch

## Claude Usage Dashboard

### Zusammenfassung

**Anthropic- und Claude-Code-Monitoring:** Ein **selbst gehostetes Web-Dashboard** und optional ein **transparenter HTTP-Proxy** zur **Anthropic-API** — um **Tokenfluss**, heuristische Limits, **Forensik** und Proxy-Metriken darzustellen. **Motivation:** In der Praxis entstehen bei **Anthropic-Nutzung** (Claude Code, Max-/Session-Fenster u. a.) oft **schnelle „Usage-Drains“**; die offizielle Anzeige erklärt nicht immer, **warum** der Zähler so schnell leerläuft. Datenquellen: **`~/.claude/projects/**/*.jsonl`** und — mit Proxy — **NDJSON** pro Request (Latenz, Cache, u. a. **rate-limit-relevante Header**). Gezählt werden nur **`claude-*`**-Modelle (kein `<synthetic>`). Betrieb **lokal** oder in **Docker/Kubernetes** — kein zentraler SaaS.

### Referenz und Kontext

- **Gemessene Hintergrundarbeit (Proxy-Idee):** **[Claude Code Hidden Problem Analysis](https://github.com/ArkNill/claude-code-hidden-problem-analysis)** von **ArkNill** — dokumentierte Analyse zu Cache-Bugs, **5h/7d-Quota** und Proxy-erfassten Headern (u. a. **cc-relay**-ähnliche Messung). **Dieses Projekt übernimmt die Proxy-/NDJSON-Idee** in Dashboard und Pipeline; die **Befundtiefe** steht in **seinem** Repo.
- **GitHub-Issue-Diskussion (Claude Code):** **[anthropics/claude-code#38335](https://github.com/anthropics/claude-code/issues/38335)** — u. a. zu **abnorm schnell** ausgereizten Max-/Session-Fenstern (Stand Diskussion: u. a. März 2026). **fgrosswig** ist dort mit **Forensik/Messungen** eingestiegen; **alle dort verlinkten Kommentare, Issues und Unter-Diskussionen** gehören zum **gleichen Themenspektrum** (Usage, Regression, Community-Messwerte) und sind **Lese-Referenzen** — ein vollständiges URL-Inventar würde das Feld hier sprengen.

Technik, UI, Umgebungsvariablen, API: **[Dokumentation](docs/README.md)**.

### Dokumentation

Die **vollständige** Beschreibung liegt in **[docs/](docs/README.md)** mit Unterseiten (Architektur, UI, Proxy, Forensik, Umgebungsvariablen, API).

- **Deutsch:** [docs/de/README.md](docs/de/README.md)  
- **English:** [docs/en/README.md](docs/en/README.md)

### Schnellstart

```bash
node server.js              # Dashboard :3333
node start.js both          # Dashboard + Proxy :8080
node start.js forensics     # CLI-Auswertung
```

Optionen, Logging, Cache, Multi-Host und Sync: jeweils in der **[Dokumentation](docs/de/README.md)**.

### Docker

Zwei Images: **`Dockerfile.base`** (npm-Deps) → **`Dockerfile`** (App inkl. **`images/`**-Screenshots unter `/app/images`). Lokal z. B. `docker build -f Dockerfile.base -t claude-base:local .` dann **`BASE_IMAGE=claude-base BASE_TAG=local docker compose build`**. **`docker compose up`** = **`node start.js both`** (3333 / 8080); weitere Modi: Kopfzeilen in **`docker-compose.yml`**. CI: **`docker-compose.ci.yml`**, **`.github/workflows/docker.yml`**.

### Gitea und GitHub (Routine nach Merge auf `main`)

Arbeit läuft primär auf **Gitea** (Branch z. B. **`feat/proxy-logs`** → PR → **`main`**). **GitHub** dient als öffentlicher Spiegel; dort heißt der Branch aktuell meist **`feat/proxy-analytics`** → PR → **`main`** ([Repo](https://github.com/fgrosswig/claude-usage-dashboard)).

**Einmalig — zweiten Remote:**

```bash
git remote add github https://github.com/fgrosswig/claude-usage-dashboard.git   # Name frei wählbar
git fetch github
```

**A) Nach Merge auf Gitea-`main` — GitHub-`main` nachziehen**

```bash
git checkout main
git pull origin main                    # origin = Gitea
git push github main                   # github-Remote: main aktualisieren
```

**B) Feature für GitHub-PR hochladen (Branch-Namen abgleichen)**

Vom gleichen Stand wie der Gitea-Feature-Branch, aber unter dem GitHub-Branch-Namen pushen (damit der offene PR dort aktualisiert wird):

```bash
git checkout feat/proxy-logs
git pull origin feat/proxy-logs
git push github feat/proxy-logs:feat/proxy-analytics
```

Auf GitHub: PR **„feat/proxy-analytics“ → `main`** anlegen oder den bestehenden PR prüfen (zeigt neuen Push).  
Optional lokal: **`gh pr create`** / **`gh pr sync`** mit installiertem [GitHub CLI](https://cli.github.com/), falls du nicht nur im Web arbeitest.

### Screenshots

**Token-Übersicht** (Dashboard) und **Proxy-Analytics** — weiteres in [docs/de/08-screenshots.md](docs/de/08-screenshots.md).

![Token-Übersicht / Haupt-Charts](images/main_overview_statistics.png)

![Anthropic-Monitor-Proxy / Proxy-Analytics](images/proxy_statistics.png)
