$ErrorActionPreference = 'Stop'

$RootDir = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).ProviderPath
$RuntimeDir = if ($env:JELLYTUBE_RUNTIME_DIR) { $env:JELLYTUBE_RUNTIME_DIR } else { Join-Path $RootDir '.jellytube' }
$PidFile = if ($env:JELLYTUBE_PID_FILE) { $env:JELLYTUBE_PID_FILE } else { Join-Path $RuntimeDir 'jellytube.pid' }

if (-not (Test-Path -LiteralPath $PidFile)) {
  Write-Host 'JellyTube is not running; no PID file found.'
  exit 0
}

$pidText = ''
try {
  $pidText = (Get-Content -LiteralPath $PidFile -Raw -ErrorAction Stop).Trim()
} catch {
  $pidText = ''
}

$processIdValue = 0
if (-not [int]::TryParse($pidText, [ref]$processIdValue)) {
  Remove-Item -LiteralPath $PidFile -Force -ErrorAction SilentlyContinue
  Write-Host 'Removed stale PID file.'
  exit 0
}

$process = Get-Process -Id $processIdValue -ErrorAction SilentlyContinue
if ($null -eq $process) {
  Remove-Item -LiteralPath $PidFile -Force -ErrorAction SilentlyContinue
  Write-Host 'Removed stale PID file.'
  exit 0
}

Stop-Process -Id $processIdValue -ErrorAction SilentlyContinue
for ($attempt = 0; $attempt -lt 20; $attempt += 1) {
  if ($null -eq (Get-Process -Id $processIdValue -ErrorAction SilentlyContinue)) {
    Remove-Item -LiteralPath $PidFile -Force -ErrorAction SilentlyContinue
    Write-Host 'JellyTube stopped.'
    exit 0
  }

  Start-Sleep -Milliseconds 200
}

[Console]::Error.WriteLine("JellyTube did not stop within 4 seconds; PID $processIdValue is still running.")
exit 1
