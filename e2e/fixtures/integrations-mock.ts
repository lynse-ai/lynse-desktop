/**
 * Stateful mock for the Connections contract (`/api/v2/integrations/*`,
 * `/api/v2/calendar/*`).
 *
 * The flat route table in `api-mocks.ts` cannot express this feature: it
 * ignores the HTTP method, always answers 200, and holds no state — so a
 * connect → status → disconnect round trip, a partial-success export, or the
 * 403/503/400 error copy the PRD's AC-4 demands are all untestable through it.
 *
 * This module keeps an in-memory account store and answers the real verbs.
 * `completeOAuth()` is the mock-only seam that stands in for "the user
 * finished in the system browser", so an e2e spec can drive the whole
 * WorkBuddy-style polling flow without leaving Playwright.
 */

export interface IntegrationsMockState {
  /** provider → connected accounts. */
  accounts: Map<string, MockAccount[]>;
  /** Monotonic counter behind issued states, so repeat connects are distinct
   * identities even after a state is consumed (deriving it from the pending map
   * size collides once `exchange-code` deletes the entry). */
  oauthSeq: number;
  /** pending OAuth sessions created by `oauth-state`. */
  pendingOAuth: Map<string, { provider: string; completed: boolean; email: string }>;
  /** events returned by `/api/v2/calendar/google/events`. */
  events: MockCalendarEvent[];
  /** every export call, so a spec can assert the payload the app sent. */
  exportCalls: MockExportCall[];
  /** file_id -> the page created for it, so a re-export updates instead of duplicating. */
  summaryPages: Map<string, string>;
  /** every auto-export toggle, likewise. */
  toggleCalls: Array<{ provider: string; accountId: string; autoExport: boolean }>;
  /**
   * When false, every provider is treated as free. The paywall is part of the
   * contract, but the document/task flows behind it (default destination,
   * summary export) are otherwise untestable end to end.
   */
  paywallEnabled: boolean;
  /**
   * When set, the next matching request fails with this status/body instead of
   * behaving normally. Consumed once. Lets specs drive AC-4's error copy.
   */
  failNext: Array<{ method: string; pathPrefix: string; status: number; body?: unknown }>;
}

export interface MockAccount {
  id: string;
  email: string;
  display_name: string;
  workspace_name?: string;
  is_primary: boolean;
  sync_enabled: boolean;
  notify_enabled: boolean;
  auto_export: boolean;
  default_destination_id: string | null;
}

export interface MockCalendarEvent {
  id: string;
  title: string;
  /** ISO start instant; the app computes the reminder from this. */
  start_time: string;
  end_time: string;
  meeting_url: string | null;
  account_id: string;
}

export interface MockExportCall {
  provider: string;
  body: Record<string, unknown>;
}

/** Providers the mock knows how to connect. */
const KNOWN_PROVIDERS = new Set([
  "google-calendar",
  "outlook-calendar",
  "notion",
  "todoist",
  "google-tasks",
]);

/** Free-tier providers; anything else is paywalled (PRD §6.4). */
const FREE_PROVIDERS = new Set(["google-calendar", "todoist", "google-tasks"]);

/** Providers whose backend is "not deployed yet" — drives the 503 copy. */
const NOT_CONFIGURED_PROVIDERS = new Set(["outlook-calendar"]);

/** Destination catalogue per provider, for the default-destination dropdown. */
const DESTINATIONS: Record<string, Array<{ id: string; name: string }>> = {
  notion: [
    { id: "db-meetings", name: "Meeting Notes" },
    { id: "db-archive", name: "Company Archive" },
  ],
  todoist: [
    { id: "proj-work", name: "Work" },
    { id: "proj-personal", name: "Personal" },
  ],
  "google-tasks": [{ id: "list-primary", name: "My Tasks" }],
};

export function createIntegrationsState(): IntegrationsMockState {
  return {
    accounts: new Map(),
    oauthSeq: 0,
    pendingOAuth: new Map(),
    events: [
      {
        id: "evt-standup",
        title: "Daily standup",
        start_time: futureIso(2),
        end_time: futureIso(32),
        meeting_url: "https://meeting.example.com/standup",
        account_id: "acct-seed",
      },
    ],
    exportCalls: [],
    summaryPages: new Map(),
    toggleCalls: [],
    paywallEnabled: true,
    failNext: [],
  };
}

function futureIso(minutesFromNow: number): string {
  return new Date(Date.now() + minutesFromNow * 60_000).toISOString();
}

function respond(res: { writeHead(s: number, h: Record<string, string>): void; end(b?: string): void }, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body ?? {}));
}

interface Ctx {
  method: string;
  path: string;
  query: URLSearchParams;
  body: Record<string, unknown>;
}

/**
 * Handle an integrations/calendar request. Returns false when the path is not
 * ours, so the caller falls through to its normal routing.
 */
export function handleIntegrationsRequest(
  ctx: Ctx,
  res: httpLikeResponse,
  state: IntegrationsMockState,
): boolean {
  const { method, path } = ctx;
  if (!path.startsWith("/api/v2/integrations") && !path.startsWith("/api/v2/calendar")) return false;

  const injected = takeInjectedFailure(ctx, state);
  if (injected) {
    respond(res, injected.status, injected.body ?? { message: "injected failure" });
    return true;
  }

  // ---- provider-scoped routes ---------------------------------------------
  const providerMatch = path.match(
    /^\/api\/v2\/integrations\/([^/]+)\/(status|accounts|oauth-state|exchange-code|oauth-result|disconnect|auto-export|default-destination|export|export-summary|destinations)$/,
  );
  if (providerMatch) {
    const provider = decodeURIComponent(providerMatch[1]!);
    const verb = providerMatch[2]!;
    if (!KNOWN_PROVIDERS.has(provider)) {
      // Unknown / not-yet-deployed provider: the 503 shape the PRD maps to
      // "integration is not configured".
      respond(res, 503, {
        code: "not_configured",
        message: "error.integrations.not_configured",
        provider,
      });
      return true;
    }
    handleProviderRoute(ctx, res, state, provider, verb);
    return true;
  }

  // ---- calendar consumption routes ----------------------------------------
  if (path === "/api/v2/calendar/events" && method === "GET") {
    const from = ctx.query.get("from");
    const to = ctx.query.get("to");
    const connected = connectedAccounts(state, "google-calendar");
    if (!connected.length) {
      respond(res, 200, { events: [], connected: false });
      return true;
    }
    const events = state.events.filter((e) => {
      if (from && e.start_time < from) return false;
      if (to && e.start_time > to) return false;
      return true;
    });
    respond(res, 200, { events, connected: true });
    return true;
  }

  const toggleMatch = path.match(/^\/api\/v2\/calendar\/accounts\/([^/]+)\/toggles$/);
  if (toggleMatch && method === "PUT") {
    const accountId = decodeURIComponent(toggleMatch[1]!);
    let hit = false;
    for (const accounts of state.accounts.values()) {
      const account = accounts.find((a) => a.id === accountId);
      if (account) {
        if (typeof ctx.query.get("sync") === "string") account.sync_enabled = ctx.query.get("sync") === "true";
        if (typeof ctx.body.sync_enabled === "boolean") account.sync_enabled = ctx.body.sync_enabled;
        if (typeof ctx.body.notify_enabled === "boolean") account.notify_enabled = ctx.body.notify_enabled;
        hit = true;
        break;
      }
    }
    respond(res, hit ? 200 : 404, hit ? { ok: true } : { message: "unknown account" });
    return true;
  }

  respond(res, 404, { message: `unhandled v2 route ${method} ${path}` });
  return true;
}

type httpLikeResponse = {
  writeHead(status: number, headers: Record<string, string>): unknown;
  end(body?: string): unknown;
};

function handleProviderRoute(
  ctx: Ctx,
  res: httpLikeResponse,
  state: IntegrationsMockState,
  provider: string,
  verb: string,
): void {
  const { method } = ctx;

  switch (verb) {
    case "status": {
      const accounts = connectedAccounts(state, provider);
      respond(res, 200, {
        connected: accounts.length > 0,
        provider,
        accounts,
        // PRD §6.4: the client needs to know whether to render the Upgrade
        // affordance without re-deriving the entitlement matrix itself.
        requires_pro: !FREE_PROVIDERS.has(provider) && state.paywallEnabled,
      });
      return;
    }

    case "accounts": {
      respond(res, 200, { accounts: connectedAccounts(state, provider) });
      return;
    }

    case "destinations": {
      if (!connectedAccounts(state, provider).length) {
        respond(res, 409, { code: "not_connected", message: "connect first" });
        return;
      }
      respond(res, 200, { destinations: DESTINATIONS[provider] ?? [] });
      return;
    }

    case "oauth-state": {
      if (method !== "GET") return respond(res, 405, { message: "GET only" });
      if (!FREE_PROVIDERS.has(provider) && state.paywallEnabled) {
        // Paywall path: 403 with the dotted business key the client maps to
        // "X is a Pro feature".
        respond(res, 403, { code: "requires_pro", message: `error.integrations.requires_pro` });
        return;
      }
      state.oauthSeq += 1;
      const stateToken = `state-${provider}-${state.oauthSeq}`;
      state.pendingOAuth.set(stateToken, {
        provider,
        completed: false,
        // One identity per issued state, so "connect twice" means two accounts
        // rather than the same person re-authorising.
        email: `${provider.split("-")[0]}-user-${state.oauthSeq}@e2e.local`,
      });
      respond(res, 200, {
        state: stateToken,
        client_id: `${provider}-client-id`,
        scope: "openid email profile",
        redirect_uri: "lynse://integration-callback",
        authorization_url: `https://accounts.example.com/o/authorize?state=${stateToken}&client_id=${provider}-client-id`,
      });
      return;
    }

    case "oauth-result": {
      // The polling half of the WorkBuddy pattern: pending until the user
      // finishes in the browser (see completeOAuth), then done.
      const token = ctx.query.get("state");
      const pending = token ? state.pendingOAuth.get(token) : undefined;
      if (!pending) {
        respond(res, 404, { code: "state_expired", message: "unknown or expired state" });
        return;
      }
      if (!pending.completed) {
        respond(res, 200, { status: "pending" });
        return;
      }
      respond(res, 200, { status: "done", account_id: `acct-${pending.provider}-${state.pendingOAuth.size}` });
      return;
    }

    case "exchange-code": {
      if (method !== "POST") return respond(res, 405, { message: "POST only" });
      const token = String(ctx.body.state ?? "");
      const pending = state.pendingOAuth.get(token);
      if (!pending) {
        // CSRF-ish / expired state: the client must show the retry copy, not a
        // raw code.
        respond(res, 400, { code: "state_invalid", message: "error.integrations.state_invalid" });
        return;
      }
      if (!ctx.body.code) {
        respond(res, 400, { code: "missing_code", message: "error.integrations.missing_code" });
        return;
      }
      const already = findAccountByPendingEmail(state, provider, pending.email);
      if (already) {
        state.pendingOAuth.delete(token);
        respond(res, 200, { connected: true, account: already });
        return;
      }
      const account: MockAccount = {
        id: `acct-${provider}-${(state.accounts.get(provider)?.length ?? 0) + 1}`,
        email: pending.email,
        display_name: pending.email.split("@")[0]!,
        workspace_name: provider === "notion" ? "Lynse Workspace" : undefined,
        is_primary: (state.accounts.get(provider)?.length ?? 0) === 0,
        sync_enabled: true,
        notify_enabled: true,
        auto_export: false,
        default_destination_id: null,
      };
      const list = state.accounts.get(provider) ?? [];
      list.push(account);
      state.accounts.set(provider, list);
      state.pendingOAuth.delete(token);
      // Never a token in the body: the real backend keeps access/refresh
      // server-side (PRD §6.3), and the mock must not tempt the client to
      // expect one.
      respond(res, 200, { connected: true, account });
      return;
    }

    case "disconnect": {
      if (method !== "DELETE") return respond(res, 405, { message: "DELETE only" });
      const accountId = ctx.query.get("account_id");
      const list = state.accounts.get(provider) ?? [];
      const next = list.filter((a) => a.id !== accountId);
      if (next.length === list.length) {
        respond(res, 404, { code: "unknown_account", message: "error.integrations.unknown_account" });
        return;
      }
      state.accounts.set(provider, next);
      respond(res, 200, { connected: next.length > 0, remaining: next.length });
      return;
    }

    case "auto-export": {
      if (method !== "PUT") return respond(res, 405, { message: "PUT only" });
      const accountId = String(ctx.body.account_id ?? "");
      const account = (state.accounts.get(provider) ?? []).find((a) => a.id === accountId);
      if (!account) {
        respond(res, 404, { code: "unknown_account", message: "error.integrations.unknown_account" });
        return;
      }
      account.auto_export = Boolean(ctx.body.auto_export);
      state.toggleCalls.push({ provider, accountId, autoExport: account.auto_export });
      respond(res, 200, { ok: true, auto_export: account.auto_export });
      return;
    }

    case "default-destination": {
      if (method !== "PUT") return respond(res, 405, { message: "PUT only" });
      const accountId = String(ctx.body.account_id ?? "");
      const destinationId = String(ctx.body.destination_id ?? "");
      const account = (state.accounts.get(provider) ?? []).find((a) => a.id === accountId);
      if (!account) {
        respond(res, 404, { code: "unknown_account", message: "error.integrations.unknown_account" });
        return;
      }
      const known = (DESTINATIONS[provider] ?? []).some((d) => d.id === destinationId);
      if (!destinationId || !known) {
        respond(res, 400, { code: "unknown_destination", message: "error.integrations.unknown_destination" });
        return;
      }
      account.default_destination_id = destinationId;
      respond(res, 200, { ok: true, destination_id: destinationId });
      return;
    }

case "export-summary": {
      if (method !== "POST") return respond(res, 405, { message: "POST only" });
      const summaryAccounts = connectedAccounts(state, provider);
      if (!summaryAccounts.length) {
        respond(res, 409, { code: "not_connected", message: "error.integrations.not_connected" });
        return;
      }
      const fileId = String(ctx.body.file_id ?? "");
      if (!fileId) {
        respond(res, 400, { code: "missing_file", message: "error.integrations.missing_file" });
        return;
      }
      if (!ctx.body.destination_id && !summaryAccounts[0]!.default_destination_id) {
        respond(res, 409, { code: "no_destination", message: "error.integrations.no_destination" });
        return;
      }
      // FR-3 AC: re-exporting the same note updates the same page.
      const existing = state.summaryPages.get(fileId);
      const pageId = existing ?? `page-${fileId}-${state.summaryPages.size + 1}`;
      state.summaryPages.set(fileId, pageId);
      respond(res, 200, {
        page_id: pageId,
        url: `https://www.notion.so/${pageId}`,
        created: !existing,
        updated: Boolean(existing),
      });
      return;
    }

    case "export": {
      if (method !== "POST") return respond(res, 405, { message: "POST only" });
      const accounts = connectedAccounts(state, provider);
      if (!accounts.length) {
        respond(res, 409, { code: "not_connected", message: "error.integrations.not_connected" });
        return;
      }
      const destinationKey =
        provider === "todoist" ? "default_project_id" : provider === "google-tasks" ? "default_task_list_id" : "default_database_id";
      const destinationId = ctx.body[destinationKey] ?? accounts[0]!.default_destination_id;
      if (!destinationId) {
        // PRD FR-2 AC: exporting without a default target must bounce the user
        // to the picker rather than silently picking one.
        respond(res, 409, { code: "no_destination", message: "error.integrations.no_destination" });
        return;
      }
      const ids = Array.isArray(ctx.body.action_item_ids) ? (ctx.body.action_item_ids as unknown[]) : [];
      state.exportCalls.push({ provider, body: { ...ctx.body } });
      // Deterministic partial failure: the id containing "fail" is rejected, so
      // specs can assert the succeeded/failed toast copy (Pocket semantics).
      const succeeded = ids.filter((id) => !String(id).includes("fail")).map((id) => ({ id: String(id), external_id: `ext-${String(id)}` }));
      const failed = ids.filter((id) => String(id).includes("fail")).map((id) => ({ id: String(id), reason: "error.integrations.export_item_failed" }));
      respond(res, 200, { succeeded, failed, destination_id: String(destinationId) });
      return;
    }

    default:
      respond(res, 404, { message: `unhandled verb ${verb}` });
  }
}

function connectedAccounts(state: IntegrationsMockState, provider: string): MockAccount[] {
  return state.accounts.get(provider) ?? [];
}

function takeInjectedFailure(
  ctx: Ctx,
  state: IntegrationsMockState,
): { status: number; body?: unknown } | null {
  const index = state.failNext.findIndex(
    (f) => f.method === ctx.method && ctx.path.startsWith(f.pathPrefix),
  );
  if (index === -1) return null;
  const [injected] = state.failNext.splice(index, 1);
  return injected ?? null;
}

/**
 * Mock-only seam: pretend the user finished the third-party consent screen in
 * the system browser. An e2e spec calls this (via `page.evaluate` against a
 * helper route, or directly in a unit-style test) to let the client's poll
 * resolve.
 */
/**
 * Pretend the user finished the third-party consent screen.
 *
 * Per contract §2.2 the *backend* exchanges the code in the web relay during
 * P0, so completing the browser step must create the account right then — the
 * client only polls for the outcome. `exchange-code` stays implemented as the
 * P1 deep-link path and is idempotent against a state already completed here.
 */
export function completeOAuth(state: IntegrationsMockState, stateToken: string): boolean {
  const pending = state.pendingOAuth.get(stateToken);
  if (!pending) return false;
  pending.completed = true;
  if (!findAccountByPendingEmail(state, pending.provider, pending.email)) {
    const list = state.accounts.get(pending.provider) ?? [];
    list.push({
      id: `acct-${pending.provider}-${list.length + 1}`,
      email: pending.email,
      display_name: pending.email.split("@")[0] ?? pending.email,
      workspace_name: pending.provider === "notion" ? "Lynse Workspace" : undefined,
      is_primary: list.length === 0,
      sync_enabled: true,
      notify_enabled: true,
      auto_export: false,
      default_destination_id: null,
    });
    state.accounts.set(pending.provider, list);
  }
  return true;
}

function findAccountByPendingEmail(
  state: IntegrationsMockState,
  provider: string,
  email: string,
) {
  return (state.accounts.get(provider) ?? []).find((a) => a.email === email);
}

/** Turn the paywall off so Pro providers can be connected in a test. */
export function setPaywall(state: IntegrationsMockState, enabled: boolean): void {
  state.paywallEnabled = enabled;
}

/** Queue a one-shot failure for the next matching request. */
export function failNextRequest(
  state: IntegrationsMockState,
  spec: { method: string; pathPrefix: string; status: number; body?: unknown },
): void {
  state.failNext.push(spec);
}

/** Set the default destination for an account (dropdown persistence). */
export function setDefaultDestination(
  state: IntegrationsMockState,
  provider: string,
  accountId: string,
  destinationId: string,
): boolean {
  const account = (state.accounts.get(provider) ?? []).find((a) => a.id === accountId);
  if (!account) return false;
  account.default_destination_id = destinationId;
  return true;
}
