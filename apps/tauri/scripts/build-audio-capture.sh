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

SOURCE_HASH=$(
  find "$SOURCE_DIR" -path "$SOURCE_DIR/.build" -prune -o -type f \( -name '*.swift' -o -name 'Package.swift' -o -name 'Info.plist' \) -print0 \
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
  swift build -c release --arch "$(uname -m)"
)

cp "$SOURCE_DIR/.build/release/lynse-audio-capture" "$DEST"
chmod +x "$DEST"
xattr -cr "$DEST" || true

SIGNING_IDENTITY="${CODESIGN_IDENTITY:--}"
codesign --force --options runtime --sign "$SIGNING_IDENTITY" "$DEST"

printf '%s\n' "$SOURCE_HASH" > "$STAMP"
echo "built $DEST"
