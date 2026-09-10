export interface AuthUser {
  id: string;
  name: string;
  email: string;
  avatar_url?: string;
}

/**
 * Session payload returned by every login channel (API key, app-scanned QR
 * code, WeChat). `apiKey` is present when the backend also issues an API key
 * for the account — persisting it lets `restoreSession` mint fresh access
 * tokens after a restart.
 */
export interface AuthSession {
  accessToken: string;
  apiKey?: string;
  user: AuthUser;
}
