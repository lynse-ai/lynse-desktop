#!/usr/bin/env node
/**
 * Inject (or remove) Tauri's `bundle.windows.signCommand` in
 * apps/tauri/src-tauri/tauri.conf.json.
 *
 * We deliberately target the MAIN config rather than tauri.windows.conf.json:
 * the platform-specific file is merged by the CLI, and we do not want the
 * signature to depend on merge semantics (a shallow merge would drop the
 * existing bundle.targets / icon / resources). This step only runs on the
 * Windows runner, so macOS builds keep a clean config. The checked-in file is
 * untouched: this mutates the CI working copy only, like
 * sync-version-from-tag.cjs already does for the version.
 *
 * The release workflow runs this on the Windows runner immediately before
 * `tauri build`, with the ABSOLUTE path of sign-windows.ps1. Tauri parses the
 * signCommand string into argv (no shell) and replaces a standalone `%1`
 * token with the binary path as one argv element, so binary paths containing
 * spaces are safe. We cannot hard-code a relative script path in the
 * checked-in config because the working directory of `tauri build` is not
 * guaranteed (tauri-action uses projectPath, the CLI resolves src-tauri).
 *
 * Why signing must be configured here rather than done after the build:
 * Tauri signs the main exe and the MSI during bundling and only afterwards
 * computes the minisign updater .sig. Re-signing the MSI post-build changes
 * its bytes and invalidates that .sig, breaking every in-app update.
 *
 * Usage:
 *   node configure-windows-signing.cjs --script <abs path to sign-windows.ps1>
 *   node configure-windows-signing.cjs --off
 */
const fs = require('node:fs');
const path = require('node:path');

const CONF = path.resolve(__dirname, '../src-tauri/tauri.conf.json');

function arg(name) {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
}

const off = process.argv.includes('--off');
const script = arg('--script');

if (!off && (!script || !fs.existsSync(script))) {
  console.error('usage: node configure-windows-signing.cjs --script <abs path> | --off');
  process.exit(1);
}

const conf = JSON.parse(fs.readFileSync(CONF, 'utf8'));
conf.bundle = conf.bundle || {};
conf.bundle.windows = conf.bundle.windows || {};

if (off) {
  delete conf.bundle.windows.signCommand;
  if (Object.keys(conf.bundle.windows).length === 0) delete conf.bundle.windows;
  if (Object.keys(conf.bundle).length === 0) delete conf.bundle;
} else {
  // Forward slashes keep argv splitting unambiguous on Windows. The config
  // is parsed as a plain string, so a script path with spaces cannot be
  // quoted reliably; reject it with a clear message instead.
  const normalized = script.replace(/\\/g, '/');
  if (/\s/.test(normalized)) {
    console.error(`sign script path must not contain spaces: ${normalized}`);
    process.exit(1);
  }
  conf.bundle.windows.signCommand =
    `pwsh -NoProfile -ExecutionPolicy Bypass -File ${normalized} -Files %1 -Verify`;
}

fs.writeFileSync(CONF, `${JSON.stringify(conf, null, 2)}\n`);
console.log(off
  ? 'Windows signCommand removed'
  : `Windows signCommand -> ${conf.bundle.windows.signCommand}`);
