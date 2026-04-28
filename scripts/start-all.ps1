param(
  [int]$CoyotePort = 8787,
  [int]$DglabPort = 9999,
  [string]$CoyoteConfig = "config.local.yaml",
  [switch]$NoBrowser,
  [switch]$Build,
  [switch]$KeepBuildArtifacts
)

$ErrorActionPreference = "Stop"

$root = Resolve-Path (Join-Path $PSScriptRoot "..")
$bridgeDir = Join-Path $root "coyote-codex-bridge"
$dglabDir = Join-Path $root "DG-LAB-OPENSOURCE\socket\v2\backend"
$logDir = Join-Path $root ".test-logs"
$runtimeDir = Join-Path $root ".runtime"

New-Item -ItemType Directory -Force -Path $logDir, $runtimeDir | Out-Null

$managedProcesses = New-Object System.Collections.Generic.List[System.Diagnostics.Process]
$cleanupPaths = New-Object System.Collections.Generic.List[string]
$cleanupScriptPath = Join-Path $runtimeDir "cleanup-$PID.ps1"

function Add-ManagedProcess {
  param(
    [System.Diagnostics.Process]$Process,
    [string]$Name
  )

  Write-Host "$Name process is managed by this startup window (PID $($Process.Id))."
  $managedProcesses.Add($Process) | Out-Null
}

function Stop-PreviousProcess {
  param([string]$Name)

  $pidFile = Join-Path $runtimeDir "$Name.pid"
  if (-not (Test-Path $pidFile)) {
    return
  }

  $oldPid = Get-Content $pidFile -ErrorAction SilentlyContinue
  if ($oldPid -and (Get-Process -Id $oldPid -ErrorAction SilentlyContinue)) {
    Stop-ProcessTree -ProcessId ([int]$oldPid)
  }
  Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
}

function Test-Port {
  param([int]$Port)
  return [bool](Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
}

function Get-PortOwnerPid {
  param([int]$Port)

  $connection = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
    Select-Object -First 1
  if (-not $connection) {
    return $null
  }

  return [int]$connection.OwningProcess
}

function Get-ProcessCommandLine {
  param([int]$ProcessId)

  $process = Get-CimInstance Win32_Process -Filter "ProcessId = $ProcessId" -ErrorAction SilentlyContinue
  if (-not $process) {
    return ""
  }

  return [string]$process.CommandLine
}

function Test-CoyoteCoderProcess {
  param([int]$ProcessId)

  $commandLine = Get-ProcessCommandLine -ProcessId $ProcessId
  return ($commandLine -like "*coyote-codex-bridge*" -and
    ($commandLine -like "*src/index.ts*" -or $commandLine -like "*dist/src/index.js*"))
}

function Test-CoyoteCoderPort {
  param(
    [int]$Port,
    [int]$OwnerPid
  )

  try {
    $health = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/health" -TimeoutSec 2 -ErrorAction Stop
    if ($health.service -eq "coyote-codex-bridge") {
      return $true
    }
  } catch {
  }

  return (Test-CoyoteCoderProcess -ProcessId $OwnerPid)
}

function Stop-ProcessTree {
  param([int]$ProcessId)

  $children = Get-CimInstance Win32_Process -Filter "ParentProcessId = $ProcessId" -ErrorAction SilentlyContinue
  foreach ($child in $children) {
    Stop-ProcessTree -ProcessId ([int]$child.ProcessId)
  }

  if (Get-Process -Id $ProcessId -ErrorAction SilentlyContinue) {
    Stop-Process -Id $ProcessId -Force -ErrorAction SilentlyContinue
  }
}

function Wait-PortFree {
  param(
    [int]$Port,
    [int]$TimeoutSeconds = 8
  )

  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    if (-not (Test-Port $Port)) {
      return
    }
    Start-Sleep -Milliseconds 250
  }

  throw "Port $Port is still in use after waiting $TimeoutSeconds seconds."
}

function Resolve-CoyotePort {
  param([int]$PreferredPort)

  $ownerPid = Get-PortOwnerPid -Port $PreferredPort
  if (-not $ownerPid) {
    return $PreferredPort
  }

  if (Test-CoyoteCoderPort -Port $PreferredPort -OwnerPid $ownerPid) {
    Write-Host "CoyoteCoder port $PreferredPort is already used by a previous CoyoteCoder process (PID $ownerPid); stopping it..."
    Stop-ProcessTree -ProcessId $ownerPid
    Wait-PortFree -Port $PreferredPort
    return $PreferredPort
  }

  Write-Host "CoyoteCoder port $PreferredPort is already in use by another process (PID $ownerPid); searching for the next free port..."
  $port = $PreferredPort + 1
  while ($port -le 65535) {
    if (-not (Test-Port $port)) {
      Write-Host "Using CoyoteCoder port $port instead of $PreferredPort."
      return $port
    }
    $port += 1
  }

  throw "No free CoyoteCoder port found after $PreferredPort."
}

function Resolve-FullPath {
  param([string]$Path)

  $item = Get-Item -LiteralPath $Path -ErrorAction SilentlyContinue
  if ($item) {
    return $item.FullName
  }

  return [System.IO.Path]::GetFullPath($Path)
}

function Test-PathInside {
  param(
    [string]$Path,
    [string]$Parent
  )

  $fullPath = Resolve-FullPath -Path $Path
  $fullParent = (Resolve-FullPath -Path $Parent).TrimEnd([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar)
  return $fullPath.StartsWith($fullParent + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)
}

function Remove-BuildArtifacts {
  foreach ($path in $cleanupPaths) {
    if ((Test-Path -LiteralPath $path) -and (Test-PathInside -Path $path -Parent $bridgeDir)) {
      Write-Host "Cleaning build artifact: $path"
      Remove-Item -LiteralPath $path -Recurse -Force -ErrorAction SilentlyContinue
    }
  }
}

function Start-CleanupWatchdog {
  $managedProcessIds = @($managedProcesses | ForEach-Object { [int]$_.Id })
  $cleanupPathValues = @()
  if ($Build -and -not $KeepBuildArtifacts) {
    $cleanupPathValues = @($cleanupPaths | ForEach-Object { [string]$_ })
  }

  $payload = @{
    ParentPid = [int]$PID
    ManagedPids = $managedProcessIds
    CleanupPaths = $cleanupPathValues
    BridgeDir = [string](Resolve-FullPath -Path $bridgeDir)
    RuntimeDir = [string](Resolve-FullPath -Path $runtimeDir)
    RuntimeScript = [string]$cleanupScriptPath
  }

  $payloadJson = $payload | ConvertTo-Json -Depth 4 -Compress
  $escapedPayloadJson = $payloadJson -replace "'", "''"

  Set-Content -Path $cleanupScriptPath -Encoding UTF8 -Value @"
`$ErrorActionPreference = "SilentlyContinue"
`$payload = '$escapedPayloadJson' | ConvertFrom-Json

function Stop-Tree {
  param([int]`$ProcessId)

  `$children = Get-CimInstance Win32_Process -Filter "ParentProcessId = `$ProcessId"
  foreach (`$child in `$children) {
    Stop-Tree -ProcessId ([int]`$child.ProcessId)
  }

  Stop-Process -Id `$ProcessId -Force
}

function Resolve-FullPath {
  param([string]`$Path)

  `$item = Get-Item -LiteralPath `$Path
  if (`$item) {
    return `$item.FullName
  }

  return [System.IO.Path]::GetFullPath(`$Path)
}

function Test-PathInside {
  param(
    [string]`$Path,
    [string]`$Parent
  )

  `$fullPath = Resolve-FullPath -Path `$Path
  `$fullParent = (Resolve-FullPath -Path `$Parent).TrimEnd([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar)
  return `$fullPath.StartsWith(`$fullParent + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)
}

Wait-Process -Id ([int]`$payload.ParentPid)

foreach (`$managedPid in `$payload.ManagedPids) {
  Stop-Tree -ProcessId ([int]`$managedPid)
}

foreach (`$path in `$payload.CleanupPaths) {
  if ((Test-Path -LiteralPath `$path) -and (Test-PathInside -Path `$path -Parent `$payload.BridgeDir)) {
    Remove-Item -LiteralPath `$path -Recurse -Force
  }
}

Get-ChildItem -LiteralPath `$payload.RuntimeDir -Filter "*.pid" | Remove-Item -Force
Remove-Item -LiteralPath `$payload.RuntimeScript -Force
"@

  Start-Process `
    -FilePath (Join-Path $PSHOME "powershell.exe") `
    -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File `"$cleanupScriptPath`"" `
    -RedirectStandardOutput (Join-Path $logDir "cleanup-$PID.out.log") `
    -RedirectStandardError (Join-Path $logDir "cleanup-$PID.err.log") `
    -WindowStyle Hidden | Out-Null
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

  Add-ManagedProcess -Process $process -Name $Name
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

$cleanupPaths.Add((Join-Path $bridgeDir "dist")) | Out-Null
$cleanupPaths.Add((Join-Path $bridgeDir "src-ui\dist")) | Out-Null

if ($Build) {
  Write-Host "Building CoyoteCoder UI/API..."
  Remove-BuildArtifacts
  Push-Location $bridgeDir
  try {
    & npm.cmd run build
  } finally {
    Pop-Location
  }
}

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

$CoyotePort = Resolve-CoyotePort -PreferredPort $CoyotePort

Write-Host "Starting CoyoteCoder UI/API..."
Start-NpmProcess `
  -Name "coyote" `
  -WorkingDirectory $bridgeDir `
  -Arguments $(if ($Build) { @("start") } else { @("run", "dev") }) `
  -Environment @{
    COYOTE_CONFIG = $CoyoteConfig
    PORT = [string]$CoyotePort
  } | Out-Null

Start-CleanupWatchdog

Wait-Port -Port $CoyotePort -Name "CoyoteCoder"

$url = "http://127.0.0.1:$CoyotePort/ui"
Write-Host ""
Write-Host "CoyoteCoder is ready: $url"
Write-Host "Logs:"
Write-Host "  $logDir\dglab-backend.out.log"
Write-Host "  $logDir\coyote.out.log"
Write-Host ""
Write-Host "Keep this window open while validating. Press Ctrl+C or close this window to stop managed processes."
if ($Build -and -not $KeepBuildArtifacts) {
  Write-Host "Build artifacts will be cleaned on exit."
}

if (-not $NoBrowser) {
  Start-Process $url
}

try {
  while ($true) {
    $running = @($managedProcesses | Where-Object { -not $_.HasExited })
    if ($running.Count -eq 0) {
      throw "All managed CoyoteCoder processes exited."
    }
    Start-Sleep -Seconds 1
  }
} finally {
  Write-Host ""
  Write-Host "Stopping managed CoyoteCoder processes..."
  foreach ($process in $managedProcesses) {
    Stop-ProcessTree -ProcessId ([int]$process.Id)
  }
  Remove-Item (Join-Path $runtimeDir "*.pid") -Force -ErrorAction SilentlyContinue
  if ($Build -and -not $KeepBuildArtifacts) {
    Remove-BuildArtifacts
  }
}
