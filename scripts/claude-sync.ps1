#!/usr/bin/env pwsh
<#
.SYNOPSIS
  Sync local ~/.claude/projects (and optional proxy logs) to the
  Claude Usage Dashboard running on Kubernetes.

.DESCRIPTION
  Wrapper around `node scripts/claude-data-sync-client.js` that:
    * Reads the sync token from a secret file at runtime (never echoed).
    * Defaults the dashboard URL to the k8s production host.
    * Passes credentials via environment variables instead of command-line
      arguments so the token never ends up in shell history or process lists.
    * Clears the environment variables again when the sync completes or fails.

  Secret file format: either a single line containing the raw token, or
  KEY=VALUE lines where the script looks for `CLAUDE_SYNC_TOKEN=...` or
  `SYNC_TOKEN=...`. Lines starting with `#` are treated as comments.

.PARAMETER Url
  Dashboard base URL. Defaults to the production k8s host.

.PARAMETER SecretPath
  Path to the secret file containing the sync token.
  Defaults to `<repo-root>/.sync.secret`.

.PARAMETER ProxyLogs
  Also include ~/.claude/anthropic-proxy-logs/ in the upload
  (passes `--proxy-logs` to the Node client).

.PARAMETER RepoRoot
  Path to the Claude Usage Dashboard repo checkout.
  Defaults to the parent directory of this script when it lives in scripts/,
  otherwise the script's own directory.

.EXAMPLE
  # Default k8s sync
  .\scripts\claude-sync.ps1

.EXAMPLE
  # Include proxy logs
  .\scripts\claude-sync.ps1 -ProxyLogs

.EXAMPLE
  # Override URL (e.g. dev instance)
  .\scripts\claude-sync.ps1 -Url http://localhost:3333 -SecretPath C:\dev\.sync.secret

.NOTES
  Never logs the token contents. Only the character length is printed for
  sanity checking. If the Node tar binary cannot be found on Windows, set
  $env:CLAUDE_SYNC_TAR="C:\Windows\System32\tar.exe" before running.
#>

[CmdletBinding()]
param(
  [string]$Url = "https://claude-usage.grosswig-it.de",
  [string]$SecretPath = "",
  [switch]$ProxyLogs,
  [string]$RepoRoot = ""
)

$ErrorActionPreference = "Stop"

# ── Resolve repo root ────────────────────────────────────────
if (-not $RepoRoot) {
  $scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
  if ((Split-Path -Leaf $scriptDir) -eq "scripts") {
    $RepoRoot = Split-Path -Parent $scriptDir
  }
  else {
    $RepoRoot = $scriptDir
  }
}

# ── Verify sync client script exists ────────────────────────
$syncClientPath = Join-Path $RepoRoot "scripts/claude-data-sync-client.js"
if (-not (Test-Path -LiteralPath $syncClientPath)) {
  Write-Error "sync client not found: $syncClientPath"
  exit 1
}

# ── Resolve secret file path ────────────────────────────────
if (-not $SecretPath) {
  $SecretPath = Join-Path $RepoRoot ".sync.secret"
}
if (-not (Test-Path -LiteralPath $SecretPath)) {
  Write-Error "secret file not found: $SecretPath"
  Write-Host ""
  Write-Host "Create it with:" -ForegroundColor Yellow
  Write-Host "  echo 'CLAUDE_SYNC_TOKEN=<your-token>' > $SecretPath" -ForegroundColor Yellow
  Write-Host "or paste the raw token (single line) into that file." -ForegroundColor Yellow
  exit 1
}

# ── Parse secret file (no echo of contents) ─────────────────
$token = $null
try {
  $lines = Get-Content -LiteralPath $SecretPath -ErrorAction Stop
}
catch {
  Write-Error ("cannot read secret file: " + $_.Exception.Message)
  exit 1
}

# Prefer KEY=VALUE lines (CLAUDE_SYNC_TOKEN or SYNC_TOKEN)
foreach ($line in $lines) {
  $trimmed = $line.Trim()
  if (-not $trimmed) { continue }
  if ($trimmed.StartsWith("#")) { continue }
  if ($trimmed -match '^(CLAUDE_SYNC_TOKEN|SYNC_TOKEN)\s*=\s*"?([^"\r\n]+)"?\s*$') {
    $token = $Matches[2]
    break
  }
}

# Fallback: first non-empty, non-comment line is the raw token
if (-not $token) {
  foreach ($line in $lines) {
    $trimmed = $line.Trim()
    if (-not $trimmed) { continue }
    if ($trimmed.StartsWith("#")) { continue }
    $token = $trimmed
    break
  }
}

if (-not $token) {
  Write-Error "no sync token found in $SecretPath"
  exit 1
}

# Strip optional "Bearer " prefix (matches what the Node client also does)
$token = $token -replace '^Bearer\s+', ''

# ── Summary (no token content) ──────────────────────────────
Write-Host "Sync target : $Url" -ForegroundColor Cyan
Write-Host "Repo root   : $RepoRoot" -ForegroundColor DarkGray
Write-Host "Sync client : $syncClientPath" -ForegroundColor DarkGray
Write-Host "Secret file : $SecretPath" -ForegroundColor DarkGray
Write-Host ("Token length: {0} chars" -f $token.Length) -ForegroundColor DarkGray
if ($ProxyLogs) {
  Write-Host "Include     : projects + anthropic-proxy-logs" -ForegroundColor Yellow
}
else {
  Write-Host "Include     : projects only (pass -ProxyLogs to also upload proxy logs)" -ForegroundColor DarkGray
}
Write-Host ""

# ── Run the Node client with env-var credentials ────────────
$env:CLAUDE_SYNC_URL = $Url
$env:CLAUDE_SYNC_TOKEN = $token

$exit = 1
try {
  $nodeArgs = @($syncClientPath)
  if ($ProxyLogs) { $nodeArgs += "--proxy-logs" }
  & node @nodeArgs
  $exit = $LASTEXITCODE
}
finally {
  # Clear secrets from the current shell environment
  Remove-Item Env:CLAUDE_SYNC_TOKEN -ErrorAction SilentlyContinue
  Remove-Item Env:CLAUDE_SYNC_URL -ErrorAction SilentlyContinue
}

if ($exit -eq 0) {
  Write-Host ""
  Write-Host "Sync complete." -ForegroundColor Green
}
else {
  Write-Host ""
  Write-Host "Sync failed (exit $exit)." -ForegroundColor Red
}

exit $exit
