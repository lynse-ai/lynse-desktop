# Lynse Integrations BFF

Contract adapter between the Lynse desktop Connections UI (and the lynclaw
assistant) and a self-hosted
[OpenConnector](https://github.com/oomol-lab/open-connector) gateway.

- Contract: `docs/connections-api-contract.md` (Pocket-shape `/api/v2/integrations/*`)
- Response shapes mirror `e2e/fixtures/integrations-mock.ts` — the desktop
  client and its error predicates were written against that fixture.
- Runs on the overseas Tencent VPS next to the gateway; nginx routes
  `https://www.lynse.ai/api/v2/{integrations,calendar}/` here and
  `https://www.lynse.ai/oc/` to the gateway (the gateway strips its `/oc`
  mount path itself, driven by `OOMOL_CONNECT_ORIGIN`).

## Modes: legacy vs multiuser (rollout flag)

`CONNECTORS_MULTIUSER=1` switches the whole service onto the per-principal
registry. The default keeps the legacy single-tenant debug behaviour (shared
JSON state, no auth) untouched — flip the flag only after the state migration
below, per the rollout plan (step 12.3).

Multiuser mode:

- **Identity**: every request must carry the user's Lynse accessToken; it is
  verified at the server-pinned `IDENTITY_URL` (lynclaw
  `GET /api/connectors/identity`). Client-claimed user ids and gateway keys
  never grant access. Verification results are cached by token hash (TTL +
  capacity bound); tokens are never persisted.
- **Registry**: accounts, authorization requests, summary docs and the feishu
  self-serve app live in SQLite (`node:sqlite`, WAL) keyed by the verified
  principal. `request_id`/`account_id` are location references, not
  capabilities — ownership is checked on every access.
- **OAuth**: every connect attempt mints a per-request gateway
  `connectionName` alias (`lynse-<request id>`, TTL 10 min); completion binds
  only the connection whose alias (and upstream authorization id) matches,
  in one transaction. Reconnects keep the product account id; a new pending
  request supersedes the old one for the same target; completed results stay
  queryable (identically) for the retention window.
- **Read endpoint** (lynclaw, step 7): `POST /api/v2/integrations/{provider}/read`
  with `{ operation, arguments, account_id? }` answers
  `ok` / `connection_required` / `account_selection_required` /
  `unknown_account` / `rate_limited` / `unavailable` / `invalid_input`.
  Provider ids accept kebab (`google-calendar`) and snake (`google_calendar`).
  Only the operations in `src/read.mjs` (`READ_REGISTRY`) are accepted; the
  gateway action id, HTTP method and URL are fixed server-side.
- **Connection pinning**: gateway action calls never run on "whatever the
  gateway picks". The BFF mints an opaque runtime token per
  (connection, action) via the gateway admin API `POST /api/runtime-tokens`
  with an `allowedConnections: [id]` policy — read calls additionally pin
  `allowedActions` to the single whitelisted action — and executes with it.
  (The gateway's own runtime-JWT mode is JWKS/asymmetric and stays OFF; no
  shared secret exists.) Minted tokens live in the BFF's memory only, are
  named `lynse-bff-*` and revocable in the gateway. Without ADMIN_TOKEN the
  read path fails closed (`connection_selection_unavailable`) once a service
  has more than one connection — it never silently runs on the wrong account.
- **Disconnect** deletes exactly the selected connection
  (`DELETE /api/connections/{service}/{connectionId}`) and refuses to fall
  back to the service-wide delete.

## Deploy (server: `tencent` ssh alias → ubuntu@43.130.12.243)

```bash
ssh tencent 'mkdir -p ~/apps/open-connector/bff'
scp -r services/integrations-bff/{server.mjs,src,tools} tencent:apps/open-connector/bff/
ssh tencent 'cd apps/open-connector && docker compose up -d integrations-bff'
```

The compose service bind-mounts `./bff` into `/srv` (multiuser mode needs the
whole directory, not just `server.mjs`) and keeps state in the `bff-state`
volume at `/data`.

## Deploy checklist (step 1 — verify before enabling multiuser)

Cloud state as of 2026-10-08: NOT yet verified (the `tencent` SSH alias does
not resolve from the dev machine). Each item needs on-server confirmation
before the flag flip; do not check items off from this file.

1. [x] Compose file: gateway runs `ghcr.io/oomol-lab/open-connector@sha256:61e5e29a…`
       (Node 24 inside; `:latest` tag — consider pinning the digest in compose).
       Upstream capabilities CONFIRMED on the running image (2026-10-08):
       `POST /api/oauth/authorizations` honors `connectionName`
       (connect-server.ts `readConnectionName`), connection summaries carry
       `oauthAuthorizationId`, and `POST /api/runtime-tokens` mints
       policy-scoped tokens (`allowedConnections`/`allowedActions`).
2. [x] Gateway env: `OOMOL_CONNECT_ADMIN_TOKEN` / `RUNTIME_TOKEN` /
       `ENCRYPTION_KEY` / `ORIGIN` all set. ACTION: the data volume was
       created ~3.5h BEFORE `.env` gained the encryption key (2026-10-05
       18:25 vs 22:02) — run the upstream rotate tool
       (`runtime:data` → `node scripts/runtime-data.ts`) once to re-encode
       any rows written plaintext in that window.
3. [ ] Reverse proxy: `/oc/` → :3100, `/api/v2/{integrations,calendar}/` →
       :3101, `/api/` → :3001 all route correctly, BUT the gateway admin API
       is publicly reachable under `https://www.lynse.ai/oc/api/*`
       (answers 401, bearer-only). Add an nginx deny for `/oc/api/` (and
       consider `/oc/v1/`) so the admin surface is not public at all.
4. [ ] BFF deployment shape: currently bind-mounts the SINGLE file
       `bff/server.mjs`. Multiuser mode needs the directory:
       `- ./bff:/srv:ro` (compose `command: node server.mjs` unchanged), plus
       the multiuser env block below. Persistent volume `bff-state` → `/data`
       already holds `state.json` (migration input, present, 6.8 KB).
5. [x] BFF image `node:22-alpine` runs v22.23.3 — `node:sqlite` available.
6. [ ] `IDENTITY_URL` BLOCKING: not set, and nothing serves lynclaw's
       `/api/connectors/identity` on this server (only gateway + BFF run
       here). Deploy lynclaw — or a minimal identity sidecar — somewhere the
       BFF container can reach, then set `IDENTITY_URL`.
7. [x] Connection pinning needs NO extra secret: scoped runtime tokens are
       minted with the BFF's existing ADMIN_TOKEN (verified against the
       running gateway's API surface). Keep `OOMOL_CONNECT_JWT_*` unset.
8. [ ] Provider OAuth apps: `googlecalendar` ✅ and `googletasks` ✅ are
       configured on the gateway; `notion` ❌ is NOT (`configured=false`) —
       register/configure the Notion connection (incl. developer-side content
       sharing scope) before enabling that provider. Only ONE real connection
       exists today (googlecalendar, `connectionName=default`), so the
       migration mapping is trivial.

Config sample (no real credentials):

```env
PORT=3101
GW=http://127.0.0.1:3100/oc
ADMIN_TOKEN=...            # gateway admin token (server-side only); also authorizes scoped-token minting
RUNTIME_TOKEN=...          # gateway runtime token
CONNECTORS_MULTIUSER=1
CONNECTORS_DB_FILE=/data/connectors.sqlite3
IDENTITY_URL=https://<lynclaw-host>/api/connectors/identity
CONNECTORS_PROVIDERS=google_calendar,google_tasks,notion
CONNECTORS_AUTH_TTL_MS=600000
```

## Migration (legacy state → registry)

```bash
# 1. review the mapping (explicit principal per connection id — no email guessing)
cat > mappings.json <<'EOF'
[ { "connection_id": "<gateway connection id>", "principal": "<lynse user id>" } ]
EOF
# 2. dry-run report (creates/conflicts/unmapped)
node tools/migrate-state.mjs --state /data/state.json --db /data/connectors.sqlite3 --mapping mappings.json
# 3. apply (idempotent; writes state.json.backup first)
node tools/migrate-state.mjs --state /data/state.json --db /data/connectors.sqlite3 --mapping mappings.json --apply
```

Unmapped connections stay invisible in multiuser mode — their owners just
reconnect in the browser; the legacy file remains untouched as the rollback
copy.

## Tests

```bash
cd services/integrations-bff
node --test "test/*.test.mjs"
```

Covers the offline matrix of the implementation plan: concurrent
authorization isolation, multi-account reads with connection pinning (JWT
claim asserted), cross-user denial, reconnect stability, expiry, restart
recovery, read whitelist, precise disconnect.

## Known limitations / pending verification

- Gateway action ids and output field mappings in `src/read.mjs` follow the
  existing BFF calls but still need per-action verification against the
  deployed gateway (plan step 7.4) — mappers unwrap defensively.
- Single-process assumption: `DatabaseSync` + in-process locks. Multi-instance
  deployments need a real cross-instance refresh/claim lock first.
- Feishu device-registration sessions are in-memory (short-lived; a restart
  means redoing the guided setup).
- `export` still receives only `action_item_ids`; the business backend owns
  the action-item rows, so tasks are titled `Lynse action item: <id>` until
  the real backend resolves text.
- Notion capability scope also depends on the developer-side connection
  settings (user content sharing), not just local whitelists.
