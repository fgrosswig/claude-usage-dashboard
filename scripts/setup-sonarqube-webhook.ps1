#!/usr/bin/env pwsh
<#
.SYNOPSIS
  Register the SonarQube-Gitea bot webhook on the Claude-Usage-Dashboard repo.

.DESCRIPTION
  Creates a Gitea webhook pointing at the in-cluster sonarqube bot, with
  the shared secret pulled from a local infra-secrets file at runtime.
  The secret is read by this script only; it is never echoed to stdout,
  never passed as a command-line argument, and is cleared from the
  process environment before the script exits.

.PARAMETER SecretsPath
  Path to the infra secrets file. Defaults to ~/.secrets/infra-secrets.txt.
  File format: KEY=VALUE lines, looks for `gitea_webhook_secret`.

.PARAMETER GiteaUrl
  Gitea base URL. Defaults to https://gitea.grosswig-it.de.

.PARAMETER Repo
  owner/name. Defaults to GRO/Claude-Usage-Dashboard.

.PARAMETER GiteaTokenPath
  Path to a file containing a Gitea API token with repo admin rights,
  OR set `GITEA_TOKEN` env var before running.

.PARAMETER WebhookUrl
  Webhook target URL (the bot's /hooks/gitea endpoint).
  Defaults to the in-cluster service DNS.

.EXAMPLE
  # Default: all paths and values from convention
  $env:GITEA_TOKEN = '...'
  .\scripts\setup-sonarqube-webhook.ps1

.NOTES
  The webhook secret file is read here and passed directly to the Gitea
  API. It is never stored in shell history, tmp files, or script output.
#>

[CmdletBinding()]
param(
  [string]$SecretsPath = "$HOME/.secrets/infra-secrets.txt",
  [string]$GiteaUrl = "https://gitea.grosswig-it.de",
  [string]$Repo = "GRO/Claude-Usage-Dashboard",
  [string]$GiteaTokenPath = "",
  [string]$WebhookUrl = "http://gitea-sonarqube-bot.sonarqube.svc.cluster.local:3000/hooks/gitea"
)

$ErrorActionPreference = "Stop"

# ── Load Gitea API token (env var or file, never echoed) ────
$giteaToken = $env:GITEA_TOKEN
if (-not $giteaToken -and $GiteaTokenPath) {
  if (-not (Test-Path -LiteralPath $GiteaTokenPath)) {
    Write-Error "Gitea token file not found: $GiteaTokenPath"
    exit 1
  }
  $giteaToken = (Get-Content -LiteralPath $GiteaTokenPath -TotalCount 1).Trim()
}
if (-not $giteaToken) {
  Write-Error "No Gitea API token. Set `$env:GITEA_TOKEN or pass -GiteaTokenPath"
  exit 1
}

# ── Load webhook secret from secrets file ──────────────────
if (-not (Test-Path -LiteralPath $SecretsPath)) {
  Write-Error "Secrets file not found: $SecretsPath"
  exit 1
}

$webhookSecret = $null
$lines = Get-Content -LiteralPath $SecretsPath -ErrorAction Stop
foreach ($line in $lines) {
  $trimmed = $line.Trim()
  if (-not $trimmed) { continue }
  if ($trimmed.StartsWith("#")) { continue }
  if ($trimmed -match '^gitea_webhook_secret\s*=\s*"?([^"\r\n]+)"?\s*$') {
    $webhookSecret = $Matches[1]
    break
  }
}
if (-not $webhookSecret) {
  Write-Error "Key 'gitea_webhook_secret' not found in $SecretsPath"
  exit 1
}

Write-Host "Gitea URL       : $GiteaUrl" -ForegroundColor Cyan
Write-Host "Repo            : $Repo" -ForegroundColor DarkGray
Write-Host "Webhook target  : $WebhookUrl" -ForegroundColor DarkGray
Write-Host ("Secret length   : {0} chars" -f $webhookSecret.Length) -ForegroundColor DarkGray
Write-Host ""

# ── Build payload ──────────────────────────────────────────
$payload = @{
  type = "gitea"
  active = $true
  events = @(
    "pull_request",
    "pull_request_sync"
  )
  config = @{
    url = $WebhookUrl
    content_type = "json"
    secret = $webhookSecret
  }
} | ConvertTo-Json -Depth 5 -Compress

# ── POST to Gitea API ──────────────────────────────────────
$apiUrl = "$GiteaUrl/api/v1/repos/$Repo/hooks"

try {
  $response = Invoke-RestMethod `
    -Uri $apiUrl `
    -Method Post `
    -Headers @{
      "Authorization" = "token $giteaToken"
      "Content-Type"  = "application/json"
    } `
    -Body $payload

  Write-Host "Webhook created successfully:" -ForegroundColor Green
  Write-Host ("  id    : {0}" -f $response.id)
  Write-Host ("  type  : {0}" -f $response.type)
  Write-Host ("  url   : {0}" -f $response.config.url)
  Write-Host ("  events: {0}" -f ($response.events -join ", "))
}
catch {
  $msg = $_.Exception.Message
  if ($_.ErrorDetails -and $_.ErrorDetails.Message) {
    $msg += " -- " + $_.ErrorDetails.Message
  }
  Write-Error "Webhook creation failed: $msg"
  exit 1
}
finally {
  # Clear secrets from local variables and env
  $webhookSecret = $null
  $giteaToken = $null
  $payload = $null
  [System.GC]::Collect()
}
