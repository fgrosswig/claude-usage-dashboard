# Kubernetes / Helm

[![Woodpecker CI — main](https://ci.grosswig-it.de/api/badges/3/status.svg?branch=main)](https://ci.grosswig-it.de/repos/3)

Chart: `k8/claude-usage-dashboard/` — Usage-Dashboard + Anthropic-Proxy (`node start.js both`).

**Woodpecker-Deploy** entspricht **SCHUFA**: `kubectl apply -k k8s/overlays/dev`, `set image` auf **Deployment `claude-app`**. Details und Tabellen → Abschnitt **Kustomize** unten. **Helm-Chart** bleibt für manuelles Installieren; bei Template-Änderungen **`k8s/base/*.yml`** abstimmen.

## Build image

**Reihenfolge wie SCHUFA:** Zuerst **`harbor.grosswig-it.de/claude/base`** — Workflow **`.woodpecker/base.yml`** (Push auf `Dockerfile.base`, `version.json`, `package.json`, `package-lock.json`, **Docker-Agent .220**). Danach (oder parallel bei nur App-Änderungen) **`.woodpecker/app.yml`**: **prepare** (schreibt **`Dockerfile.ci`** mit `BASE_TAG` aus **`version.json`**) → **Kaniko** (zieht das Base von Harbor, **Docker-Agent .220** wie SCHUFA) → Deploy → Cleanup. Ohne existierendes Base-Tag schlägt Kaniko fehl — erst **`base.yml`** laufen lassen oder Base manuell pushen.

**Erstmalig / leeres Harbor-Repo `claude/base`:** In Woodpecker den Workflow **`base`** (`.woodpecker/base.yml`) **manuell** ausführen — `when` enthält **`manual`**; Pfadfilter greifen dabei nicht. Danach existiert **`claude/base:v3`** (und **`latest`**), dann **`app.yml`** erneut starten. In Harbor Projekt **`claude`** und Robot mit **Push** auf **`base`** vorsehen.

**Normalfall Branch-Events:** **`main`**, **`int`**, **`feat/**`**, **`fix/**`**. Doku-Gesamtbild: [SCHUFA `docs/01-deployment.md`](https://gitea.grosswig-it.de/GRO/SCHUFA/src/branch/main/docs/01-deployment.md).

**Pull Requests:** **`.woodpecker/pr.yml`** — Checks ohne Kaniko (SCHUFA hat kein separates PR-File; hier ergänzt).

Lokal: `Dockerfile` nutzt **`FROM harbor.grosswig-it.de/claude/base:<tag>`** (`version.json` → `base_image`, Standard **`v3`**). Registry-Login setzen, Base-Image vorhanden, dann vom **Repository-Root**:

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

Harbor liefert beim Anlegen eines Robot-Accounts eine JSON-Datei. **Standardablage (nur lokal, nicht im Git):**

**`k8/claude-usage-dashboard/robot$claude+developer.json`**

(`robot*.json` unter diesem Pfad ist per **`.gitignore`** ausgeschlossen.)

**Ein Befehl — Secret `harbor-pull` im Cluster** (Repo-Root, `kubectl` + `jq`):

```bash
sh scripts/k8-harbor-pull-secret.sh
```

Andere JSON-Datei: `ROBOT_JSON=/pfad/zur/robot.json sh scripts/k8-harbor-pull-secret.sh`  
Anderer Registry-Host: `HARBOR_HOST=harbor.grosswig-it.de` (Standard).

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
| `k8s/overlays/dev/` | Namespace **claude**, **Ingress** (Traefik), `images.newTag: latest` — vgl. [SCHUFA overlays/dev](https://gitea.grosswig-it.de/GRO/SCHUFA/src/branch/feat/fastify-v5/k8s/overlays/dev/kustomization.yml) |

Prüfen: `kubectl kustomize k8s/overlays/dev`

## CI — Woodpecker

| Datei | Rolle |
|-------|--------|
| [`.woodpecker/base.yml`](../.woodpecker/base.yml) | **Harbor `claude/base`** (`woodpeckerci/plugin-docker` über **poc**, **backend: docker** / .220) |
| [`.woodpecker/app.yml`](../.woodpecker/app.yml) | prepare → **Dockerfile.ci**, Kaniko, **kubectl apply -k k8s/overlays/dev**, set image, rollout, cleanup — **wie SCHUFA** nur **`platform`** → **Docker-Agent .220** |
| [`.woodpecker/pr.yml`](../.woodpecker/pr.yml) | PR-Checks ohne Kaniko (**backend: docker** / .220) |

**Agent-Auswahl (GRO):** `.woodpecker/app.yml` entspricht **[SCHUFA `app.yml`](https://gitea.grosswig-it.de/GRO/SCHUFA/src/branch/feat/fastify-v5/.woodpecker/app.yml)** — nur **`platform: linux/amd64`** (kein **`backend: kubernetes`**), damit **Kaniko** und kurze Image-Namen auf dem **Docker-Agent .220** laufen. **`backend: kubernetes`** würde **Job-Pods auf .171** erzeugen; dann Step-Images über Harbor **`poc`** nötig (Cluster ohne Docker-Hub). **`.woodpecker/pr.yml`** setzt explizit **`backend: docker`**. Base-Image weiterhin **`.woodpecker/base.yml`** auf .220. Siehe [04-woodpecker.md](https://gitea.grosswig-it.de/GRO/infrastructure-docs/src/branch/main/docs/04-woodpecker.md).

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

**Registry:** **App-Pipeline** (`.woodpecker/app.yml`) läuft auf **Docker .220** wie SCHUFA — Step-Images **`alpine`**, **`plugins/kaniko`**, **`bitnami/kubectl`** zieht der **Docker-Host** (Hub/Mirror). Nur bei **`backend: kubernetes`** (optional): Step-Images über Harbor-Proxy **`poc`**. **`Dockerfile.base`**: **`FROM node:20-alpine`** auf .220. **App-**`Dockerfile`: **`harbor.../claude/base`**. Doku: **05-harbor.md**.

**Auslöser `app.yml`:** wie SCHUFA nur **`push`** und **`manual`** auf **`feat/**`**, **`fix/**`**, **`main`**, **`int`** (kein separater Tag-/Deployment-Event — wer Tags braucht, analog SCHUFA erweitern).

Lokal: `sh scripts/k8-ci-verify.sh` (Helm/Kustomize + Smoke für **Dockerfile.ci**, kein `docker build` — Base/App laufen in Woodpecker). `kubectl` in der Pipeline: `--insecure-skip-tls-verify` wie SCHUFA.

**Deploy / Registry:** **[GRO / infrastructure-docs](https://gitea.grosswig-it.de/GRO/infrastructure-docs)**, **05-harbor.md**.

**Hinweis:** **`.woodpecker/base.yml`** auf **.220** → Harbor **`claude/base`**; Plugin-Image nur über **`poc`**, nicht Docker Hub. Optional **Gitea Actions** (SCHUFA): [deploy.yml `feat/fastify-v5`](https://gitea.grosswig-it.de/GRO/SCHUFA/src/branch/feat/fastify-v5/.gitea/workflows/deploy.yml).

## Deploy im Kubernetes-Cluster

**Reihenfolge:**

1. **Vorbereitung** — Namespace `claude` (legt Helm mit `--create-namespace` an). Bei privater Registry Pull-Secret **`harbor-pull`** anlegen (Abschnitt **Harbor** oben). Ohne dieses Secret: Pod-Event **`Failed to pull image`** / **`image can't be pulled`** — prüfen mit `kubectl describe pod -n claude -l app=claude-dashboard` (oft `401`/`no basic auth`). **`--docker-server`** muss der reine Hostname sein (z. B. **`harbor.grosswig-it.de`**, ohne `https://`).
2. **Base-Image** — Woodpecker **`.woodpecker/base.yml`** auf **.220** nach Harbor **`claude/base`** (bei Änderung an Base-Deps oder einmalig manuell triggern). **App-Image** — **Kaniko** in **`app.yml`** auf **.220** (`build-push`, wie SCHUFA).
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

4. **Erreichbarkeit** — **`kubectl apply -k k8s/overlays/dev`** legt einen **Ingress** (`k8s/overlays/dev/ingress.yml`) mit **Traefik** an: **`claude-usage.grosswig-it.de`** → Dashboard (`http-dashboard`), **`claude-usage-proxy.grosswig-it.de`** → Proxy (`http-proxy`). Standard **HTTP** (`web`-Entrypoint-Annotation). **TLS im Ingress:** optional `spec.tls` + Secret **`claude-usage-tls`** und Annotation **`traefik.ingress.kubernetes.io/router.entrypoints: web,websecure`** (siehe Kommentare in `ingress.yml`). DNS → Traefik, **[06-traefik.md](https://gitea.grosswig-it.de/GRO/infrastructure-docs/src/branch/main/docs/06-traefik.md)**. Helm: **`values-cluster.example.yaml`**. Ohne Ingress: **ClusterIP** / `kubectl port-forward`.

   **Browser `ERR_CONNECTION_REFUSED`:** Meist **kein Listener** auf der IP, die der Hostname auflöst — nicht „Ingress fehlt in Git“. Prüfen:
   - `kubectl apply -k k8s/overlays/dev` und `kubectl get ingress -n claude` — Spalte **ADDRESS** / **HOSTS** (leer = Traefik/IngressClass prüfen).
   - `kubectl get ingressclass` — existiert **`traefik`**?
   - **DNS:** `claude-usage.grosswig-it.de` muss auf die **Traefik-IP** zeigen (z. B. **AdGuard DNS-Rewrite** auf `.171` oder die **LoadBalancer-/NodePort-IP** des Traefik-`Service`, nicht auf einen Rechner ohne offenes 80/443).
   - Vom LAN: `curl -v --resolve claude-usage.grosswig-it.de:80:<TRAEFIK-IP> http://claude-usage.grosswig-it.de/` (Port 80 muss auf Traefik offen sein).

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
