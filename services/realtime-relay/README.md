# Lynse realtime relay

Plan-B credential isolation for live translation: the desktop client speaks
the DashScope realtime protocol to this relay with its Lynse accessToken;
the relay authenticates the principal (lynclaw identity endpoint, the same
authority as `services/integrations-bff`), opens the real DashScope
websocket with the **server-held** `DASHSCOPE_API_KEY`, and pipes frames
both ways. The API key never reaches a client device.

Deployed as CloudBase CloudRun container `lynse-realtime-relay` in the
`lynse` environment (ap-shanghai — same region as DashScope, no cross-border
hop). Runs on the `ws` package only.

## Configuration (env)

| Variable | Default | Meaning |
|---|---|---|
| `DASHSCOPE_API_KEY` | — (required) | Server-held DashScope key; sessions refused when unset |
| `IDENTITY_URL` | `https://gapp.lynse.cn/api/connectors/identity` | lynclaw identity authority |
| `REALTIME_ALLOWED_USERS` | empty | Comma-separated lynclaw user_ids; **empty denies everybody** |
| `REALTIME_MODELS` | `qwen3.8-livetranslate-flash-realtime` | Relayable `?model=` values |
| `REALTIME_MAX_PER_USER` / `_GLOBAL` | 2 / 20 | Concurrency caps |
| `REALTIME_MAX_SESSION_MS` | 1800000 | Hard session lifetime (30 min) |

## Bootstrap

With `REALTIME_ALLOWED_USERS` empty, every attempt is denied and the tried
principal id is logged once (`denied: principal <id> …`). Copy that id into
the env var (or ask the operator to) and retry — no code change needed.

## Client

`packages/views/live-translation/providers/lynse-qwen.ts` — the
“Lynse 内置 · 通义实时翻译” provider. No API key field: the connection
builder stamps the logged-in user's accessToken as the handshake credential
and points at this relay's `/realtime` endpoint.
