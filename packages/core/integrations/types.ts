/**
 * Connections contract types.
 *
 * The shape mirrors the Pocket-derived API contract in
 * `docs/connections-api-contract.md`, which the e2e mock
 * (`e2e/fixtures/integrations-mock.ts`) implements — mock, client and server
 * are meant to agree on exactly this.
 *
 * Third-party access/refresh tokens never appear here: the backend exchanges
 * and stores them (PRD §6.3), and the client only ever sees account metadata.
 */

export type IntegrationsProvider =
  | "google-calendar"
  | "outlook-calendar"
  | "notion"
  | "todoist"
  | "google-tasks";

/** Where a provider's exports land. Field name differs per provider. */
export type DestinationField =
  | "default_project_id"
  | "default_task_list_id"
  | "default_database_id";

export interface IntegrationAccount {
  id: string;
  email: string;
  display_name: string;
  /** Notion only — the workspace the integration was shared with. */
  workspace_name?: string;
  is_primary: boolean;
  /** Pull this account's events into Lynse (calendar providers). */
  sync_enabled: boolean;
  /** Pre-meeting reminders for this account (calendar providers). */
  notify_enabled: boolean;
  auto_export: boolean;
  default_destination_id: string | null;
}

export interface IntegrationStatus {
  connected: boolean;
  provider: IntegrationsProvider;
  accounts: IntegrationAccount[];
  /**
   * Server-side truth for the paywall. The client must not re-derive it from
   * member level — `benefitType`/`memberLevel` carry no capability list, so a
   * local matrix would drift from whatever the backend actually gates.
   */
  requires_pro: boolean;
}

/** Step 1 of the OAuth three-step flow: what to open in the system browser. */
export interface OAuthState {
  state: string;
  client_id: string;
  scope: string;
  redirect_uri: string;
  authorization_url: string;
}

/** Step 2 result, polled until `done`/`error`. */
export interface OAuthPollResult {
  status: "pending" | "done" | "error";
  account_id?: string;
  error?: string;
}

export interface ExportedItem {
  id: string;
  external_id: string;
}

export interface FailedItem {
  id: string;
  reason: string;
}

/**
 * Pocket's partial-success semantics: an export that accepted some items
 * still answers 200, listing both sides. Callers must not treat a non-empty
 * `failed` as a thrown error — the toast copy differs.
 */
export interface ExportResult {
  succeeded: ExportedItem[];
  failed: FailedItem[];
  destination_id: string;
}

/**
 * Summary push result (PRD FR-3). `created`/`updated` are how the client knows
 * the server honoured its upsert promise — a second export of the same note
 * must report `updated`, never create a second page.
 */
export interface SummaryExportResult {
  page_id: string;
  url: string;
  created: boolean;
  updated: boolean;
}

export interface ExportPayload {
  action_item_ids: string[];
  default_project_id?: string;
  default_task_list_id?: string;
  default_database_id?: string;
}

export interface Destination {
  id: string;
  name: string;
}

export interface CalendarEvent {
  id: string;
  title: string;
  /** ISO-8601 instant; the reminder lead time is computed client-side. */
  start_time: string;
  end_time: string;
  /** Present for meetings with a join link — the auto-record trigger. */
  meeting_url: string | null;
  account_id: string;
}

export interface CalendarEventsResponse {
  connected: boolean;
  events: CalendarEvent[];
}

export interface AccountToggles {
  sync_enabled?: boolean;
  notify_enabled?: boolean;
}

/** The destination field a given provider uses, for typed payload building. */
export function destinationFieldFor(provider: IntegrationsProvider): DestinationField {
  switch (provider) {
    case "todoist":
      return "default_project_id";
    case "google-tasks":
      return "default_task_list_id";
    default:
      return "default_database_id";
  }
}

/** Providers whose accounts carry Sync/Notify rather than a destination. */
export function isCalendarProvider(provider: IntegrationsProvider): boolean {
  return provider === "google-calendar" || provider === "outlook-calendar";
}
