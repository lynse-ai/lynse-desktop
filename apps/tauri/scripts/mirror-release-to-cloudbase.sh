#!/usr/bin/env bash
# Mirror an EXISTING GitHub Release onto Tencent CloudBase static hosting — the
# endpoint the in-app updater polls first.
#
#   bash apps/tauri/scripts/mirror-release-to-cloudbase.sh v1.1.6
#   bash apps/tauri/scripts/mirror-release-to-cloudbase.sh v1.1.6 --dry-run
#   bash apps/tauri/scripts/mirror-release-to-cloudbase.sh v1.1.16-beta.1 --prerelease
#   GH_REPO=lynse-ai/lynse-desktop DIST=/tmp/x bash ... <tag>   # override
#
# Counterpart of publish-cloudbase.sh:
#   - publish-cloudbase.sh  runs on ONE build machine, publishes ONE platform,
#                           and merges the other platform's live entry.
#   - this script           takes the already-built, already-signed GitHub
#                           Release (both platforms + a merged latest.json) and
#                           republishes it to CloudBase in a single run.
#
# Why it exists: the updater serves `updates/latest.json` from CloudBase because
# GitHub Releases is throttled from mainland China. When the CI job performing
# this mirror was dropped (48602a24), GitHub kept shipping new releases while
# the live manifest silently froze at the previous version — so existing clients
# were never told an update existed.
#
# Order of operations is load-bearing: the per-tag copy is uploaded FIRST and the
# stable `updates/latest.json` pointer is flipped LAST, so a client can never be
# pointed at a file that is not there yet.
#
# Prerequisites:
#   - gh (authenticated for the private repo via GH_TOKEN), curl, node.
#   - tcb CLI: npm i -g @cloudbase/cli  (falls back to npx -y @cloudbase/cli).
#   - CLOUDBASE_API_KEY env (云开发控制台 → 环境设置 → API 密钥).
# JSON is read with node rather than jq: jq is not installed on a typical
# Windows/Git-Bash box, and a human has to be able to run this by hand.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"

CLOUDBASE_ENV_ID="${CLOUDBASE_ENV_ID:-lynse-d8g49o1i956741f9e}"
UPDATES_BASE="${UPDATES_BASE:-https://dl.lynse.cn/updates}"
GH_REPO="${GH_REPO:-${GITHUB_REPOSITORY:-lynse-ai/lynse-desktop}}"

# Both platform keys the updater can ask for. A manifest missing either one
# strands that entire population on the old version.
REQUIRED_PLATFORMS=("darwin-aarch64" "windows-x86_64")

DRY_RUN=false
PRERELEASE=false
TAG=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=true ;;
    --prerelease) PRERELEASE=true ;;
    -h|--help) grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*) printf 'Unknown option: %s\n' "$1" >&2; exit 1 ;;
    *) TAG="$1" ;;
  esac
  shift
done

log() { printf '\n==> %s\n' "$*"; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

# manifest_query <file> <javascript expression over `m`>
# Prints the expression result; empty string when a path is missing.
manifest_query() {
  MANIFEST_FILE="$1" EXPR="$2" node -e '
    const fs = require("fs");
    const m = JSON.parse(fs.readFileSync(process.env.MANIFEST_FILE, "utf8"));
    const out = eval(process.env.EXPR);
    process.stdout.write(out == null ? "" : String(out));
  '
}

[[ -n "$TAG" ]] || die "Usage: mirror-release-to-cloudbase.sh <tag> [--dry-run]"
# Tags carry build counters with parentheses in this repo's history (v1.1.4(2)),
# so only the vN.N.N prefix is validated; the object key is percent-encoded below.
[[ "$TAG" =~ ^v[0-9]+\.[0-9]+\.[0-9]+ ]] || die "Tag must start with vN.N.N, got: $TAG"
if [[ "$TAG" == *-* ]]; then
  [[ "$PRERELEASE" == true ]] || die "Prerelease tags require --prerelease; stable updates must stay unchanged."
elif [[ "$PRERELEASE" == true ]]; then
  die "--prerelease requires a prerelease tag."
fi

for tool in gh curl node; do
  command -v "$tool" >/dev/null || die "$tool not found on PATH"
done

DIST="${DIST:-$ROOT/apps/tauri/src-tauri/target/cloudbase-mirror/$TAG}"
if [[ "${KEEP_DIST:-false}" != true ]]; then rm -rf "$DIST"; fi
mkdir -p "$DIST"

# ── 1. pull the release assets (installers, .sig, latest.json, STT runtime) ──
log "Downloading release $TAG (repo $GH_REPO) into $DIST"
gh release download "$TAG" --repo "$GH_REPO" --dir "$DIST" --clobber \
  || die "Could not download release $TAG — is the tag published, and is GH_TOKEN/gh auth valid for $GH_REPO?"

MANIFEST="$DIST/latest.json"
[[ -s "$MANIFEST" ]] || die "Release $TAG has no latest.json — it was built without updater artifacts
  (release.yml needs includeUpdater: true plus TAURI_SIGNING_PRIVATE_KEY)."

# ── 2. the release manifest must be complete before anything is mirrored ─────
log "Checking the release manifest"
MANIFEST_VERSION="$(manifest_query "$MANIFEST" 'm.version')"
[[ -n "$MANIFEST_VERSION" ]] || die "latest.json has no .version"
for platform in "${REQUIRED_PLATFORMS[@]}"; do
  [[ -n "$(manifest_query "$MANIFEST" "m.platforms?.['$platform']?.url")" ]] \
    || die "latest.json has no \"$platform\" entry, so that platform was never built for $TAG
  (a macOS dmg-only build produces no .app.tar.gz and therefore no darwin entry).
  Refusing to publish a manifest that would strand half the installed base."
done
echo "manifest version=$MANIFEST_VERSION, platforms: $(manifest_query "$MANIFEST" 'Object.keys(m.platforms ?? {}).join(", ")')"

# ── 3. rewrite URLs to the CloudBase base, then prove every asset came along ─
TAG_ENC="$(TAG="$TAG" node -e 'console.log(encodeURIComponent(process.env.TAG))')"
BASE="$UPDATES_BASE/$TAG_ENC"
MANIFEST_FILE="$MANIFEST" BASE="$BASE" RELEASE_NOTES_FILE="$ROOT/apps/tauri/release-notes/$MANIFEST_VERSION.json" node -e '
  const fs = require("fs");
  const file = process.env.MANIFEST_FILE;
  const m = JSON.parse(fs.readFileSync(file, "utf8"));
  if (fs.existsSync(process.env.RELEASE_NOTES_FILE)) {
    const notes = JSON.parse(fs.readFileSync(process.env.RELEASE_NOTES_FILE, "utf8"));
    for (const locale of ["en", "zh-Hans", "zh-Hant", "ja", "ko"]) {
      if (typeof notes[locale] !== "string" || !notes[locale].trim()) throw new Error(`Missing release notes for ${locale}`);
    }
    m.notes_i18n = notes;
    m.notes = notes.en;
  }
  for (const [platform, entry] of Object.entries(m.platforms ?? {})) {
    const name = new URL(entry.url).pathname.split("/").pop();
    if (!name) throw new Error(`${platform}: cannot derive an asset name from ${entry.url}`);
    entry.url = `${process.env.BASE}/${encodeURIComponent(name)}`;
  }
  fs.writeFileSync(file, JSON.stringify(m, null, 2) + "\n");
'

log "Verifying every referenced asset was downloaded and is signed"
# Process substitution, not a pipe: inside `| while` the body runs in a subshell
# where `die` cannot abort this script, so a failed check would fall through to
# the pointer flip.
while IFS=$'\t' read -r platform url signature; do
    name="${url##*/}"
    name="$(node -e 'console.log(decodeURIComponent(process.argv[1]))' "$name")"
    [[ -s "$DIST/$name" ]] || die "$platform: $name is referenced by latest.json but was not downloaded"
    [[ -n "$signature" ]] || die "$platform: latest.json carries no minisign signature — clients would reject the update"
    echo "  ok $platform -> $name ($(wc -c <"$DIST/$name") bytes)"
  done < <(MANIFEST_FILE="$MANIFEST" node -e '
    const fs = require("fs");
    const m = JSON.parse(fs.readFileSync(process.env.MANIFEST_FILE, "utf8"));
    for (const [k, v] of Object.entries(m.platforms ?? {})) {
      process.stdout.write(`${k}\t${v.url}\t${v.signature ?? ""}\n`);
    }
  ')

log "Rewritten manifest:"
cat "$MANIFEST"

if [[ "$DRY_RUN" == true ]]; then
  log "Dry run — nothing uploaded. Manifest kept at $MANIFEST"
  exit 0
fi

# ── 4. upload: per-tag copy first, pointer last ──────────────────────────────
[[ -n "${CLOUDBASE_API_KEY:-}" ]] || die "CLOUDBASE_API_KEY is not set (云开发控制台 → 环境设置 → API 密钥)."
if ! command -v tcb >/dev/null; then
  tcb() { npx -y @cloudbase/cli "$@"; }
fi

log "Uploading everything to updates/$TAG_ENC (per-tag copy first…)"
tcb login --cloudbase-api-key "$CLOUDBASE_API_KEY" -e "$CLOUDBASE_ENV_ID"
# Deploy to the encoded path so the object key always matches the URLs written
# into latest.json — a mismatch would 404 clients onto a file that exists under
# a different name.
tcb hosting deploy "$DIST" "updates/$TAG_ENC" -e "$CLOUDBASE_ENV_ID"

log "Confirming each asset is live before flipping the pointer"
while read -r url; do
  code="$(curl -sIL -o /dev/null -w '%{http_code}' --max-time 20 "$url")"
  [[ "$code" == 200 ]] || die "Asset not reachable (HTTP $code): $url — pointer NOT flipped."
done < <(MANIFEST_FILE="$MANIFEST" node -e '
  const fs = require("fs");
  for (const v of Object.values(JSON.parse(fs.readFileSync(process.env.MANIFEST_FILE, "utf8")).platforms ?? {})) {
    process.stdout.write(`${v.url}\n`);
  }
')

if [[ "$PRERELEASE" == true ]]; then
  log "Prerelease available at $BASE — stable manifest and download aliases unchanged"
  exit 0
fi

log "Flipping stable updates/latest.json"
tcb hosting deploy "$MANIFEST" "updates/latest.json" -e "$CLOUDBASE_ENV_ID"

# ── 5. post-flip read-back ───────────────────────────────────────────────────
# The old flow never confirmed its own result: a flip that silently failed looked
# identical to a successful one, which is how the live manifest sat on 1.1.0
# across several releases.
log "Reading the live manifest back"
LIVE_FILE="$DIST/latest.live.json"
curl -fsSL --max-time 20 "$UPDATES_BASE/latest.json?cb=$(date +%s)" -o "$LIVE_FILE" \
  || die "Could not read $UPDATES_BASE/latest.json after the flip"
SERVED="$(manifest_query "$LIVE_FILE" 'm.version')"
[[ -n "$SERVED" ]] || die "Live manifest is not valid JSON: $LIVE_FILE"
[[ "$SERVED" == "$MANIFEST_VERSION" ]] \
  || die "Flip did not take: live manifest serves \"$SERVED\", expected \"$MANIFEST_VERSION\".
  Check the CloudBase deploy output and hosting cache."
for platform in "${REQUIRED_PLATFORMS[@]}"; do
  [[ -n "$(manifest_query "$LIVE_FILE" "m.platforms?.['$platform']?.url")" ]] \
    || die "Live manifest lost the \"$platform\" entry after the flip"
done

log "Live manifest confirmed: $SERVED ($(manifest_query "$LIVE_FILE" 'Object.keys(m.platforms ?? {}).join(", ")'))"

# ── 6. refresh the version-less stable download aliases ─────────────────────
# dl.lynse.cn/updates/latest/ holds copies of the two installers under
# version-less filenames — the fixed URLs the website download page (and any
# manually shared link) points at. Refreshing them here keeps every published
# link forever current; the next cleanup can then delete old updates/<tag>/
# dirs without breaking anything.
log "Refreshing stable aliases under updates/latest/"
STABLE_DMG="$(printf '%s\n' "$DIST"/Lynse_*_aarch64.dmg | head -1)"
STABLE_MSI="$(printf '%s\n' "$DIST"/Lynse_*_x64_en-US.msi | head -1)"
[[ -s "$STABLE_DMG" ]] || die "No aarch64 dmg in the release assets — cannot refresh updates/latest/."
[[ -s "$STABLE_MSI" ]] || die "No x64 msi in the release assets — cannot refresh updates/latest/."
tcb hosting deploy "$STABLE_DMG" "updates/latest/Lynse_aarch64.dmg" -e "$CLOUDBASE_ENV_ID"
tcb hosting deploy "$STABLE_MSI" "updates/latest/Lynse_x64_en-US.msi" -e "$CLOUDBASE_ENV_ID"
for url in "$UPDATES_BASE/latest/Lynse_aarch64.dmg" "$UPDATES_BASE/latest/Lynse_x64_en-US.msi"; do
  code="$(curl -sIL -o /dev/null -w '%{http_code}' --max-time 20 "$url?cb=$(date +%s)")"
  [[ "$code" == 200 ]] || die "Stable alias not reachable after refresh (HTTP $code): $url"
  echo "  ok $url"
done

echo "In-app updates for $TAG are now served. Existing clients learn about it on"
echo "their next launch, or within 30 minutes via the updater poll."
