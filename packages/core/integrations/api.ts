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

function providerPath(provider: IntegrationsProvider, verb: string): string {
  return `${V2}/integrations/${encodeURIComponent(provider)}/${verb}`;
}

export function fetchIntegrationStatus(
  provider: IntegrationsProvider,
): Promise<IntegrationStatus> {
  return api().get<IntegrationStatus>(providerPath(provider, "status"));
}

export function fetchIntegrationAccounts(
  provider: IntegrationsProvider,
): Promise<{ accounts: IntegrationAccount[] }> {
  return api().get<{ accounts: IntegrationAccount[] }>(providerPath(provider, "accounts"));
}

/** Step 1: ask the backend what to open in the system browser. */
export function requestOAuthState(
  provider: IntegrationsProvider,
  params: { platform: "desktop" | "web"; origin?: string },
): Promise<OAuthState> {
  return api().getWithParams<OAuthState>(providerPath(provider, "oauth-state"), {
    platform: params.platform,
    origin: params.origin,
  });
}

/** Step 2: poll until the browser round trip lands (WorkBuddy's pattern). */
export function pollOAuthResult(
  provider: IntegrationsProvider,
  state: string,
): Promise<OAuthPollResult> {
  return api().getWithParams<OAuthPollResult>(providerPath(provider, "oauth-result"), { state });
}

/** Step 3: exchange the code server-side. Returns account metadata only. */
export function exchangeOAuthCode(
  provider: IntegrationsProvider,
  payload: { code: string; state: string; redirect_uri: string },
): Promise<{ connected: boolean; account: IntegrationAccount }> {
  return api().post<{ connected: boolean; account: IntegrationAccount }>(
    providerPath(provider, "exchange-code"),
    payload,
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
  );
}

export function setAutoExport(
  provider: IntegrationsProvider,
  payload: { account_id: string; auto_export: boolean },
): Promise<{ ok: boolean; auto_export: boolean }> {
  return api().put<{ ok: boolean; auto_export: boolean }>(
    providerPath(provider, "auto-export"),
    payload,
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
  );
}

/** Projects / task lists / Notion databases for the default-destination picker. */
export function fetchDestinations(
  provider: IntegrationsProvider,
): Promise<{ destinations: Destination[] }> {
  return api().get<{ destinations: Destination[] }>(providerPath(provider, "destinations"));
}

export function exportActionItems(
  provider: IntegrationsProvider,
  payload: ExportPayload,
): Promise<ExportResult> {
  return api().post<ExportResult>(providerPath(provider, "export"), payload);
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
  return api().post<SummaryExportResult>(providerPath(provider, "export-summary"), payload);
}

export function fetchCalendarEvents(range: { from: string; to: string }): Promise<CalendarEventsResponse> {
  return api().getWithParams<CalendarEventsResponse>(`${V2}/calendar/events`, {
    from: range.from,
    to: range.to,
  });
}
