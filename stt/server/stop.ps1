<#
.SYNOPSIS
  Stop the faster-whisper sidecar (Windows).

.DESCRIPTION
  Finds the process listening on the sidecar port and stops it. The plugin never
  stops the sidecar on its own — reloading the DSH profile re-composes plugins,
  and a model that has to reload on every patch would be far worse than an idle
  process — so this is the explicit way to reclaim the memory.

.EXAMPLE
  pwsh -File stt\server\stop.ps1
#>
[CmdletBinding()]
param([int]$Port = 8124)

$ErrorActionPreference = "Stop"

$connections = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if (-not $connections) {
  Write-Host "Nothing is listening on port $Port." -ForegroundColor Yellow
  exit 0
}

foreach ($processId in ($connections | Select-Object -ExpandProperty OwningProcess -Unique)) {
  $process = Get-Process -Id $processId -ErrorAction SilentlyContinue
  if ($process) {
    Write-Host "Stopping $($process.ProcessName) (pid $processId)" -ForegroundColor Cyan
    Stop-Process -Id $processId -Force
  }
}
Write-Host "Sidecar stopped." -ForegroundColor Green
