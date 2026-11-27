import { api } from "@lynse/core/api";

/**
 * Firmware pairing credentials for the USB recording card.
 *
 * The password gates USB access to a physically-held card, so it is never
 * hardcoded into this public repository or the shipped bundle: lynse-agent-auth
 * serves it behind user authentication at
 * `/platform/oauth/api/agent/device/recording-card/credential`.
 *
 * Vendor/product IDs are optional overrides for the reference hardware pair
 * the vendor SDK filters on; when the server omits them, connect falls back
 * to the SDK's built-in filter.
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

/** Site auth-gateway origin per business API origin (lynse-agent-auth). */
const API_HOST_TO_AGENT_AUTH_ORIGIN: Record<string, string> = {
  "api.lynse.cn": "https://www.lynse.cn",
  "gapp.lynse.cn": "https://www.lynse.cn",
  "api-en.lynse.ai": "https://www.lynse.ai",
  "api.lynse.ai": "https://www.lynse.ai",
};

function agentAuthOriginForApi(apiBase: string): string | null {
  try {
    const host = new URL(apiBase).host.toLowerCase();
    return API_HOST_TO_AGENT_AUTH_ORIGIN[host] ?? null;
  } catch {
    return null;
  }
}

let cachedRequest: {
  apiBase: string;
  origin: string;
  token: string;
  result: Promise<RecordingCardConfig>;
} | null = null;

/** Share the pairing-config request for the current signed-in session. */
export async function fetchRecordingCardConfig(): Promise<RecordingCardConfig> {
  const client = api();
  const token = client.getToken();
  const apiBase = typeof client.getBaseUrl === "function" ? client.getBaseUrl() : "";
  if (!token) {
    throw new Error("no signed-in session");
  }
  const siteOrigin = agentAuthOriginForApi(apiBase);
  if (!siteOrigin) {
    throw new Error("recording_card_verification_unavailable");
  }
  if (
    cachedRequest?.apiBase === apiBase &&
    cachedRequest?.origin === siteOrigin &&
    cachedRequest.token === token
  ) {
    return cachedRequest.result;
  }
  const request = {
    apiBase,
    origin: siteOrigin,
    token,
    result: requestCredentialFromAgentAuth(siteOrigin, token),
  };
  cachedRequest = request;
  try {
    return await request.result;
  } catch (error) {
    if (cachedRequest === request) cachedRequest = null;
    throw error;
  }
}

async function parseCredentialResponse(response: Response): Promise<RecordingCardConfig> {
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
    if (response.status === 401) throw new Error("recording_card_account_required");
    const detail = (payload as { detail?: string } | null)?.detail;
    // The server-side issuance gate denies binding-less accounts with this
    // machine code; map it so the renderer can localize it like the
    // ownership errors (raw gateway details stay verbatim).
    if (detail === "recording_card_not_bound") throw new Error("recording_card_not_bound");
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

async function requestCredentialFromAgentAuth(origin: string, token: string): Promise<RecordingCardConfig> {
  const response = await fetch(`${origin}/platform/oauth/api/agent/device/recording-card/credential`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });
  return parseCredentialResponse(response);
}

/** Test hook: forget the cached config so the next fetch hits the API. */
export function resetRecordingCardConfigCache(): void {
  cachedRequest = null;
}
