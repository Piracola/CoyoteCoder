param(
  [int]$CoyotePort = 8787,
  [int]$DglabPort = 9999,
  [string]$CoyoteConfig = "config.local.yaml",
  [switch]$NoBrowser
)

$ErrorActionPreference = "Stop"

$root = Resolve-Path (Join-Path $PSScriptRoot "..")
$bridgeDir = Join-Path $root "coyote-codex-bridge"
$dglabDir = Join-Path $root "DG-LAB-OPENSOURCE\socket\v2\backend"
$logDir = Join-Path $root ".test-logs"
$runtimeDir = Join-Path $root ".runtime"

New-Item -ItemType Directory -Force -Path $logDir, $runtimeDir | Out-Null

function Stop-PreviousProcess {
  param([string]$Name)

  $pidFile = Join-Path $runtimeDir "$Name.pid"
  if (-not (Test-Path $pidFile)) {
    return
  }

  $oldPid = Get-Content $pidFile -ErrorAction SilentlyContinue
  if ($oldPid -and (Get-Process -Id $oldPid -ErrorAction SilentlyContinue)) {
    Stop-Process -Id $oldPid -Force
  }
  Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
}

function Test-Port {
  param([int]$Port)
  return [bool](Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
}

function Start-NpmProcess {
  param(
    [string]$Name,
    [string]$WorkingDirectory,
    [string[]]$Arguments,
    [hashtable]$Environment = @{}
  )

  $outFile = Join-Path $logDir "$Name.out.log"
  $errFile = Join-Path $logDir "$Name.err.log"
  $envPrefix = ""

  foreach ($item in $Environment.GetEnumerator()) {
    $escaped = [string]$item.Value -replace "'", "''"
    $envPrefix += "Set-Item -Path Env:$($item.Key) -Value '$escaped'; "
  }

  $argumentText = ($Arguments | ForEach-Object { "'$($_ -replace "'", "''")'" }) -join " "
  $command = "${envPrefix}& npm.cmd $argumentText"

  $process = Start-Process `
    -FilePath "powershell.exe" `
    -ArgumentList @("-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", $command) `
    -WorkingDirectory $WorkingDirectory `
    -RedirectStandardOutput $outFile `
    -RedirectStandardError $errFile `
    -WindowStyle Hidden `
    -PassThru

  Set-Content -Path (Join-Path $runtimeDir "$Name.pid") -Value $process.Id
  return $process
}

function Wait-Port {
  param(
    [int]$Port,
    [string]$Name,
    [int]$TimeoutSeconds = 20
  )

  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    if (Test-Port $Port) {
      Write-Host "$Name is listening on port $Port"
      return
    }
    Start-Sleep -Milliseconds 400
  }
  throw "$Name did not start on port $Port within $TimeoutSeconds seconds."
}

Stop-PreviousProcess "dglab-backend"
Stop-PreviousProcess "coyote"

if (Test-Port $DglabPort) {
  Write-Host "DG-LAB Socket backend port $DglabPort is already in use; leaving it running."
} else {
  Write-Host "Starting DG-LAB Socket backend..."
  Start-NpmProcess `
    -Name "dglab-backend" `
    -WorkingDirectory $dglabDir `
    -Arguments @("run", "start") `
    -Environment @{ PORT = [string]$DglabPort } | Out-Null
  Wait-Port -Port $DglabPort -Name "DG-LAB Socket backend"
}

if (Test-Port $CoyotePort) {
  throw "CoyoteCoder port $CoyotePort is already in use. Close the old server or rerun with -CoyotePort <port>."
}

Write-Host "Starting CoyoteCoder UI/API..."
Start-NpmProcess `
  -Name "coyote" `
  -WorkingDirectory $bridgeDir `
  -Arguments @("run", "dev") `
  -Environment @{
    COYOTE_CONFIG = $CoyoteConfig
    PORT = [string]$CoyotePort
  } | Out-Null

Wait-Port -Port $CoyotePort -Name "CoyoteCoder"

$url = "http://127.0.0.1:$CoyotePort/ui"
Write-Host ""
Write-Host "CoyoteCoder is ready: $url"
Write-Host "Logs:"
Write-Host "  $logDir\dglab-backend.out.log"
Write-Host "  $logDir\coyote.out.log"

if (-not $NoBrowser) {
  Start-Process $url
}
