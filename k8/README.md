# Kubernetes / Helm

Chart: `claude-usage-dashboard/` — Usage-Dashboard + Anthropic-Proxy (`node start.js both`).

## Build image

From the **repository root** (where the `Dockerfile` lives):

```bash
docker build -t claude-usage-dashboard:latest .
```

For a registry:

```bash
docker tag claude-usage-dashboard:latest your.registry.example/claude-usage-dashboard:latest
docker push your.registry.example/claude-usage-dashboard:latest
```

Set in `values.yaml`: `image.repository` / `image.tag` / `imagePullSecrets` as needed.

## Install

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

## Beispiel Secret + Values-Ausschnitt

```bash
kubectl create secret generic claude-usage-sync -n claude --from-literal=token="$(openssl rand -hex 32)"
```

```yaml
sync:
  tokenFromSecret:
    name: claude-usage-sync
    key: token
```

## Proxy und Claude Code

Der Container lauscht mit `ANTHROPIC_PROXY_BIND=0.0.0.0` auf Port **8080**. Clients außerhalb des Clusters brauchen einen erreichbaren Service (NodePort, LoadBalancer, Ingress mit TCP oder separater Route) und setzen z. B. `ANTHROPIC_BASE_URL=http://…:8080`.
