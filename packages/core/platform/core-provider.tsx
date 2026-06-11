"use client";

import { useMemo } from "react";
import { ApiClient, setApiInstance } from "../api/client";
import { createAuthStore, registerAuthStore } from "../auth";
import { defaultStorage } from "./storage";
import { QueryProvider } from "../provider";
import { initI18n } from "../i18n";
import type { CoreProviderProps } from "./types";
import type { StorageAdapter } from "../types/storage";

let initialized = false;
let authStore: ReturnType<typeof createAuthStore>;

function initCore(
  apiBaseUrl: string,
  storage: StorageAdapter,
  onLogin?: () => void,
  onLogout?: () => void,
  cookieAuth?: boolean,
  identity?: CoreProviderProps["identity"],
) {
  if (initialized) return;

  // Use saved API URL if available, otherwise fall back to env default
  const savedApiUrl = storage.getItem("lynse_api_url");
  const effectiveUrl = savedApiUrl || apiBaseUrl;

  const apiClient = new ApiClient(effectiveUrl, {
    onUnauthorized: () => {
      storage.removeItem("lynse_token");
    },
    identity,
  });
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
