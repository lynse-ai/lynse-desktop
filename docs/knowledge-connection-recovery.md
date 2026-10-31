# Knowledge connection recovery

## Behavior

- Cloud requests share a pooled client and single-flight verified backend registration. The in-memory binding expires after 240 seconds and is isolated by account, gateway, token hash and runtime generation.
- Read-only requests and idempotent backend registration allow at most two attempts within a shared 35-second budget. Connection attempts are bounded to 8 seconds. Retry-After is honored across requests to the same session, including values beyond the immediate retry budget.
- Policy updates, source uploads and event writes are never automatically replayed by this transport. Model generation does not use this retry path.
- Persisted transient setup failures allow a fresh authorization check. Only successful checks clear the connection failure and release failed source work. Login rejection, policy conflicts, source scope changes and validation failures require their existing explicit recovery actions.
- A failed setup check resets the displayed stage to preparing; it does not display an earlier topic's compilation progress. Completed catalog chunks, stable identities and published pages are retained.
- Technical failures retain a safe stage and reason, such as identity_binding/timeout or capabilities/connect. URLs, credentials and raw upstream responses are excluded. Connection guidance opens knowledge base connection settings.
- Reading cloud policy no longer holds the local commit lock during network requests. Policy writes commit pending changes before network access and verify the operation ID before applying the response.

## Gateway and memory service

The matching Lynclaw source snapshot is `14ca6ea4a4aab37206c3a6443bbd8e3d1697f253`. It includes the previously verified memory row-lock and capability snapshot fixes, catalog diagnostics and the following connection changes:

- Backend binding persistence runs on the HTTP executor instead of blocking the ASGI event loop.
- Memory identity checks share the existing verified identity cache populated during registration. A bound token uses exactly its selected gateway.
- Explicit authentication rejection returns 401; temporary identity dependency failures return 503. Neither failure is cached as a successful identity.

Test environment: `lynse-staging-d0gswcvxwa1831b14`. Images: `lynse-memory:466066b1` and `lynclaw-api:466066b1`. Online versions: memory 007 and API 003. Existing configuration and secrets are preserved. The CNB branch was restored to its skeleton after the build was triggered; both image manifests were verified anonymously as linux/amd64.

## Validation

- Native Workbench: 165 passed, 5 ignored. Tests cover shared binding, expiry, token/runtime changes, authentication rejection, source scope conflicts, transient failure recovery, Retry-After, write non-replay and safe diagnostics.
- Views: 729 passed, 1 skipped. Views and desktop TypeScript checks passed.
- Desktop Playwright: 10 passed, including connection guidance, cloud reconnect without changing drafts or consent, and preservation of saved topic revisions. Legacy feature exposure is explicitly enabled for these fixtures; packaged login uses the unified official default.
- Gateway/identity/catalog/citation/graph tests: 92 passed, 1 optional PostgreSQL test skipped in that run. Memory adapter and knowledge tests: 30 passed.
- Real isolated PostgreSQL: 4 passed, including concurrent background row locks, capability snapshot tenant isolation and the real gateway/HTTP memory round trip.
- Agent regression: 121/121 scenarios; runtime tests: 210 passed. Built-in skill version check passed.
- Staging health and authentication smoke checks are run after deployment, without model generation.

Before restart, a local state snapshot preserved 630 published topics, 645 total topics and 338 successful catalog chunks. The snapshot is local to the test machine; it is not included in the repository or image.

## Live verification (2026-10-30)

- Both services are normal at 100% traffic. Health and authentication smoke checks passed 5/5. Environment key sets and network/runtime configuration match the previous versions (ignoring access-type ordering).
- The current test account loaded its cloud knowledge policy successfully. Service logs confirm backend registration and capability reads returned HTTP 200.
- Local Lynse 1.2.2 build 1030.1.1 was started with the unified official login surface. The installed copy in `~/Applications/Lynse.app` was updated to the same build and passed code-signature verification; the prior bundle was backed up locally.
- The connection setup failure was cleared and the worker advanced through source analysis into compilation. All 338 pre-existing catalog cache keys remained present; the 630 saved topic pages were present after restart, with no revision changed by startup.
- Remaining AI citation validation failures are kept as separate source failures with their reference location and actual correction attempt. They do not indicate a connection failure and are not accepted as successful output.
