# Lynse Integrations BFF

Contract adapter between the Lynse desktop Connections UI and a self-hosted
[OpenConnector](https://github.com/oomol-lab/open-connector) gateway.

- Contract: `docs/connections-api-contract.md` (Pocket-shape `/api/v2/integrations/*`)
- Response shapes mirror `e2e/fixtures/integrations-mock.ts` — the desktop
  client and its error predicates were written against that fixture.
- Runs on the overseas Tencent VPS next to the gateway; nginx routes
  `https://www.lynse.ai/api/v2/{integrations,calendar}/` here and
  `https://www.lynse.ai/oc/` to the gateway (the gateway strips its `/oc`
  mount path itself, driven by `OOMOL_CONNECT_ORIGIN`).

## Why a BFF

OpenConnector is a single-tenant gateway with no end-user model. Lynse needs
per-user, Pocket-shaped endpoints plus gating, so the adapter owns the contract
(accounts, toggles, destinations) and forwards credentials-bound work to the
gateway, whose encrypted store keeps all third-party tokens (contract §1).

## Deploy (server: `tencent` ssh alias)

```bash
scp services/integrations-bff/server.mjs tencent:apps/open-connector/bff/
ssh tencent 'cd apps/open-connector && docker compose up -d integrations-bff'
```

`docker-compose.yml` on the server defines `integrations-bff` (node:22-alpine,
bind-mounts `bff/server.mjs`, state volume `/data`, port `127.0.0.1:3101`).
Gateway env lives in `apps/open-connector/.env`
(`OOMOL_CONNECT_ADMIN_TOKEN` / `OOMOL_CONNECT_RUNTIME_TOKEN` /
`OOMOL_CONNECT_ENCRYPTION_KEY` / `OOMOL_CONNECT_ORIGIN=https://www.lynse.ai/oc`).

## Provider status (2026-10-05)

| Provider | Chain | Notes |
|---|---|---|
| todoist | ✅ status / destinations / export | API-key connection created via gateway admin API |
| google-calendar | status + OAuth passthrough | needs an OAuth app registered with redirect `https://www.lynse.ai/oc/oauth/callback`; calendar events (phase 2) return `connected:false` |
| outlook-calendar / notion / google-tasks | status only | destinations/export answer 503 `not_configured` |

## Known simplification (to fix when the real backend lands)

`export` receives only `action_item_ids`; the business backend owns the
action-item rows, so this BFF cannot resolve their text and creates Todoist
tasks titled `Lynse action item: <id>` as a placeholder. The real Lynse
backend must resolve ids → content (and take over auto-export scheduling).
