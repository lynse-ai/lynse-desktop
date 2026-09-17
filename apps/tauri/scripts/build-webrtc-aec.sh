#!/usr/bin/env bash
# Builds the vendored WebRTC AEC3 echo-cancellation engine into a single merged
# static library consumed by the audio-capture SwiftPM package.
#
# Inputs (fixed upstream snapshots — see vendor/SHA256SUMS):
#   vendor/tarballs/webrtc-audio-processing-1.3.tar.gz   (PulseAudio packaging of webrtc APM, BSD-3)
#   vendor/tarballs/abseil-cpp-20230125.1.tar.gz          (pinned by upstream's abseil wrap, Apache-2.0)
#   vendor/tarballs/abseil-cpp_20230125.1-4_patch.zip     (meson.build overlay from meson wrapdb)
# Output:
#   vendor/build/lib/liblynse_dsp.a   (webrtc + abseil + the C bridge in lynse_aec.cc, merged)
#   vendor/build/include/lynse_aec.h  (bridge header for the build record)
#
# Nothing is downloaded at build time; meson + ninja must be installed
# (e.g. `brew install meson ninja`).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CAPTURE_DIR="$(cd "$SCRIPT_DIR/../audio-capture" && pwd)"
VENDOR_DIR="$CAPTURE_DIR/vendor"
BUILD_DIR="$VENDOR_DIR/build"
SRC_DIR="$VENDOR_DIR/src"

command -v meson >/dev/null 2>&1 || { echo "meson is required (brew install meson ninja)" >&2; exit 1; }
command -v ninja >/dev/null 2>&1 || { echo "ninja is required (brew install meson ninja)" >&2; exit 1; }
command -v libtool >/dev/null 2>&1 || { echo "libtool is required (part of Xcode CLT)" >&2; exit 1; }

if [[ "$(uname -s)" != "Darwin" || "$(uname -m)" != "arm64" ]]; then
  echo "webrtc AEC dsp is only built for macOS arm64" >&2
  exit 1
fi

# Pin the exact upstream bytes we build from.
(
  cd "$VENDOR_DIR/tarballs"
  shasum -a 256 --check < "$VENDOR_DIR/SHA256SUMS" >/dev/null
) || { echo "vendor tarball checksum mismatch" >&2; exit 1; }

HASH_INPUTS=(
  "$VENDOR_DIR/SHA256SUMS"
  "$SCRIPT_DIR/build-webrtc-aec.sh"
  "$CAPTURE_DIR/dsp/lynse_aec.cc"
  "$CAPTURE_DIR/dsp/lynse_aec.h"
)
STAMP="$BUILD_DIR/.dsp.stamp"
mkdir -p "$BUILD_DIR"
CURRENT_HASH="$(cat "${HASH_INPUTS[@]}" | shasum -a 256 | awk '{print $1}')"
if [[ "${FORCE_WEBRTC_REBUILD:-0}" != "1" && -f "$STAMP" && "$(tr -d '\n' < "$STAMP")" == "$CURRENT_HASH" ]]; then
  echo "webrtc dsp unchanged"
  exit 0
fi

# The standalone CommandLineTools SDK can lag the OS SDK's tbd files (tapi
# rejects the newer arm64e targets). Prefer the full Xcode SDK when present.
if [[ -z "${SDKROOT:-}" && -d "/Applications/Xcode.app" ]]; then
  XCODE_SDK="/Applications/Xcode.app/Contents/Developer/Platforms/MacOSX.platform/Developer/SDKs/MacOSX.sdk"
  [[ -d "$XCODE_SDK" ]] && export SDKROOT="$XCODE_SDK"
fi

rm -rf "$SRC_DIR"
mkdir -p "$SRC_DIR"

EXTRACT="$SRC_DIR/webrtc-audio-processing-1.3"
tar -xzf "$VENDOR_DIR/tarballs/webrtc-audio-processing-1.3.tar.gz" -C "$SRC_DIR"
# abseil is placed as a meson *directory* subproject so the build never needs
# to fetch the wrap from the network; the wrapdb patch provides its meson build.
ABSEIL_SRC="$EXTRACT/subprojects/abseil-cpp"
mkdir -p "$ABSEIL_SRC"
tar -xzf "$VENDOR_DIR/tarballs/abseil-cpp-20230125.1.tar.gz" -C "$ABSEIL_SRC" --strip-components=1
unzip -q -o "$VENDOR_DIR/tarballs/abseil-cpp_20230125.1-4_patch.zip" -d "$ABSEIL_SRC/.patch"
cp "$ABSEIL_SRC/.patch/abseil-cpp-20230125.1/meson.build" "$ABSEIL_SRC/meson.build"
rm -rf "$ABSEIL_SRC/.patch"

# Static libraries only; NEON stays on (upstream default, validated on arm64).
meson setup "$EXTRACT/build" "$EXTRACT" \
  --default-library static --buildtype release -Dneon=yes >/dev/null
ninja -C "$EXTRACT/build" >/dev/null

# Merge every archive (webrtc, abseil, third_party) into one so SwiftPM needs
# a single -llynse_dsp instead of the ~20 abseil libs.
LIBS=()
while IFS= read -r lib; do LIBS+=("$lib"); done < <(find "$EXTRACT/build" -name '*.a' | sort)
[[ ${#LIBS[@]} -gt 0 ]] || { echo "meson produced no static libraries" >&2; exit 1; }

mkdir -p "$BUILD_DIR/lib" "$BUILD_DIR/include"
clang++ -std=c++17 -stdlib=libc++ -isysroot "${SDKROOT:-$(xcrun --show-sdk-path)}" \
  -I "$EXTRACT/webrtc" -I "$EXTRACT/subprojects/abseil-cpp" \
  -Wno-deprecated-builtins -O2 -fvisibility=hidden \
  -c "$CAPTURE_DIR/dsp/lynse_aec.cc" -o "$BUILD_DIR/lynse_aec.o"
libtool -static -o "$BUILD_DIR/lib/liblynse_dsp.a" "$BUILD_DIR/lynse_aec.o" "${LIBS[@]}" 2>/dev/null
cp "$CAPTURE_DIR/dsp/lynse_aec.h" "$BUILD_DIR/include/lynse_aec.h"

printf '%s\n' "$CURRENT_HASH" > "$STAMP"
echo "built $BUILD_DIR/lib/liblynse_dsp.a"
