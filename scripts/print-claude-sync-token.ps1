#!/usr/bin/env pwsh
<#
.SYNOPSIS
  Liest sync-token aus Kubernetes (Opaque Secret) und schreibt den Klartext auf stdout.
  Gleiches Secret wie k8s/base/deployment.yml -> CLAUDE_USAGE_SYNC_TOKEN.

.EXAMPLE
  $t = & scripts/print-claude-sync-token.ps1
  $env:CLAUDE_SYNC_TOKEN = $t
  $env:CLAUDE_SYNC_URL = "http://NODE:31333"
  node scripts/claude-data-sync-client.js
#>
param(
  [string] $Namespace = $(if ($env:CLAUDE_SYNC_K8S_NAMESPACE) { $env:CLAUDE_SYNC_K8S_NAMESPACE } else { "claude" }),
  [string] $SecretName = $(if ($env:CLAUDE_SYNC_K8S_SECRET) { $env:CLAUDE_SYNC_K8S_SECRET } else { "claude-usage-dashboard-app" })
)

$ErrorActionPreference = "Stop"
$b64 = kubectl get secret $SecretName -n $Namespace -o "jsonpath={.data.sync-token}"
if (-not $b64) {
  Write-Error "Secret $SecretName in namespace $Namespace hat keinen Key sync-token (oder kubectl nicht eingeloggt)."
}
[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($b64))
