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

export function clearIdentityCache() {
  cache.clear();
}

export function bearerToken(authorization) {
  const cleaned = String(authorization ?? "").trim();
  if (!cleaned.toLowerCase().startsWith("bearer ")) return "";
  return cleaned.slice(7).trim();
}

export function cachedPrincipal(token) {
  const key = sha256(token);
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

function remember(token, principal) {
  const key = sha256(token);
  cache.set(key, { principal, at: Date.now() });
  if (cache.size > config.identityCacheMax) {
    for (const [k, v] of [...cache.entries()].sort((a, b) => a[1].at - b[1].at)) {
      cache.delete(k);
      if (cache.size <= config.identityCacheMax) break;
    }
  }
}

/**
 * Resolve the verified principal for a request, or null. Never throws; never
 * falls back to a client-claimed id.
 */
export async function resolvePrincipal(authorization) {
  const token = bearerToken(authorization);
  if (!token || !config.identityUrl) return null;
  const cached = cachedPrincipal(token);
  if (cached) return cached;
  try {
    const res = await fetch(`${config.identityUrl}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(config.identityTimeoutMs),
    });
    if (!res.ok) return null;
    const json = await res.json().catch(() => null);
    const principal = String(json?.user_id ?? "").trim();
    if (!principal) return null;
    remember(token, principal);
    return principal;
  } catch {
    return null;
  }
}
