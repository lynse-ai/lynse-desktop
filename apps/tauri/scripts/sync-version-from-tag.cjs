// Stamp the release tag's version into every version-bearing file.
//
// The git tag is the single source of truth for the release version: this
// script runs in release.yml right after checkout and writes the tag's
// semver into tauri.conf.json, apps/tauri/package.json and Cargo.toml (+ its
// lock entry), so cutting a release never edits version files by hand. The
// old three-place manual bump had already drifted (Cargo.toml lagged six
// releases behind tauri.conf.json).
//
// Usage: node sync-version-from-tag.cjs <tag>
//   tag like "v1.2.9", "v1.1.16-beta.1" or a bare "1.2.9".
//
// Behavior on odd inputs:
//   - a valid semver prerelease suffix is kept (updater manifests advertise
//     it verbatim and verify-updates asserts the full tag);
//   - a non-semver suffix (e.g. "v1.2.0-build247") is dropped with a loud
//     warning — the numeric triple still builds;
//   - a tag that carries no version at all (a branch name from a
//     workflow_dispatch without release_tag) leaves every file untouched, so
//     branch builds behave exactly as before.
//
// Exit codes: 0 = synced or intentionally skipped; 1 = the tag parsed to a
// version but a file could not be updated (a silent no-op here would ship
// the wrong version), or the version itself is unusable.

const fs = require("fs");
const path = require("path");

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");

const SEMVER = /^(\d+\.\d+\.\d+)(-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

function fail(message) {
  console.error(`::error::${message}`);
  process.exit(1);
}

const raw = process.argv[2] || process.env.LYNSE_RELEASE_TAG || "";
if (!raw) fail("no tag given: pass one as argv[1] or set LYNSE_RELEASE_TAG");

const candidate = raw.replace(/^v/, "");
const match = candidate.match(SEMVER);
if (!match) {
  // A suffix after the numeric triple that is not semver-prerelease shaped
  // (the historical "v1.2.0-build247" style): build the plain triple.
  const triple = candidate.match(/^\d+\.\d+\.\d+/);
  if (!triple) {
    console.warn(
      `::warning::"${raw}" carries no semver version — leaving checked-in versions untouched (branch build).`
    );
    process.exit(0);
  }
  console.warn(
    `::warning::tag "${raw}" has a non-semver suffix; using ${triple[0]} for the built app. Stable-channel verify-updates will reject this tag — rename it.`
  );
  stamp(triple[0]);
} else {
  stamp(match[0]);
}

function stamp(version) {
  // JSON files each contain exactly one "version" key (asserted at script
  // introduction); replace it textually to keep the diff to one line.
  for (const rel of [
    path.join("apps", "tauri", "src-tauri", "tauri.conf.json"),
    path.join("apps", "tauri", "package.json"),
  ]) {
    replaceOnce(rel, /"version":\s*"[^"]*"/, `"version": "${version}"`, rel);
  }

  // Cargo.toml: the crate version is the first line-start `version =` after
  // the [package] header. Dependency tables never start a line with it here
  // before that point, but guard by stopping at the next section header.
  const cargoRel = path.join("apps", "tauri", "src-tauri", "Cargo.toml");
  const cargo = read(cargoRel);
  const lines = cargo.split("\n");
  let inPackage = false;
  let done = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\[/.test(line)) {
      if (inPackage) break; // left [package] without finding a version
      inPackage = line.trim() === "[package]";
      continue;
    }
    if (inPackage && /^version\s*=\s*"[^"]*"/.test(line)) {
      lines[i] = line.replace(/^version\s*=\s*"[^"]*"/, `version = "${version}"`);
      done = true;
      break;
    }
  }
  if (!done) fail(`no crate version line found in ${cargoRel}`);
  writeIfChanged(cargoRel, lines.join("\n"));

  // Cargo.lock: the lone "lynse-tauri" package block — the version line
  // immediately following its name line. Without this, `cargo fetch
  // --locked` in the release job fails the build.
  const lockRel = path.join("apps", "tauri", "src-tauri", "Cargo.lock");
  const lock = read(lockRel);
  const lockLines = lock.split("\n");
  let locked = false;
  for (let i = 0; i < lockLines.length - 1; i++) {
    if (lockLines[i].trim() === 'name = "lynse-tauri"') {
      const next = lockLines[i + 1];
      if (!/^version\s*=\s*"/.test(next)) {
        fail(`entry after "lynse-tauri" in ${lockRel} is not a version line: ${JSON.stringify(next)}`);
      }
      lockLines[i + 1] = next.replace(/^version\s*=\s*"[^"]*"/, `version = "${version}"`);
      locked = true;
      break;
    }
  }
  if (!locked) fail(`no "lynse-tauri" package entry found in ${lockRel}`);
  writeIfChanged(lockRel, lockLines.join("\n"));

  console.log(`version stamped from "${raw}": ${version}`);
}

function read(rel) {
  const abs = path.join(REPO_ROOT, rel);
  if (!fs.existsSync(abs)) fail(`file not found: ${rel}`);
  return fs.readFileSync(abs, "utf8");
}

function replaceOnce(rel, pattern, replacement) {
  const content = read(rel);
  const matches = content.match(new RegExp(pattern.source, "g")) || [];
  if (matches.length !== 1) {
    fail(`expected exactly one "version" key in ${rel}, found ${matches.length}`);
  }
  writeIfChanged(rel, content.replace(pattern, replacement));
}

function writeIfChanged(rel, content) {
  const abs = path.join(REPO_ROOT, rel);
  if (fs.readFileSync(abs, "utf8") === content) return;
  fs.writeFileSync(abs, content);
  console.log(`  updated ${rel}`);
}
