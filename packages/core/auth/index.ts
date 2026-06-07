import { create } from "zustand";
import { ApiClient } from "../api/client";
import type { StorageAdapter } from "../types/storage";

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

let authStoreInstance: ReturnType<typeof createAuthStore>;

export function createAuthStore(opts: AuthOpts) {
  return create<AuthState>()((set) => ({
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

      const res = await opts.api.post<{ accessToken: string }>(
        "/api/auth/apikey/token",
      );

      if (!opts.cookieAuth) {
        opts.storage.setItem("lynse_api_key", apiKey);
        opts.storage.setItem("lynse_token", res.accessToken);
        opts.api.setToken(res.accessToken);
      }
      set({ isAuthenticated: true, isLoading: false });
      opts.onLogin?.();
    },

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
      } else {
        set({ isLoading: false });
      }
    },
  }));
}

export function registerAuthStore(store: ReturnType<typeof createAuthStore>) {
  authStoreInstance = store;
}

export function useAuthStore<T>(selector: (s: AuthState) => T): T {
  return authStoreInstance(selector);
}
