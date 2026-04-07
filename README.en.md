**[Deutsch](README.md)** · English

## Claude Usage Dashboard

### Summary

**Anthropic / Claude Code monitoring:** A **self-hosted web dashboard** and optional **transparent HTTP proxy** to the **Anthropic API** — surfacing **tokens**, heuristic limits, **forensics**, and proxy-side metrics. **Why it exists:** many users see **fast “usage drains”** on **Anthropic** workloads (Claude Code, Max / session windows, etc.) where the official counters do not fully explain **why** the budget empties so quickly. Inputs: **`~/.claude/projects/**/*.jsonl`**, and — with the proxy — **per-request NDJSON** (latency, cache, **rate-limit-related headers**, etc.). Only **`claude-*`** models (no `<synthetic>`). Runs **locally** or in **Docker/Kubernetes** — not a central SaaS.

### References and context

- **Measured background (proxy idea):** **[Claude Code Hidden Problem Analysis](https://github.com/ArkNill/claude-code-hidden-problem-analysis)** by **ArkNill** — write-ups on cache bugs, **5h/7d quota**, and proxy-captured headers (similar in spirit to **cc-relay**-style capture). **This codebase implements** the proxy/NDJSON approach in the dashboard; **deep evidence** stays in **his** repo.
- **GitHub issue discussion (Claude Code):** **[anthropics/claude-code#38335](https://github.com/anthropics/claude-code/issues/38335)** — e.g. **Max / session limits** draining much faster than expected (discussion around Mar 2026). **fgrosswig** participated with **forensics/measurements**; **all linked comments, issues, and cross-threads** belong to the **same broad topic** (usage, regressions, community data) and are **reading references** — listing every URL here would not scale.

See **[Documentation](docs/README.md)** for architecture, env vars, and API.

### Documentation

The **full** guide is in **[docs/](docs/README.md)** with sub-pages (architecture, UI, proxy, forensics, env vars, API).

- **English:** [docs/en/README.md](docs/en/README.md)  
- **Deutsch:** [docs/de/README.md](docs/de/README.md)

### Quick start

```bash
node server.js              # dashboard :3333
node start.js both          # dashboard + proxy :8080
node start.js forensics     # CLI report
```

### Docker

Two images: **`Dockerfile.base`** (npm deps) → **`Dockerfile`** (app). Locally e.g. `docker build -f Dockerfile.base -t claude-base:local .` then **`BASE_IMAGE=claude-base BASE_TAG=local docker compose build`**. **`docker compose up`** = **`node start.js both`**; other modes: **`docker-compose.yml`** header. CI: **`docker-compose.ci.yml`**, **`.github/workflows/docker.yml`**.

### Working copy and GitHub

Primary development is on a **private forge** (e.g. branch **`feat/proxy-logs`** → PR → **`main`**). **GitHub** is the public mirror; the branch there is often **`feat/proxy-analytics`** → PR → **`main`** ([repo](https://github.com/fgrosswig/claude-usage-dashboard)).

**One-time — second remote:**

```bash
git remote add github https://github.com/fgrosswig/claude-usage-dashboard.git
git fetch github
```

**A) After merging to the private upstream `main` — update GitHub `main`**

```bash
git checkout main
git pull origin main                    # upstream: private forge
git push github main
```

**B) Update the GitHub feature branch for a PR**

Push the same commits under the GitHub branch name (refreshes the existing PR):

```bash
git checkout feat/proxy-logs
git pull origin feat/proxy-logs
git push github feat/proxy-logs:feat/proxy-analytics
```

On GitHub: open or refresh PR **feat/proxy-analytics → `main`**. Optional locally: [GitHub CLI](https://cli.github.com/) `gh pr create` / `gh pr sync`.

**Automatic mirror:** After merging to the private upstream `main`, **`private automation (paths omitted in public tree)`** publishes a scrubbed snapshot to **GitHub `main`** (the published tree omits private infrastructure and hostnames). The manual `git push github` steps above are only if you bypass that workflow or maintain a separate GitHub feature branch.

### Screenshots

**Token overview** (dashboard) and **proxy analytics** — more in [docs/en/08-screenshots.md](docs/en/08-screenshots.md).

![Token overview / main charts](images/main_overview_statistics.png)

![Anthropic monitor proxy / proxy analytics](images/proxy_statistics.png)
