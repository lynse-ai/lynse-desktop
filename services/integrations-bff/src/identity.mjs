/**
 * Principal verification (plan step 2). The ONLY identity authority is the
 * server-pinned IDENTITY_URL (lynclaw `GET /api/connectors/identity`): a
 * caller's Lynse token is exchanged for a stable user_id. Client-claimed
 * user ids, gateway keys and disabled identity derivation can never produce a
 * principal here.
 *
 * Verification results are cached by token hash with a TTL and a capacity
 * bound — the raw token is never persisted (plan step 2.4).
 */

import { createHash } from "node:crypto";
import { config } from "./env.mjs";

const cache = new Map(); // token hash -> { principal, at }
const pending = new Map();

export function clearIdentityCache() {
  cache.clear();
  pending.clear();
}

export function bearerToken(authorization) {
  const cleaned = String(authorization ?? "").trim();
  if (!cleaned.toLowerCase().startsWith("bearer ")) return "";
  return cleaned.slice(7).trim();
}

export function cachedPrincipal(token) {
  return lookup(sha256(token));
}

function lookup(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at >= config.identityCacheTtlMs) {
    cache.delete(key);
    return null;
  }
  return hit.principal;
}

function sha256(text) {
  return createHash("sha256").update(String(text ?? "")).digest("hex");
}

function remember(key, principal) {
  cache.delete(key);
  cache.set(key, { principal, at: Date.now() });
  const limit = config.identityCacheMax;
  while (cache.size > limit && cache.size > 0) {
    cache.delete(cache.keys().next().value);
  }
}

/**
 * Resolve the verified principal for a request, or null. Never throws; never
 * falls back to a client-claimed id.
 */
export async function resolvePrincipal(authorization) {
  const token = bearerToken(authorization);
  if (!token || !config.identityUrl) return null;
  const key = sha256(token);
  const cached = lookup(key);
  if (cached) return cached;
  const current = pending.get(key);
  if (current) return current;
  const request = verify(token).then((principal) => {
    if (pending.get(key) === request) {
      pending.delete(key);
      if (principal) remember(key, principal);
    }
    return principal;
  });
  pending.set(key, request);
  return request;
}

async function verify(token) {
  try {
    const res = await fetch(`${config.identityUrl}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(config.identityTimeoutMs),
    });
    if (!res.ok) return null;
    const json = await res.json().catch(() => null);
    return typeof json?.user_id === "string" ? json.user_id.trim() || null : null;
  } catch {
    return null;
  }
}
