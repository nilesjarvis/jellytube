$ErrorActionPreference = 'Stop'

function Write-Fatal {
  param([Parameter(Mandatory = $true)][string]$Message)

  [Console]::Error.WriteLine($Message)
  exit 1
}

function Resolve-NativeCommand {
  param([Parameter(Mandatory = $true)][string]$Name)

  $candidates = @()
  if ($env:OS -eq 'Windows_NT') {
    $candidates += "$Name.cmd"
    $candidates += "$Name.exe"
  }
  $candidates += $Name

  foreach ($candidate in $candidates) {
    $command = Get-Command $candidate -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($null -ne $command) {
      return $command.Source
    }
  }

  return $null
}

function Invoke-NativeCommand {
  param(
    [Parameter(Mandatory = $true)][string]$FilePath,
    [string[]]$Arguments = @()
  )

  & $FilePath @Arguments
  $exitCode = if ($null -eq $LASTEXITCODE) { 0 } else { $LASTEXITCODE }
  if ($exitCode -ne 0) {
    exit $exitCode
  }
}

function Write-RecentLog {
  param([string[]]$Paths)

  foreach ($path in ($Paths | Select-Object -Unique)) {
    if ([string]::IsNullOrWhiteSpace($path) -or -not (Test-Path -LiteralPath $path)) {
      continue
    }

    [Console]::Error.WriteLine("==> $path <==")
    Get-Content -LiteralPath $path -Tail 40 -ErrorAction SilentlyContinue |
      ForEach-Object { [Console]::Error.WriteLine($_) }
  }
}

$RootDir = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).ProviderPath
Set-Location -LiteralPath $RootDir

$HostName = if ($env:JELLYTUBE_HOST) { $env:JELLYTUBE_HOST } else { '0.0.0.0' }
$Port = if ($env:JELLYTUBE_PORT) { $env:JELLYTUBE_PORT } else { '4173' }
$RuntimeDir = if ($env:JELLYTUBE_RUNTIME_DIR) { $env:JELLYTUBE_RUNTIME_DIR } else { Join-Path $RootDir '.jellytube' }
$PidFile = if ($env:JELLYTUBE_PID_FILE) { $env:JELLYTUBE_PID_FILE } else { Join-Path $RuntimeDir 'jellytube.pid' }
$LogFile = if ($env:JELLYTUBE_LOG_FILE) { $env:JELLYTUBE_LOG_FILE } else { Join-Path $RuntimeDir 'jellytube.log' }

foreach ($directory in @($RuntimeDir, (Split-Path -Parent $PidFile), (Split-Path -Parent $LogFile))) {
  if (-not [string]::IsNullOrWhiteSpace($directory)) {
    New-Item -ItemType Directory -Path $directory -Force | Out-Null
  }
}

$NodeCommand = Resolve-NativeCommand 'node'
if (-not $NodeCommand) {
  Write-Fatal 'Node.js 20 or newer is required.'
}

$NpmCommand = Resolve-NativeCommand 'npm'
if (-not $NpmCommand) {
  Write-Fatal 'npm is required.'
}

$nodeVersionOutput = & $NodeCommand -p 'process.versions.node' 2>$null
if ($LASTEXITCODE -ne 0 -or -not $nodeVersionOutput) {
  Write-Fatal 'Node.js 20 or newer is required.'
}

$nodeVersion = ($nodeVersionOutput | Select-Object -First 1).Trim()
$nodeMajor = 0
if (-not [int]::TryParse($nodeVersion.Split('.')[0], [ref]$nodeMajor) -or $nodeMajor -lt 20) {
  Write-Fatal "Node.js 20 or newer is required. Found v$nodeVersion."
}

if (Test-Path -LiteralPath $PidFile) {
  $existingPidText = ''
  try {
    $existingPidText = (Get-Content -LiteralPath $PidFile -Raw -ErrorAction Stop).Trim()
  } catch {
    $existingPidText = ''
  }

  $existingPid = 0
  if ([int]::TryParse($existingPidText, [ref]$existingPid)) {
    $existingProcess = Get-Process -Id $existingPid -ErrorAction SilentlyContinue
    if ($null -ne $existingProcess) {
      $displayHost = if ($HostName -eq '0.0.0.0') { 'localhost' } else { $HostName }
      Write-Host "JellyTube is already running with PID $existingPid."
      Write-Host "URL: http://${displayHost}:$Port"
      Write-Host "Log: $LogFile"
      exit 0
    }
  }

  Remove-Item -LiteralPath $PidFile -Force -ErrorAction SilentlyContinue
}

Write-Host 'Installing dependencies...'
if (Test-Path -LiteralPath 'package-lock.json') {
  Invoke-NativeCommand $NpmCommand @('ci')
} else {
  Invoke-NativeCommand $NpmCommand @('install')
}

Write-Host 'Building JellyTube...'
Invoke-NativeCommand $NpmCommand @('run', 'build')

New-Item -ItemType File -Path $LogFile -Force | Out-Null

Write-Host 'Starting JellyTube detached...'
$env:JELLYTUBE_HOST = $HostName
$env:JELLYTUBE_PORT = $Port

$errorLogFile = $null
try {
  $serverProcess = Start-Process `
    -FilePath $NodeCommand `
    -ArgumentList @('scripts/serve-dist.mjs') `
    -WorkingDirectory $RootDir `
    -RedirectStandardOutput $LogFile `
    -RedirectStandardError $LogFile `
    -WindowStyle Hidden `
    -PassThru
} catch {
  $logParent = Split-Path -Parent $LogFile
  $errorLogFile = if ([string]::IsNullOrWhiteSpace($logParent)) {
    'jellytube.error.log'
  } else {
    Join-Path $logParent 'jellytube.error.log'
  }

  New-Item -ItemType File -Path $errorLogFile -Force | Out-Null
  $serverProcess = Start-Process `
    -FilePath $NodeCommand `
    -ArgumentList @('scripts/serve-dist.mjs') `
    -WorkingDirectory $RootDir `
    -RedirectStandardOutput $LogFile `
    -RedirectStandardError $errorLogFile `
    -WindowStyle Hidden `
    -PassThru
}

Set-Content -LiteralPath $PidFile -Value $serverProcess.Id

Start-Sleep -Seconds 1
if ($null -eq (Get-Process -Id $serverProcess.Id -ErrorAction SilentlyContinue)) {
  [Console]::Error.WriteLine('JellyTube failed to start. Recent log output:')
  Write-RecentLog @($LogFile, $errorLogFile)
  Remove-Item -LiteralPath $PidFile -Force -ErrorAction SilentlyContinue
  exit 1
}

$displayHost = if ($HostName -eq '0.0.0.0') { 'localhost' } else { $HostName }
Write-Host 'JellyTube is running.'
Write-Host "URL: http://${displayHost}:$Port"
Write-Host "PID: $($serverProcess.Id)"
Write-Host "Log: $LogFile"
if ($errorLogFile) {
  Write-Host "Error log: $errorLogFile"
}
Write-Host 'Stop: powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\stop.ps1'
