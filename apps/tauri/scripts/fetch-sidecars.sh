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
# FunASR's llama.cpp runtime is consumed as a signed release tag whose assets are
# published for exactly the platforms we ship. SHA-256s are the digests GitHub
# reports for `runtime-llamacpp-v0.2.6`; the windows-x64 one is additionally
# verified byte-for-byte on this machine.
FUNASR_REF="${FUNASR_REF:-runtime-llamacpp-v0.2.6}"
FUNASR_RELEASE_BASE="https://github.com/modelscope/FunASR/releases/download/${FUNASR_REF}"
FUNASR_SHA_WINDOWS_X64="f6a73a548413ba9fbaf2145263ea66ec53cbdad1fb11790dbeeee493e339492e"
FUNASR_SHA_MACOS_ARM64="bda59474202b887190f59d25b7b42c714469efae71276072c12fa0a38de68792"

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

# FunASR on the llama.cpp / GGUF runtime: native binaries, quantized weights,
# no Python at transcription time. Upstream publishes exactly the platforms we
# ship, so the portable path consumes their signed release assets rather than
# compiling here — the same choice the CUDA/AVX2 tiering upstream documents.
#
# The asset is verified against a pinned SHA-256 BEFORE extraction, then the
# extracted binary is vetted for the flags the adapter actually passes. That
# second check is not ceremony: a whisper.cpp generation mismatch shipped a
# one-shot build as `vibeasr` and every Windows transcription died on
# "Unknown argument: --no-token-stream" (see build_vibeasr below). A wrong
# FunASR binary would fail the same way, only after the user paid for a download.
# Two of the release's binaries are consumed, mapped to the names the Rust side
# resolves (`stt::FUNASR_SIDECAR`, `stt::FUNASR_NANO_SIDECAR`):
#   llama-funasr-sensevoice -> funasr        (SenseVoice-Small, the default)
#   llama-funasr-cli        -> funasr-nano   (Fun-ASR-Nano: encoder + Qwen3 LLM)
# The other four (vad/embd/encoder/paraformer) are debugging or unused tools;
# shipping binaries the app cannot select only widens the signed surface.
FUNASR_BIN_MAP=("llama-funasr-sensevoice:funasr" "llama-funasr-cli:funasr-nano")

fetch_funasr_prebuilt() {
  local asset sha archive dir pair src target extension
  extension=""
  if [[ "$IS_WINDOWS" -eq 1 ]]; then
    asset="funasr-llamacpp-windows-x64.zip"
    sha="$FUNASR_SHA_WINDOWS_X64"
    extension=".exe"
  elif [[ "$(uname -m)" == "arm64" || "$(uname -m)" == "aarch64" ]]; then
    asset="funasr-llamacpp-macos-arm64.tar.gz"
    sha="$FUNASR_SHA_MACOS_ARM64"
  else
    build_funasr_source
    return
  fi
  archive="$(mktemp)"
  curl -fL --retry 3 --retry-all-errors "$FUNASR_RELEASE_BASE/$asset" -o "$archive"
  printf '%s  %s\n' "$sha" "$archive" | sha256sum -c - \
    || { rm -f "$archive"; return 1; }
  dir="$(mktemp -d)"
  case "$asset" in
    *.zip) (cd "$dir" && unzip -o -q "$archive") ;;
    *)     (cd "$dir" && tar -xzf "$archive") ;;
  esac
  rm -f "$archive"
  # Vet each consumed binary's flag surface before packaging it. A wrong-
  # generation sidecar still launches fine and only dies at transcribe time:
  # that is exactly how a one-shot asr_infer shipped as `vibeasr` and failed
  # every Windows run with "Unknown argument: --no-token-stream" (see
  # build_vibeasr). `--srt` is the adapter's only source of segment timings,
  # `--vad` keeps long audio off the degraded whole-clip decode, and
  # `--chunk` is what stops Fun-ASR-Nano's greedy loop on long segments.
  for pair in "${FUNASR_BIN_MAP[@]}"; do
    src="${pair%%:*}"; target="${pair##*:}"
    local bin="$dir/$src$extension"
    [[ -f "$bin" ]] || { echo "ERROR: $asset contained no $src$extension" >&2; return 1; }
    for flag in --srt --vad; do
      if ! "$bin" --help 2>&1 | grep -q -- "$flag"; then
        echo "ERROR: $src does not advertise $flag; the adapter cannot drive it" >&2
        return 1
      fi
    done
    if [[ "$target" == "funasr-nano" ]] && ! "$bin" --help 2>&1 | grep -q -- '--chunk'; then
      echo "ERROR: $src does not advertise --chunk; Fun-ASR-Nano would decode long segments out-of-distribution" >&2
      return 1
    fi
    cp "$bin" "$SIDECARS/$target$extension"
    chmod +x "$SIDECARS/$target$extension" 2>/dev/null || true
    echo "    funasr -> $target$extension ($src, $asset @ $FUNASR_REF)"
  done
  rm -rf "$dir"
}

# Intel Mac: upstream ships no macos-x86_64 asset, so build the same tag from
# source. The runtime's own CMake tree fetches its pinned llama.cpp, which is the
# CI-friendly path upstream documents for exactly this case.
build_funasr_source() {
  local src pair srcbin target bins=()
  src="$(mktemp -d)"
  git clone --depth 1 --branch "$FUNASR_REF" --recursive https://github.com/modelscope/FunASR "$src"
  cmake -S "$src/runtime/llama.cpp" -B "$src/runtime/llama.cpp/build" \
    -DCMAKE_BUILD_TYPE=Release -DGGML_NATIVE=OFF -DGGML_AVX2=ON -DLLAMA_CURL=OFF
  for pair in "${FUNASR_BIN_MAP[@]}"; do bins+=("${pair%%:*}"); done
  cmake --build "$src/runtime/llama.cpp/build" --config Release \
    --target "${bins[@]}" -j"$(sysctl -n hw.ncpu)"
  for pair in "${FUNASR_BIN_MAP[@]}"; do
    srcbin="${pair%%:*}"; target="${pair##*:}"
    local bin
    bin="$(find "$src/runtime/llama.cpp/build" -type f -name "$srcbin" | head -n1)"
    [[ -n "$bin" ]] || { echo "ERROR: source build produced no $srcbin" >&2; return 1; }
    if ! "$bin" --help 2>&1 | grep -q -- '--srt'; then
      echo "ERROR: $srcbin does not advertise --srt; the adapter cannot get timestamps from it" >&2
      return 1
    fi
    cp "$bin" "$SIDECARS/$target"
    echo "    funasr -> $target (built from $FUNASR_REF source, x86_64)"
  done
  rm -rf "$src"
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
fetch_funasr_prebuilt || { echo "ERROR: FunASR sidecar unavailable — the GGUF engine cannot ship without resources/sidecars/funasr" >&2; exit 1; }
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
