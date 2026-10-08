#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TAURI_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
DEST_DIR="$TAURI_DIR/src-tauri/resources/sidecars"
DEST="$DEST_DIR/audio-capture"

if [[ "$(uname -s)" != "Darwin" ]]; then
  mkdir -p "$DEST_DIR"
  printf '%s\n' 'audio-capture is available on macOS only' > "$DEST"
  echo "audio-capture sidecar is macOS-only; created packaging placeholder"
  exit 0
fi

SOURCE_DIR="$TAURI_DIR/audio-capture"
STAMP="$DEST_DIR/.audio-capture.stamp"

mkdir -p "$DEST_DIR"

# The vendored AEC3 engine (and the C bridge in dsp/) feeds the link step, so
# its build must happen first and its inputs participate in the change stamp.
bash "$SCRIPT_DIR/build-webrtc-aec.sh"
DSP_FLAGS="$(bash "$SOURCE_DIR/scripts/dsp-link-flags.sh")"

SOURCE_HASH=$(
  find "$SOURCE_DIR" \( -path "$SOURCE_DIR/.build" -o -path "$SOURCE_DIR/vendor/src" -o -path "$SOURCE_DIR/vendor/build" \) -prune -o \
    -type f \( -name '*.swift' -o -name '*.cc' -o -name '*.h' -o -name 'Package.swift' -o -name 'Info.plist' -o -name 'SHA256SUMS' \) -print0 \
    | sort -z \
    | xargs -0 shasum -a 256 \
    | shasum -a 256 \
    | awk '{print $1}'
)

if [[ "${FORCE_AUDIO_CAPTURE_REBUILD:-0}" != "1" && -x "$DEST" && -f "$STAMP" && "$(tr -d '\n' < "$STAMP")" == "$SOURCE_HASH" ]]; then
  echo "audio-capture sidecar unchanged"
  exit 0
fi

(
  cd "$SOURCE_DIR"
  swift build -c release --arch "$(uname -m)" $DSP_FLAGS
)

cp "$SOURCE_DIR/.build/release/lynse-audio-capture" "$DEST"
chmod +x "$DEST"
xattr -cr "$DEST" || true

# Ad-hoc signature only. The release pipeline Developer ID-signs this binary
# in a dedicated workflow step (release.yml): codesign cannot see the
# certificate here — tauri imports it into a temporary keychain only during
# bundling, after beforeBuildCommand has already run. The build script's stamp
# check then skips the rebuild in the tauri build step, preserving that
# signature (Developer ID + timestamp + audio-input entitlement, see
# Entitlements-sidecar-direct.plist).
SIGNING_IDENTITY="${CODESIGN_IDENTITY:--}"
codesign --force --options runtime --sign "$SIGNING_IDENTITY" "$DEST"

printf '%s\n' "$SOURCE_HASH" > "$STAMP"
echo "built $DEST"
