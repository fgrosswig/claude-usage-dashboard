#!/usr/bin/env sh
# Einheitliche Checks für Manifeste/Helm (von infrastructure-docs oder lokal aufrufbar).
# Base-Image: nur Woodpecker **.woodpecker/base.yml** auf Docker-Agent **.220** → Harbor **claude/base**.
# App-Image: **.woodpecker/app.yml** + Kaniko auf **.171** — hier kein docker build.
# Ausführung vom Repo-Root: sh scripts/k8-ci-verify.sh
set -e
ROOT="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "== prepare smoke (sed wie Woodpecker prepare → temporäres Dockerfile.ci) =="
test -f Dockerfile && test -f version.json
BASE_VER=$(awk -F'"' '/base_image/{print $4}' version.json)
TMP_CI="${TMPDIR:-/tmp}/cud-Dockerfile.ci-$$"
trap 'rm -f "$TMP_CI"' EXIT
sed "s|^ARG BASE_TAG=.*|ARG BASE_TAG=$BASE_VER|" Dockerfile >"$TMP_CI"
grep -F "ARG BASE_TAG=$BASE_VER" "$TMP_CI" >/dev/null || {
  echo "prepare smoke: expected ARG BASE_TAG=$BASE_VER in generated file"
  exit 1
}

echo "== helm lint =="
helm lint k8/claude-usage-dashboard

echo "== helm template (smoke) =="
helm template k8-ci-smoke k8/claude-usage-dashboard >/dev/null

echo "== kubectl kustomize k8s/overlays/dev (SCHUFA-Pfad) =="
kubectl kustomize k8s/overlays/dev >/dev/null

echo "k8-ci-verify: OK"
