#!/usr/bin/env bash
# Liest sync-token aus K8s (wie k8s/base/deployment.yml). Klartext auf stdout.
# CLAUDE_SYNC_K8S_NAMESPACE (default: claude), CLAUDE_SYNC_K8S_SECRET (default: claude-usage-dashboard-app)

set -euo pipefail
NS="${CLAUDE_SYNC_K8S_NAMESPACE:-claude}"
SECRET="${CLAUDE_SYNC_K8S_SECRET:-claude-usage-dashboard-app}"
b64="$(kubectl get secret "$SECRET" -n "$NS" -o jsonpath='{.data.sync-token}')"
if [[ -z "$b64" ]]; then
  echo "print-claude-sync-token: empty sync-token (secret=$SECRET ns=$NS)" >&2
  exit 1
fi
printf '%s' "$b64" | base64 -d
