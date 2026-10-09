#!/usr/bin/env bash
#
# Fetch / build the offline STT sidecars (whisper.cpp, VibeASR.cpp,
# FFmpeg/ffprobe) and place them under
# apps/tauri/src-tauri/resources/sidecars so `tauri build` can bundle them.
#
# This runs in CI before `tauri build`. Locally you can run it once to obtain
# the binaries for development. The VibeASR ref and FFmpeg artifact URLs are
# pinned; bump them deliberately when upgrading.
set -euo pipefail

# Pinned upstream revisions (override via env if needed). WHISPER_REF is a
# release tag, not master: the GPU backend flags below (and the loader-DLL
# layout) are only guaranteed against a fixed tree.
VIBEASR_REF="${VIBEASR_REF:-main}"
WHISPER_REF="${WHISPER_REF:-v1.9.4}"

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
  # GPU backends are a compile-time property: the shipped binary carries one
  # backend per platform and uses it with zero user configuration (whisper.cpp
  # falls back to CPU on its own when no Vulkan device is present).
  #   macOS   -> Metal; ggml embeds the metallib into the binary
  #              (GGML_METAL_EMBED_LIBRARY), so the single-file sidecar works.
  #   Windows -> Vulkan (one binary covers NVIDIA / AMD / Intel) with an AVX2
  #              portable baseline; the Vulkan loader DLL is shipped next to
  #              the binary so machines without the runtime installed still
  #              get GPU acceleration.
  # CoreML is deliberately not enabled: current whisper.cpp hard-fails model
  # load when the compiled-in CoreML encoder finds no <model>.mlmodelc asset
  # next to the weights, and we do not ship those assets (yet).
  local gpu_opts=()
  if [[ "$IS_WINDOWS" -eq 1 ]]; then
    if [[ -n "${VULKAN_SDK:-}" && -d "$VULKAN_SDK" ]] || command -v vulkaninfo >/dev/null 2>&1; then
      gpu_opts=(-DGGML_VULKAN=ON)
    else
      echo "    WARNING: VULKAN_SDK not found — building whisper.cpp CPU-only"
    fi
    # AVX2 portable baseline (implied FMA/F16C on MSVC): GGML_NATIVE=OFF keeps
    # the binary off the build machine's instruction set; AVX512 stays off so
    # older CPUs never hit an illegal-instruction crash.
    gpu_opts+=(-DGGML_NATIVE=OFF -DGGML_AVX2=ON -DGGML_AVX512=OFF)
  else
    gpu_opts=(-DGGML_METAL=ON)
  fi
  cmake -S "$src" -B "$src/build" -DCMAKE_BUILD_TYPE=Release \
    -DBUILD_SHARED_LIBS=OFF "${gpu_opts[@]}"
  cmake --build "$src/build" --config Release -j"$(nproc 2>/dev/null || sysctl -n hw.ncpu)"
  local bin
  bin="$(find "$src/build" -type f \( -name 'whisper-cli' -o -name 'whisper-cli.exe' \) | head -n1)"
  local name
  name="$(basename "$bin")"
  local target="$SIDECARS/whisper"
  [[ "$name" == *.exe ]] && target="$SIDECARS/whisper.exe"
  cp "$bin" "$target"
  if [[ "$IS_WINDOWS" -eq 1 && " ${gpu_opts[*]} " == *" -DGGML_VULKAN=ON "* && -n "${VULKAN_SDK:-}" ]]; then
    local loader
    for loader in "$VULKAN_SDK/Lib/vulkan-1.dll" "$VULKAN_SDK/Bin/vulkan-1.dll" "/c/Windows/System32/vulkan-1.dll"; do
      # The SDK's own Bin/Lib dirs ship the loader in some SDK versions only;
      # the silent installer always drops one into System32, so that is the
      # last-resort source. The runtime archive's completeness gate in
      # publish-cloudbase.sh --build fails the build when none of these existed.
      if [[ -f "$loader" ]]; then
        cp "$loader" "$SIDECARS/"
        echo "    vulkan-1.dll -> sidecars (from $loader)"
        break
      fi
    done
  fi
  rm -rf "$src"
  echo "    whisper -> $(basename "$target")"
}

build_vibeasr() {
  local src
  src="$(mktemp -d)"
  # --recursive: VibeASR.cpp vendors ggml as a git submodule (3rdparty/llama.cpp).
  git clone --depth 1 --branch "$VIBEASR_REF" --recursive https://github.com/microsoft/VibeASR.cpp "$src"
  local gen_args=()
  if [[ "$IS_WINDOWS" -eq 1 ]]; then
    # MSVC is rejected by VibeASR.cpp; the build requires MinGW (GCC/Clang).
    # Statically link the MinGW runtime (libgcc/libstdc++/winpthread) so the
    # shipped vibeasr.exe launches on machines without the MinGW bin dir on
    # PATH — the dynamically linked build was why the sidecar had to be
    # dropped from Windows runtimes ("missing MinGW runtime DLLs").
    gen_args=(-G "MinGW Makefiles" -DCMAKE_MAKE_PROGRAM=mingw32-make \
      -DCMAKE_EXE_LINKER_FLAGS="-static -static-libgcc -static-libstdc++")
    # Portable CPU baseline, mirroring the whisper build: GGML_NATIVE=OFF keeps
    # the binary off the CI runner's instruction set; AVX2 on, AVX512 off so
    # older user CPUs never hit an illegal-instruction crash.
    gen_args+=(-DGGML_NATIVE=OFF -DGGML_AVX2=ON -DGGML_AVX512=OFF)
  fi
  cmake -S "$src" -B "$src/build" -DCMAKE_BUILD_TYPE=Release \
    -DBUILD_SHARED_LIBS=OFF "${gen_args[@]+"${gen_args[@]}"}"
  cmake --build "$src/build" --config Release -j"$(nproc 2>/dev/null || sysctl -n hw.ncpu)"
  local bin
  # The adapter talks to the streaming server (src/asr_server.cpp, OUTPUT_NAME
  # asr_stream_server): it prints `---READY---`, reads one audio path per line on
  # stdin, and with `--no-token-stream` emits the transcript then `---END---`.
  # The one-shot `asr_infer` (demo/asr_infer.cpp) instead REQUIRES `--audio` and
  # has no token-stream flag at all. CMake builds both into the same tree, so a
  # single find over both name sets picks whichever one the traversal meets
  # first — which shipped an asr_infer as vibeasr.exe and failed every Windows
  # transcription with "Unknown argument: --no-token-stream". Ask for the server
  # by name; only fall back when it genuinely was not built.
  bin="$(find "$src/build" -type f \( -name 'asr_stream_server' -o -name 'asr_stream_server.exe' \) | head -n1)"
  if [[ -z "$bin" ]]; then
    echo "    WARNING: asr_stream_server missing, falling back to one-shot asr_infer" >&2
    bin="$(find "$src/build" -type f \( -name 'asr_infer' -o -name 'asr_infer.exe' \) | head -n1)"
  fi
  if [[ -z "$bin" ]]; then
    echo "ERROR: no VibeASR binary found under $src/build" >&2
    exit 1
  fi
  # A wrong-generation sidecar still launches fine and only dies at transcribe
  # time, so verify the protocol marker here — before it is packaged.
  if ! grep -aq -- '---READY---' "$bin"; then
    echo "ERROR: $bin is not the streaming server (no ---READY--- marker); the adapter cannot drive it" >&2
    exit 1
  fi
  local name
  name="$(basename "$bin")"
  local target="$SIDECARS/vibeasr"
  [[ "$name" == *.exe ]] && target="$SIDECARS/vibeasr.exe"
  cp "$bin" "$target"
  rm -rf "$src"
  echo "    vibeasr -> $(basename "$target")"
}

build_ffmpeg_source() {
  # Native Apple Silicon build, minimal LGPL config: no GPL extras (x264 etc.),
  # no network, no external libs — everything the app needs (decode to WAV,
  # trim/concat/silencedetect/afftdn filters, ffprobe) is built-in. Prebuilt
  # arm64 LGPL binaries don't exist (ffbinaries ships x86_64 only, which
  # EPERMs when a sandboxed App Store build spawns it), so we compile.
  local src
  src="$(mktemp -d)"
  git clone --depth 1 --branch "${FFMPEG_REF:-n6.1.1}" https://github.com/FFmpeg/FFmpeg "$src"
  (cd "$src" && ./configure \
    --enable-static --disable-shared \
    --disable-debug --disable-doc --disable-autodetect \
    --disable-ffplay --disable-network --enable-protocol=file \
    && make -j"$(nproc 2>/dev/null || sysctl -n hw.ncpu)" ffmpeg ffprobe \
    && strip ffmpeg ffprobe)
  cp "$src/ffmpeg" "$src/ffprobe" "$SIDECARS/"
  rm -rf "$src"
  echo "    ffmpeg / ffprobe built from source ($(uname -m), LGPL)"
}

fetch_ffmpeg() {
  if [[ "$IS_WINDOWS" -eq 1 ]]; then
    # BtbN LGPL static build (CPU), so the bundled executables need no DLLs.
    local zip
    zip="$(mktemp)"
    curl -fL "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-lgpl.zip" -o "$zip"
    local tmp
    tmp="$(mktemp -d)"
    (cd "$tmp" && unzip -o "$zip" >/dev/null)
    cp "$tmp"/ffmpeg-master-latest-win64-lgpl/bin/ffmpeg.exe "$SIDECARS/"
    cp "$tmp"/ffmpeg-master-latest-win64-lgpl/bin/ffprobe.exe "$SIDECARS/"
    rm -rf "$tmp" "$zip"
  elif [[ "$(uname -m)" == "arm64" ]]; then
    build_ffmpeg_source
  else
    # ffbinaries LGPL static build (x64 macOS) — fine for unsandboxed Intel
    # builds; Apple Silicon App Store builds need the arm64 source build above.
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
build_vibeasr
fetch_ffmpeg

# Sidecars are no longer bundled into the app — they are fetched on demand at
# first offline-model install (the Rust backend downloads, verifies and
# atomically installs a per-platform archive). The binaries produced here still
# serve local development (the dev `resources/sidecars` lookup) and the CI
# smoke test, and are packaged into a per-platform `tar.gz` by the release
# workflow. No cross-platform `.exe` counterpart is created: each platform
# only ever emits its own binary set.

# Ensure every sidecar is executable.
chmod +x "$SIDECARS"/* 2>/dev/null || true

echo "==> Sidecars ready in $SIDECARS"
ls -la "$SIDECARS"
