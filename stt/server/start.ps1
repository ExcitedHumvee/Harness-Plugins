<#
.SYNOPSIS
  Start the faster-whisper sidecar for the DSH STT plugin (Windows).

.DESCRIPTION
  Launches `stt_server.py` with the plugin's own virtualenv, detached, writing its
  output to `stt/server/server.log`. The plugin starts this automatically when DSH
  loads it, so this script is for starting it by hand, or for watching the log in
  a terminal.

  The model stays resident in the process, and the first request after a restart
  pays the load time (seconds) plus, on a brand-new install, the weight download.

.EXAMPLE
  pwsh -File stt\server\start.ps1                 # detached, logs to server.log
  pwsh -File stt\server\start.ps1 -Foreground     # keep the log on this console
  pwsh -File stt\server\start.ps1 -Model base     # start with other weights
#>
[CmdletBinding()]
param(
  [int]$Port = 8124,
  [switch]$Foreground,
  [string]$Model = "",
  [string]$Language = "",
  [ValidateSet("auto", "cpu", "cuda")]
  [string]$Device = "auto"
)

$ErrorActionPreference = "Stop"
$serverDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Split-Path -Parent $serverDir
$pythonExe = Join-Path $root ".venv\Scripts\python.exe"
$script = Join-Path $serverDir "stt_server.py"
$logFile = Join-Path $serverDir "server.log"

if (-not (Test-Path $pythonExe)) {
  throw "The sidecar virtualenv is missing. Run: pwsh -File `"$serverDir\setup.ps1`""
}

# Already running? Any answer on /health means yes — including 503 while the
# model loads, which is precisely when a second process would be harmful.
try {
  $probe = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/health" -TimeoutSec 2 -UseBasicParsing
  Write-Host "Sidecar already listening on 127.0.0.1:$Port" -ForegroundColor Yellow
  Write-Host $probe.Content
  exit 0
} catch {
  if ($_.Exception.Response) {
    Write-Host "Sidecar already listening on 127.0.0.1:$Port (still loading)" -ForegroundColor Yellow
    exit 0
  }
}

$env:DSH_STT_PORT = "$Port"
$env:DSH_STT_DEVICE = $Device
if ($Model -ne "") { $env:DSH_STT_MODEL = $Model }
if ($Language -ne "") { $env:DSH_STT_LANGUAGE = $Language }

if ($Foreground) {
  Write-Host "Starting sidecar on 127.0.0.1:$Port (Ctrl+C to stop)" -ForegroundColor Cyan
  & $pythonExe $script
  exit $LASTEXITCODE
}

# The script path is quoted: this checkout lives under a path with spaces, and
# Start-Process hands ArgumentList to the child as a command line verbatim.
$process = Start-Process -FilePath $pythonExe -ArgumentList @("`"$script`"") -WorkingDirectory $root `
  -WindowStyle Hidden -PassThru `
  -RedirectStandardOutput $logFile -RedirectStandardError "$logFile.err"

Write-Host "Started sidecar (pid $($process.Id)) on http://127.0.0.1:$Port" -ForegroundColor Green
Write-Host "Log: $logFile"
Write-Host "The model reports ready at http://127.0.0.1:$Port/health once the weights are loaded."
