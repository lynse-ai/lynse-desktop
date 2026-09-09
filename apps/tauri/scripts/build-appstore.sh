#!/usr/bin/env bash
# Build a macOS App Store / TestFlight package (.pkg) for Lynse.
#
# Secrets policy: no key ever enters the repository.
# - Distribution certificates live in the login Keychain (created by Xcode).
# - Upload authentication uses either the Transporter app's GUI login or an
#   App Store Connect API key (.p8) placed in ~/.private_keys/ (gitignored).
#
# Prerequisites:
#   1. Full Xcode installed, Apple ID signed in (Xcode → Settings → Accounts),
#      Apple Developer Program membership active.
#   2. "Apple Distribution" + "3rd Party Mac Developer Installer" certificates
#      in the Keychain (Xcode → Settings → Accounts → Manage Certificates).
#   3. An App Store Connect app record for bundle id com.lynse.sparknote,
#      with the "Audio Input" (microphone) capability enabled — otherwise the
#      provisioning profile won't carry com.apple.security.device.audio-input
#      and TestFlight builds can't get microphone access.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
APP_DIR="$ROOT/apps/tauri"
APP_PATH="$APP_DIR/src-tauri/target/release/bundle/macos/Lynse.app"
ENTITLEMENTS="$APP_DIR/src-tauri/Entitlements-appstore.plist"
OUT_DIR="${OUT_DIR:-$APP_DIR/src-tauri/target/appstore}"
PKG_PATH="$OUT_DIR/Lynse.pkg"

log() { printf '\n==> %s\n' "$*"; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

# --- preflight ---------------------------------------------------------------
command -v codesign >/dev/null || die "codesign not found"
command -v productbuild >/dev/null || die "productbuild not found"
[[ -f "$ENTITLEMENTS" ]] || die "Missing $ENTITLEMENTS"
if [[ "$(xcode-select -p 2>/dev/null)" == *"CommandLineTools" ]]; then
  die "xcode-select points at Command Line Tools. Install full Xcode, then:
  sudo xcode-select -s /Applications/Xcode.app"
fi

pick_identity() {
  security find-identity -v 2>/dev/null \
    | grep "$1" | head -n1 | sed -E 's/^[^"]*"(.*)"$/\1/'
}
APP_IDENTITY="${APPLE_SIGNING_IDENTITY:-$(pick_identity 'Apple Distribution:')}"
PKG_IDENTITY="${APPLE_INSTALLER_IDENTITY:-$(pick_identity '3rd Party Mac Developer Installer:')}"
[[ -n "$APP_IDENTITY" ]] || die "No 'Apple Distribution' certificate in the Keychain.
Create one via Xcode → Settings → Accounts → Manage Certificates
(requires Apple Developer Program membership)."
[[ -n "$PKG_IDENTITY" ]] || die "No '3rd Party Mac Developer Installer' certificate in the Keychain.
Create it the same way as above."

# --- version bump --------------------------------------------------------------
# TestFlight requires every upload's version to be strictly higher than the
# previous one, so each packaging run bumps the patch version across
# tauri.conf.json, package.json and Cargo.toml (they must stay in sync).
# Set NO_BUMP=1 to reuse the current version for a local test package.
if [[ -z "${NO_BUMP:-}" ]]; then
  CONF="$APP_DIR/src-tauri/tauri.conf.json"
  VERSION="$(sed -nE 's/^[[:space:]]*"version": "([0-9]+)\.([0-9]+)\.([0-9]+)",?$/\1 \2 \3/p' "$CONF" | head -n1)"
  [[ -n "$VERSION" ]] || die "Cannot parse version from $CONF"
  read -r MAJ MIN PATCH <<< "$VERSION"
  OLD_VERSION="$MAJ.$MIN.$PATCH"
  NEW_VERSION="$MAJ.$MIN.$((PATCH + 1))"
  log "Bumping version: $OLD_VERSION → $NEW_VERSION"
  sed -i '' "s/\"version\": \"$OLD_VERSION\"/\"version\": \"$NEW_VERSION\"/" \
    "$CONF" "$APP_DIR/package.json"
  sed -i '' "s/^version = \"$OLD_VERSION\"/version = \"$NEW_VERSION\"/" \
    "$APP_DIR/src-tauri/Cargo.toml"
fi

# --- build -------------------------------------------------------------------
log "Building the Tauri app bundle (updater artifacts disabled for App Store)"
(cd "$ROOT" && pnpm --filter @lynse/tauri exec tauri build --bundles app \
  --config '{"bundle":{"createUpdaterArtifacts":false}}')
[[ -d "$APP_PATH" ]] || die "Expected app bundle not found at $APP_PATH"

# --- sign --------------------------------------------------------------------
# TestFlight rejects packages whose files carry the com.apple.quarantine xattr
# (error 91109) — the build machine or downloaded profiles can add it. Wipe all
# extended attributes from the freshly built bundle before signing.
log "Clearing extended attributes (quarantine etc.)"
xattr -cr "$APP_PATH"

# Innermost first: App Store validation requires *every* executable in the
# package to carry the app-sandbox entitlement, and `codesign --deep` re-signs
# nested code WITHOUT entitlements — so sign helper executables explicitly,
# then sign the outer bundle (plain codesign, no --deep).
HELPER_ENTITLEMENTS="$APP_DIR/src-tauri/Entitlements-audio-capture.plist"
[[ -f "$HELPER_ENTITLEMENTS" ]] || die "Missing $HELPER_ENTITLEMENTS"
find "$APP_PATH/Contents" -type f ! -path "*/Contents/MacOS/*" | while read -r nested; do
  file "$nested" | grep -q "Mach-O" || continue
  log "Codesigning nested executable: ${nested#"$APP_PATH/Contents/"}"
  codesign --force --options runtime \
    --entitlements "$HELPER_ENTITLEMENTS" --sign "$APP_IDENTITY" "$nested"
done

# TestFlight requires the main bundle to embed a provisioning profile
# (plain App Store distribution does not). Download one from
# developer.apple.com → Certificates, Identifiers & Profiles → Profiles → +
# (Distribution → App Store Connect, App ID com.lynse.sparknote).
PROFILE="${MAC_PROVISION_PROFILE:-$(ls -t "$HOME"/Downloads/*.provisionprofile 2>/dev/null | head -n1)}"
if [[ -z "$PROFILE" || ! -f "$PROFILE" ]]; then
  die "No .provisionprofile found.
Create one at developer.apple.com → Profiles → + → Distribution 'App Store Connect'
for App ID com.lynse.sparknote, download it (lands in ~/Downloads),
then re-run with: MAC_PROVISION_PROFILE=/path/to/file.provisionprofile bash $0"
fi
log "Embedding provisioning profile: $PROFILE"
cp "$PROFILE" "$APP_PATH/Contents/embedded.provisionprofile"
xattr -c "$APP_PATH/Contents/embedded.provisionprofile" 2>/dev/null || true

log "Codesigning app bundle with '$APP_IDENTITY'"
codesign --force --options runtime \
  --entitlements "$ENTITLEMENTS" --sign "$APP_IDENTITY" "$APP_PATH"
codesign --verify --deep --strict "$APP_PATH"
log "Signature OK"

# --- package -----------------------------------------------------------------
log "Building installer package: $PKG_PATH"
mkdir -p "$OUT_DIR"
productbuild --component "$APP_PATH" /Applications \
  --sign "$PKG_IDENTITY" "$PKG_PATH"

log "Done: $PKG_PATH"
echo
echo "Upload to TestFlight (pick one):"
echo "  1. Transporter app: open it, sign in with your Apple ID, add $PKG_PATH, press Deliver."
echo "  2. CLI: xcrun altool --upload-package '$PKG_PATH' \\"
echo "         --apiIssuer <ISSUER_ID> --apiKey <KEY_ID>"
echo "     (API key .p8 file must be in ~/.private_keys/ — gitignored, never in the repo.)"
echo
echo "Then add testers in App Store Connect → your app → TestFlight."
