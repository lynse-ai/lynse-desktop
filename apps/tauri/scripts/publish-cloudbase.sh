#!/usr/bin/env bash
# Build (optional) and publish Lynse desktop release artifacts to Tencent
# CloudBase static hosting — the sole distribution channel since GitHub
# Actions / TestFlight were retired.
#
#   macOS: bash apps/tauri/scripts/publish-cloudbase.sh v1.2.0 --build
#   Windows (Git Bash): bash apps/tauri/scripts/publish-cloudbase.sh v1.2.0 --build
#
# What it does:
#   --build   Build the current platform first: fetch/build STT sidecars,
#             package the shared runtime archive (SHA-256 exported to the Rust
#             build — a local build without it skips download verification),
#             then `tauri build` with the updater signing key. Artifacts are
#             collected into a flat dist dir.
#   publish   Generate latest.json (release notes pulled from CHANGELOG.md),
#             merge with the live manifest when publishing one platform of a
#             version whose other platform is already live, upload everything
#             to updates/<tag>/, verify every referenced file is reachable,
#             and only then flip the stable updates/latest.json.
#
# Prerequisites:
#   - Node (for JSON assembly) and curl.
#   - tcb CLI for uploads: npm i -g @cloudbase/cli  (auto-falls back to
#     `npx -y @cloudbase/cli` when absent).
#   - CLOUDBASE_API_KEY env, or --reuse-login with an already authenticated CLI.
#   - With --build: TAURI_SIGNING_PRIVATE_KEY(/_PASSWORD) env — the updater
#     key pair at ~/.tauri/lynse-desktop.key. Optionally APPLE_SIGNING_IDENTITY
#     etc. for Developer ID signing; without it the macOS bundle is ad-hoc
#     (Gatekeeper right-click-open and TCC grants do not survive updates).
#
# The website download links point at the per-tag installers, e.g.
#   https://<host>/updates/v1.2.0/Lynse_1.2.0_aarch64.dmg
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
APP_DIR="$ROOT/apps/tauri"
CONF="$APP_DIR/src-tauri/tauri.conf.json"
CHANGELOG="$ROOT/CHANGELOG.md"
BUNDLE_DIR="$APP_DIR/src-tauri/target/release/bundle"

CLOUDBASE_ENV_ID="${CLOUDBASE_ENV_ID:-lynse-d8g49o1i956741f9e}"
UPDATES_BASE="${UPDATES_BASE:-https://dl.lynse.cn/updates}"

DRY_RUN=false
DO_BUILD=false
REUSE_LOGIN=false
TAG=""

log() { printf '\n==> %s\n' "$*"; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=true ;;
    --build) DO_BUILD=true ;;
    --reuse-login) REUSE_LOGIN=true ;;
    -h|--help) grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*) die "Unknown option: $1" ;;
    *) TAG="$1" ;;
  esac
  shift
done

[[ -n "$TAG" ]] || die "Usage: publish-cloudbase.sh <tag> [--build] [--dry-run] [--reuse-login]
  e.g. publish-cloudbase.sh v1.2.0 --build"

# A build-counter suffix is allowed: this repo's history carries tags like
# v1.1.4(2), and rejecting them made the script unusable for exactly the
# releases that need repairing. The manifest version is always the numeric
# prefix, which is also what tauri.conf.json carries.
[[ "$TAG" =~ ^v([0-9]+\.[0-9]+\.[0-9]+) ]] \
  || die "Tag must look like v1.2.0 (optionally with a build suffix, e.g. v1.1.4(2)), got: $TAG"
VERSION="${BASH_REMATCH[1]}"

# The updater compares the manifest version against the running app, so the
# manifest MUST carry the version the app was built with — never the tag alone.
CONF_VERSION="$(sed -nE 's/^[[:space:]]*"version": "([0-9]+\.[0-9]+\.[0-9]+)",?$/\1/p' "$CONF" | head -n1)"
[[ "$CONF_VERSION" == "$VERSION" ]] || die "tauri.conf.json version is $CONF_VERSION but tag is $TAG —
  bump the version first (tauri.conf.json + Cargo.toml + apps/tauri/package.json) or fix the tag."

DIST="${OUT_DIR:-$APP_DIR/src-tauri/target/cloudbase-dist/$TAG}"
mkdir -p "$DIST"

OS="$(uname -s)"
if [[ "$OS" == Darwin ]]; then
  # The runtime archive is cut per OS+arch and the Rust side resolves
  # `stt-runtimes/v<version>/macos-aarch64|macos-x86_64`, so hardcoding aarch64
  # here would publish an arm64 archive under whichever name the host happened to
  # build it — and an Intel Mac would install arm64 binaries it cannot exec.
  PLATFORM=macos
  if [[ "$(uname -m)" == "x86_64" ]]; then
    RUNTIME_PLATFORM=macos-x86_64; SHA_VAR=LYNSE_RUNTIME_SHA_MACOS_X86_64
  else
    RUNTIME_PLATFORM=macos-aarch64; SHA_VAR=LYNSE_RUNTIME_SHA_MACOS_AARCH64
  fi
elif [[ "$OS" == MINGW* || "$OS" == MSYS* ]]; then
  PLATFORM=windows; RUNTIME_PLATFORM=windows-x86_64; SHA_VAR=LYNSE_RUNTIME_SHA_WINDOWS_X86_64
else
  die "Unsupported host OS: $OS (macOS or Windows only)"
fi

# ── optional build ───────────────────────────────────────────────────────────
if [[ "$DO_BUILD" == true ]]; then
  command -v pnpm >/dev/null || die "pnpm not found"
  [[ -n "${TAURI_SIGNING_PRIVATE_KEY:-}" ]] || die "TAURI_SIGNING_PRIVATE_KEY is not set —
  export it from ~/.tauri/lynse-desktop.key (see docs/auto-update.md)."

  log "Fetching / building STT sidecars"
  (cd "$ROOT" && bash apps/tauri/scripts/fetch-sidecars.sh)

  SIDECARS="$APP_DIR/src-tauri/resources/sidecars"
  if [[ "$PLATFORM" == windows ]]; then
    # A Vulkan-less archive would pass the completeness check but silently run
    # CPU-only (the same hard gate the old release workflow had).
    [[ -s "$SIDECARS/vulkan-1.dll" ]] || die "vulkan-1.dll missing from sidecars — the whisper build went out CPU-only"
  fi
  # Everything `stt::required_runtime_names` demands must be present, or the
  # archive fails the client's own completeness gate: `model_is_installed` would
  # report FunASR/Whisper as missing, and because re-downloading the same
  # incomplete archive can never satisfy the check, the user would loop on
  # "组件未下载" with no way out. FunASR is in this list now that it is a sidecar.
  extension=""; [[ "$PLATFORM" == windows ]] && extension=".exe"
  for required in whisper vibeasr funasr funasr-nano ffmpeg ffprobe; do
    [[ -s "$SIDECARS/${required}${extension}" ]] \
      || die "${required}${extension} missing from sidecars — run fetch-sidecars.sh first; this archive would fail the client's runtime check"
  done

  log "Packaging STT runtime archive (SHA exported as $SHA_VAR)"
  ARCHIVE="lynse-stt-runtime-$RUNTIME_PLATFORM.tar.gz"
  tar -czf "$DIST/$ARCHIVE" -C "$SIDECARS" .
  RUNTIME_SHA="$(sha256sum "$DIST/$ARCHIVE" 2>/dev/null | cut -d' ' -f1 || shasum -a 256 "$DIST/$ARCHIVE" | cut -d' ' -f1)"
  export "$SHA_VAR=$RUNTIME_SHA"
  log "runtime sha256: $RUNTIME_SHA"

  log "Building the Tauri app ($PLATFORM)"
  if [[ "$PLATFORM" == macos ]]; then
    # `app` is required alongside dmg: the updater artifact (.app.tar.gz + .sig)
    # is cut from the app bundle — a dmg-only build produces no darwin entry.
    (cd "$ROOT" && pnpm --filter @lynse/tauri exec tauri build --bundles app,dmg)
  else
    (cd "$ROOT" && pnpm --filter @lynse/tauri exec tauri build --bundles msi)
  fi
fi

# ── collect artifacts into dist ──────────────────────────────────────────────
log "Collecting artifacts for $PLATFORM into $DIST"

# Updater artifact + signature are the contract with the in-app updater; the
# dmg/msi are the website-download copies of the same build.
if [[ "$PLATFORM" == macos ]]; then
  UPDATER_SRC="$BUNDLE_DIR/macos/Lynse.app.tar.gz"
  DMG_SRC="$(ls -t "$BUNDLE_DIR"/dmg/Lynse_*.dmg 2>/dev/null | head -n1 || true)"
  [[ -s "$UPDATER_SRC" ]] || die "Missing $UPDATER_SRC — run with --build first (or point OUT_DIR at a prepared dist)."
  [[ -n "${DMG_SRC:-}" && -s "$DMG_SRC" ]] || die "No dmg found in $BUNDLE_DIR/dmg — run with --build first."
  bash "$ROOT/apps/tauri/scripts/verify-macos-release.sh" "$UPDATER_SRC" "$DMG_SRC" "$VERSION"
  cp "$UPDATER_SRC" "$DIST/Lynse_${VERSION}_aarch64.app.tar.gz"
  cp "$UPDATER_SRC.sig" "$DIST/Lynse_${VERSION}_aarch64.app.tar.gz.sig"
  cp "$DMG_SRC" "$DIST/"
else
  MSI_SRC="$(ls -t "$BUNDLE_DIR"/msi/Lynse_*.msi 2>/dev/null | head -n1 || true)"
  [[ -n "${MSI_SRC:-}" && -s "$MSI_SRC" ]] || die "No msi found in $BUNDLE_DIR/msi — run with --build first."
  cp "$MSI_SRC" "$DIST/"
  cp "$MSI_SRC.sig" "$DIST/"
fi
ls -la "$DIST"

# ── release notes from CHANGELOG ─────────────────────────────────────────────
NOTES="$(awk -v ver="$VERSION" '
  $0 ~ "^## " ver "( |$)" { found = 1; next }
  found && /^## / { exit }
  found { print }
' "$CHANGELOG" 2>/dev/null | cat -s | sed -e '/./,$!d' || true)"
[[ -n "${NOTES:-}" ]] || NOTES="Lynse ${TAG} — macOS (dmg) and Windows (msi)."

# ── assemble latest.json ─────────────────────────────────────────────────────
# Platform entry format per tauri-plugin-updater: { signature, url }. The
# signature is the minisign .sig content shipped beside the artifact.
declare -a ENTRIES=()
if [[ "$PLATFORM" == macos ]]; then
  ENTRIES+=("darwin-aarch64|Lynse_${VERSION}_aarch64.app.tar.gz|Lynse_${VERSION}_aarch64.app.tar.gz.sig")
else
  MSI_NAME="$(basename "$MSI_SRC")"
  ENTRIES+=("windows-x86_64|$MSI_NAME|$MSI_NAME.sig")
fi

MANIFEST="$DIST/latest.json"
node - "$DIST" "$MANIFEST" "$VERSION" "$UPDATES_BASE/$TAG" "$NOTES" "${ENTRIES[@]}" <<'NODE'
const [dist, manifest, version, baseUrl, notes, ...entries] = process.argv.slice(2);
const fs = require("fs");
const path = require("path");
const platforms = {};
for (const entry of entries) {
  const [key, artifact, sigFile] = entry.split("|");
  platforms[key] = {
    signature: fs.readFileSync(path.join(dist, sigFile), "utf8").trim(),
    url: `${baseUrl}/${artifact}`,
  };
}
fs.writeFileSync(manifest, JSON.stringify(
  { version, notes, pub_date: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"), platforms },
  null, 2,
) + "\n");
NODE
log "Manifest for this run:"
cat "$MANIFEST"

# When only one platform is published from this machine, merge in the entry
# already live for the same version so the flip never drops the other side.
REMOTE_PLATFORMS="{}"
if [[ ${#ENTRIES[@]} -eq 1 ]]; then
  if REMOTE="$(curl -fsSL --max-time 20 "$UPDATES_BASE/latest.json" 2>/dev/null)"; then
    REMOTE_PLATFORMS="$(REMOTE="$REMOTE" VERSION="$VERSION" node -e '
      const r = JSON.parse(process.env.REMOTE);
      console.log(JSON.stringify(r.version === process.env.VERSION ? (r.platforms ?? {}) : {}));
    ' 2>/dev/null)"
    REMOTE_PLATFORMS="${REMOTE_PLATFORMS:-}"
    if [[ -z "$REMOTE_PLATFORMS" ]]; then REMOTE_PLATFORMS="{}"; fi
    if [[ "$REMOTE_PLATFORMS" != "{}" ]]; then
      KEYS="$(REMOTE_PLATFORMS="$REMOTE_PLATFORMS" node -e 'console.log(Object.keys(JSON.parse(process.env.REMOTE_PLATFORMS)).join(", "))')"
      log "Merging live same-version platform entries: $KEYS"
    else
      echo "WARNING: no live entry for version $VERSION — publishing $PLATFORM only means
  the other platform gets no update until its artifact run completes." >&2
    fi
  fi
fi

FINAL="$DIST/latest.final.json"
MANIFEST="$MANIFEST" REMOTE_PLATFORMS="$REMOTE_PLATFORMS" node -e '
const fs = require("fs");
const m = JSON.parse(process.env.MANIFEST && fs.readFileSync(process.env.MANIFEST, "utf8"));
m.platforms = { ...JSON.parse(process.env.REMOTE_PLATFORMS), ...m.platforms };
fs.writeFileSync(process.env.MANIFEST.replace(/\.json$/, ".final.json"), JSON.stringify(m, null, 2) + "\n");
'
mv "$FINAL" "$MANIFEST"
log "Final manifest to publish:"
cat "$MANIFEST"

# ── upload, then verify, then flip ───────────────────────────────────────────
# Order is load-bearing (same as mirror-release-to-cloudbase.sh): the per-tag
# copy lands FIRST, the reachability check proves every manifest URL serves,
# and only then is the stable pointer flipped — a client can never be pointed
# at a file that is not there yet. (Verifying before uploading can never pass:
# this machine's artifacts are by definition not on the CDN yet.)
if [[ "$DRY_RUN" == true ]]; then
  log "Dry run — nothing uploaded. Manifest kept at $MANIFEST for inspection."
  exit 0
fi

if [[ "$REUSE_LOGIN" != true ]]; then
  [[ -n "${CLOUDBASE_API_KEY:-}" ]] || die "CLOUDBASE_API_KEY is not set; use --reuse-login with an already authenticated tcb CLI."
fi
if ! command -v tcb >/dev/null; then
  tcb() { npx -y @cloudbase/cli "$@"; }
fi

log "Uploading artifacts to updates/$TAG (per-tag copy first…)"
if [[ "$REUSE_LOGIN" != true ]]; then
  tcb login --cloudbase-api-key "$CLOUDBASE_API_KEY" -e "$CLOUDBASE_ENV_ID"
fi
tcb hosting deploy "$DIST" "updates/$TAG" -e "$CLOUDBASE_ENV_ID" --yes

log "Verifying manifest URLs exist under $UPDATES_BASE/$TAG"
for url in $(MANIFEST_JSON="$(cat "$MANIFEST")" node -e 'console.log(Object.values(JSON.parse(process.env.MANIFEST_JSON).platforms).map(p=>p.url).join("\n"))'); do
  code="$(curl -sIL -o /dev/null -w '%{http_code}' --max-time 20 "$url")"
  [[ "$code" == 200 ]] || die "Manifest URL not reachable (HTTP $code): $url — pointer NOT flipped."
done
log "All manifest URLs reachable"

# Stable endpoint polled by every client — flip last, atomically. The hosting
# gateway serves no-store, so clients read it fresh.
log "Flipping stable updates/latest.json"
tcb hosting deploy "$MANIFEST" "updates/latest.json" -e "$CLOUDBASE_ENV_ID" --yes

log "Done. $TAG is live.
  Website download: $UPDATES_BASE/$TAG/  (dmg / msi)
  In-app update:    clients pick it up on next poll (≤30 min) or via 检查更新."
