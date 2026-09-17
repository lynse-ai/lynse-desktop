#!/usr/bin/env bash
# Builds the Swift audio-capture self tests with the AEC3 dsp library linked
# in and runs them. Keeps the pnpm test script free of flag plumbing.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CAPTURE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
TAURI_DIR="$(cd "$CAPTURE_DIR/.." && pwd)"

bash "$TAURI_DIR/scripts/build-webrtc-aec.sh"
FLAGS="$(bash "$SCRIPT_DIR/dsp-link-flags.sh")"

cd "$CAPTURE_DIR"
swift run -c release --arch "$(uname -m)" $FLAGS audio-capture-core-tests
