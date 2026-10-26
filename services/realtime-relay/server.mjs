/**
 * Lynse realtime relay — plan-B credential isolation for live translation.
 *
 * The desktop client speaks the DashScope realtime protocol to THIS service
 * (authenticated with the user's Lynse accessToken); the service opens the
 * real DashScope websocket with the server-held DASHSCOPE_API_KEY and pipes
 * frames both ways. The API key never reaches any client device.
 *
 * Identity: the Lynse accessToken is verified against the server-pinned
 * lynclaw identity endpoint (same authority as services/integrations-bff) —
 * client-claimed user ids never grant access. Results are cached by token
 * hash with a TTL; tokens are never persisted or logged.
 *
 * Abuse posture: an allowlist gates which principals may open sessions at
 * all (the relay holds a real billing key, so by default NOBODY is allowed
 * — denied principals are logged once so the operator can bootstrap the
 * list), plus per-principal and global concurrency caps and a hard session
 * duration cap.
 *
 * Endpoints:
 *   GET  /healthz    → 200 "ok" (CloudRun readiness)
 *   WS   /realtime   → authenticated DashScope passthrough
 *                     ?model=<allowlisted model>[&<extra passthrough query>]
 *                     Authorization: Bearer <lynse accessToken>
 */

import http from "node:http";
import { WebSocket, WebSocketServer } from "ws";

// ── configuration (env only, never request-controlled) ──────────────────

const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? "0.0.0.0";

/** lynclaw identity endpoint — the only identity authority. */
const IDENTITY_URL = (process.env.IDENTITY_URL ?? "https://gapp.lynse.cn/api/connectors/identity").replace(/\/+$/, "");
const IDENTITY_TIMEOUT_MS = Number(process.env.IDENTITY_TIMEOUT_MS ?? 10_000);
const IDENTITY_CACHE_TTL_MS = Number(process.env.IDENTITY_CACHE_TTL_MS ?? 300_000);
const IDENTITY_CACHE_MAX = Number(process.env.IDENTITY_CACHE_MAX ?? 2048);

/** Server-held DashScope key. Sessions are refused when unset. */
const DASHSCOPE_API_KEY = process.env.DASHSCOPE_API_KEY ?? "";
const DASHSCOPE_REALTIME_BASE =
  (process.env.DASHSCOPE_REALTIME_BASE ?? "wss://dashscope.aliyuncs.com/api-ws/v1/realtime").replace(/\/+$/, "");

/** Comma-separated lynclaw user_ids that may open sessions. Empty = deny all. */
const ALLOWED_USERS = new Set(
  (process.env.REALTIME_ALLOWED_USERS ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean),
);

/** Comma-separated model names relayable upstream. */
const ALLOWED_MODELS = new Set(
  (process.env.REALTIME_MODELS ?? "qwen3.8-livetranslate-flash-realtime")
    .split(",")
    .map((m) => m.trim())
    .filter(Boolean),
);

const MAX_SESSIONS_PER_USER = Number(process.env.REALTIME_MAX_PER_USER ?? 2);
const MAX_SESSIONS_GLOBAL = Number(process.env.REALTIME_MAX_GLOBAL ?? 20);
const MAX_SESSION_MS = Number(process.env.REALTIME_MAX_SESSION_MS ?? 30 * 60_000);
const MAX_MESSAGE_BYTES = Number(process.env.REALTIME_MAX_MESSAGE_BYTES ?? 1_000_000);
const UPSTREAM_HANDSHAKE_TIMEOUT_MS = Number(process.env.REALTIME_UPSTREAM_TIMEOUT_MS ?? 15_000);

// ── identity (mirrors services/integrations-bff/src/identity.mjs) ────────

import { createHash } from "node:crypto";

const identityCache = new Map(); // token hash -> { userId, at }

function sha256(text) {
  return createHash("sha256").update(String(text ?? "")).digest("hex");
}

function bearerToken(authorization) {
  const cleaned = String(authorization ?? "").trim();
  if (!cleaned.toLowerCase().startsWith("bearer ")) return "";
  return cleaned.slice(7).trim();
}

async function resolveUserId(authorization) {
  const token = bearerToken(authorization);
  if (!token) return null;
  const key = sha256(token);
  const hit = identityCache.get(key);
  if (hit && Date.now() - hit.at < IDENTITY_CACHE_TTL_MS) return hit.userId;
  if (hit) identityCache.delete(key);
  try {
    const res = await fetch(IDENTITY_URL, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(IDENTITY_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const json = await res.json().catch(() => null);
    const userId = String(json?.user_id ?? "").trim();
    if (!userId) return null;
    if (identityCache.size >= IDENTITY_CACHE_MAX) {
      for (const [k, v] of [...identityCache.entries()].sort((a, b) => a[1].at - b[1].at)) {
        identityCache.delete(k);
        if (identityCache.size < IDENTITY_CACHE_MAX) break;
      }
    }
    identityCache.set(key, { userId, at: Date.now() });
    return userId;
  } catch {
    return null;
  }
}

// ── session bookkeeping ──────────────────────────────────────────────────

/** user_id -> Set<WebSocket> (client legs). */
const sessionsByUser = new Map();
let globalSessions = 0;

function closeWith(ws, code, reason) {
  try {
    ws.close(code, reason.slice(0, 120));
  } catch {
    /* already gone */
  }
}

function trackOpen(userId, ws) {
  let set = sessionsByUser.get(userId);
  if (!set) {
    set = new Set();
    sessionsByUser.set(userId, set);
  }
  set.add(ws);
  globalSessions += 1;
}

function trackClose(userId, ws) {
  const set = sessionsByUser.get(userId);
  if (set) {
    set.delete(ws);
    if (set.size === 0) sessionsByUser.delete(userId);
  }
  globalSessions = Math.max(0, globalSessions - 1);
}

// ── the relay ────────────────────────────────────────────────────────────

function relaySession(clientWs, request) {
  const url = new URL(request.url ?? "/realtime", "http://localhost");
  if (url.pathname !== "/realtime") {
    return closeWith(clientWs, 1008, "unknown path");
  }

  const model = url.searchParams.get("model") ?? "";
  if (!ALLOWED_MODELS.has(model)) {
    log(`denied: model ${JSON.stringify(model)} not allowlisted`);
    return closeWith(clientWs, 1008, "model not allowed");
  }

  const authorization = request.headers.authorization;
  resolveUserId(authorization).then((userId) => {
    if (!userId) return closeWith(clientWs, 4401, "identity verification failed");
    if (ALLOWED_USERS.size === 0) {
      // Bootstrap visibility: the operator must see which principal tried.
      log(`denied: principal ${userId} not in REALTIME_ALLOWED_USERS (allowlist is empty)`);
      return closeWith(clientWs, 4403, "relay not provisioned for this account");
    }
    if (!ALLOWED_USERS.has(userId)) {
      log(`denied: principal ${userId} not in REALTIME_ALLOWED_USERS`);
      return closeWith(clientWs, 4403, "relay not provisioned for this account");
    }
    const mine = sessionsByUser.get(userId)?.size ?? 0;
    if (mine >= MAX_SESSIONS_PER_USER) {
      log(`denied: principal ${userId} at per-user cap (${mine})`);
      return closeWith(clientWs, 4429, "too many concurrent sessions");
    }
    if (globalSessions >= MAX_SESSIONS_GLOBAL) {
      log(`denied: principal ${userId} — global cap (${globalSessions})`);
      return closeWith(clientWs, 4429, "service busy");
    }
    if (!DASHSCOPE_API_KEY) {
      log(`denied: DASHSCOPE_API_KEY is not configured on the relay`);
      return closeWith(clientWs, 4450, "upstream key missing");
    }

    openUpstream(clientWs, userId, url.searchParams);
  }).catch(() => closeWith(clientWs, 1011, "internal error"));
}

function openUpstream(clientWs, userId, passthroughParams) {
  const upstreamQuery = new URLSearchParams();
  for (const [key, value] of passthroughParams) {
    // The model is re-added from the allowlist; the client token must never
    // leak upstream; everything else (languages etc.) passes through.
    if (key === "token" || key === "access_token" || key === "model") continue;
    upstreamQuery.set(key, value);
  }
  upstreamQuery.set("model", passthroughParams.get("model") ?? "");
  const upstream = new WebSocket(`${DASHSCOPE_REALTIME_BASE}?${upstreamQuery.toString()}`, {
    headers: { Authorization: `Bearer ${DASHSCOPE_API_KEY}` },
    handshakeTimeout: UPSTREAM_HANDSHAKE_TIMEOUT_MS,
  });

  let opened = false;
  const teardown = (why) => {
    log(`session end: principal ${userId} (${why})`);
    clearTimeout(lifetime);
    trackClose(userId, clientWs);
    for (const ws of [clientWs, upstream]) {
      try {
        ws.close(1000, "");
      } catch {
        /* already gone */
      }
    }
  };

  const lifetime = setTimeout(() => teardown("max session duration"), MAX_SESSION_MS);

  upstream.on("unexpected-response", (_req, res) => {
    const status = res.statusCode ?? 500;
    log(`upstream rejected for principal ${userId}: HTTP ${status}`);
    const code = status === 401 ? 4401 : status === 429 ? 4429 : 4400;
    clearTimeout(lifetime);
    closeWith(clientWs, code, `upstream ${status}`);
  });
  upstream.on("open", () => {
    opened = true;
    trackOpen(userId, clientWs);
    log(`session open: principal ${userId} (global ${globalSessions})`);
  });
  upstream.on("message", (data, isBinary) => {
    if (clientWs.readyState === WebSocket.OPEN) clientWs.send(data, { binary: isBinary });
  });
  upstream.on("close", (code, reason) => {
    if (opened) teardown(`upstream closed ${code}`);
    else if (!clientWs.readyState === WebSocket.CLOSED) closeWith(clientWs, 4400, "upstream unavailable");
  });
  upstream.on("error", (error) => {
    log(`upstream error for principal ${userId}: ${error.message}`);
    if (!opened) {
      clearTimeout(lifetime);
      closeWith(clientWs, 4400, "upstream unavailable");
    }
  });

  clientWs.on("message", (data, isBinary) => {
    if (!opened) return;
    if (data.length > MAX_MESSAGE_BYTES) {
      return teardown("client message too large");
    }
    if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary: isBinary });
  });
  clientWs.on("close", () => {
    if (opened) teardown("client closed");
  });
  clientWs.on("error", () => {
    if (opened) teardown("client error");
  });
}

function log(message) {
  console.log(`[realtime-relay] ${new Date().toISOString()} ${message}`);
}

// ── http surface ─────────────────────────────────────────────────────────

const server = http.createServer((req, res) => {
  if (req.url === "/healthz") {
    res.writeHead(200, { "content-type": "text/plain" }).end("ok");
    return;
  }
  res.writeHead(404, { "content-type": "text/plain" }).end();
});

const wss = new WebSocketServer({ noServer: true });
server.on("upgrade", (request, socket, head) => {
  const { pathname } = new URL(request.url ?? "/", "http://localhost");
  if (pathname !== "/realtime") {
    socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
    socket.destroy();
    return;
  }
  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit("connection", ws, request);
  });
});
wss.on("connection", relaySession);

server.listen(PORT, HOST, () => {
  log(`listening on ${HOST}:${PORT} (identity: ${IDENTITY_URL}, models: ${[...ALLOWED_MODELS].join(", ")}, ` +
      `allowlist: ${ALLOWED_USERS.size} principal(s), key: ${DASHSCOPE_API_KEY ? "configured" : "MISSING"})`);
});
