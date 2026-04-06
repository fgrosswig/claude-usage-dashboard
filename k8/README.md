# Kubernetes / Helm

[![Woodpecker CI — main](https://ci.grosswig-it.de/api/badges/3/status.svg?branch=main)](https://ci.grosswig-it.de/repos/3)

Chart: `k8/claude-usage-dashboard/` — Usage-Dashboard + Anthropic-Proxy (`node start.js both`).

**Woodpecker-Deploy** entspricht **SCHUFA**: `kubectl apply -k k8s/overlays/dev`, `set image` auf **Deployment `claude-app`**. Details und Tabellen → Abschnitt **Kustomize** unten. **Helm-Chart** bleibt für manuelles Installieren; bei Template-Änderungen **`k8s/base/*.yml`** abstimmen.

## Build image

**Normalfall:** Push/Manual auf **`main`**, **`int`**, **`feat/**`**, **`fix/**`** → **`.woodpecker/app.yml`** (nach [SCHUFA app.yml](https://gitea.grosswig-it.de/GRO/SCHUFA/src/branch/feat/fastify-v5/.woodpecker/app.yml), ohne Sonar): **prepare** → **Kaniko** → **`kubectl apply -k k8s/overlays/dev`** → **`set image`** / **`rollout`** → **cleanup**. Doku-Gesamtbild: [SCHUFA `docs/01-deployment.md`](https://gitea.grosswig-it.de/GRO/SCHUFA/src/branch/main/docs/01-deployment.md).

**Pull Requests:** **`.woodpecker/pr.yml`** — Checks ohne Kaniko (SCHUFA hat kein separates PR-File; hier ergänzt).

Lokal (optional, gleiches `Dockerfile` wie CI) vom **Repository-Root**:

```bash
docker build -t claude-usage-dashboard:latest .
```

Manuell in eine andere Registry:

```bash
docker tag claude-usage-dashboard:latest your.registry.example/claude-usage-dashboard:latest
docker push your.registry.example/claude-usage-dashboard:latest
```

Für Helm: `image.repository` / `image.tag` / `imagePullSecrets` setzen — im Cluster typischerweise wie in `values-cluster.example.yaml` bzw. wie die Pipeline per `--set` übergibt.

## Harbor

Eure Registry-Doku: **[05-harbor.md](https://gitea.grosswig-it.de/GRO/infrastructure-docs/src/branch/main/docs/05-harbor.md)** (GRO / infrastructure-docs).

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

Harbor liefert beim Anlegen eines Robot-Accounts eine JSON-Datei (z. B. `robot$claude+developer.json`). Lege sie **nur lokal** unter `k8/claude-usage-dashboard/` ab — sie ist per **`.gitignore`** (`robot*.json`) vom Commit ausgeschlossen.

**`docker login`** (lokal / CI), Platzhalter anpassen:

```bash
export HARBOR_HOST=<harbor-host-aus-05-harbor.md>
ROBOT_JSON='k8/claude-usage-dashboard/robot$claude+developer.json'
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
$j = Get-Content "k8\claude-usage-dashboard\robot`$claude+developer.json" -Raw | ConvertFrom-Json
kubectl create secret docker-registry harbor-pull -n claude `
  --docker-server=$env:HARBOR_HOST `
  --docker-username=$j.name `
  --docker-password=$j.secret
```

Im Chart und in **`k8s/base/deployment.yml`**: Pull-Secret **`harbor-pull`** (siehe `values-cluster.example.yaml`).

## Kustomize (`k8s/` — SCHUFA-Layout)

| Pfad | Inhalt |
|------|--------|
| `k8s/base/` | `deployment.yml` (**Deployment** `claude-app`, Container **`app`**), `service.yml`, `pvc.yml`, `kustomization.yml` |
| `k8s/overlays/dev/` | Namespace **claude**, `images.newTag: latest` — vgl. [SCHUFA overlays/dev](https://gitea.grosswig-it.de/GRO/SCHUFA/src/branch/feat/fastify-v5/k8s/overlays/dev/kustomization.yml) |

Prüfen: `kubectl kustomize k8s/overlays/dev`

## CI — Woodpecker

| Datei | Rolle |
|-------|--------|
| [`.woodpecker/app.yml`](../.woodpecker/app.yml) | Wie SCHUFA (ohne Sonar): prepare, Kaniko, **kubectl apply -k k8s/overlays/dev**, set image, rollout, cleanup |
| [`.woodpecker/pr.yml`](../.woodpecker/pr.yml) | PR-Checks ohne Kaniko (Zusatz zu SCHUFA) |

**Agent-Auswahl (GRO):** `.woodpecker/app.yml` nutzt **`labels.backend: kubernetes`** → Woodpecker **K8s-Agent .171** (Kaniko-Builds als Pods im Cluster). **`.woodpecker/pr.yml`** nutzt **`backend: docker`** → **Docker-Agent .220**. Base-/Hilfsimages typischerweise einmalig auf .220 bauen/spiegeln; siehe [04-woodpecker.md](https://gitea.grosswig-it.de/GRO/infrastructure-docs/src/branch/main/docs/04-woodpecker.md).

**Referenz:** [SCHUFA `app.yml` feat/fastify-v5](https://gitea.grosswig-it.de/GRO/SCHUFA/src/branch/feat/fastify-v5/.woodpecker/app.yml) · [SCHUFA `docs/01-deployment.md`](https://gitea.grosswig-it.de/GRO/SCHUFA/src/branch/main/docs/01-deployment.md) · [Kaniko-Plugin](https://woodpecker-ci.org/plugins/kaniko).

Instanz: [ci.grosswig-it.de — Repo #3](https://ci.grosswig-it.de/repos/3) · [Workflow-Syntax](https://woodpecker-ci.org/docs/usage/workflow-syntax).

**Woodpecker-Secrets:** `harbor_user`, `harbor_password`, `kube_url`, `kube_token`.

**Harbor-Robot in Woodpecker (Kaniko):** Die YAML-Datei enthält **keine** Zugangsdaten. Kaniko bekommt Login ausschließlich aus **`harbor_user`** und **`harbor_password`**. Trage dort exakt die Werte aus der Robot-JSON ein (lokal z. B. `robot$claude+developer.json`, Felder **`name`** und **`secret`**):

```bash
ROBOT_JSON='k8/claude-usage-dashboard/robot$claude+developer.json'
jq -r '.name, .secret' "$ROBOT_JSON"
```

- **`harbor_user`** = kompletter Robot-Name (z. B. `robot$claude+developer` — inkl. `$`, keine Leerzeichen).
- **`harbor_password`** = Wert von **`secret`** (einmalig beim Anlegen; bei Verlust neuen Robot/Secret in Harbor erzeugen).

In **Harbor** muss der Robot für das Projekt **`claude`** ins Repository **`claude-usage-dashboard`** **pushen** dürfen. In der Robot-Maske **Select Permissions** → Zeile **Repository** müssen u. a. **Pull** und **Push** angehakt sein (nur *List / Read / Update* reicht nicht — dann genau der Fehler **`UNAUTHORIZED` … action: push**). Meldung **`UNAUTHORIZED`** heißt sonst oft: falsche Woodpecker-Secrets oder abgelaufener Robot.

**Base Image Connector / Docker Hub:** Das `Dockerfile` nutzt `FROM node:22-alpine` (Docker Hub). Harbor warnt vor Rate-Limits; optional Base-Image über euren Harbor-Proxy spiegeln (siehe **05-harbor.md** / „Base Image Connector“) — unabhängig vom Push-`UNAUTHORIZED`, das reine Registry-Auth betrifft.

**Auslöser `app.yml`:** wie SCHUFA nur **`push`** und **`manual`** auf **`feat/**`**, **`fix/**`**, **`main`**, **`int`** (kein separater Tag-/Deployment-Event — wer Tags braucht, analog SCHUFA erweitern).

Lokal: `sh scripts/k8-ci-verify.sh`. `kubectl` in der Pipeline: `--insecure-skip-tls-verify` wie SCHUFA.

**Deploy / Registry:** **[GRO / infrastructure-docs](https://gitea.grosswig-it.de/GRO/infrastructure-docs)**, **05-harbor.md**.

**Hinweis:** SCHUFA nutzt zusätzlich **`.woodpecker/base.yml`** (`plugins/docker` für `Dockerfile.base`) und optional **Gitea Actions** für statische Pages — hier nur ein **Dockerfile**, daher keine `base.yml`. [Gitea Actions](https://docs.gitea.com/usage/actions/overview)-Beispiel (statisch): [SCHUFA `deploy.yml` auf `feat/fastify-v5`](https://gitea.grosswig-it.de/GRO/SCHUFA/src/branch/feat/fastify-v5/.gitea/workflows/deploy.yml).

## Deploy im Kubernetes-Cluster

**Reihenfolge:**

1. **Vorbereitung** — Namespace `claude` (legt Helm mit `--create-namespace` an). Bei privater Registry Pull-Secret **`harbor-pull`** anlegen (Abschnitt **Harbor** oben).
2. **Image bauen und nach Harbor pushen** — Woodpecker **Kaniko** (`build-push`).
3. **Deploy** — **`kubectl apply -k k8s/overlays/dev`** + **`set image`** (Woodpecker) **oder** manuell `helm upgrade` über Chart (ältere Releases hießen z. B. `cud`; Kustomize nutzt **Deployment `claude-app`**).

Voraussetzung: `kubectl` zeigt auf **euren** Cluster (`kubectl config current-context`), Helm 3 installiert.

**Details (ergänzend zur Reihenfolge):**

1. **Image in Values** — `image.repository` / `image.tag` auf das **eben gebaute** Harbor-Image; `imagePullSecrets` wie in `values-cluster.example.yaml` (Robot-Secret vorher anlegen, siehe **Harbor**).

2. **Speicher** — Chart legt standardmäßig eine **PVC** an (`claudeData.mode: newPvc`). Setzt `claudeData.newPvc.storageClassName` auf eine **StorageClass**, die im Cluster existiert (`kubectl get storageclass`). Für Tests ohne sinnvolle Klasse: `claudeData.mode: emptyDir` (Daten gehen bei Pod-Neustart verloren).

3. **Helm installieren oder aktualisieren**

```bash
helm upgrade --install cud ./k8/claude-usage-dashboard --namespace claude --create-namespace -f my-values.yaml
```

Ohne eigene Datei reicht z. B. `--set image.repository=… --set image.tag=…` (siehe `values.yaml`).

4. **Erreichbarkeit** — Intern: `Service` ClusterIP auf Ports 3333 (Dashboard) und 8080 (Proxy). Von außen: `ingress.enabled: true` inkl. Host/TLS setzen, oder `service.type: NodePort` / LoadBalancer je nach Cluster.

5. **Smoke-Test** — `kubectl -n claude port-forward svc/<release>-claude-usage-dashboard 3333:3333` und Browser `http://127.0.0.1:3333/` (Service-Name aus `helm status cud` / `kubectl get svc -n claude`).

## Install (Minimal, ohne Overrides)

```bash
helm install cud ./k8/claude-usage-dashboard --namespace claude --create-namespace
```

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

Helm: `sync.tokenFromSecret` setzen, um `CLAUDE_USAGE_SYNC_TOKEN` aus einem Kubernetes-Secret zu befüllen.

## Secrets (Sync, GitHub, Admin)

Das Chart kann **ein** Opaque-Secret mit festen Key-Namen einbinden (alle `optional: true`, fehlende Keys sind erlaubt):

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

```yaml
secrets:
  existingSecret: claude-usage-dashboard-app
```

**Variante 2 — nur Sync-Token in separatem Secret** (wie früher):

```bash
kubectl create secret generic claude-usage-sync -n claude --from-literal=token="$(openssl rand -hex 32)"
```

```yaml
sync:
  tokenFromSecret:
    name: claude-usage-sync
    key: token
```

**Variante 3 — Secret von Helm erzeugen** (Werte nur in **privater** Datei, nicht committen):

```yaml
# secrets.local.yaml
secrets:
  create: true
  stringData:
    sync-token: "..."
    github-token: ""
    admin-token: ""
```

```bash
helm upgrade --install cud ./k8/claude-usage-dashboard -n claude --create-namespace \
  -f my-values.yaml -f secrets.local.yaml
```

Key-Namen überschreibbar unter `secrets.keys` in `values.yaml`.

## Cluster-Beispiel

Siehe `claude-usage-dashboard/values-cluster.example.yaml` (Harbor-Image, `imagePullSecrets`, StorageClass, Ingress/TLS, Ressourcen, `secrets.existingSecret`).

## Proxy und Claude Code

Der Container lauscht mit `ANTHROPIC_PROXY_BIND=0.0.0.0` auf Port **8080**. Clients außerhalb des Clusters brauchen einen erreichbaren Service (NodePort, LoadBalancer, Ingress mit TCP oder separater Route) und setzen z. B. `ANTHROPIC_BASE_URL=http://…:8080`.
