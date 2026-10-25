# Private inspiration protocol, suite 1

## Identity and authorization

The server hashes `deployment_namespace + NUL + verified_identity_realm + NUL +
verified_user_id` with SHA-256 and returns the lowercase hex `account_scope`.
No JSON ownership declaration selects the tenant. Configure stable realm aliases
before exposing v2, and keep the namespace stable across service-domain moves.

The desktop binds natively before a network preflight can fail. An offline
binding survives only when the bearer fingerprint, Memory service and login
backend match the previously verified binding. Queues, drafts, views, file
capabilities and asynchronous writes are invalidated across account changes.

Protected operations additionally need an Ed25519 device signature over compact
UTF-8 JSON with recursively sorted object keys:

```json
{"account_scope":"<server scope>","action":"save","payload":{"...":"exact request without proof"}}
```

The HTTP body appends `proof: {device_id, signature}` with standard base64.
Action names are `save`, `delete`, `transition`, `commit_transition`,
`media_prepare`, `session`, `approve_device`, `consume_request`, and `rotate`.
An account bearer alone can obtain public recovery material or locked stubs.
A signed, nonce-protected session exchange grants a random, native-memory-only
`X-Lynse-Private-Session` for ciphertext transport. Revocation and key epochs are
checked before replaying idempotent responses. The token expires after 24 hours;
renewal requires an unlocked device. Locking does not grant decryption rights to
that token.

## Record wire representation

Both variants carry `id: inspiration:<uuid>`, `base_version`, `media_ids`,
`created_at`, `protection`, and `ai_context_enabled`. The optional client scope
is checked by the native transport; the server still derives the owner itself.

- `plain`: `payload` contains text, tags, images, files and optional audio.
- `e2ee`: `crypto_version: 1`, `content_revision: <uuid>`, `key_epoch`, and
  `envelope: {payload: {nonce,ciphertext}, wrapped_key: {nonce,ciphertext}}`.
  Plain payload fields are forbidden and AI must be false.

The server adds its owner, CAS version, timestamps, tombstone and separate
transition state. Content-free receipts reference the current record/version;
they cannot replay an old plaintext response after encryption. Protection
changes always leave AI disabled, including a transition back to ordinary
storage. Previously ordinary records carry `history_cleanup: unverified`;
this flag never claims that historical backups or external copies were erased.

The encrypted JSON payload contains text, tags, transcripts and the attachment
manifest. Each manifest entry has an opaque UUID `file`, original name, MIME,
size, optional image dimensions, and an independently generated 32-byte file
key. File keys are removed before IPC display. Encrypted list rows expose no
text, tags, filenames, covers or manifest keys.

## Cryptography and associated data

All encryption uses native libsodium-rs 0.3.0 and the locked transitive libsodium
build. The verified local macOS build links sodium statically. No `fetch-latest`
feature is enabled.

Envelope AAD is the compact JSON array:

```text
["lynse-inspiration",1,purpose,account_scope,record_id,revision,key_generation]
```

A random 32-byte record key is regenerated for each content revision. Payload
AAD uses purpose `payload`, the random revision UUID, and generation 0 so root
rotation can rewrap the same immutable ciphertext. Wrapped-key AAD uses
`record-key` and the root key epoch. A new random 24-byte nonce is generated for
every envelope. File AAD uses `file`, its immutable asset UUID as revision, and
file-key generation 1; changing a file creates a new asset ID and new key.

Local packages use Argon2id13, 256 MiB, three passes and libsodium's single-lane
implementation, with a random 16-byte salt. HKDF-SHA256 combines the result and
an OS-keystore-only device secret, with `local-unlock` scope AAD as context.
Packages use `device-package` AAD and XChaCha20-Poly1305. Resource failure is an
error; no parameter weakening or plaintext credential fallback exists. The
separate keyring service is `com.lynse.inspiration.e2ee.v1`.

Recovery uses a random 256-bit code with a SHA-256 checksum. The service holds
only a recovery envelope authenticated with purpose `recovery` and account
scope. The password is per account and per device, at least 12 characters, and
never leaves native IPC for a server request. New encrypted writes stay blocked until
the user acknowledges saving a newly generated recovery code.

## File format and transfer

```text
8 bytes      ASCII LYNSEF01
24 bytes     libsodium secretstream header
repeated     uint32 big-endian frame length, then authenticated ciphertext
last frame   empty plaintext with TAG_FINAL
```

Plain chunks are at most 1 MiB. The decoder rejects unknown tags, frames larger
than the limit, swapped/repeated chunks, missing final frames and trailing
bytes. New attachments and staging are ciphertext at their first app-managed
write. Source files are streamed into encrypted staging and remain untouched.
The final ciphertext is immutable, so retries reuse identical bytes.

A record or transition target exists before media registration. Register the
opaque ID, protection, ciphertext length and SHA-256, upload ordered parts, then
finalize. The server verifies every part and the total digest. Downloads return
short-lived signed URLs without forwarding the user's bearer to object storage.
The native client bounds each response, verifies all digests and renames a
completed temporary file. Signed links already issued can live until expiry.

Limits: 200 MiB source file, 201 MiB transport allowance, 9 images and 20 general
files. In-app previews allow common raster images and audio, up to 25 MiB;
larger files remain available through explicit export. SVG and HTML are not
executed. Office/PDF/ZIP files are stored and exported without server parsing.

## Transitions, devices and recovery

Cloud protection changes require connectivity. The native client durably
records a conversion intent before freezing the server version. The old content
remains intact while replacement assets and a signed commit are prepared.
An atomic row write also carries the immutable signed operation; a secondary
queue can be reconstructed after a crash. Repeated attempts reuse operation IDs.
After CAS commit and readback, app-managed old assets, Markdown mirrors and
source copies are retired. A preparation failure can be retried using the card
lock; a prepared upload is retried by sync. Conflicts preserve data and do not
silently merge ciphertext into an ordinary record.

Pairing uses fresh encryption/signing keys, a challenge, a ten-minute request
and a fingerprint that includes the locally trusted root identity. The approving
device signs a root-authorized certificate and seals the root package to the new
device public key. The recipient verifies the fingerprint-pinned root, request,
certificate and scope before consuming the request once. Public certificates
cannot be replayed to re-register a revoked device identity.

Root rotation requires fresh certificates and sealed packages for every retained
device, an old-root-signed trust link, all encrypted record versions, and a new
recovery envelope. The native pending rotation is password protected and can
resume a lost commit response. Full re-encryption additionally regenerates
record and file keys. Historical copies already possessed by revoked devices
cannot be recovered or erased by the platform.
