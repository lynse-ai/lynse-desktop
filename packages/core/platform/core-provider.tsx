"use client";

import { useMemo } from "react";
import { ApiClient, setApiInstance } from "../api/client";
import { createAuthStore, getAuthStore, registerAuthStore } from "../auth";
import { DEFAULT_API_URL, AGENT_API_URL_STORAGE_KEY } from "../config";
import { defaultStorage } from "./storage";
import { QueryProvider } from "../provider";
import { initI18n } from "../i18n";
import type { CoreProviderProps } from "./types";
import type { StorageAdapter } from "../types/storage";

let initialized = false;
let authStore: ReturnType<typeof createAuthStore>;

/** Idempotent core bootstrap (API client + auth store). Exported for
 *  non-React bootstrap paths and tests; `CoreProvider` calls it on mount. */
export function initCore(
  apiBaseUrl: string,
  storage: StorageAdapter,
  onLogin?: () => void,
  onLogout?: () => void,
  cookieAuth?: boolean,
  identity?: CoreProviderProps["identity"],
) {
  if (initialized) return;

  // Server precedence: user's saved pick → build-time env → production
  // default. An empty URL must never reach the client: the packaged shells
  // fetch from a custom-scheme origin where relative URLs don't parse.
  const savedApiUrl = storage.getItem("lynse_api_url");
  const effectiveUrl = savedApiUrl || apiBaseUrl || DEFAULT_API_URL;

  const apiClient = new ApiClient(effectiveUrl, {
    onUnauthorized: () => {
      storage.removeItem("lynse_token");
      // The saved credential is dead. Drop the whole session so the AuthGate
      // swaps to the launch page — the user can sign in again there (or
      // re-enter the API key via its corner link) instead of staring at
      // failing requests.
      getAuthStore()?.getState().logout();
    },
    identity,
  });
  // The AI assistant can target a dedicated backend (route B direct
  // CloudRun); absent/empty means it follows the main URL above.
  apiClient.setAgentBaseUrl(storage.getItem(AGENT_API_URL_STORAGE_KEY));
  setApiInstance(apiClient);

  if (!cookieAuth) {
    const token = storage.getItem("lynse_token");
    const apiKey = storage.getItem("lynse_api_key");
    if (token) apiClient.setToken(token);
    if (apiKey) apiClient.setApiKey(apiKey);
  }

  authStore = createAuthStore({ api: apiClient, storage, onLogin, onLogout, cookieAuth });
  registerAuthStore(authStore);

  // Restore auth state from saved credentials
  authStore.getState().restoreSession();

  initialized = true;
}

export function CoreProvider({
  children,
  apiBaseUrl = "",
  storage = defaultStorage,
  cookieAuth,
  onLogin,
  onLogout,
  identity,
  locale,
  resources,
}: CoreProviderProps) {
  useMemo(
    () => {
      initI18n({ locale, resources });
      initCore(apiBaseUrl, storage, onLogin, onLogout, cookieAuth, identity);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  return (
    <QueryProvider>
      {children}
    </QueryProvider>
  );
}
