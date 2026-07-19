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

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
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
  git clone --depth 1 --branch "$WHISPER_REF" https://github.com/ggerganov/whisper.cpp "$src"
  cmake -S "$src" -B "$src/build" -DCMAKE_BUILD_TYPE=Release \
    -DWHISPER_COREML=0 ${IS_WINDOWS:+-DWHISPER_METAL=0} ${IS_WINDOWS:- -DWHISPER_METAL=on}
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
  git clone --depth 1 --branch "$MOSS_COMMIT" https://github.com/localai-org/moss-transcribe.cpp "$src"
  cmake -S "$src" -B "$src/build" -DCMAKE_BUILD_TYPE=Release \
    ${IS_WINDOWS:+-DGGML_METAL=0} ${IS_WINDOWS:- -DGGML_METAL=on}
  cmake --build "$src/build" --config Release -j"$(nproc 2>/dev/null || sysctl -n hw.ncpu)"
  local bin
  bin="$(find "$src/build" -type f \( -name 'moss-transcribe' -o -name 'moss-transcribe.exe' \) | head -n1)"
  cp "$bin" "$SIDECARS/"
  rm -rf "$src"
  echo "    moss-transcribe -> $(basename "$bin")"
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
    # johnvansickle LGPL static build (x64 macOS).
    local tar
    tar="$(mktemp)"
    curl -fL "https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-x64-static.tar.xz" -o "$tar"
    local tmp
    tmp="$(mktemp -d)"
    (cd "$tmp" && tar xf "$tar")
    cp "$tmp"/ffmpeg-*/ffmpeg "$SIDECARS/"
    cp "$tmp"/ffmpeg-*/ffprobe "$SIDECARS/"
    rm -rf "$tmp" "$tar"
  fi
  echo "    ffmpeg / ffprobe fetched"
}

build_whisper
build_moss
fetch_ffmpeg

echo "==> Sidecars ready in $SIDECARS"
ls -la "$SIDECARS"
