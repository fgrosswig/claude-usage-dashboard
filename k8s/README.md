# Kubernetes (Kustomize)

[![CI CI — main](https://ci.example.com/api/badges/3/status.svg?branch=main)](https://ci.example.com/repos/3)

Usage-Dashboard + Anthropic-Proxy (`node start.js both`).

**Woodpecker-Deploy** entspricht **RefOrg**: `kubectl apply -k k8s/overlays/dev`, `set image` auf **Deployment `claude-app`**.

## Build image

**Reihenfolge wie RefOrg:** Zuerst **`registry.example.com/claude/base`** — Workflow **`ci-config/base.yml`** (Push auf `Dockerfile.base`, `version.json`, `package.json`, `package-lock.json`, **CI build host**). Danach (oder parallel bei nur App-Änderungen) **`ci-config/app.yml`**: **prepare** (schreibt **`Dockerfile.ci`** mit `BASE_TAG` aus **`version.json`**) → **Kaniko** (zieht das Base von Harbor, **CI build host** wie RefOrg) → Deploy → Cleanup. Ohne existierendes Base-Tag schlägt Kaniko fehl — erst **`base.yml`** laufen lassen oder Base manuell pushen.

**Erstmalig / leeres Harbor-Repo `claude/base`:** In CI den Workflow **`base`** (`ci-config/base.yml`) **manuell** ausführen — `when` enthält **`manual`**; Pfadfilter greifen dabei nicht. Danach existiert **`claude/base:v3`** (und **`latest`**), dann **`app.yml`** erneut starten. In Harbor Projekt **`claude`** und Robot mit **Push** auf **`base`** vorsehen.

**Normalfall Branch-Events:** **`main`**, **`int`**, **`feat/**`**, **`fix/**`**. Doku-Gesamtbild: [RefOrg `docs/01-deployment.md`](https://git.example.com/GRO/RefOrg/src/branch/main/docs/01-deployment.md).

**Pull Requests:** **`ci-config/pr.yml`** — Checks ohne Kaniko (RefOrg hat kein separates PR-File; hier ergänzt).

Lokal: `Dockerfile` nutzt **`FROM registry.example.com/claude/base:<tag>`** (`version.json` → `base_image`, Standard **`v3`**). Registry-Login setzen, Base-Image vorhanden, dann vom **Repository-Root**:

```bash
docker build -t claude-usage-dashboard:latest .
```

Manuell in eine andere Registry:

```bash
docker tag claude-usage-dashboard:latest your.registry.example/claude-usage-dashboard:latest
docker push your.registry.example/claude-usage-dashboard:latest
```

Image/Tag wird von der Pipeline per `kubectl set image` gesetzt.

## Harbor

Eure Registry-Doku: **[05-harbor.md](https://git.example.com/GRO/infrastructure-docs/src/branch/main/docs/05-harbor.md)** (GRO / infrastructure-docs).

**Projekt in Harbor:** `claude` — darin ein Image-Repository anlegen, z. B. **`claude-usage-dashboard`**. Vollständiger Referenzname:

`<harbor-host>/claude/claude-usage-dashboard:<tag>`

(`harbor-host` und ggf. Projekt-/Repo-Namen exakt wie in **05-harbor.md** — der folgende Host ist nur ein Platzhalter.)

```bash
docker build -t claude-usage-dashboard:1.0.0 .
docker tag claude-usage-dashboard:1.0.0 <harbor-host>/claude/claude-usage-dashboard:1.0.0
docker push <harbor-host>/claude/claude-usage-dashboard:1.0.0
```

`docker login`, Robot-Account und exakte Registry-URL stehen in **05-harbor.md**.

### Pull-Secret aus Harbor-Robot (JSON)

Harbor liefert beim Anlegen eines Robot-Accounts eine JSON-Datei. **Standardablage (nur lokal, nicht im Git):**

Robot-JSON lokal ablegen (nicht ins Git committen).

**Ein Befehl — Secret `harbor-pull` im Cluster** (Repo-Root, `kubectl` + `jq`):

```bash
sh scripts/k8-harbor-pull-secret.sh
```

Andere JSON-Datei: `ROBOT_JSON=/pfad/zur/robot.json sh scripts/k8-harbor-pull-secret.sh`  
Anderer Registry-Host: `HARBOR_HOST=registry.example.com` (Standard).

**`docker login`** (lokal / CI), Platzhalter anpassen:

```bash
export HARBOR_HOST=<harbor-host-aus-05-harbor.md>
ROBOT_JSON='robot.json'
docker login "$HARBOR_HOST" -u "$(jq -r .name "$ROBOT_JSON")" -p "$(jq -r .secret "$ROBOT_JSON")"
```

**Kubernetes** (Name `harbor-pull` wie in `values-cluster.example.yaml`):

```bash
kubectl create secret docker-registry harbor-pull -n claude \
  --docker-server="$HARBOR_HOST" \
  --docker-username="$(jq -r .name "$ROBOT_JSON")" \
  --docker-password="$(jq -r .secret "$ROBOT_JSON")"
```

Ohne `jq` (PowerShell, im Repo-Root):

```powershell
$j = Get-Content "robot.json" -Raw | ConvertFrom-Json
kubectl create secret docker-registry harbor-pull -n claude `
  --docker-server=$env:HARBOR_HOST `
  --docker-username=$j.name `
  --docker-password=$j.secret
```

In **`k8s/base/deployment.yml`**: Pull-Secret **`harbor-pull`**.

## Kustomize (`k8s/` — RefOrg-Layout)

| Pfad | Inhalt |
|------|--------|
| `k8s/base/` | `deployment.yml` (**Deployment** `claude-app`, Container **`app`**), `service.yml`, `pvc.yml`, `kustomization.yml` |
| `k8s/overlays/dev/` | Namespace **claude**, **Ingress** (Traefik), `images.newTag: latest` — vgl. [RefOrg overlays/dev](https://git.example.com/GRO/RefOrg/src/branch/feat/fastify-v5/k8s/overlays/dev/kustomization.yml) |

Prüfen: `kubectl kustomize k8s/overlays/dev`

## CI — Woodpecker

| Datei | Rolle |
|-------|--------|
| [`ci-config/base.yml`](../ci-config/base.yml) | **Harbor `claude/base`** (`ci-plugin/plugin-docker` über **poc**, **backend: docker** / CI-host) |
| [`ci-config/app.yml`](../ci-config/app.yml) | prepare → **Dockerfile.ci**, Kaniko, **kubectl apply -k k8s/overlays/dev**, set image, rollout, cleanup — **wie RefOrg** nur **`platform`** → **CI build host** |
| [`ci-config/pr.yml`](../ci-config/pr.yml) | PR-Checks ohne Kaniko (**backend: docker** / CI-host) |

**Agent-Auswahl (GRO):** `ci-config/app.yml` entspricht **[RefOrg `app.yml`](https://git.example.com/GRO/RefOrg/src/branch/feat/fastify-v5/ci-config/app.yml)** — nur **`platform: linux/amd64`** (kein **`backend: kubernetes`**), damit **Kaniko** und kurze Image-Namen auf dem **CI build host** laufen. **`backend: kubernetes`** würde **Job-Pods auf .171** erzeugen; dann Step-Images über Harbor **`poc`** nötig (Cluster ohne Docker-Hub). **`ci-config/pr.yml`** setzt explizit **`backend: docker`**. Base-Image weiterhin **`ci-config/base.yml`** auf CI-host. Siehe [04-ci-pipeline.md](https://git.example.com/GRO/infrastructure-docs/src/branch/main/docs/04-ci-pipeline.md).

**Referenz:** [RefOrg `app.yml` feat/fastify-v5](https://git.example.com/GRO/RefOrg/src/branch/feat/fastify-v5/ci-config/app.yml) · [RefOrg `docs/01-deployment.md`](https://git.example.com/GRO/RefOrg/src/branch/main/docs/01-deployment.md) · [Kaniko-Plugin](https://woodpecker-ci.org/plugins/kaniko).

Instanz: [ci.example.com — Repo #3](https://ci.example.com/repos/3) · [Workflow-Syntax](https://woodpecker-ci.org/docs/usage/workflow-syntax).

**Woodpecker-Secrets:** `harbor_user`, `harbor_password`, `kube_url`, `kube_token`.

**Harbor-Robot in CI (Kaniko):** Die YAML-Datei enthält **keine** Zugangsdaten. Kaniko bekommt Login ausschließlich aus **`harbor_user`** und **`harbor_password`**. Trage dort exakt die Werte aus der Robot-JSON ein (lokal z. B. `robot$claude+developer.json`, Felder **`name`** und **`secret`**):

```bash
ROBOT_JSON='robot.json'
jq -r '.name, .secret' "$ROBOT_JSON"
```

- **`harbor_user`** = kompletter Robot-Name (z. B. `robot$claude+developer` — inkl. `$`, keine Leerzeichen).
- **`harbor_password`** = Wert von **`secret`** (einmalig beim Anlegen; bei Verlust neuen Robot/Secret in Harbor erzeugen).

In **Harbor** muss der Robot für das Projekt **`claude`** ins Repository **`claude-usage-dashboard`** **pushen** dürfen. In der Robot-Maske **Select Permissions** → Zeile **Repository** müssen u. a. **Pull** und **Push** angehakt sein (nur *List / Read / Update* reicht nicht — dann genau der Fehler **`UNAUTHORIZED` … action: push**). Meldung **`UNAUTHORIZED`** heißt sonst oft: falsche Woodpecker-Secrets oder abgelaufener Robot.

**Registry:** **App-Pipeline** (`ci-config/app.yml`) läuft auf **Docker CI-host** wie RefOrg — Step-Images **`alpine`**, **`plugins/kaniko`**, **`bitnami/kubectl`** zieht der **Docker-Host** (Hub/Mirror). Nur bei **`backend: kubernetes`** (optional): Step-Images über Harbor-Proxy **`poc`**. **`Dockerfile.base`**: **`FROM node:20-alpine`** auf CI-host. **App-**`Dockerfile`: **`registry.example.com/claude/base`**. Doku: **05-harbor.md**.

**Auslöser `app.yml`:** wie RefOrg nur **`push`** und **`manual`** auf **`feat/**`**, **`fix/**`**, **`main`**, **`int`** (kein separater Tag-/Deployment-Event — wer Tags braucht, analog RefOrg erweitern).

Lokal: `sh scripts/k8-ci-verify.sh` (Helm/Kustomize + Smoke für **Dockerfile.ci**, kein `docker build` — Base/App laufen in Woodpecker). `kubectl` in der Pipeline: `--insecure-skip-tls-verify` wie RefOrg.

**Deploy / Registry:** **[GRO / infrastructure-docs](https://git.example.com/GRO/infrastructure-docs)**, **05-harbor.md**.

**Hinweis:** **`ci-config/base.yml`** auf **CI agent** → Harbor **`claude/base`**; Plugin-Image nur über **`poc`**, nicht Docker Hub. Optional **Gitea Actions** (RefOrg): [deploy.yml `feat/fastify-v5`](https://git.example.com/GRO/RefOrg/src/branch/feat/fastify-v5/.gitea/workflows/deploy.yml).

## Deploy im Kubernetes-Cluster

**Reihenfolge:**

1. **Vorbereitung** — Namespace `claude` (legt Helm mit `--create-namespace` an). Bei privater Registry Pull-Secret **`harbor-pull`** anlegen (Abschnitt **Harbor** oben). Ohne dieses Secret: Pod-Event **`Failed to pull image`** / **`image can't be pulled`** — prüfen mit `kubectl describe pod -n claude -l app=claude-dashboard` (oft `401`/`no basic auth`). **`--docker-server`** muss der reine Hostname sein (z. B. **`registry.example.com`**, ohne `https://`).
2. **Base-Image** — CI **`ci-config/base.yml`** auf **CI agent** nach Harbor **`claude/base`** (bei Änderung an Base-Deps oder einmalig manuell triggern). **App-Image** — **Kaniko** in **`app.yml`** auf **CI agent** (`build-push`, wie RefOrg).
3. **Deploy** — **`kubectl apply -k k8s/overlays/dev`** + **`set image`** (Woodpecker).

Voraussetzung: `kubectl` zeigt auf **euren** Cluster (`kubectl config current-context`).

## Daten vom Client ins Pod-Volume (JSONL)

Kubernetes mountet **kein** Verzeichnis von deinem Laptop direkt in einen Pod auf einem anderen Node. Typische Wege:

1. **HTTP-Push (eingebaut)**  
   - Setze im Pod `CLAUDE_USAGE_SYNC_TOKEN` (langes Geheimnis).  
   - Auf dem Laptop: Repo klonen/auschecken und  
     `CLAUDE_SYNC_URL=https://…` `CLAUDE_SYNC_TOKEN=…`  
     `node scripts/claude-data-sync-client.js`  
   - Der Server entpackt ein `tar.gz` nach `/root/.claude` (**nur** `projects/**` und optional `anthropic-proxy-logs/**`) und startet einen Neu-Scan.  
   - API: `POST /api/claude-data-sync`, Body = rohes gzip-Tar-Archiv, Header `Authorization: Bearer <Token>`.

2. **PVC + rsync über Jump**  
   Ein PersistentVolume (z. B. NFS), das du vom Client aus per `rsync`/`scp` auf einen Sync-Host schreibst, der dieselbe Freigabe mountet — oder `kubectl cp` in den Pod (eher manuell).

3. **Ein-Node-Cluster auf dem gleichen Rechner**  
   `claudeData.mode: hostPath` mit einem Pfad, in den du die Dateien spiegelst.

## Secrets (Sync, GitHub, Admin)

Secrets als Kubernetes Opaque-Secret mit festen Key-Namen:

| Key im Secret (Standard) | Umgebungsvariable im Pod |
|----------------------------|-------------------------|
| `sync-token` | `CLAUDE_USAGE_SYNC_TOKEN` (HTTP-Push der JSONL-Daten) |
| `github-token` | `GITHUB_TOKEN` (Rate-Limit / Releases; optional) |
| `admin-token` | `CLAUDE_USAGE_ADMIN_TOKEN` (z. B. `POST /api/github-releases-refresh` — siehe Server-Doku) |

**Variante 1 — Secret manuell, Name in Values:**

```bash
kubectl create secret generic claude-usage-dashboard-app -n claude \
  --from-literal=sync-token="$(openssl rand -hex 32)" \
  --from-literal=github-token="ghp_..." \
  --from-literal=admin-token="$(openssl rand -hex 16)"
```

## Lokales Dev-Testing (Proxy-Logs vom Cluster)

Der Server kann Proxy-NDJSON-Logs vom Remote-Cluster holen, um das Dashboard lokal mit echten Daten zu testen. Voraussetzung: auf dem Cluster ist `DEBUG_API=1` gesetzt (`k8s/base/deployment.yml`).

**PowerShell:**

```powershell
$env:DEV_PROXY_SOURCE="https://claude-usage.example.com"; node start.js dashboard
```

**CMD:**

```cmd
set DEV_PROXY_SOURCE=https://claude-usage.example.com && node start.js dashboard
```

**bash / Linux / macOS:**

```bash
DEV_PROXY_SOURCE=https://claude-usage.example.com node start.js dashboard
```

Dann `http://localhost:3333` öffnen. Die Logs werden nach `%TEMP%/claude-proxy-logs-dev` (Windows) bzw. `/tmp/claude-proxy-logs-dev` (Linux) geschrieben.

### Dev-Testing Flow

```mermaid
flowchart LR
    subgraph Cluster
        Pod["Pod claude-app<br/>DEBUG_API=1"]
        PVC["PVC /root/.claude<br/>anthropic-proxy-logs/*.ndjson"]
        Pod -->|schreibt| PVC
        API["/api/debug/proxy-logs"]
        PVC -->|liest| API
    end

    subgraph Lokal
        ENV["DEV_PROXY_SOURCE=https://..."]
        Start["node start.js dashboard"]
        Fetch["devFetchProxyLogs()"]
        TMP["%TEMP%/claude-proxy-logs-dev"]
        Server["Dashboard :3333"]
        Browser["Browser localhost:3333"]

        ENV --> Start
        Start --> Fetch
        Fetch -->|HTTP GET| API
        API -->|JSON files[]| Fetch
        Fetch -->|schreibt| TMP
        TMP -->|ANTHROPIC_PROXY_LOG_DIR| Server
        Server -->|SSE| Browser
    end

    subgraph Auto-Sync
        Interval["setInterval 180s"]
        Sync["Sync Now Button"]
        Interval -->|devFetchAndRefreshProxy| Fetch
        Sync -->|POST /api/debug/sync-proxy-logs| Fetch
    end
```

**Hinweis:** `node start.js both` ist mit `DEV_PROXY_SOURCE` blockiert — kein lokaler Proxy im Dev-Modus.

## Proxy und Claude Code

Der Container lauscht mit `ANTHROPIC_PROXY_BIND=0.0.0.0` auf Port **8080**. Clients außerhalb des Clusters brauchen einen erreichbaren Service (NodePort, LoadBalancer, Ingress mit TCP oder separater Route) und setzen z. B. `ANTHROPIC_BASE_URL=http://…:8080`.
