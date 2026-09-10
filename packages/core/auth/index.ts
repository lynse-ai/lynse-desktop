import { create } from "zustand";
import { ApiClient } from "../api/client";
import type { StorageAdapter } from "../types/storage";
import type { AuthSession } from "./session";
import {
  buildWechatQrUrl,
  createWechatState,
  defaultWechatRedirectUri,
} from "./wechat";

interface User {
  id: string;
  name: string;
  email: string;
  avatar_url?: string;
}

interface AuthState {
  user: User | null;
  isLoading: boolean;
  isAuthenticated: boolean;
  login: (apiKey: string, apiUrl?: string) => Promise<void>;
  /**
   * Persist any pending API-base-URL change, mint a `state`, and return the
   * WeChat QR-code authorize URL to navigate to (web: same-window redirect;
   * desktop: open in the system browser).
   */
  startWechatLogin: (opts?: { apiUrl?: string; redirectUri?: string }) => {
    authorizeUrl: string;
    state: string;
  };
  /** Persist the session returned by the WeChat exchange/poll. */
  completeLogin: (result: AuthSession, apiUrl?: string) => void;
  logout: () => void;
  setUser: (user: User | null) => void;
  restoreSession: () => Promise<void>;
}

type AuthOpts = {
  api: ApiClient;
  storage: StorageAdapter;
  onLogin?: () => void;
  onLogout?: () => void;
  cookieAuth?: boolean;
};

let authStoreInstance: ReturnType<typeof createAuthStore> | undefined;

export function createAuthStore(opts: AuthOpts) {
  return create<AuthState>()((set) => {
    /**
     * Shared tail of every login channel: persist credentials, flip the store
     * to authenticated, notify listeners. `apiUrl` may refine the backend URL
     * chosen at connect time (e.g. typed into the API-config page).
     */
    function persistSession(result: AuthSession, apiUrl?: string) {
      if (apiUrl) {
        opts.api.setBaseUrl(apiUrl);
        opts.storage.setItem("lynse_api_url", apiUrl);
      }
      if (!opts.cookieAuth) {
        if (result.apiKey) {
          opts.api.setApiKey(result.apiKey);
          opts.storage.setItem("lynse_api_key", result.apiKey);
        }
        opts.storage.setItem("lynse_token", result.accessToken);
        opts.storage.removeItem("lynse_wechat_state");
      }
      opts.api.setToken(result.accessToken);
      set({
        user: result.user,
        isAuthenticated: true,
        isLoading: false,
      });
      opts.onLogin?.();
    }

    return {
    user: null,
    isLoading: true,
    isAuthenticated: false,

    login: async (apiKey: string, apiUrl?: string) => {
      // Update API URL if provided
      if (apiUrl) {
        opts.api.setBaseUrl(apiUrl);
        opts.storage.setItem("lynse_api_url", apiUrl);
      }

      // Set apiKey BEFORE the token request so X-API-Key header is sent
      opts.api.setApiKey(apiKey);

      // Persist the API key up-front (before the network call) so a failed
      // connect — e.g. the test server being unreachable ("Load failed") —
      // does NOT force the user to re-type the key on the next app open.
      // The session token is still only saved after a successful login.
      if (!opts.cookieAuth) {
        opts.storage.setItem("lynse_api_key", apiKey);
      }

      const res = await opts.api.post<{ accessToken: string }>(
        "/api/auth/apikey/token",
      );

      if (!opts.cookieAuth) {
        opts.storage.setItem("lynse_token", res.accessToken);
        opts.api.setToken(res.accessToken);
      }
      set({ isAuthenticated: true, isLoading: false });
      opts.onLogin?.();
    },

    startWechatLogin: (startOpts) => {
      const apiUrl = startOpts?.apiUrl;
      if (apiUrl) {
        opts.api.setBaseUrl(apiUrl);
        opts.storage.setItem("lynse_api_url", apiUrl);
      }
      const state = createWechatState();
      // The callback page reads this back to reject forged redirects (the
      // `state` query param must match what we generated).
      opts.storage.setItem("lynse_wechat_state", state);
      const authorizeUrl = buildWechatQrUrl(
        startOpts?.redirectUri ?? defaultWechatRedirectUri(),
        state,
      );
      return { authorizeUrl, state };
    },

    completeLogin: (result: AuthSession, apiUrl?: string) =>
      persistSession(result, apiUrl),

    logout: () => {
      if (!opts.cookieAuth) {
        opts.storage.removeItem("lynse_api_key");
        opts.storage.removeItem("lynse_token");
        opts.api.setApiKey(null);
        opts.api.setToken(null);
      }
      set({ user: null, isAuthenticated: false, isLoading: false });
      opts.onLogout?.();
    },

    setUser: (user) =>
      set({ user, isAuthenticated: !!user, isLoading: false }),

    restoreSession: async () => {
      const savedApiKey = opts.storage.getItem("lynse_api_key");
      const savedToken = opts.storage.getItem("lynse_token");

      if (savedApiKey) {
        opts.api.setApiKey(savedApiKey);

        if (savedToken) {
          opts.api.setToken(savedToken);
        }

        try {
          const res = await opts.api.post<{ accessToken: string }>(
            "/api/auth/apikey/token",
          );
          opts.storage.setItem("lynse_token", res.accessToken);
          opts.api.setToken(res.accessToken);
          set({ isAuthenticated: true, isLoading: false });
        } catch {
          opts.api.setToken(null);
          opts.storage.removeItem("lynse_token");
          set({ isAuthenticated: false, isLoading: false });
        }
      } else if (savedToken) {
        // Sessions from phone/WeChat login may not carry an API key to mint a
        // fresh token with; trust the saved access token until the backend
        // rejects it (401 clears it via onUnauthorized).
        opts.api.setToken(savedToken);
        set({ isAuthenticated: true, isLoading: false });
      } else {
        set({ isLoading: false });
      }
    },
    };
  });
}

export function registerAuthStore(store: ReturnType<typeof createAuthStore>) {
  authStoreInstance = store;
}

/** Imperative access for non-React callers (e.g. the API client's
 *  onUnauthorized handler); undefined until registerAuthStore runs. */
export function getAuthStore() {
  return authStoreInstance;
}

export function useAuthStore<T>(selector: (s: AuthState) => T): T {
  return authStoreInstance!(selector);
}
