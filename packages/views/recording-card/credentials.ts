import { api } from "@lynse/core/api";

/**
 * Firmware pairing credentials for the recording card.
 *
 * The password gates USB access to a physically-held card, so it is never
 * hardcoded into this public repository or the shipped bundle: lynclaw
 * serves it behind user authentication and the page fetches it after the
 * AuthGate has confirmed a session. If the vendor ever confirms the password
 * is a non-secret pairing gate, this module is the single place to swap in a
 * build-time constant instead.
 */

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
  const raw = await api().get<RawConfig | { data?: RawConfig }>(
    "/api/desktop/recording-card/config",
  );
  // The API client unwraps `{data}` envelopes, but stay defensive: older
  // gateway shapes may hand back the envelope itself.
  const payload = (raw as { data?: RawConfig }).data ?? (raw as RawConfig);
  const password = payload?.password;
  if (typeof password !== "string" || password.length < 8 || password.length > 64 || password.includes("#")) {
    throw new Error("recording-card config is missing a usable firmware password");
  }
  const config: RecordingCardConfig = { password };
  // Only pass the descriptor pair when both halves arrived; otherwise the
  // SDK falls back to its built-in VID/PID filter (reference hardware).
  if (typeof payload?.vendorId === "number" && typeof payload?.productId === "number") {
    config.vendorId = payload.vendorId;
    config.productId = payload.productId;
  }
  return config;
}

/** Test hook: forget the cached config so the next fetch hits the API. */
export function resetRecordingCardConfigCache(): void {
  cache = null;
  pending = null;
}
