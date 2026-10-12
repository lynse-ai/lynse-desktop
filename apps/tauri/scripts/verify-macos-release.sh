#!/usr/bin/env bash
# Verify the actual updater and installer before publishing any update pointer.
set -euo pipefail
[[ $# == 3 ]] || { echo "Usage: verify-macos-release.sh <app.tar.gz> <dmg> <version>" >&2; exit 2; }
ARCHIVE="$1"; DMG="$2"; VERSION="$3"
TEAM="${APPLE_TEAM_ID:-76HBB34PNK}"
WORK="$(mktemp -d)"
MOUNT="$WORK/mount"
cleanup() { if mount | grep -Fq " on $MOUNT "; then hdiutil detach "$MOUNT" >/dev/null; fi; rm -rf "$WORK"; }
trap cleanup EXIT
mkdir -p "$WORK/update" "$MOUNT"
tar -xzf "$ARCHIVE" -C "$WORK/update"
APP="$WORK/update/Lynse.app"
verify_app() {
  local app="$1"
  [[ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$app/Contents/Info.plist")" == "$VERSION" ]]
  [[ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$app/Contents/Info.plist")" == "com.lynse.sparknote" ]]
  codesign --verify --deep --strict --verbose=2 "$app"
  codesign -dv "$app" 2>&1 | grep -Fx "TeamIdentifier=$TEAM"
  spctl --assess --type execute --verbose=4 "$app"
  xcrun stapler validate "$app"
}
verify_app "$APP"
xcrun stapler validate "$DMG"
hdiutil attach -readonly -nobrowse -mountpoint "$MOUNT" "$DMG" >/dev/null
verify_app "$MOUNT/Lynse.app"
UPDATER_SEAL="$(codesign -dv "$APP" 2>&1 | sed -n 's/^CDHash=//p')"
INSTALLER_SEAL="$(codesign -dv "$MOUNT/Lynse.app" 2>&1 | sed -n 's/^CDHash=//p')"
[[ -n "$UPDATER_SEAL" && "$UPDATER_SEAL" == "$INSTALLER_SEAL" ]] || { echo "Updater and installer app seals differ" >&2; exit 1; }
echo "Verified notarized macOS $VERSION updater and installer with matching app seal."
