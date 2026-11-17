import { api } from "@lynse/core/api";

/**
 * Firmware pairing credentials for the USB recording card.
 *
 * The password gates USB access to a physically-held card, so it is never
 * hardcoded into this public repository or the shipped bundle: lynclaw
 * serves it behind user authentication and the page fetches it after the
 * AuthGate has confirmed a session. If the vendor ever confirms the password
 * is a non-secret pairing gate, this module is the single place to swap in a
 * build-time constant instead.
 *
 * The endpoint lives on the lynclaw assistant service (its own CloudRun
 * origin), NOT under the account API base — /api/desktop/* on the account
 * backend belongs to a different service and never reaches lynclaw. lynclaw
 * sends per-origin CORS headers, so the browser calls it directly.
 *
 * Vendor/product IDs returned here are only PREFILL values for the page's
 * editable descriptor inputs; the values used at connect time come from the
 * user (see use-recording-card-session).
 */

/** Reference hardware descriptors baked into the vendor SDK. */
export const DEFAULT_VENDOR_ID = 0x3654;
export const DEFAULT_PRODUCT_ID = 0x4155;

export interface RecordingCardConfig {
  password: string;
  vendorId?: number;
  productId?: number;
}

interface RawConfig {
  password?: string;
  vendorId?: number;
  productId?: number;
}

let cache: RecordingCardConfig | null = null;
let pending: Promise<RecordingCardConfig> | null = null;

/** Fetch (and cache) the pairing config for the signed-in user. Cached for
 * the page session; `resetRecordingCardConfigCache` exists for tests. */
export function fetchRecordingCardConfig(): Promise<RecordingCardConfig> {
  if (cache) return Promise.resolve(cache);
  if (!pending) {
    pending = requestConfig().then((config) => {
      cache = config;
      return config;
    });
    pending.catch(() => {
      pending = null;
    });
  }
  return pending;
}

async function requestConfig(): Promise<RecordingCardConfig> {
  const agentBase = api().getAgentBaseUrl();
  const token = api().getToken();
  if (!agentBase) {
    throw new Error("assistant service address is not ready");
  }
  if (!token) {
    throw new Error("no signed-in session");
  }
  const origin = new URL(agentBase).origin;
  const response = await fetch(`${origin}/api/desktop/recording-card/config`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  // Parse defensively: a gateway shell can answer with plain text (the raw
  // JSON.parse error shows an opaque token like `Unexpected token 'g'`),
  // surface the body head instead.
  const raw = await response.text();
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    throw new Error(`service returned a non-JSON response: ${raw.slice(0, 60)}`);
  }
  if (!response.ok) {
    const detail = (payload as { detail?: string } | null)?.detail;
    throw new Error(detail || `HTTP ${response.status}`);
  }
  const config = (payload ?? {}) as RawConfig;
  const password = config.password;
  if (typeof password !== "string" || password.length < 8 || password.length > 64 || password.includes("#")) {
    throw new Error("recording-card config is missing a usable firmware password");
  }
  const result: RecordingCardConfig = { password };
  // Only prefill the descriptor inputs when both halves arrived.
  if (typeof config.vendorId === "number" && typeof config.productId === "number") {
    result.vendorId = config.vendorId;
    result.productId = config.productId;
  }
  return result;
}

/** Test hook: forget the cached config so the next fetch hits the API. */
export function resetRecordingCardConfigCache(): void {
  cache = null;
  pending = null;
}
