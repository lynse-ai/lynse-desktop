/**
 * OpenConnector gateway access. Third-party tokens never leave the gateway —
 * this module only carries the deployment's admin/runtime credentials.
 *
 * Connection pinning (plan step 6/7): action calls never run on "whatever the
 * gateway picks". The gateway has no shared-secret JWT mode (its runtime JWT
 * is JWKS/asymmetric), so instead the BFF mints an opaque runtime token per
 * (connection, action) via the admin API `POST /api/runtime-tokens` with an
 * `allowedConnections: [id]` access policy — for reads also pinning
 * `allowedActions` to exactly the one whitelisted action. Tokens are held in
 * memory only; a restart re-mints, and leftovers are revocable in the gateway
 * by their `lynse-bff-*` name.
 */

import { config } from "./env.mjs";

export async function gw(path, { method = "GET", body, token = config.adminToken } = {}) {
  const res = await fetch(`${config.gw}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20_000),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }
  return { status: res.status, ok: res.ok, json };
}

export async function listConnections() {
  const { json } = await gw("/api/connections");
  return Array.isArray(json) ? json : [];
}

/** Gateway connection entries that represent a real (non-virtual) connection. */
export function realConnections(connections, service) {
  return connections.filter((c) => c.service === service && !c.virtual && c.configured);
}

/** Action result envelopes vary across executors; unwrap defensively. */
export function unwrap(json) {
  if (json == null) return null;
  return json.output ?? json.result ?? json.data ?? json;
}

const scopedTokenCache = new Map(); // `${connectionId}:${actionId ?? "*"}` -> bearer token

async function mintScopedToken(connectionId, actionId) {
  const name = `lynse-bff-${String(connectionId).slice(0, 12)}-${Math.random().toString(16).slice(2, 10)}`;
  const policy = {
    allowedActions: actionId ? [actionId] : [],
    blockedActions: [],
    allowedProxies: [],
    allowedConnections: [String(connectionId)],
  };
  const created = await gw("/api/runtime-tokens", { method: "POST", body: { name, policy } });
  if (!created.ok || !created.json?.token) {
    throw Object.assign(new Error("runtime token minting failed"), { code: "token_minting_failed", status: created.status });
  }
  return String(created.json.token);
}

/**
 * Bearer credentials pinned to ONE connection. Returns null when minting is
 * impossible (no admin token configured) — callers must fail closed rather
 * than fall back to the shared runtime token for a multi-connection service.
 */
async function connectionScopedAuthorization(connectionId, actionId) {
  const key = `${connectionId}:${actionId ?? "*"}`;
  const cached = scopedTokenCache.get(key);
  if (cached) return cached;
  if (!config.adminToken) return null;
  const bearer = await mintScopedToken(connectionId, actionId);
  scopedTokenCache.set(key, bearer);
  return bearer;
}

/**
 * Run one gateway action pinned to one connection. `readOnly` additionally
 * pins the token to the single action id (read path). Throws-free contract:
 * returns { ok:false, reason } for caller-mapped failures.
 */
export async function runAction(actionId, input, connectionId, { readOnly = false } = {}) {
  let token = config.runtimeToken;
  if (connectionId) {
    try {
      const scoped = await connectionScopedAuthorization(connectionId, readOnly ? actionId : null);
      if (!scoped) return { ok: false, reason: "connection_selection_unavailable" };
      token = scoped;
    } catch (error) {
      if (error?.code === "token_minting_failed") return { ok: false, reason: error.code };
      return { ok: false, reason: "gateway_unavailable" };
    }
  }
  const run = await gw(`/v1/actions/${actionId}`, {
    method: "POST",
    body: { input },
    token,
  });
  return { ok: true, run };
}
