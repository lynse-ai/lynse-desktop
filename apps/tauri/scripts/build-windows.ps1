#Requires -Version 5.1
<#
  One-shot Windows packaging helper for the Lynse Tauri desktop app.

  What it does (idempotent - safe to re-run):
    1. Self-elevates to Administrator (needed to install VS Build Tools).
    2. Installs the Rust toolchain (stable, x86_64-pc-windows-msvc) via rustup,
       using the rsproxy.cn mirror because registry.npmjs.org / static.rust-lang.org
       can be slow or blocked on this network.
    3. Writes a cargo config that redirects crates.io to the rsproxy mirror.
    4. Installs Visual Studio 2022 Build Tools with the C++ (VCTools) workload,
       which provides the MSVC linker (link.exe) Tauri needs.
    5. Points pnpm at the npmmirror registry and installs workspace deps with
       --force so the win32-x64-msvc native bindings (rolldown, tailwind oxide,
       lightningcss, tauri cli) are fetched.
    6. Builds the NSIS installer.

  Output: apps\tauri\src-tauri\target\release\bundle\nsis\Lynse_*-setup.exe

  NOTE: native macOS-only features (MLX/Qwen3 ASR, audio-capture sidecar,
  sherpa voiceprint, moss_mlx) are not available on Windows; build-audio-capture.sh
  already writes a placeholder there. The resulting app is a functional shell
  without those native transcription engines.
#>

$ErrorActionPreference = 'Stop'

# --- 1. Self-elevate to Administrator ---------------------------------------
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Write-Host 'Requesting administrator privileges (needed for VS Build Tools)...' -ForegroundColor Yellow
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = 'powershell.exe'
  $psi.Arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`""
  $psi.UseShellExecute = $true
  $psi.Verb = 'runas'
  [System.Diagnostics.Process]::Start($psi) | Out-Null
  exit
}

# Resolve repo root (script lives in apps/tauri/scripts)
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
$TauriDir = Join-Path $RepoRoot 'apps\tauri'
Write-Host "Repo root: $RepoRoot" -ForegroundColor Cyan

# --- 2. Install Rust via rustup (rsproxy mirror) ----------------------------
$env:RUSTUP_DIST_SERVER = 'https://rsproxy.cn'
$env:RUSTUP_UPDATE_ROOT = 'https://rsproxy.cn/rustup'
$CargoBin = Join-Path $env:USERPROFILE '.cargo\bin'

if (-not (Get-Command cargo -ErrorAction SilentlyContinue)) {
  Write-Host 'Installing Rust (stable, msvc host) via rustup...' -ForegroundColor Yellow
  $rustupInit = Join-Path $env:TEMP 'rustup-init.exe'
  # rsproxy mirrors rustup-init as well; fall back to the official host.
  $urls = @(
    'https://rsproxy.cn/rustup-init.exe',
    'https://static.rust-lang.org/rustup/dist/x86_64-pc-windows-msvc/rustup-init.exe'
  )
  $ok = $false
  foreach ($u in $urls) {
    try {
      Invoke-WebRequest -Uri $u -OutFile $rustupInit -UseBasicParsing
      $ok = $true; Write-Host "  downloaded rustup-init from $u"; break
    } catch { Write-Host "  failed $u : $_" -ForegroundColor DarkGray }
  }
  if (-not $ok) { throw 'Could not download rustup-init.exe from any mirror.' }
  & $rustupInit -y --default-host x86_64-pc-windows-msvc --default-toolchain stable --profile default
  $env:Path = "$CargoBin;$env:Path"
} else {
  Write-Host 'Rust already installed.' -ForegroundColor Green
}
& cargo --version
& rustc --version

# --- 3. Cargo crates mirror (rsproxy) ---------------------------------------
$cargoConfigDir = Join-Path $env:USERPROFILE '.cargo'
New-Item -ItemType Directory -Force -Path $cargoConfigDir | Out-Null
$cargoConfig = Join-Path $cargoConfigDir 'config.toml'
if (-not (Test-Path $cargoConfig)) {
  Write-Host 'Writing cargo mirror config...' -ForegroundColor Yellow
  @'
[source.crates-io]
replace-with = 'rsproxy-sparse'

[source.rsproxy]
registry = "https://rsproxy.cn/crates.io-index"

[source.rsproxy-sparse]
registry = "sparse+https://rsproxy.cn/index/"

[registries.rsproxy]
index = "https://rsproxy.cn/crates.io-index"

[net]
git-fetch-with-cli = true
'@ | Set-Content -Path $cargoConfig -Encoding UTF8
}

# --- 4. Install VS Build Tools + C++ workload -------------------------------
$vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
$hasCl = $false
if (Test-Path $vswhere) {
  $installPath = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath 2>$null
  if ($installPath) { $hasCl = $true }
}
if (-not $hasCl) {
  Write-Host 'Installing Visual Studio 2022 Build Tools (C++ workload). This is a multi-GB download...' -ForegroundColor Yellow
  winget install --id Microsoft.VisualStudio.2022.BuildTools -e `
    --accept-source-agreements --accept-package-agreements `
    --override "--quiet --wait --norestart --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
} else {
  Write-Host 'VS Build Tools C++ workload already present.' -ForegroundColor Green
}

# --- 5. pnpm mirror + deps ---------------------------------------------------
Write-Host 'Configuring pnpm registry mirror...' -ForegroundColor Yellow
& pnpm config set registry https://registry.npmmirror.com
Write-Host 'Installing workspace deps (--force to fetch win32 native bindings)...' -ForegroundColor Yellow
Push-Location $RepoRoot
& pnpm install --force
if ($LASTEXITCODE -ne 0) { Pop-Location; throw "pnpm install failed ($LASTEXITCODE)" }

# --- 6. Build NSIS installer -------------------------------------------------
Write-Host 'Building Windows NSIS installer...' -ForegroundColor Yellow
& pnpm --filter '@lynse/tauri' exec tauri build --bundles nsis
$buildExit = $LASTEXITCODE
Pop-Location

if ($buildExit -ne 0) { throw "tauri build failed ($buildExit)" }

$nsisDir = Join-Path $TauriDir 'src-tauri\target\release\bundle\nsis'
Write-Host '' 
Write-Host 'Build complete. Installer(s):' -ForegroundColor Green
Get-ChildItem -Path $nsisDir -Filter '*.exe' | ForEach-Object { Write-Host "  $($_.FullName)" -ForegroundColor Green }
