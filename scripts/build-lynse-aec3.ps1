# Build the shared WebRTC AEC3 static library (lynse_webrtc_aec) for Windows.
#
# Produces the artifacts the `aec3` cargo feature links against:
#   apps/tauri/src-tauri/aec3/lib/lynse_webrtc_aec.lib   (static lib, x64)
#
# The WebRTC version is FIXED by the product spec (one shared APM build for
# every platform, same AEC behaviour on macOS and Windows); bumping it is a
# deliberate, tested change — update $WebRtcVersion and re-run the dual-track
# device acceptance suite before shipping.
#
# Usage (Windows CI or a dev box):
#   powershell -ExecutionPolicy Bypass -File scripts/build-lynse-aec3.ps1
# Requirements: Visual Studio 2022 (C++ workload), CMake >= 3.24, Ninja or
# MSBuild, internet access for the pinned source tarball.

$ErrorActionPreference = "Stop"

$WebRtcVersion = "v1.3"   # pulseaudio webrtc-audio-processing release (AEC3)
$WebRtcUrl = "https://gitlab.freedesktop.org/pulseaudio/webrtc-audio-processing/-/archive/$WebRtcVersion/webrtc-audio-processing-$WebRtcVersion.tar.gz"

$RepoRoot = Split-Path -Parent $PSScriptRoot
$Aec3Dir = Join-Path $RepoRoot "apps/tauri/src-tauri/aec3"
$LibOutDir = Join-Path $Aec3Dir "lib"
$WorkDir = Join-Path $env:TEMP "lynse-webrtc-aec-build"

New-Item -ItemType Directory -Force -Path $WorkDir, $LibOutDir | Out-Null

$Tarball = Join-Path $WorkDir "webrtc-audio-processing-$WebRtcVersion.tar.gz"
$SrcDir = Join-Path $WorkDir "webrtc-audio-processing-$WebRtcVersion"
if (-not (Test-Path $SrcDir)) {
    Write-Host "Downloading webrtc-audio-processing $WebRtcVersion ..."
    Invoke-WebRequest -Uri $WebRtcUrl -OutFile $Tarball
    tar -xzf $Tarball -C $WorkDir
}

# 1. Build the WebRTC APM static library (CMake, x64 Release).
$BuildDir = Join-Path $SrcDir "build-win64"
New-Item -ItemType Directory -Force -Path $BuildDir | Out-Null
Push-Location $BuildDir
try {
    cmake .. -G "Visual Studio 17 2022" -A x64 `
        -DCMAKE_BUILD_TYPE=Release `
        -DENABLE_TESTS=OFF -DENABLE_EXAMPLES=OFF `
        -DCMAKE_CXX_FLAGS="/DWEBRTC_WIN /EHsc"
    if ($LASTEXITCODE -ne 0) { throw "cmake configure failed" }
    cmake --build . --config Release --target webrtc-audio-processing
    if ($LASTEXITCODE -ne 0) { throw "cmake build failed" }
} finally {
    Pop-Location
}

# 2. Compile the Lynse C ABI shim on top of the WebRTC APM and merge into one
#    static library the Rust linker can consume. The shim source is SHARED
#    with the macOS sidecar (audio-capture/dsp/) — one implementation of the
#    frozen lynse_aec.h ABI on every platform.
$WebrtcLib = Get-ChildItem -Recurse -Filter "webrtc-audio-processing.lib" $BuildDir | Select-Object -First 1
if (-not $WebrtcLib) { throw "webrtc-audio-processing.lib not found" }
$DspDir = Join-Path $RepoRoot "apps/tauri/audio-capture/dsp"
$ShimSource = Join-Path $DspDir "lynse_aec.cc"
if (-not (Test-Path $ShimSource)) { throw "shared AEC shim not found: $ShimSource" }
$ShimObj = Join-Path $WorkDir "lynse_aec.obj"
$IncludeArgs = @(
    "/I", (Join-Path $SrcDir),
    "/I", (Join-Path $SrcDir "src"),
    "/I", $DspDir,
    "/DWEBRTC_WIN", "/EHsc", "/O2", "/c"
)
& cl.exe @IncludeArgs "/Fo:$ShimObj" $ShimSource
if ($LASTEXITCODE -ne 0) { throw "lynse_aec.cc compile failed" }

$MergedLib = Join-Path $LibOutDir "lynse_webrtc_aec.lib"
& lib.exe "/OUT:$MergedLib" $WebrtcLib.FullName $ShimObj
if ($LASTEXITCODE -ne 0) { throw "lib.exe merge failed" }

Write-Host "OK: $MergedLib"
Write-Host "Enable with: cargo build --features aec3 (release.yml sets this once device acceptance passes)"
