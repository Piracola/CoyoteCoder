param(
  [string]$Version = "",
  [switch]$SkipInstall,
  [switch]$SkipTests,
  [switch]$NoClean
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$AppRoot = Join-Path $RepoRoot "app"
$OutputRoot = Join-Path $RepoRoot "dist"
$PortableRoot = Join-Path $OutputRoot "portable"
$PortableDir = Join-Path $PortableRoot "CoyoteCoder"
$BackendExePath = Join-Path $OutputRoot "coyote-backend.exe"

function Write-Step {
  param([string]$Message)
  Write-Host ""
  Write-Host "==> $Message" -ForegroundColor Cyan
}

function Run {
  param(
    [string]$Command,
    [string[]]$Arguments,
    [string]$WorkingDirectory = $AppRoot
  )

  & $Command @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "Command failed: $Command $($Arguments -join ' ')"
  }
}

function Normalize-Version {
  param([string]$InputVersion)

  $value = $InputVersion.Trim()
  if ($value.StartsWith("v")) {
    $value = $value.Substring(1)
  }
  if ($value -notmatch '^\d+\.\d+\.\d+([\-+][0-9A-Za-z.-]+)?$') {
    throw "Version must look like 0.1.0, 0.1.0-beta.1, or v0.1.0."
  }
  return $value
}

function Require-Command {
  param(
    [string]$Name,
    [string]$InstallHint
  )

  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    throw "Missing $Name. $InstallHint"
  }
}

function Find-VsBuildToolsPath {
  $vswhereCandidates = @(
    (Join-Path ${env:ProgramFiles(x86)} "Microsoft Visual Studio\Installer\vswhere.exe"),
    (Join-Path $env:ProgramFiles "Microsoft Visual Studio\Installer\vswhere.exe")
  )

  foreach ($candidate in $vswhereCandidates) {
    if (Test-Path -LiteralPath $candidate) {
      $installationPath = & $candidate -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
      if ($LASTEXITCODE -eq 0 -and $installationPath) {
        return [string]$installationPath
      }
    }
  }

  $fallbacks = @(
    "Y:\Tools\VSBuildTools",
    "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools",
    "C:\Program Files\Microsoft Visual Studio\2022\Community",
    "C:\Program Files\Microsoft Visual Studio\2022\Professional",
    "C:\Program Files\Microsoft Visual Studio\2022\Enterprise"
  )

  foreach ($fallback in $fallbacks) {
    if (Test-Path -LiteralPath (Join-Path $fallback "VC\Auxiliary\Build\vcvarsall.bat")) {
      return $fallback
    }
  }

  return $null
}

function Import-VsBuildToolsEnvironment {
  if (Get-Command "link.exe" -ErrorAction SilentlyContinue) {
    return
  }

  $vsPath = Find-VsBuildToolsPath
  if (-not $vsPath) {
    return
  }

  $vcvars = Join-Path $vsPath "VC\Auxiliary\Build\vcvarsall.bat"
  if (-not (Test-Path -LiteralPath $vcvars)) {
    return
  }

  Write-Step "Load Visual Studio C++ build environment"
  $envOutput = & cmd.exe /s /c "set VCToolsVersion=& set VCToolsInstallDir=& call `"$vcvars`" x64 >nul && set"
  if ($LASTEXITCODE -ne 0) {
    throw "Failed to load Visual Studio Build Tools environment from $vcvars."
  }

  foreach ($line in $envOutput) {
    $separator = $line.IndexOf("=")
    if ($separator -le 0) {
      continue
    }

    $name = $line.Substring(0, $separator)
    $value = $line.Substring($separator + 1)
    Set-Item -LiteralPath "env:$name" -Value $value
  }
}

Push-Location $AppRoot
try {
  New-Item -ItemType Directory -Force -Path $OutputRoot | Out-Null

  Require-Command "node" "Install Node.js 20+."
  Require-Command "npm" "Install Node.js 20+."
  Require-Command "cargo" "Install Rust stable toolchain."
  Import-VsBuildToolsEnvironment
  Require-Command "link.exe" "Install Visual Studio Build Tools with the C++ desktop workload."

  $packageJson = Get-Content "package.json" -Raw | ConvertFrom-Json
  $buildVersion = if ($Version.Trim()) { Normalize-Version $Version } else { [string]$packageJson.version }
  $zipName = "CoyoteCoder-$buildVersion-windows-portable.zip"
  $zipPath = Join-Path $OutputRoot $zipName

  if ($Version.Trim()) {
    Write-Step "Apply build version $buildVersion"

    $packageJson.version = $buildVersion
    $packageJson | ConvertTo-Json -Depth 100 | Set-Content "package.json" -Encoding utf8

    $packageLockJson = Get-Content "package-lock.json" -Raw | ConvertFrom-Json -AsHashtable
    $packageLockJson["version"] = $buildVersion
    if ($packageLockJson.ContainsKey("packages") -and $packageLockJson["packages"].ContainsKey("")) {
      $packageLockJson["packages"][""]["version"] = $buildVersion
    }
    $packageLockJson | ConvertTo-Json -Depth 100 | Set-Content "package-lock.json" -Encoding utf8

    $tauriConfig = Get-Content "src-tauri\tauri.conf.json" -Raw | ConvertFrom-Json
    $tauriConfig.version = $buildVersion
    $tauriConfig | ConvertTo-Json -Depth 100 | Set-Content "src-tauri\tauri.conf.json" -Encoding utf8

    $cargoToml = Get-Content "src-tauri\Cargo.toml" -Raw
    $cargoToml = $cargoToml -replace '(?m)^version = ".+"', "version = `"$buildVersion`""
    Set-Content "src-tauri\Cargo.toml" $cargoToml -Encoding utf8
  }

  if (-not $SkipInstall) {
    Write-Step "Install dependencies"
    Run "npm" @("ci")
  }

  if (-not $SkipTests) {
    Write-Step "Run typecheck"
    Run "npm" @("run", "typecheck")

    Write-Step "Run tests"
    Run "npm" @("test")
  }

  Write-Step "Build API and UI"
  Run "npm" @("run", "build")

  if (-not $NoClean) {
    Remove-Item -LiteralPath $BackendExePath -Force -ErrorAction SilentlyContinue
  }

  Write-Step "Build backend sidecar"
  Run "npx" @("--yes", "@yao-pkg/pkg", "dist/src/index.js", "--targets", "node20-win-x64", "--output", $BackendExePath)

  Write-Step "Build desktop app"
  Run "npm" @("run", "tauri:build")

  Write-Step "Assemble portable zip"
  if (-not $NoClean) {
    Remove-Item -LiteralPath $PortableDir -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $zipPath -Force -ErrorAction SilentlyContinue
  }

  New-Item -ItemType Directory -Force -Path $PortableDir | Out-Null
  New-Item -ItemType Directory -Force -Path (Join-Path $PortableDir "src-ui") | Out-Null
  New-Item -ItemType Directory -Force -Path (Join-Path $PortableDir "waveforms") | Out-Null

  Copy-Item ".\src-tauri\target\release\coyote-coder.exe" (Join-Path $PortableDir "CoyoteCoder.exe") -Force
  Copy-Item $BackendExePath (Join-Path $PortableDir "coyote-backend.exe") -Force
  Copy-Item ".\config.example.yaml" (Join-Path $PortableDir "config.example.yaml") -Force
  Copy-Item "..\README.md" (Join-Path $PortableDir "README.md") -Force
  Copy-Item "..\CoyoteCoder.png" (Join-Path $PortableDir "CoyoteCoder.png") -Force
  Copy-Item "..\waveforms\README.md" (Join-Path $PortableDir "waveforms\README.md") -Force
  Copy-Item "..\waveforms\example.json" (Join-Path $PortableDir "waveforms\example.json") -Force
  Copy-Item ".\src-ui\dist" (Join-Path $PortableDir "src-ui\dist") -Recurse -Force

  Compress-Archive -Path (Join-Path $PortableDir "*") -DestinationPath $zipPath -Force

  Write-Host ""
  Write-Host "Build complete: $zipPath" -ForegroundColor Green
} finally {
  Pop-Location
}
