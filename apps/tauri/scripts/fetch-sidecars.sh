#!/usr/bin/env bash
#
# Fetch / build the offline STT sidecars (whisper.cpp, moss-transcribe.cpp,
# FFmpeg/ffprobe) and place them under
# apps/tauri/src-tauri/resources/sidecars so `tauri build` can bundle them.
#
# This runs in CI before `tauri build`. Locally you can run it once to obtain
# the binaries for development. The MOSS commit and FFmpeg artifact URLs are
# pinned; bump them deliberately when upgrading.
set -euo pipefail

# Pinned upstream revisions (override via env if needed).
MOSS_COMMIT="${MOSS_COMMIT:-master}"
WHISPER_REF="${WHISPER_REF:-master}"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
SIDECARS="$ROOT/apps/tauri/src-tauri/resources/sidecars"
mkdir -p "$SIDECARS"

OS="$(uname -s)"
IS_WINDOWS=0
if [[ "$OS" == MINGW* || "$OS" == MSYS* || "$OS" == CYGWIN* ]]; then
  IS_WINDOWS=1
fi

echo "==> Building STT sidecars for $OS into $SIDECARS"

build_whisper() {
  local src
  src="$(mktemp -d)"
  # --recursive: whisper.cpp vendors ggml as a git submodule (third_party/ggml);
  # a shallow clone alone leaves it empty and cmake's add_subdirectory fails.
  git clone --depth 1 --branch "$WHISPER_REF" --recursive https://github.com/ggerganov/whisper.cpp "$src"
  local metal_opt
  if [[ "$IS_WINDOWS" -eq 1 ]]; then
    metal_opt="-DWHISPER_METAL=0"
  else
    metal_opt="-DWHISPER_METAL=on"
  fi
  cmake -S "$src" -B "$src/build" -DCMAKE_BUILD_TYPE=Release \
    -DWHISPER_COREML=0 $metal_opt
  cmake --build "$src/build" --config Release -j"$(nproc 2>/dev/null || sysctl -n hw.ncpu)"
  local bin
  bin="$(find "$src/build" -type f \( -name 'whisper-cli' -o -name 'whisper-cli.exe' \) | head -n1)"
  local name
  name="$(basename "$bin")"
  local target="$SIDECARS/whisper"
  [[ "$name" == *.exe ]] && target="$SIDECARS/whisper.exe"
  cp "$bin" "$target"
  rm -rf "$src"
  echo "    whisper -> $(basename "$target")"
}

build_moss() {
  local src
  src="$(mktemp -d)"
  # --recursive: moss-transcribe.cpp vendors ggml as a git submodule too.
  git clone --depth 1 --branch "$MOSS_COMMIT" --recursive https://github.com/localai-org/moss-transcribe.cpp "$src"
  local metal_opt
  if [[ "$IS_WINDOWS" -eq 1 ]]; then
    metal_opt="-DGGML_METAL=0"
  else
    metal_opt="-DGGML_METAL=on"
  fi
  cmake -S "$src" -B "$src/build" -DCMAKE_BUILD_TYPE=Release $metal_opt
  cmake --build "$src/build" --config Release -j"$(nproc 2>/dev/null || sysctl -n hw.ncpu)"
  local bin
  # The CLI target is `moss-transcribe-cli` but its OUTPUT_NAME is
  # `moss-transcribe` (resp. `.exe` on Windows) — that's the file cmake emits.
  bin="$(find "$src/build" -type f \( -name 'moss-transcribe' -o -name 'moss-transcribe.exe' \) | head -n1)"
  local name
  name="$(basename "$bin")"
  local target="$SIDECARS/moss-transcribe"
  [[ "$name" == *.exe ]] && target="$SIDECARS/moss-transcribe.exe"
  cp "$bin" "$target"
  rm -rf "$src"
  echo "    moss-transcribe -> $(basename "$target")"
}

fetch_ffmpeg() {
  if [[ "$IS_WINDOWS" -eq 1 ]]; then
    # BtbN LGPL shared build (CPU).
    local zip
    zip="$(mktemp)"
    curl -fL "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-lgpl-shared.zip" -o "$zip"
    local tmp
    tmp="$(mktemp -d)"
    (cd "$tmp" && unzip -o "$zip" >/dev/null)
    cp "$tmp"/ffmpeg-master-latest-win64-lgpl-shared/bin/ffmpeg.exe "$SIDECARS/"
    cp "$tmp"/ffmpeg-master-latest-win64-lgpl-shared/bin/ffprobe.exe "$SIDECARS/"
    rm -rf "$tmp" "$zip"
  else
    # ffbinaries LGPL static build (x64 macOS; runs via Rosetta on Apple Silicon).
    # johnvansickle's old /releases/ffmpeg-release-x64-static.tar.xz now 404s, and
    # evermeet moved to a .7z on a different host. ffbinaries is GitHub-hosted and
    # reliably ships both ffmpeg and ffprobe for macOS.
    local fz pz tmp
    fz="$(mktemp)"; pz="$(mktemp)"
    curl -fL "https://github.com/ffbinaries/ffbinaries-prebuilt/releases/download/v6.1/ffmpeg-6.1-macos-64.zip" -o "$fz"
    curl -fL "https://github.com/ffbinaries/ffbinaries-prebuilt/releases/download/v6.1/ffprobe-6.1-macos-64.zip" -o "$pz"
    tmp="$(mktemp -d)"
    (cd "$tmp" && unzip -o "$fz" >/dev/null && unzip -o "$pz" >/dev/null)
    cp "$(find "$tmp" -type f -name ffmpeg | head -n1)" "$SIDECARS/"
    cp "$(find "$tmp" -type f -name ffprobe | head -n1)" "$SIDECARS/"
    rm -rf "$tmp" "$fz" "$pz"
  fi
  echo "    ffmpeg / ffprobe fetched"
}

build_whisper
build_moss
fetch_ffmpeg

# tauri.conf.json's `resources` map references BOTH the extensionless name
# (used on macOS/Linux) and the `.exe` name (used on Windows) for every
# sidecar. Tauri validates all listed source files at build time on every
# platform, so each platform must ship both variants even though the app only
# ever invokes the one matching its own OS. Create the missing counterpart.
for b in whisper moss-transcribe ffmpeg ffprobe; do
  if [[ -f "$SIDECARS/$b" && ! -f "$SIDECARS/$b.exe" ]]; then
    cp "$SIDECARS/$b" "$SIDECARS/$b.exe"
  fi
  if [[ -f "$SIDECARS/$b.exe" && ! -f "$SIDECARS/$b" ]]; then
    cp "$SIDECARS/$b.exe" "$SIDECARS/$b"
  fi
done

# Ensure every bundled sidecar is executable.
chmod +x "$SIDECARS"/* 2>/dev/null || true

echo "==> Sidecars ready in $SIDECARS"
ls -la "$SIDECARS"
