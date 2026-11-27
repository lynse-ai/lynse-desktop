"use client";

import { useMemo } from "react";
import { ApiClient, setApiInstance } from "../api/client";
import { createAuthStore, getAuthStore, registerAuthStore } from "../auth";
import { DEFAULT_API_URL, AGENT_API_URL_STORAGE_KEY, CLOUDBASE_AGENT_URL, STAGING_CLOUDBASE_AGENT_URL, LEGACY_CLOUDBASE_AGENT_URL, agentUrlForApiUrl, DEFAULT_INTEGRATIONS_API_URL, INTEGRATIONS_API_URL_STORAGE_KEY } from "../config";
import { defaultStorage } from "./storage";
import { QueryProvider } from "../provider";
import { initI18n, setLocaleApiBaseUrl } from "../i18n";
import { analytics, PostHogProvider, posthog } from "../analytics";
import { telemetry, SentryErrorBoundary } from "../telemetry";
import type { CoreProviderProps } from "./types";
import type { StorageAdapter } from "../types/storage";

let initialized = false;
let authStore: ReturnType<typeof createAuthStore>;

function resolveApiBaseUrl(apiBaseUrl: string, storage: StorageAdapter): string {
  return storage.getItem("lynse_api_url") || apiBaseUrl || DEFAULT_API_URL;
}

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
  const effectiveUrl = resolveApiBaseUrl(apiBaseUrl, storage);

  const apiClient = new ApiClient(effectiveUrl, {
    onBaseUrlChange: setLocaleApiBaseUrl,
    onUnauthorized: () => {
      // The saved credential is dead. Drop the whole session so the AuthGate
      // swaps to the launch page — the user can sign in again there (or
      // re-enter the API key via its corner link) instead of staring at
      // failing requests.
      getAuthStore()?.getState().logout();
    },
    identity,
  });
  // The AI assistant targets a dedicated backend (route B direct CloudBase);
  // absent/empty means it follows the main URL above. Server switches keep
  // the persisted agent in sync (auth login / api-config panel), but installs
  // saved before that rule may still carry an agent pinned to the *other*
  // environment — heal those at boot so a session can never chat across
  // environments. Hand-typed custom URLs are left untouched. The legacy
  // preset host (pre-2026-10-10 build) counts as the preset too, so its
  // saved value migrates instead of stranding as a frozen custom URL.
  const savedAgentUrl = storage.getItem(AGENT_API_URL_STORAGE_KEY);
  const agentUrl =
    !savedAgentUrl ||
    savedAgentUrl === CLOUDBASE_AGENT_URL ||
    savedAgentUrl === STAGING_CLOUDBASE_AGENT_URL ||
    savedAgentUrl === LEGACY_CLOUDBASE_AGENT_URL
      ? agentUrlForApiUrl(effectiveUrl)
      : savedAgentUrl;
  apiClient.setAgentBaseUrl(agentUrl);
  // Connections always target the BFF, including packaged builds with no
  // saved override. Preserve explicitly configured self-hosted origins.
  const savedIntegrationsUrl = storage.getItem(INTEGRATIONS_API_URL_STORAGE_KEY)?.trim();
  apiClient.setIntegrationsBaseUrl(savedIntegrationsUrl || DEFAULT_INTEGRATIONS_API_URL);
  setApiInstance(apiClient);

  authStore = createAuthStore({
    api: apiClient,
    storage,
    onLogin: () => {
      onLogin?.();
      const user = authStore?.getState().user;
      if (user?.id) {
        analytics.identify(user.id);
        telemetry.setUser({ id: user.id });
      }
    },
    onLogout: () => {
      onLogout?.();
      analytics.reset();
      telemetry.setUser(null);
    },
    cookieAuth,
  });
  registerAuthStore(authStore);

  // Restore auth state from saved credentials
  authStore.getState().restoreSession().then(() => {
    const user = authStore?.getState().user;
    if (user?.id) {
      analytics.identify(user.id);
      telemetry.setUser({ id: user.id });
    }
  }).catch(() => {});

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
  analyticsConfig,
  telemetryConfig,
}: CoreProviderProps) {
  useMemo(
    () => {
      initI18n({ locale, resources, apiBaseUrl: resolveApiBaseUrl(apiBaseUrl, storage) });
      if (analyticsConfig) {
        analytics.init(analyticsConfig);
      }
      if (telemetryConfig) {
        telemetry.init(telemetryConfig);
      }
      initCore(apiBaseUrl, storage, onLogin, onLogout, cookieAuth, identity);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  return (
    <SentryErrorBoundary fallback={<div className="p-4 text-center text-sm text-destructive">Application error occurred.</div>}>
      <PostHogProvider client={posthog}>
        <QueryProvider storage={storage}>
          {children}
        </QueryProvider>
      </PostHogProvider>
    </SentryErrorBoundary>
  );
}
