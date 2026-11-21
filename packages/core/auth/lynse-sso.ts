/**
 * Lynse account-center SSO — OAuth authorization code + PKCE S256.
 *
 * The apps act as a PUBLIC OAuth client of the account center (the
 * lynse-agent-auth gateway's /oauth/* endpoints): no client secret in the
 * app, PKCE only (docs/lynse-sso-architecture.md §4.2). A successful token
 * response also carries `upstream_token` — the Lynse business session token —
 * so product calls keep working exactly like a phone/WeChat login while the
 * SSO session at the account center makes feedlog sign-in one click.
 *
 * Desktop: the authorize page opens in the embedded `oauth-auth` window and
 * the callback redirect is intercepted before it loads. Web: full-page
 * redirect; the /auth/sso route completes the flow via completeWebSsoLogin.
 */
import type { AuthSession } from "./session";

export interface LynseSsoConfig {
  /** Account center origin, e.g. https://accounts.lynse.cn. */
  origin: string;
  /** Registered public client id. */
  clientId: string;
  /** Registered callback URL. Desktop: an intercepted page; web: /auth/sso. */
  redirectUri: string;
}

let ssoConfig: LynseSsoConfig | null = null;

/** Called once at app bootstrap from the platform env vars; null disables. */
export function configureLynseSso(config: LynseSsoConfig | null): void {
  ssoConfig = config && config.origin && config.clientId && config.redirectUri ? config : null;
}

export function getLynseSsoConfig(): LynseSsoConfig | null {
  return ssoConfig;
}

interface SsoFlow {
  verifier: string;
  state: string;
}

const WEB_FLOW_STORAGE_KEY = "lynse_sso_flow";

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function randomUrlSafe(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return base64Url(bytes);
}

async function pkcePair(): Promise<{ verifier: string; challenge: string }> {
  if (!crypto.subtle) throw new Error("WebCrypto is unavailable in this context");
  const verifier = randomUrlSafe(48); // 64 url-safe chars, within PKCE's 43..128
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return { verifier, challenge: base64Url(new Uint8Array(digest)) };
}

export function buildSsoAuthorizeUrl(config: LynseSsoConfig, challenge: string, state: string): string {
  const params = new URLSearchParams({
    client_id: config.clientId,
    response_type: "code",
    redirect_uri: config.redirectUri,
    scope: "openid profile email",
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  return `${config.origin}/oauth/authorize?${params.toString()}`;
}

/** Mint the PKCE pair and build the authorize URL for the embedded window. */
export async function startSsoLogin(): Promise<{
  authorizeUrl: string;
  state: string;
  verifier: string;
}> {
  const config = ssoConfig;
  if (!config) throw new Error("Lynse account sign-in is not configured");
  const { verifier, challenge } = await pkcePair();
  const state = randomUrlSafe(24);
  return { authorizeUrl: buildSsoAuthorizeUrl(config, challenge, state), state, verifier };
}

/** Exchange the intercepted callback code for the persistable session. */
export async function completeSsoLogin(
  verifier: string,
  code: string | null,
  state: string | null,
  expectedState: string,
): Promise<AuthSession> {
  const config = ssoConfig;
  if (!config) throw new Error("Lynse account sign-in is not configured");
  if (!state || state !== expectedState) throw new Error("Invalid SSO callback state");
  return finishSsoLogin(config, code, verifier);
}

/** Web: persist the PKCE pair and navigate the whole page to the authorize URL. */
export async function beginWebSsoLogin(): Promise<string> {
  const config = ssoConfig;
  if (!config) throw new Error("Lynse account sign-in is not configured");
  const { verifier, challenge } = await pkcePair();
  const flow: SsoFlow = { verifier, state: randomUrlSafe(24) };
  sessionStorage.setItem(WEB_FLOW_STORAGE_KEY, JSON.stringify(flow));
  return buildSsoAuthorizeUrl(config, challenge, flow.state);
}

/** Web callback route: verify state, exchange the code, clear the flow. */
export async function completeWebSsoLogin(
  code: string | null,
  state: string | null,
): Promise<AuthSession> {
  const config = ssoConfig;
  if (!config) throw new Error("Lynse account sign-in is not configured");
  const raw = sessionStorage.getItem(WEB_FLOW_STORAGE_KEY);
  sessionStorage.removeItem(WEB_FLOW_STORAGE_KEY);
  const flow: SsoFlow | null = raw ? JSON.parse(raw) : null;
  if (!flow) throw new Error("No Lynse account sign-in in progress");
  // Forged-redirect guard: the callback state must match what we stored.
  if (!state || state !== flow.state) throw new Error("Invalid SSO callback state");
  return finishSsoLogin(config, code, flow.verifier);
}

interface SsoTokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  refresh_token?: string;
  scope?: string;
  upstream_token?: string;
}

async function exchangeCode(
  config: LynseSsoConfig,
  code: string,
  verifier: string,
): Promise<SsoTokenResponse> {
  const response = await fetch(`${config.origin}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: config.redirectUri,
      code_verifier: verifier,
      client_id: config.clientId,
    }),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload?.access_token) {
    throw new Error(payload?.error_description || payload?.error || "SSO token exchange failed");
  }
  return payload as SsoTokenResponse;
}

interface SsoUserInfo {
  sub: string;
  name?: string;
  picture?: string;
  email?: string;
  email_verified?: boolean;
}

async function fetchUserInfo(
  config: LynseSsoConfig,
  accessToken: string,
): Promise<SsoUserInfo | null> {
  try {
    const response = await fetch(`${config.origin}/oauth/userinfo`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    return response.ok ? ((await response.json()) as SsoUserInfo) : null;
  } catch {
    // Profile fields are cosmetic here; the dashboard backfills the real
    // account card from /api/business/customer/current after sign-in.
    return null;
  }
}

async function finishSsoLogin(
  config: LynseSsoConfig,
  code: string | null,
  verifier: string,
): Promise<AuthSession> {
  if (!code) throw new Error("SSO sign-in was denied");
  const tokens = await exchangeCode(config, code, verifier);
  // Product calls ride the business session token while the backend still
  // validates raw tokens (docs/lynse-sso-architecture.md §8, phase-2 bridge);
  // the OIDC tokens themselves authorize account-center endpoints only.
  if (!tokens.upstream_token) throw new Error("SSO response missing the business session token");
  const userinfo = await fetchUserInfo(config, tokens.access_token);
  return {
    accessToken: tokens.upstream_token,
    user: {
      id: userinfo?.sub ?? "",
      name: userinfo?.name ?? "",
      email: userinfo?.email ?? "",
      avatar_url: userinfo?.picture,
    },
  };
}
