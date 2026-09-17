#!/usr/bin/env bash
# Prints the linker flags that bind the prebuilt AEC3 dsp library
# (vendor/build/lib/liblynse_dsp.a) into a SwiftPM build of this package.
# Usage: FLAGS="$(bash scripts/dsp-link-flags.sh)"; swift build $FLAGS ...
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CAPTURE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
LIB_DIR="$CAPTURE_DIR/vendor/build/lib"

if [[ "$(uname -s)" != "Darwin" || "$(uname -m)" != "arm64" ]]; then
  exit 0
fi
if [[ ! -f "$LIB_DIR/liblynse_dsp.a" ]]; then
  echo "liblynse_dsp.a missing — run scripts/build-webrtc-aec.sh first" >&2
  exit 1
fi

printf '%s\n' \
  -Xlinker "-L$LIB_DIR" \
  -Xlinker -llynse_dsp \
  -Xlinker -lc++ \
  -Xlinker -framework -Xlinker CoreFoundation \
  -Xlinker -framework -Xlinker AudioToolbox
