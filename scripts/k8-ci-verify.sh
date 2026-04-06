#!/usr/bin/env sh
# Einheitliche Build-/Helm-Checks für CI (von infrastructure-docs oder lokal aufrufbar).
# Ausführung vom Repo-Root: sh scripts/k8-ci-verify.sh
set -e
ROOT="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "== docker build =="
docker build -t claude-usage-dashboard:ci .

echo "== helm lint =="
helm lint k8/claude-usage-dashboard

echo "== helm template (smoke) =="
helm template k8-ci-smoke k8/claude-usage-dashboard >/dev/null

echo "k8-ci-verify: OK"
