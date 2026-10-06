import { api } from "../api/client";
import type {
  AccountToggles,
  CalendarEventsResponse,
  Destination,
  ExportPayload,
  ExportResult,
  IntegrationAccount,
  IntegrationStatus,
  IntegrationsProvider,
  SummaryExportResult,
  OAuthPollResult,
  OAuthState,
} from "./types";

/**
 * Plain API surface for Connections — no React, no query client.
 *
 * Every call goes through the Lynse backend (`api()` already carries the base
 * URL, token and platform headers). Third-party endpoints are never called
 * from here: Notion and Todoist do answer CORS today, but a direct call would
 * require the access token to live in the WebView, which PRD §6.3 forbids.
 */

const V2 = "/api/v2";

/**
 * Per-call origin override. When the Connections BFF origin is configured
 * (lynse_integrations_api_url), these calls go there instead of the main
 * backend — the same seam the AI-assistant transport uses. The BFF ignores
 * session credentials, but carrying them is harmless and keeps this module
 * agnostic to which backend answers.
 */
function override(): { baseUrl?: string } {
  const url = api().getIntegrationsBaseUrl();
  return url ? { baseUrl: url } : {};
}

function providerPath(provider: IntegrationsProvider, verb: string): string {
  return `${V2}/integrations/${encodeURIComponent(provider)}/${verb}`;
}

export function fetchIntegrationStatus(
  provider: IntegrationsProvider,
): Promise<IntegrationStatus> {
  return api().get<IntegrationStatus>(providerPath(provider, "status"), override());
}

export function fetchIntegrationAccounts(
  provider: IntegrationsProvider,
): Promise<{ accounts: IntegrationAccount[] }> {
  return api().get<{ accounts: IntegrationAccount[] }>(providerPath(provider, "accounts"), override());
}

/** Step 1: ask the backend what to open in the system browser. */
export function requestOAuthState(
  provider: IntegrationsProvider,
  params: { platform: "desktop" | "web"; origin?: string },
): Promise<OAuthState> {
  return api().getWithParams<OAuthState>(
    providerPath(provider, "oauth-state"),
    {
      platform: params.platform,
      origin: params.origin,
    },
    override(),
  );
}

/**
 * Step 1 for self-serve providers (Feishu Model B): the user's own org-app
 * credentials ride along so the backend can mint the authorize URL from them.
 * The credentials are forwarded once and never persisted by the client.
 */
export function requestOAuthStateWithCredentials(
  provider: IntegrationsProvider,
  params: { platform: "desktop" | "web"; origin?: string; client_id: string; client_secret: string },
): Promise<OAuthState> {
  return api().post<OAuthState>(
    providerPath(provider, "oauth-state"),
    {
      platform: params.platform,
      origin: params.origin,
      client_id: params.client_id,
      client_secret: params.client_secret,
    },
    override(),
  );
}

/**
 * Feishu Model B, step 1: begin the one-click app creation. The backend mints
 * a short-lived Feishu confirmation URL (user_code inside); the user confirms
 * in their own org and the created app's credentials flow server-side — they
 * never reach this client.
 */
export function startFeishuAppSetup(): Promise<{ state: string; url: string; expire_in: number }> {
  return api().post<{ state: string; url: string; expire_in: number }>(
    "/api/v2/integrations/feishu-app-setup",
    {},
    override(),
  );
}

/**
 * Feishu Model B, reuse path: an org app already exists server-side (from an
 * earlier half-finished bind) — skip creation and mint a fresh user
 * authorization from the saved credentials. Returns 409 `no_saved_app` when
 * nothing is saved, which callers treat as "run the creation flow".
 */
export function reuseFeishuAppSetup(): Promise<{
  status: "ready";
  oauth_state: string;
  authorization_url: string;
  client_id?: string;
  redirect_uri?: string;
  redirect_configured?: boolean;
  permission_grant_url?: string | null;
}> {
  return api().post<{
    status: "ready";
    oauth_state: string;
    authorization_url: string;
    client_id?: string;
    redirect_uri?: string;
    redirect_configured?: boolean;
    permission_grant_url?: string | null;
  }>(
    "/api/v2/integrations/feishu-app-setup",
    { reuse: true },
    override(),
  );
}

/**
 * Feishu Model B, step 2: poll until the user confirmed the creation. `ready`
 * carries the minted OAuth state + authorize URL plus the created app's id and
 * the callback URL — Feishu's console is the only place the redirect URL can
 * be registered (no OpenAPI for it), so the client walks the user through
 * that one paste before handing off to the normal connect session.
 */
export function pollFeishuAppSetup(
  state: string,
): Promise<{
  status: "waiting" | "ready" | "error";
  oauth_state?: string;
  authorization_url?: string;
  client_id?: string;
  redirect_uri?: string;
  redirect_configured?: boolean;
  permission_grant_url?: string | null;
  error?: string;
}> {
  return api().getWithParams<{
    status: "waiting" | "ready" | "error";
    oauth_state?: string;
    authorization_url?: string;
    client_id?: string;
    redirect_uri?: string;
    redirect_configured?: boolean;
    permission_grant_url?: string | null;
    error?: string;
  }>(
    "/api/v2/integrations/feishu-app-setup",
    { state },
    override(),
  );
}

/** Step 2: poll until the browser round trip lands (WorkBuddy's pattern). */
export function pollOAuthResult(
  provider: IntegrationsProvider,
  state: string,
): Promise<OAuthPollResult> {
  return api().getWithParams<OAuthPollResult>(
    providerPath(provider, "oauth-result"),
    { state },
    override(),
  );
}

/** Step 3: exchange the code server-side. Returns account metadata only. */
export function exchangeOAuthCode(
  provider: IntegrationsProvider,
  payload: { code: string; state: string; redirect_uri: string },
): Promise<{ connected: boolean; account: IntegrationAccount }> {
  return api().post<{ connected: boolean; account: IntegrationAccount }>(
    providerPath(provider, "exchange-code"),
    payload,
    override(),
  );
}

/**
 * `delete()` takes no options object, so the account id has to ride in the
 * query string — encode it here rather than at every call site.
 */
export function disconnectAccount(
  provider: IntegrationsProvider,
  accountId: string,
): Promise<{ connected: boolean; remaining: number }> {
  return api().delete<{ connected: boolean; remaining: number }>(
    `${providerPath(provider, "disconnect")}?account_id=${encodeURIComponent(accountId)}`,
    override(),
  );
}

export function setAutoExport(
  provider: IntegrationsProvider,
  payload: { account_id: string; auto_export: boolean },
): Promise<{ ok: boolean; auto_export: boolean }> {
  return api().put<{ ok: boolean; auto_export: boolean }>(
    providerPath(provider, "auto-export"),
    payload,
    override(),
  );
}

/**
 * Where this account's exports land (Notion database, Todoist project, Google
 * Tasks list). Required before the first export — the backend answers 409
 * `no_destination` rather than picking one silently.
 */
export function setDefaultDestination(
  provider: IntegrationsProvider,
  payload: { account_id: string; destination_id: string },
): Promise<{ ok: boolean; destination_id: string }> {
  return api().put<{ ok: boolean; destination_id: string }>(
    providerPath(provider, "default-destination"),
    payload,
    override(),
  );
}

/** Sync/Notify live on the calendar prefix, keyed by account rather than provider. */
export function setAccountToggles(
  accountId: string,
  toggles: AccountToggles,
): Promise<{ ok: boolean }> {
  return api().put<{ ok: boolean }>(
    `${V2}/calendar/accounts/${encodeURIComponent(accountId)}/toggles`,
    toggles,
    override(),
  );
}

/** Projects / task lists / Notion databases for the default-destination picker. */
export function fetchDestinations(
  provider: IntegrationsProvider,
): Promise<{ destinations: Destination[] }> {
  return api().get<{ destinations: Destination[] }>(providerPath(provider, "destinations"), override());
}

export function exportActionItems(
  provider: IntegrationsProvider,
  payload: ExportPayload,
): Promise<ExportResult> {
  return api().post<ExportResult>(providerPath(provider, "export"), payload, override());
}

/**
 * Push a meeting summary to a document provider (PRD FR-3). Upsert semantics
 * are the server's job: re-exporting the same note updates the same page, so
 * the client must not track page ids itself.
 */
export function exportSummary(
  provider: IntegrationsProvider,
  payload: { file_id: string; destination_id?: string; summary: string; action_items?: string[] },
): Promise<SummaryExportResult> {
  return api().post<SummaryExportResult>(
    providerPath(provider, "export-summary"),
    payload,
    override(),
  );
}

export function fetchCalendarEvents(range: { from: string; to: string }): Promise<CalendarEventsResponse> {
  return api().getWithParams<CalendarEventsResponse>(
    `${V2}/calendar/events`,
    {
      from: range.from,
      to: range.to,
    },
    override(),
  );
}
