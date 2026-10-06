import { useCallback, useMemo } from "react";
import { create } from "zustand";
import {
  fetchIntegrationStatus,
  pollOAuthResult,
  requestOAuthState,
  requestOAuthStateWithCredentials,
  type IntegrationStatus,
  type IntegrationsProvider,
} from "@lynse/core/integrations";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getActiveQueryClient } from "@lynse/core/query-client";
import { openExternalUrl } from "../app-update";
import { LIST_STALE_TIME_MS } from "../workspace/hooks/use-files";

/**
 * The connect flow, held outside React.
 *
 * WorkBuddy's equivalent lives as an inline async loop inside two components
 * (`settings/workbuddy-config-card.tsx:117-150`, `chat/page.tsx:224-246`) and
 * both cancel on unmount (`:110-115`, `:217-222`) — sign out of the settings
 * dialog mid-flow and the connection silently never completes. With 10+
 * providers and two entry points (settings, onboarding) that bug would be
 * copied a dozen times, so the session lives in a module store keyed by
 * provider and the poll is driven from there instead of from an effect.
 */

/** Poll cadence, mirroring Pocket's [0, 4s, 10s, 20s, 40s] then steady. */
const POLL_SCHEDULE_MS = [0, 4_000, 10_000, 20_000, 40_000];
const STEADY_INTERVAL_MS = 20_000;
/** Give up on a browser round trip after this long (WorkBuddy uses 10 min). */
const AUTHORIZATION_DEADLINE_MS = 10 * 60_000;

export type ConnectPhase = "idle" | "awaiting_browser" | "error";

export interface ConnectSession {
  provider: IntegrationsProvider;
  phase: ConnectPhase;
  /** OAuth state issued by the backend; echoed back by the callback. */
  state: string | null;
  authorizationUrl: string | null;
  error: string | null;
  startedAt: number | null;
}

interface ConnectStore {
  sessions: Partial<Record<IntegrationsProvider, ConnectSession>>;
  set: (provider: IntegrationsProvider, session: ConnectSession) => void;
  clear: (provider: IntegrationsProvider) => void;
}

const useConnectStore = create<ConnectStore>((set) => ({
  sessions: {},
  set: (provider, session) =>
    set((store) => ({ sessions: { ...store.sessions, [provider]: session } })),
  clear: (provider) =>
    set((store) => {
      const next = { ...store.sessions };
      delete next[provider];
      return { sessions: next };
    }),
}));

/** One timer per provider; cleared when the session resolves or is reset. */
const timers = new Map<IntegrationsProvider, ReturnType<typeof setTimeout>>();

function schedule(provider: IntegrationsProvider, attempt: number, run: () => void): void {
  cancelSchedule(provider);
  const waited = attempt < POLL_SCHEDULE_MS.length ? POLL_SCHEDULE_MS[attempt]! : STEADY_INTERVAL_MS;
  timers.set(provider, setTimeout(run, waited));
}

function cancelSchedule(provider: IntegrationsProvider): void {
  const timer = timers.get(provider);
  if (timer) clearTimeout(timer);
  timers.delete(provider);
}

export function cancelConnect(provider: IntegrationsProvider): void {
  cancelSchedule(provider);
  useConnectStore.getState().clear(provider);
}

/**
 * Start (or resume) a connect for `provider`. Safe to call again while a
 * session is live — it reattaches to the existing session rather than
 * requesting a second OAuth state.
 */
async function beginConnect(
  provider: IntegrationsProvider,
  params: { platform: "desktop" | "web"; origin?: string },
): Promise<void> {
  const store = useConnectStore.getState();
  const existing = store.sessions[provider];
  if (existing?.phase === "awaiting_browser" && existing.state) {
    // Already in flight: the caller just re-opens the browser tab if needed.
    if (existing.authorizationUrl) openExternalUrl(existing.authorizationUrl);
    return;
  }

  try {
    const oauth = await requestOAuthState(provider, params);
    store.set(provider, {
      provider,
      phase: "awaiting_browser",
      state: oauth.state,
      authorizationUrl: oauth.authorization_url,
      error: null,
      startedAt: Date.now(),
    });
    openExternalUrl(oauth.authorization_url);
    pollLoop(provider, oauth.state, 0);
  } catch (error) {
    store.set(provider, {
      provider,
      phase: "error",
      state: null,
      authorizationUrl: null,
      error: error instanceof Error ? error.message : String(error),
      startedAt: null,
    });
  }
}

/**
 * Self-serve variant (Feishu Model B): same session lifecycle, but the
 * authorize URL is minted from the user's own org-app credentials captured by
 * the setup dialog. The credentials live only in this call chain.
 */
export async function beginConnectWithCredentials(
  provider: IntegrationsProvider,
  params: { platform: "desktop" | "web"; origin?: string; clientId: string; clientSecret: string },
): Promise<void> {
  const store = useConnectStore.getState();
  const existing = store.sessions[provider];
  if (existing?.phase === "awaiting_browser" && existing.state) {
    if (existing.authorizationUrl) openExternalUrl(existing.authorizationUrl);
    return;
  }

  try {
    const oauth = await requestOAuthStateWithCredentials(provider, {
      platform: params.platform,
      origin: params.origin,
      client_id: params.clientId,
      client_secret: params.clientSecret,
    });
    store.set(provider, {
      provider,
      phase: "awaiting_browser",
      state: oauth.state,
      authorizationUrl: oauth.authorization_url,
      error: null,
      startedAt: Date.now(),
    });
    openExternalUrl(oauth.authorization_url);
    pollLoop(provider, oauth.state, 0);
  } catch (error) {
    store.set(provider, {
      provider,
      phase: "error",
      state: null,
      authorizationUrl: null,
      error: error instanceof Error ? error.message : String(error),
      startedAt: null,
    });
  }
}

/**
 * Handoff from the Feishu setup dialog: the backend has already minted the
 * authorize URL (after the user confirmed the one-click app creation), so the
 * session starts straight at the awaiting-browser stage.
 */
export function beginConnectFromUrl(
  provider: IntegrationsProvider,
  state: string,
  authorizationUrl: string,
): void {
  const store = useConnectStore.getState();
  store.set(provider, {
    provider,
    phase: "awaiting_browser",
    state,
    authorizationUrl,
    error: null,
    startedAt: Date.now(),
  });
  openExternalUrl(authorizationUrl);
  pollLoop(provider, state, 0);
}

async function pollLoop(provider: IntegrationsProvider, state: string, attempt: number): Promise<void> {
  const store = useConnectStore.getState();
  const session = store.sessions[provider];
  // The session was replaced or cancelled (disconnect, dialog close) while a
  // tick was in flight — stop rather than resurrect it.
  if (!session || session.state !== state) return;

  if (session.startedAt && Date.now() - session.startedAt > AUTHORIZATION_DEADLINE_MS) {
    store.set(provider, { ...session, phase: "error", error: "error.integrations.auth_timed_out" });
    return;
  }

  try {
    const result = await pollOAuthResult(provider, state);
    if (result.status === "pending") {
      schedule(provider, attempt + 1, () => void pollLoop(provider, state, attempt + 1));
      return;
    }
    if (result.status === "error") {
      store.set(provider, { ...session, phase: "error", error: result.error ?? "error.integrations.auth_failed" });
      return;
    }
    // Done: the backend already exchanged the code, so drop the session and
    // let the status query re-render the row as connected.
    cancelSchedule(provider);
    useConnectStore.getState().clear(provider);
    invalidateIntegrationStatus(provider);
  } catch (error) {
    store.set(provider, {
      ...session,
      phase: "error",
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * The poll is driven from a module store rather than a component, so the shared
 * QueryClient comes from `getActiveQueryClient()` (registered by
 * `QueryProvider`) instead of `useQueryClient()` — the same seam the todo data
 * layer uses to share one cache.
 */
function invalidateIntegrationStatus(provider: IntegrationsProvider): void {
  void getActiveQueryClient()?.invalidateQueries({ queryKey: integrationStatusKey(provider) });
}

export function integrationStatusKey(provider: IntegrationsProvider) {
  return ["connections", provider, "status"] as const;
}

export function useIntegrationStatus(provider: IntegrationsProvider, isAuthenticated: boolean) {
  return useQuery({
    queryKey: integrationStatusKey(provider),
    queryFn: () => fetchIntegrationStatus(provider),
    staleTime: LIST_STALE_TIME_MS,
    enabled: isAuthenticated,
    retry: false,
  });
}

export interface UseConnectFlow {
  session: ConnectSession | undefined;
  connecting: boolean;
  error: string | null;
  start: () => void;
  reset: () => void;
  query: ReturnType<typeof useIntegrationStatus>;
  refetchStatus: () => void;
}

export function useConnectFlow(
  provider: IntegrationsProvider,
  options: { platform?: "desktop" | "web"; origin?: string; isAuthenticated: boolean },
): UseConnectFlow {
  const client = useQueryClient();
  const query = useIntegrationStatus(provider, options.isAuthenticated);
  const session = useConnectStore((store) => store.sessions[provider]);

  const start = useCallback(() => {
    void beginConnect(provider, { platform: options.platform ?? "desktop", origin: options.origin });
  }, [provider, options.platform, options.origin]);

  const reset = useCallback(() => cancelConnect(provider), [provider]);

  const refetchStatus = useCallback(() => {
    void client.invalidateQueries({ queryKey: integrationStatusKey(provider) });
  }, [client, provider]);

  return useMemo(
    () => ({
      session,
      connecting: session?.phase === "awaiting_browser",
      error: session?.phase === "error" ? session.error : null,
      start,
      reset,
      query,
      refetchStatus,
    }),
    [session, start, reset, query, refetchStatus],
  );
}

/** Exposed for tests: drive a session to a terminal state without a browser. */
export const __testables = { pollLoop, cancelSchedule, integrationStatusKey };
export type { IntegrationStatus };
