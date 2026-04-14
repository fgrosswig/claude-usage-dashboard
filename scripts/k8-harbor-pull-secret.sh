#!/usr/bin/env sh
# Erzeugt/aktualisiert kubernetes.io/dockerconfigjson Secret harbor-pull im Namespace claude
# aus der Harbor-Robot-JSON (lokal, nicht im Git — siehe .gitignore).
#
# Standard-Pfad (wie k8/README.md):
#   k8/claude-usage-dashboard/robot$claude+developer.json
#
# Aufruf vom Repo-Root:
#   sh scripts/k8-harbor-pull-secret.sh
# Optional:
#   ROBOT_JSON=/pfad/robot.json HARBOR_HOST=registry.example.com sh scripts/k8-harbor-pull-secret.sh
set -e
ROOT="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

DEFAULT_JSON='k8/claude-usage-dashboard/robot$claude+developer.json'
ROBOT_JSON=${ROBOT_JSON:-$DEFAULT_JSON}
HARBOR_HOST=${HARBOR_HOST:-registry.example.com}

if ! test -f "$ROBOT_JSON"; then
  echo "Datei fehlt: $ROBOT_JSON"
  echo "Harbor Robot exportieren und dort ablegen (oder ROBOT_JSON=... setzen)."
  exit 1
fi

command -v jq >/dev/null 2>&1 || {
  echo "jq fehlt (z. B. apk add jq / apt install jq)."
  exit 1
}

U="$(jq -r .name "$ROBOT_JSON")"
P="$(jq -r .secret "$ROBOT_JSON")"
if test -z "$U" || test "$U" = null || test -z "$P" || test "$P" = null; then
  echo "Ungültige JSON: Felder name/secret erwartet."
  exit 1
fi

kubectl get ns claude >/dev/null 2>&1 || kubectl create namespace claude

kubectl delete secret harbor-pull -n claude --ignore-not-found >/dev/null
kubectl create secret docker-registry harbor-pull -n claude \
  --docker-server="$HARBOR_HOST" \
  --docker-username="$U" \
  --docker-password="$P"

echo "OK: secret harbor-pull in namespace claude (server=$HARBOR_HOST)."
echo "Optional: kubectl rollout restart deployment/claude-app -n claude"
