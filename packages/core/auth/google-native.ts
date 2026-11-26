/**
 * Google sign-in for the desktop — native installed-app flow (RFC 8252).
 *
 * Google refuses OAuth inside embedded WebViews, so the consent page runs in
 * the USER'S system browser instead: the desktop binds a one-shot loopback
 * listener (127.0.0.1:<ephemeral port>), builds the authorize URL against a
 * "Desktop app" OAuth client (public client — PKCE only, no secret), and the
 * browser 302s the authorization code straight back to the loopback listener.
 * The desktop then trades the code for a Google ID token, mints a FIREBASE ID
 * token from it via the Identity Toolkit REST API (`accounts:signInWithIdp` —
 * the same Google provider the web popup uses), and feeds that into the
 * existing /api/auth/login exchange. No backend change, no web deployment,
 * and the desktop bundle needs no Firebase SDK — just two public config
 * values injected at build time (see configureGoogleNativeLogin).
 */

export interface GoogleNativeLoginConfig {
  /** Desktop-app OAuth client id (public; PKCE). */
  clientId: string;
  /** Desktop-app OAuth client secret (Google's /token endpoint requires this
   *  for Desktop clients alongside PKCE; treated by Google as non-confidential). */
  clientSecret?: string;
  /** Firebase Web API key (public identifier) for accounts:signInWithIdp. */
  firebaseApiKey: string;
}

let nativeConfig: GoogleNativeLoginConfig | null = null;

/** Called once at app bootstrap from platform env vars; null disables. */
export function configureGoogleNativeLogin(config: GoogleNativeLoginConfig | null): void {
  nativeConfig =
    config && config.clientId && config.firebaseApiKey
      ? {
          clientId: config.clientId,
          ...(config.clientSecret ? { clientSecret: config.clientSecret } : {}),
          firebaseApiKey: config.firebaseApiKey,
        }
      : null;
}

export function getGoogleNativeLoginConfig(): GoogleNativeLoginConfig | null {
  return nativeConfig;
}

/** The loopback redirect the browser posts the code to (exact port match). */
export function googleNativeRedirectUri(port: number): string {
  return `http://127.0.0.1:${port}`;
}

// ── PKCE (same shape as the account-center SSO flow) ────────────────────────

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function pkcePair(): Promise<{ verifier: string; challenge: string }> {
  if (!crypto.subtle) throw new Error("WebCrypto is unavailable in this context");
  const verifier = new Uint8Array(48); // 64 url-safe chars, within PKCE's 43..128
  crypto.getRandomValues(verifier);
  const verifierText = base64Url(verifier);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifierText));
  return { verifier: verifierText, challenge: base64Url(new Uint8Array(digest)) };
}

export interface GoogleNativeAuthorize {
  authorizeUrl: string;
  redirectUri: string;
  state: string;
  verifier: string;
}

/** Mint the PKCE pair and build the consent URL for the system browser.
 *  `port` is the loopback listener port opened just before this call. */
export async function startGoogleNativeLogin(port: number): Promise<GoogleNativeAuthorize> {
  const config = nativeConfig;
  if (!config) throw new Error("Google desktop sign-in is not configured");
  const { verifier, challenge } = await pkcePair();
  const state = base64Url(crypto.getRandomValues(new Uint8Array(24)));
  const redirectUri = googleNativeRedirectUri(port);
  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "openid email profile",
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
    // Always let the user pick an account — a remembered browser session
    // must not silently sign the app in as the wrong identity.
    prompt: "select_account",
  });
  return {
    authorizeUrl: `https://accounts.google.com/o/oauth2/v2/auth?${params}`,
    redirectUri,
    state,
    verifier,
  };
}

/** One outcome relayed from the loopback listener for the current attempt. */
export type GoogleNativeCallback =
  | { kind: "code"; code: string }
  | { kind: "error"; error: string };

/** Parse the loopback redirect URL: query params, bound to this attempt's state. */
export function googleNativeCallbackFromUrl(
  url: string,
  expectedState: string,
): GoogleNativeCallback | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" || parsed.hostname !== "127.0.0.1") return null;
  const state = parsed.searchParams.get("state");
  if (!state || state !== expectedState) return null;
  const error = parsed.searchParams.get("error");
  if (error) return { kind: "error", error };
  const code = parsed.searchParams.get("code");
  if (code) return { kind: "code", code };
  return null;
}
