<#
.SYNOPSIS
  Install the faster-whisper sidecar for the DSH STT plugin (Windows).

.DESCRIPTION
  Creates a self-contained Python 3.11 virtualenv in `stt/.venv` using a
  standalone `uv` (no system Python needed — the Python that ships with Windows
  is only the Microsoft Store stub), installs `faster-whisper`, then downloads the
  model weights into `stt/.models` and decodes one clip so the first mic click in
  the GUI is instant.

  Everything after this runs offline: the model is read from `stt/.models`, and
  the sidecar binds 127.0.0.1 only. Total download is roughly 300 MB
  (CTranslate2 + PyAV + the default `base` weights at ~145 MB).

.EXAMPLE
  pwsh -File stt\server\setup.ps1
  pwsh -File stt\server\setup.ps1 -SkipWarmup     # install only, fetch weights later
  pwsh -File stt\server\setup.ps1 -Model tiny     # smallest/fastest weights
  pwsh -File stt\server\setup.ps1 -Model small    # better accuracy, ~3x slower here

.NOTES
  Re-running is safe: the venv, uv and the weights are reused when present.
#>
[CmdletBinding()]
param(
  [string]$Python = "3.11",
  [string]$Model = "base",
  [switch]$SkipWarmup,
  [switch]$Force
)

$ErrorActionPreference = "Stop"
$serverDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Split-Path -Parent $serverDir           # stt/
$toolsDir = Join-Path $root ".tools"
$venvDir = Join-Path $root ".venv"
$uv = Join-Path $toolsDir "uv.exe"
$pythonExe = Join-Path $venvDir "Scripts\python.exe"

function Write-Step($message) { Write-Host "==> $message" -ForegroundColor Cyan }

# ── 1. uv ────────────────────────────────────────────────────────────────────
if ($Force -or -not (Test-Path $uv)) {
  Write-Step "installing uv into $toolsDir"
  New-Item -ItemType Directory -Force -Path $toolsDir | Out-Null
  $zip = Join-Path $env:TEMP "uv-windows.zip"
  Invoke-WebRequest -Uri "https://github.com/astral-sh/uv/releases/latest/download/uv-x86_64-pc-windows-msvc.zip" -OutFile $zip
  Expand-Archive -Path $zip -DestinationPath $toolsDir -Force
  }
}
& $uv --version

# ── 2. virtualenv ────────────────────────────────────────────────────────────
if ($Force -or -not (Test-Path $pythonExe)) {
  Write-Step "creating the virtualenv at $venvDir"
  & $uv venv --python $Python $venvDir
}
& $pythonExe --version

# ── 3. faster-whisper ────────────────────────────────────────────────────────
Write-Step "installing faster-whisper (CTranslate2 + PyAV are the large part)"
& $uv pip install --python $pythonExe faster-whisper

$version = & $pythonExe -c "import faster_whisper, ctranslate2, av; print(faster_whisper.__version__, 'ctranslate2', ctranslate2.__version__, 'av', av.__version__)"
Write-Host "faster-whisper $version is installed." -ForegroundColor Green

# ── 4. weights + smoke test ──────────────────────────────────────────────────
if (-not $SkipWarmup) {
  Write-Step "downloading the '$Model' weights into stt/.models and decoding a test clip"
  & $pythonExe (Join-Path $serverDir "warmup.py") --model $Model
  if ($LASTEXITCODE -ne 0) { throw "warmup failed (exit $LASTEXITCODE)" }
}

Write-Host ""
Write-Host "Done. Start the sidecar with:" -ForegroundColor Green
Write-Host "  pwsh -File `"$serverDir\start.ps1`""
Write-Host "The plugin also starts it automatically when DSH loads the plugin."
