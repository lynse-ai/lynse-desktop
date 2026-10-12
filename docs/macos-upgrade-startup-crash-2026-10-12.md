# macOS upgrade startup crash (2026-10-12)

A local 1.1.10 crash report records SIGABRT after fern's stdout fallback panicked and the panic hook re-entered the failing logger. The same logging code was present in 1.1.12. Closing both output pipes of a separate process reproduces SIGABRT with the old sink; the production best-effort writer exits successfully under the same conditions. The affected user's own crash report is not available, so this verifies a concrete startup crash path rather than attributing every reported crash to it.

The fix tolerates stdout/file I/O failures and writes panic diagnostics independently of the global logger. Logging and the panic hook are installed before desktop MCP bootstrap. Existing log retention and daily rotation remain intact.

Checks:

```sh
cargo test --manifest-path apps/tauri/src-tauri/Cargo.toml --lib --offline
python3 apps/tauri/scripts/test-logging-relaunch.py
```

Before publishing macOS updates, `verify-macos-release.sh` checks the version, bundle identity, Developer ID team, deep signature, Gatekeeper acceptance, stapled notarization, and matching app seals in the actual updater archive and DMG. `publish-cloudbase.sh` runs this gate before uploading or changing the stable manifest.

The original 1.1.12 updater passes system signature verification and Gatekeeper assessment. A sandbox-only codesign failure did not reproduce when system security services were accessible; it is not evidence of a damaged release signature.
