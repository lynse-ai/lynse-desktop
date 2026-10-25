# Private inspiration requirements

The approved product contract is per-record encryption in the desktop capture
composer and each inspiration card. Ordinary and encrypted records coexist.

- R1: Verified accounts own separate records, files, queues, device grants and
  recovery bundles. Unowned legacy records are never claimed implicitly.
- R2: Protected text, tags, transcripts, filenames, previews and files are
  encrypted before their first durable write. No protected plaintext or raw key
  enters cloud storage, logs, diagnostics, Markdown mirrors, plugins or AI.
- R3: Opening a protected record temporarily unlocks reading. The lock action
  changes persistent protection. Removing protection never enables AI itself.
- R4: Native cryptography uses libsodium, per-version record keys, independent
  file keys, authenticated scope binding, and a password plus OS-keystore secret.
- R5: New devices need a trusted-device grant or the user's random recovery
  code. Account-password reset and operators cannot recover content.
- R6: Images and general documents support account-scoped durable storage,
  authenticated download and explicit export. Original imported files survive.
- R7: Synchronization and protection changes are versioned, replay-safe and
  recoverable after interruption. Encrypted writes never fall back to v1.
- R8: Manual lock, five minutes of inactivity, screen lock, logout and account
  change invalidate key memory, read capabilities and late asynchronous results.
- R9: Production activation requires PostgreSQL RLS, private object storage,
  backup-retention verification, cross-platform packaging tests and security review.

Non-goals: graph editing, Office editing, AI analysis of encrypted material,
platform escrow, and retroactive erasure of third-party or historical copies.
