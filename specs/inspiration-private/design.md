# Private inspiration design

Native Rust owns encryption and decrypted sessions. Renderers receive display
content and revocable read capabilities, never root, record or device keys.
The Memory v2 data plane receives only opaque envelopes for protected records.

## Cryptographic suite 1

- libsodium-rs 0.3.0; XChaCha20-Poly1305 envelopes and secretstream file frames.
- Random 32-byte account root; random record key for every content revision;
  random file keys. AEAD associated data binds account, record, revision and epoch.
- Local unlock uses Argon2id (256 MiB, three passes) followed by HKDF-SHA256
  incorporating a separate OS-keystore device secret. No debug-file fallback.
- Device encryption and signing keys are password protected. Recovery is a
  random 256-bit code with a checksum, not a server-resettable password.
- Cipher files use 1 MiB frames and require a final secretstream tag. Filenames,
  MIME types and keys are kept inside the encrypted manifest.

## Storage and protocol

Stable server-issued account scopes partition local storage and server rows.
Protected records use an explicit `e2ee` discriminator, opaque crypto envelope,
key epoch and content revision; transition state is separate. Normal records
remain supported. All protection changes use CAS and operation identifiers.
The private data plane requires transactional PostgreSQL and FORCE RLS.

Existing cloud records freeze AI/source consumption before conversion. Commit
switches the authoritative version, then cleans up old managed copies. Legacy
unowned data stays quarantined. Historical backup cleanup is reported separately.

## Trust boundaries

Encrypted records are ineligible for every AI, MCP, plugin, Wiki and automatic
export path even while unlocked. Locking revokes capabilities and session epochs.
Recovery and paired-device public keys are authenticated at the device boundary;
the server cannot silently enroll a replacement device. Metadata, denial of
service, compromised endpoints and copies already exported remain outside E2EE.
