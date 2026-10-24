# Knowledge memory v0.4 implementation and release record

The source implementation is present in Desktop and Lynclaw. This record distinguishes tests, builds and production acceptance.

## Current delivery

- Desktop 1.2.0: shared memory management, source explanations, candidate confirmation previews, corrections and forgetting previews; shared range controls and independent consent; Native local text synchronization; Wiki publication events and source checks; qualified MCP reads; account-scoped drafts; local four-state to-dos.
- Memory protocol 4: structured provenance and authorization dependencies, multi-fragment evidence, permanent body-free operation receipts, current-authority replay, upload sessions and aliases, transactional review and forgetting, durable cleanup, quota-bound worker processing and compiled read-only projections.
- Runtime: explicit token-bound proxy routes and source verification, guarded source reads, authority epochs for automatic history and tool-result replay, and an opt-in worker managed by the API lifespan.
- Withdrawal journals persist to immutable CloudBase storage objects before the database acknowledgement. Local files are an export/cache, not the production durability boundary.

## Fresh-system decision

The user approved a fresh system on 2026-10-24. Production uses a new empty `knowledge_v4` schema and a dedicated non-superuser, non-BYPASSRLS runtime account. No old memory records, cache or Markdown files are imported. Existing database objects remain intact and isolated. `LYNSE_MEMORY_KNOWLEDGE_FRESH=1` enforces structured eligibility even before an account enrolls; old unstructured writes cannot become usable memory.

## Validation evidence

- Full Desktop TypeScript suite: seven tasks passed; views 643 passed / one skipped, core 121 passed, Tauri renderer 36 passed. Type checks: four tasks passed.
- Desktop renderer flows: 11 of 12 passed in the main run; the remaining draft-navigation failure was fixed, and both affected draft/zoom cases passed on rerun. The memory confirmation/forgetting flow passed with Wiki disabled.
- Native Rust: 349 passed / four ignored in the full suite; cargo check passed. Actual native-app acceptance remains separate from renderer tests.
- Backend prior full suite: 2803 tests passed / 79 skipped; agent regression 119/119; actual local PostgreSQL: five acceptance tests passed including pg_dump/restore and FORCE RLS. Release-specific backend rerun: 2809 tests passed / 79 skipped after deployment-hardening changes; agent regression 119/119.
- The new PG and Runtime integration checks use synthetic users and local services, never production credentials in test fixtures.

## Production status

- Target: CloudBase environment `lynse-d8g49o1i956741f9e`, Shanghai; existing services `lynse-memory` and `lynclaw-api`.
- Verified existing dedicated PostgreSQL instance: `postgres-dcsis2lm`, 1 CPU / 2 GiB / 20 GB; its private VPC/subnet were read from the provider API.
- Existing Memory deployment uses the REST adapter and is not suitable for protocol 4 transactions. It has not been switched to the new implementation yet.
- `TCB_QcsRole` was denied `postgres:CreateAccount`. The required cloud authorization is pending; no database account or schema was created by the denied request.
- Desktop version is 1.2.0. The release workflow supports an explicitly named draft build, so installers can be built without updating the stable manifest.
- Production images, schema migration, deployment, gateway acceptance, installer build/signing and stable publication are recorded only after their actual results are verified.

## Remaining boundaries

Ordinary-chat background extraction, explicit suppression-release/re-remember previews, historical multi-day projection backfill, notification delivery/Gmail adapters, and business to-do four-state persistence remain unadvertised or incomplete. The existing business to-do provider delegates to the Lynse business API; Runtime source alone does not establish backend four-state support. Full P0-P7 acceptance is not claimed.

See [the phase plan](plan-v0.4.md) and Lynclaw `docs/knowledge-memory-v04.md` for requirements and operation procedures.
