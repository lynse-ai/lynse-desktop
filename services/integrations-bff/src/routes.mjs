/**
 * Multiuser route handler (CONNECTORS_MULTIUSER=1).
 *
 * Every endpoint requires a verified Lynse principal (plan step 2): the
 * Authorization header is exchanged at the server-pinned identity service,
 * and every account/authorization/settings access is principal-scoped through
 * the registry. Client-claimed user ids and gateway keys never grant access.
 *
 * Two endpoint families live here:
 *  - the legacy `/api/v2/integrations/{provider}/*` contract (same shapes as
 *    the desktop client expects), now owner-checked end to end;
 *  - the lynclaw consumer contract: `POST {provider}/read`,
 *    `POST /api/v2/integrations/oauth/state` and
 *    `GET  /api/v2/integrations/oauth/result/{request_id}`.
 */

import { config } from "./env.mjs";
import { respond, readBody, notConfigured, notConnected, unauthorized, randomId } from "./http.mjs";
import { gzipSync } from "node:zlib";
import { gw, listConnections, runAction, unwrap } from "./gateway.mjs";
import { resolvePrincipal } from "./identity.mjs";
import { resolveAccount, liveAccounts } from "./accounts.mjs";
import { accountView } from "./views.mjs";
import { beginAuthorization, pollAuthorizationResult } from "./oauth.mjs";
import { lookupOperation, validateArguments, executeRead } from "./read.mjs";

const SERVICES = {
  gmail: "gmail",
  "google-calendar": "googlecalendar",
  "outlook-calendar": "outlook_calendar",
  notion: "notion",
  todoist: "todoist",
  "google-tasks": "googletasks",
  "feishu-calendar": "feishu",
  "feishu-docs": "feishu",
  "feishu-tasks": "feishu",
  "feishu-mail": "feishu",
};

const DESTINATION_KEY = {
  todoist: "default_project_id",
  "google-tasks": "default_task_list_id",
  notion: "default_database_id",
  "feishu-tasks": "default_task_list_id",
  "feishu-docs": "default_database_id",
};

const WIRED = new Set(["todoist", "feishu-tasks"]);
const FEISHU_SCOPES = [
  "offline_access",
  "auth:user.id:read",
  "calendar:calendar.event:read",
  "task:tasklist:read",
  "task:task:write",
  "base:app:read",
  "base:table:read",
  "base:field:read",
  "base:record:create",
  "base:record:update",
  "drive:file:upload",
  "drive:drive.metadata:readonly",
];

/** Feishu device-registration sessions live in memory: they are short-lived,
 *  restart just means the user restarts the guided setup. */
const feishuSessions = new Map();

export function createStoreBoundHandler(store) {
  return async function handle(req, res) {
    const url = new URL(req.url, "http://localhost");
    const method = req.method ?? "GET";
    const path = url.pathname;
    if (method === "OPTIONS") return respond(res, 204, {});

    let principal;
    try {
      principal = await resolvePrincipal(req.headers.authorization);
    } catch {
      return respond(res, 503, { code: "identity_unavailable", message: "identity unavailable" });
    }
    if (!principal) return unauthorized(res);

    try {
      return await dispatch(store, req, res, method, path, url, principal);
    } catch (error) {
      console.error(`[bff] ${method} ${path} failed:`, error?.message ?? error);
      return respond(res, 502, { code: "gateway_unavailable", message: "gateway unavailable" });
    }
  };
}

async function dispatch(store, req, res, method, path, url, principal) {
  // ---- lynclaw consumer contract -------------------------------------------

  if (path === "/api/v2/integrations/oauth/state" && method === "POST") {
    return lynclawOAuthState(store, req, res, principal);
  }
  const resultMatch = path.match(/^\/api\/v2\/integrations\/oauth\/result\/([^/]+)$/);
  if (resultMatch && method === "GET") {
    return lynclawOAuthResult(store, res, principal, decodeURIComponent(resultMatch[1]));
  }
  const readMatch = path.match(/^\/api\/v2\/integrations\/([^/]+)\/read$/);
  if (readMatch && method === "POST") {
    return lynclawRead(store, req, res, principal, decodeURIComponent(readMatch[1]));
  }

  // ---- calendar -------------------------------------------------------------

  if (path === "/api/v2/calendar/events" && method === "GET") {
    return calendarEvents(store, res, url, principal);
  }
  const toggleMatch = path.match(/^\/api\/v2\/calendar\/accounts\/([^/]+)\/toggles$/);
  if (toggleMatch && method === "PUT") {
    const account = store.accountById(principal, decodeURIComponent(toggleMatch[1]));
    if (!account) return respond(res, 404, { code: "unknown_account", message: "error.integrations.unknown_account" });
    const body = await readBody(req);
    store.updateAccountSettings(principal, account.id, {
      sync_enabled: typeof body.sync_enabled === "boolean" ? body.sync_enabled : undefined,
      notify_enabled: typeof body.notify_enabled === "boolean" ? body.notify_enabled : undefined,
    });
    return respond(res, 200, { ok: true });
  }

  // ---- feishu Model B --------------------------------------------------------

  if (path === "/api/v2/integrations/feishu-app-setup") {
    return feishuAppSetup(store, req, res, method, url, principal);
  }

  // ---- provider-scoped legacy contract --------------------------------------

  const match = path.match(
    /^\/api\/v2\/integrations\/([^/]+)\/(status|accounts|oauth-state|oauth-result|exchange-code|disconnect|auto-export|default-destination|destinations|export|export-summary)$/,
  );
  if (!match) return respond(res, 404, { message: `unhandled route ${method} ${path}` });
  const provider = decodeURIComponent(match[1]);
  const verb = match[2];
  const service = SERVICES[provider];
  if (!service) return notConfigured(res, provider);
  return providerRoute(store, req, res, method, url, principal, provider, service, verb);
}

// ---------------------------------------------------------------------------
// lynclaw consumer endpoints
// ---------------------------------------------------------------------------

async function lynclawOAuthState(store, req, res, principal) {
  const body = await readBody(req);
  const providerRaw = String(body.provider ?? "").trim().replace(/_/g, "-");
  const service = SERVICES[providerRaw];
  if (!service) return notConfigured(res, body.provider);
  let targetAccountId = null;
  if (body.account_id) {
    const account = store.accountById(principal, String(body.account_id));
    if (!account || account.provider !== providerRaw) {
      return respond(res, 404, { code: "unknown_account", message: "error.integrations.unknown_account" });
    }
    targetAccountId = account.id; // reconnect: the product id stays stable (plan step 5.4)
  }
  const customOAuth =
    providerRaw.startsWith("feishu-") && body.client_id && body.client_secret
      ? { client_id: String(body.client_id), client_secret: String(body.client_secret) }
      : undefined;
  const begun = await beginAuthorization(store, {
    principal,
    provider: providerRaw,
    service,
    targetAccountId,
    customOAuth,
  });
  if (!begun.ok) {
    console.error("[bff] oauth authorizations failed:", begun.status, begun.json);
    return notConfigured(res, providerRaw);
  }
  return respond(res, 200, {
    authorization_request_id: begun.requestId,
    authorize_url: begun.authorizationUrl,
    expires_at: new Date(begun.expiresAt).toISOString(),
    // Backwards-compatible fields for the desktop settings flow.
    state: begun.requestId,
    authorization_url: begun.authorizationUrl,
    client_id: begun.clientId ?? `${service}-client`,
    scope: begun.scope ?? "",
    redirect_uri: begun.redirectUri ?? "https://www.lynse.ai/oc/oauth/callback",
  });
}

async function lynclawOAuthResult(store, res, principal, requestId) {
  const connections = await listConnections();
  const outcome = await pollAuthorizationResult(store, {
    principal,
    requestId,
    // request lookup is provider-checked inside poll; oauth/result is
    // provider-agnostic, so pass the request's own provider by reading first.
    provider: store.authorizationRequestById(requestId, principal)?.provider ?? "?",
    connections,
  });
  if (outcome.status === "invalid") {
    return respond(res, 404, { code: "state_invalid", message: "error.integrations.state_invalid" });
  }
  const body = { status: outcome.status };
  if (outcome.accountId) body.account_id = outcome.accountId;
  if (outcome.account) body.account = outcome.account;
  if (outcome.detail) body.detail = outcome.detail;
  return respond(res, 200, body);
}

async function lynclawRead(store, req, res, principal, providerRaw) {
  const body = await readBody(req);
  const lookup = lookupOperation(providerRaw, body.operation);
  if (lookup.error) {
    return respond(res, 400, { status: "invalid_input", error: { code: "registry_rejected", message: lookup.error } });
  }
  const checked = validateArguments(lookup.operation, body.arguments);
  if (checked.error) {
    return respond(res, 400, { status: "invalid_input", error: { code: "registry_rejected", message: checked.error } });
  }
  const owned = store.accountsFor(principal, lookup.provider);
  const connections = await listConnections();
  const outcome = await executeRead(store, {
    provider: lookup.provider,
    operation: lookup.operation,
    args: checked.args,
    accountId: body.account_id ? String(body.account_id) : undefined,
    owned,
    connections,
  });
  return respond(res, outcome.httpStatus, outcome.body);
}

// ---------------------------------------------------------------------------
// legacy-contract provider routes, owner-scoped
// ---------------------------------------------------------------------------

async function ownedLiveAccounts(store, principal, provider, connections) {
  return liveAccounts(store.accountsFor(principal, provider), connections);
}

async function providerRoute(store, req, res, method, url, principal, provider, service, verb) {
  switch (verb) {
    case "status": {
      const connections = await listConnections();
      const accounts = await ownedLiveAccounts(store, principal, provider, connections);
      return respond(res, 200, {
        connected: accounts.length > 0,
        provider,
        requires_pro: false,
        accounts: accounts.map(accountView),
      });
    }

    case "accounts": {
      const connections = await listConnections();
      const accounts = await ownedLiveAccounts(store, principal, provider, connections);
      return respond(res, 200, { accounts: accounts.map(accountView) });
    }

    case "oauth-state": {
      let body = {};
      if (method === "POST") body = await readBody(req);
      else if (method !== "GET") return respond(res, 405, { message: "GET or POST only" });
      // Reconnect (plan step 5.4): account_id pins the attempt to an existing
      // product account so its id survives the new gateway connection.
      let targetAccountId = null;
      if (body.account_id) {
        const account = store.accountById(principal, String(body.account_id));
        if (!account || account.provider !== provider) {
          return respond(res, 404, { code: "unknown_account", message: "error.integrations.unknown_account" });
        }
        targetAccountId = account.id;
      }
      const begun = await beginAuthorization(store, {
        principal,
        provider,
        service,
        targetAccountId,
        customOAuth:
          provider.startsWith("feishu-") && body.client_id && body.client_secret
            ? {
                client_id: String(body.client_id),
                client_secret: String(body.client_secret),
              }
            : undefined,
      });
      if (!begun.ok) {
        console.error("[bff] oauth authorizations failed:", begun.status, begun.json);
        return notConfigured(res, provider);
      }
      return respond(res, 200, {
        // Additive lynclaw fields (opaque request id for the waiting/resume
        // flow); the legacy desktop fields below stay authoritative for it.
        authorization_request_id: begun.requestId,
        authorize_url: begun.authorizationUrl,
        expires_at: new Date(begun.expiresAt).toISOString(),
        state: begun.requestId,
        client_id: begun.clientId ?? `${service}-client`,
        scope: begun.scope ?? "",
        redirect_uri: begun.redirectUri ?? "https://www.lynse.ai/oc/oauth/callback",
        authorization_url: begun.authorizationUrl,
      });
    }

    case "oauth-result": {
      const requestId = url.searchParams.get("state") ?? "";
      const connections = await listConnections();
      const outcome = await pollAuthorizationResult(store, { principal, requestId, provider, connections });
      // Desktop contract keeps pending|done|error; expired/superseded surface
      // as errors so the settings UI restarts the flow instead of polling
      // forever. The lynclaw endpoint reports them distinctly.
      if (outcome.status === "invalid") {
        return respond(res, 404, { code: "state_invalid", message: "error.integrations.state_invalid" });
      }
      if (outcome.status === "done") return respond(res, 200, { status: "done", account_id: outcome.accountId });
      if (outcome.status === "pending") return respond(res, 200, { status: "pending" });
      return respond(res, 200, {
        status: "error",
        error: outcome.status === "expired" ? "error.integrations.state_expired" : "error.integrations.state_invalid",
      });
    }

    case "exchange-code": {
      if (method !== "POST") return respond(res, 405, { message: "POST only" });
      const body = await readBody(req);
      const requestId = String(body.state ?? "");
      const connections = await listConnections();
      const outcome = await pollAuthorizationResult(store, { principal, requestId, provider, connections });
      if (outcome.status !== "done") {
        return respond(res, 400, { code: "state_invalid", message: "error.integrations.state_invalid" });
      }
      return respond(res, 200, { connected: true, account: outcome.account });
    }

    case "disconnect": {
      if (method !== "DELETE") return respond(res, 405, { message: "DELETE only" });
      const accountId = url.searchParams.get("account_id") ?? "";
      const account = store.accountById(principal, accountId);
      if (!account || account.provider !== provider) {
        return respond(res, 404, { code: "unknown_account", message: "error.integrations.unknown_account" });
      }
      // Delete exactly this connection. Service-wide deletes are how two
      // users end up dropping each other's calendar — refuse instead.
      const del = await gw(
        `/api/connections/${encodeURIComponent(service)}/${encodeURIComponent(account.connection_id)}`,
        { method: "DELETE" },
      );
      if (!del.ok && del.status !== 404) {
        console.error("[bff] disconnect failed:", del.status, del.json);
        return respond(res, 502, { code: "gateway_unavailable", message: "gateway unavailable" });
      }
      store.deleteAccount(principal, accountId);
      const remaining = store.accountsFor(principal, provider).length;
      return respond(res, 200, { connected: remaining > 0, remaining });
    }

    case "auto-export": {
      if (method !== "PUT") return respond(res, 405, { message: "PUT only" });
      const body = await readBody(req);
      const updated = store.updateAccountSettings(principal, String(body.account_id ?? ""), {
        auto_export: Boolean(body.auto_export),
      });
      if (!updated) return respond(res, 404, { code: "unknown_account", message: "error.integrations.unknown_account" });
      return respond(res, 200, { ok: true, auto_export: updated.auto_export });
    }

    case "default-destination": {
      if (method !== "PUT") return respond(res, 405, { message: "PUT only" });
      const body = await readBody(req);
      if (!body.destination_id) {
        return respond(res, 400, { code: "unknown_destination", message: "error.integrations.unknown_destination" });
      }
      const updated = store.updateAccountSettings(principal, String(body.account_id ?? ""), {
        default_destination_id: String(body.destination_id),
      });
      if (!updated) return respond(res, 404, { code: "unknown_account", message: "error.integrations.unknown_account" });
      return respond(res, 200, { ok: true, destination_id: updated.default_destination_id });
    }

    case "destinations":
      return destinations(store, res, principal, provider, service);

    case "export":
      return exportActionItems(store, req, res, method, principal, provider, service);

    case "export-summary":
      return exportSummary(store, req, res, method, principal, provider, service);

    default:
      return respond(res, 404, { message: `unhandled verb ${verb}` });
  }
}

async function destinations(store, res, principal, provider, service) {
  if (provider === "feishu-docs") {
    return respond(res, 200, { destinations: [{ id: "root", name: "云空间根目录" }] });
  }
  if (provider === "feishu-mail") return respond(res, 200, { destinations: [] });
  if (!WIRED.has(provider)) return notConfigured(res, provider);
  const connections = await listConnections();
  const owned = await ownedLiveAccounts(store, principal, provider, connections);
  const resolution = resolveAccount(owned, undefined);
  if (!resolution.ok) return notConnected(res);
  const input = {};
  if (provider === "feishu-tasks") input.query = "";
  const actionId = provider === "feishu-tasks" ? "feishu.search_tasklists" : `${service}.list_projects`;
  const result = await runAction(actionId, input, resolution.account.connection_id);
  if (!result.ok) {
    return respond(res, 503, { code: result.reason, message: result.reason });
  }
  if (!result.run.ok) {
    console.error("[bff] destinations failed:", result.run.status, result.run.json);
    return notConnected(res);
  }
  const out = unwrap(result.run.json);
  const values = Array.isArray(out) ? out : (out?.items ?? out?.projects ?? out?.tasklists ?? out?.data ?? []);
  return respond(res, 200, {
    destinations: values.map((r) => ({
      id: String(r.guid ?? r.id ?? r.uid),
      name: String(r.name ?? r.title ?? r.summary ?? r.guid ?? r.id ?? "?"),
    })),
  });
}

async function exportActionItems(store, req, res, method, principal, provider, service) {
  if (method !== "POST") return respond(res, 405, { message: "POST only" });
  if (!WIRED.has(provider)) return notConfigured(res, provider);
  const body = await readBody(req);
  const connections = await listConnections();
  const owned = await ownedLiveAccounts(store, principal, provider, connections);
  const resolution = resolveAccount(owned, body.account_id ? String(body.account_id) : undefined);
  if (!resolution.ok) return notConnected(res);
  const account = resolution.account;
  const destinationId = body[DESTINATION_KEY[provider]] ?? account.default_destination_id ?? null;
  if (!destinationId) {
    return respond(res, 409, { code: "no_destination", message: "error.integrations.no_destination" });
  }
  const ids = Array.isArray(body.action_item_ids) ? body.action_item_ids.map(String) : [];
  const succeeded = [];
  const failed = [];
  for (const id of ids) {
    const input =
      provider === "feishu-tasks"
        ? { summary: `Lynse action item: ${id}`, tasklistGuids: [destinationId], clientToken: `lynse-${id}` }
        : { content: `Lynse action item: ${id}`, project_id: destinationId };
    const result = await runAction(`${service}.create_task`, input, account.connection_id);
    const external = result.ok ? unwrap(result.run.json) : null;
    if (result.ok && result.run.ok) {
      succeeded.push({
        id,
        external_id: String(external?.task?.guid ?? external?.guid ?? external?.task?.id ?? external?.id ?? id),
      });
    } else {
      if (result.ok) console.error("[bff] create_task failed:", result.run.status, result.run.json);
      failed.push({ id, reason: "error.integrations.export_item_failed" });
    }
  }
  return respond(res, 200, { succeeded, failed, destination_id: String(destinationId) });
}

async function exportSummary(store, req, res, method, principal, provider, service) {
  if (method !== "POST") return respond(res, 405, { message: "POST only" });
  if (provider !== "feishu-docs") return notConfigured(res, provider);
  const body = await readBody(req);
  const connections = await listConnections();
  const owned = await ownedLiveAccounts(store, principal, provider, connections);
  const resolution = resolveAccount(owned, body.account_id ? String(body.account_id) : undefined);
  if (!resolution.ok) return notConnected(res);
  const fileId = String(body.file_id ?? "");
  if (!fileId) return respond(res, 400, { code: "missing_file", message: "error.integrations.missing_file" });
  const items = Array.isArray(body.action_items) ? body.action_items.map(String) : [];
  const markdown = [
    String(body.summary ?? "").trim() || `Lynse summary ${fileId}`,
    ...(items.length ? ["", "## Action items", ...items.map((i) => `- ${i}`)] : []),
  ].join("\n");

  const existing = store.getSummaryDoc(principal, fileId);
  const fileName = existing?.file_name ?? `Lynse-${fileId}.md`;
  let fileToken;
  let docUrl;
  if (existing?.file_token) {
    const result = await runAction(
      "feishu.overwrite_markdown_file",
      { input: { fileToken: existing.file_token, markdown } },
      resolution.account.connection_id,
    );
    if (!result.ok || !result.run.ok) {
      if (result.ok) console.error("[bff] overwrite_markdown_file failed:", result.run.status, result.run.json);
      return respond(res, 502, { code: "gateway_unavailable", message: "gateway unavailable" });
    }
    fileToken = existing.file_token;
    docUrl = existing.url;
  } else {
    const result = await runAction(
      "feishu.create_markdown_file",
      { input: { fileName, markdown } },
      resolution.account.connection_id,
    );
    if (!result.ok || !result.run.ok) {
      if (result.ok) console.error("[bff] create_markdown_file failed:", result.run.status, result.run.json);
      return respond(res, 502, { code: "gateway_unavailable", message: "gateway unavailable" });
    }
    const doc = unwrap(result.run.json) ?? {};
    const created = doc.data ?? doc;
    fileToken = String(created?.token ?? created?.fileToken ?? created?.document?.token ?? fileId);
    docUrl = String(created?.url ?? created?.document?.url ?? `https://feishu.cn/docx/${fileToken}`);
  }
  store.setSummaryDoc(principal, fileId, { fileToken, url: docUrl, fileName });
  return respond(res, 200, {
    page_id: fileToken,
    url: docUrl,
    created: !existing,
    updated: Boolean(existing),
  });
}

// ---------------------------------------------------------------------------
// calendar (principal-scoped merge)
// ---------------------------------------------------------------------------

function eventTime(t) {
  if (!t) return null;
  if (typeof t === "string") return t;
  if (typeof t.dateTime === "string") return t.dateTime;
  if (t.timestamp !== undefined && t.timestamp !== null) {
    const n = Number(t.timestamp);
    if (Number.isFinite(n)) return new Date(String(t.timestamp).length > 11 ? n : n * 1000).toISOString();
  }
  if (typeof t.date === "string") return `${t.date}T00:00:00Z`;
  return null;
}

function googleMeetingUrl(event) {
  const entryPoints = event.conferenceData?.entryPoints;
  if (Array.isArray(entryPoints)) {
    for (const ep of entryPoints) {
      if (typeof ep?.uri === "string" && ep.uri) return ep.uri;
    }
  }
  if (typeof event.hangoutLink === "string" && event.hangoutLink) return event.hangoutLink;
  if (typeof event.location === "string") {
    const match = event.location.match(/https?:\/\/\S+/);
    if (match) return match[0];
  }
  return null;
}

function feishuMeetingUrl(event) {
  for (const key of ["conference", "videoConference", "video_conference"]) {
    const conf = event[key];
    if (!conf) continue;
    if (typeof conf.url === "string" && conf.url) return conf.url;
    if (Array.isArray(conf.entryPoints)) {
      for (const ep of conf.entryPoints) {
        if (typeof ep?.uri === "string" && ep.uri) return ep.uri;
      }
    }
  }
  for (const key of ["meetUrl", "online_meeting_url", "hangoutLink", "vcUrl"]) {
    if (typeof event[key] === "string" && event[key]) return event[key];
  }
  if (typeof event.location === "string") {
    const match = event.location.match(/https?:\/\/\S+/);
    if (match) return match[0];
  }
  return null;
}

async function calendarEvents(store, res, url, principal) {
  const connections = await listConnections();
  const from = url.searchParams.get("from") ?? new Date().toISOString();
  const to = url.searchParams.get("to") ?? new Date(Date.now() + 7 * 86_400_000).toISOString();

  const googleAccounts = await ownedLiveAccounts(store, principal, "google-calendar", connections);
  const feishuAccounts = await ownedLiveAccounts(store, principal, "feishu-calendar", connections);
  if (!googleAccounts.length && !feishuAccounts.length) {
    return respond(res, 200, { connected: false, events: [] });
  }

  const events = [];
  // Per-account action calls: each is pinned to that account's connection, so
  // one user's calendar can never bleed into another user's response.
  for (const account of googleAccounts) {
    const result = await runAction(
      "googlecalendar.list_events_all_calendars",
      { input: { timeMin: from, timeMax: to, singleEvents: true, maxResultsPerCalendar: 250 } },
      account.connection_id,
    );
    if (!result.ok || !result.run.ok) {
      if (result.ok) console.error("[bff] list_events failed:", result.run.status, result.run.json);
      continue;
    }
    const out = unwrap(result.run.json) ?? {};
    const values = Array.isArray(out.events) ? out.events : [];
    for (const e of values) {
      const start = eventTime(e.start);
      if (!start) continue;
      events.push({
        id: String(e.id ?? `${e.summary ?? "event"}-${start}`),
        title: String(e.summary ?? "(untitled)"),
        start_time: start,
        end_time: eventTime(e.end) ?? start,
        meeting_url: googleMeetingUrl(e),
        account_id: account.id,
      });
    }
  }

  for (const account of feishuAccounts) {
    const result = await runAction(
      "feishu.list_calendar_agenda",
      { input: { calendarId: "primary", startTime: from, endTime: to } },
      account.connection_id,
    );
    if (!result.ok || !result.run.ok) {
      if (result.ok) console.error("[bff] feishu agenda failed:", result.run.status, result.run.json);
      continue;
    }
    const out = unwrap(result.run.json) ?? {};
    const values = Array.isArray(out) ? out : (out.events ?? out.items ?? out.data ?? []);
    for (const e of values) {
      const start = eventTime(e.start_time ?? e.start);
      if (!start) continue;
      events.push({
        id: String(e.event_id ?? e.id ?? `${e.summary ?? "event"}-${start}`),
        title: String(e.summary ?? e.title ?? "(untitled)"),
        start_time: start,
        end_time: eventTime(e.end_time ?? e.end) ?? start,
        meeting_url: feishuMeetingUrl(e),
        account_id: account.id,
      });
    }
  }

  return respond(res, 200, { connected: true, events });
}

// ---------------------------------------------------------------------------
// feishu Model B self-serve (principal-scoped sessions + saved app)
// ---------------------------------------------------------------------------

const FEISHU_REGISTRATION_BASE = "https://accounts.feishu.cn";
const FEISHU_REGISTRATION_ENDPOINT = "/oauth/v1/app/registration";
const LYNSE_REDIRECT_URI = "https://www.lynse.ai/oc/oauth/callback";

function extractGrantUrl(message) {
  if (typeof message !== "string") return null;
  const match = message.match(/https:\/\/open\.feishu\.cn\/app\/[a-z0-9_]+\/auth\?[^\s]+/);
  return match ? match[0] : null;
}

async function ensureFeishuRedirect(clientId, clientSecret) {
  try {
    const tokenRes = await fetch("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ app_id: clientId, app_secret: clientSecret }),
      signal: AbortSignal.timeout(15_000),
    });
    const tokenJson = await tokenRes.json().catch(() => ({}));
    const tenantToken = tokenJson.tenant_access_token;
    if (!tenantToken) {
      console.error("[bff] feishu tenant token failed:", tokenJson.code, tokenJson.msg);
      return { ok: false, grantUrl: extractGrantUrl(tokenJson.msg) };
    }
    const patchRes = await fetch(
      `https://open.feishu.cn/open-apis/application/v7/applications/${encodeURIComponent(clientId)}/config`,
      {
        method: "PATCH",
        headers: { Authorization: `Bearer ${tenantToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ security: { add: { redirect_urls: [LYNSE_REDIRECT_URI] } } }),
        signal: AbortSignal.timeout(15_000),
      },
    );
    const patchJson = await patchRes.json().catch(() => ({}));
    if (patchJson.code !== 0) {
      console.error("[bff] feishu redirect patch failed:", patchJson.code, patchJson.msg);
      return { ok: false, grantUrl: extractGrantUrl(patchJson.msg) };
    }
    return { ok: true, grantUrl: null };
  } catch (error) {
    console.error("[bff] ensureFeishuRedirect error:", error?.message ?? error);
    return { ok: false, grantUrl: null };
  }
}

async function feishuRegistration(baseUrl, params) {
  const res = await fetch(`${baseUrl}${FEISHU_REGISTRATION_ENDPOINT}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString(),
    signal: AbortSignal.timeout(20_000),
  });
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

function encodeFeishuAddons() {
  const manifest = {
    preset: false,
    scopes: { tenant: ["application:application"], user: FEISHU_SCOPES },
  };
  return gzipSync(Buffer.from(JSON.stringify(manifest))).toString("base64url");
}

async function mintFeishuAuthorization(store, principal, { clientId, clientSecret }) {
  const before = new Set((await listConnections()).map((c) => c.id));
  const begun = await beginAuthorization(store, {
    principal,
    provider: "feishu-calendar",
    service: "feishu",
    customOAuth: { client_id: clientId, client_secret: clientSecret, scopes: FEISHU_SCOPES },
  });
  return { begun, before };
}

async function feishuAppSetup(store, req, res, method, url, principal) {
  if (method === "POST") {
    const body = await readBody(req).catch(() => ({}));
    if (body.reuse === true) {
      const saved = store.getFeishuApp(principal);
      if (!saved) return respond(res, 409, { code: "no_saved_app", message: "no saved feishu app" });
      const redirect = await ensureFeishuRedirect(saved.client_id, saved.client_secret);
      const { begun } = await mintFeishuAuthorization(store, principal, {
        clientId: saved.client_id,
        clientSecret: saved.client_secret,
      });
      if (!begun.ok) return respond(res, 502, { code: "gateway_unavailable", message: "gateway unavailable" });
      return respond(res, 200, {
        status: "ready",
        oauth_state: begun.requestId,
        authorization_url: begun.authorizationUrl,
        client_id: saved.client_id,
        redirect_uri: LYNSE_REDIRECT_URI,
        redirect_configured: redirect.ok,
        permission_grant_url: redirect.grantUrl,
      });
    }
    const begin = await feishuRegistration(FEISHU_REGISTRATION_BASE, {
      action: "begin",
      archetype: "PersonalAgent",
      auth_method: "client_secret",
      request_user_info: "open_id",
    });
    if (!begin?.verification_uri_complete || !begin?.device_code) {
      console.error("[bff] feishu registration begin failed:", begin);
      return respond(res, 502, { code: "gateway_unavailable", message: "gateway unavailable" });
    }
    const confirmUrl = new URL(begin.verification_uri_complete);
    confirmUrl.searchParams.set("from", "sdk");
    confirmUrl.searchParams.set("source", "lynse-bff");
    confirmUrl.searchParams.set("tp", "sdk");
    confirmUrl.searchParams.set("addons", encodeFeishuAddons());
    confirmUrl.searchParams.set("createOnly", "true");
    confirmUrl.searchParams.set("name", "灵光记 Lynse");
    confirmUrl.searchParams.set("desc", "保存会议总结到多维表格与文档，读取日程做会前提醒");
    const token = randomId("setup-feishu-");
    feishuSessions.set(token, {
      principal,
      deviceCode: begin.device_code,
      baseUrl: FEISHU_REGISTRATION_BASE,
      interval: (begin.interval ?? 5) * 1000,
      expiresAt: Date.now() + (begin.expires_in ?? 600) * 1000,
      lastPolledAt: 0,
      lastPollResult: null,
    });
    return respond(res, 200, { state: token, url: confirmUrl.toString(), expire_in: begin.expires_in ?? 600 });
  }

  if (method === "GET") {
    const token = url.searchParams.get("state") ?? "";
    const session = feishuSessions.get(token);
    if (!session || session.principal !== principal) {
      return respond(res, 404, { code: "state_invalid", message: "error.integrations.state_invalid" });
    }
    if (Date.now() > session.expiresAt) {
      feishuSessions.delete(token);
      return respond(res, 200, { status: "error", error: "error.integrations.state_invalid" });
    }
    if (Date.now() - session.lastPolledAt < session.interval && session.lastPollResult) {
      return respond(res, 200, session.lastPollResult);
    }
    session.lastPolledAt = Date.now();
    const poll = await feishuRegistration(session.baseUrl, { action: "poll", device_code: session.deviceCode });

    if (poll.client_id && poll.client_secret) {
      store.setFeishuApp(principal, { clientId: poll.client_id, clientSecret: poll.client_secret });
      const redirect = await ensureFeishuRedirect(poll.client_id, poll.client_secret);
      const { begun } = await mintFeishuAuthorization(store, principal, {
        clientId: poll.client_id,
        clientSecret: poll.client_secret,
      });
      feishuSessions.delete(token);
      if (!begun.ok) return respond(res, 200, { status: "error", error: "error.integrations.not_configured" });
      return respond(res, 200, {
        status: "ready",
        oauth_state: begun.requestId,
        authorization_url: begun.authorizationUrl,
        client_id: poll.client_id,
        redirect_uri: LYNSE_REDIRECT_URI,
        redirect_configured: redirect.ok,
        permission_grant_url: redirect.grantUrl,
      });
    }

    if (poll.user_info?.tenant_brand === "lark") session.baseUrl = "https://accounts.larksuite.com";
    let result = { status: "waiting" };
    if (poll.error === "slow_down") session.interval += 5000;
    if (poll.error === "access_denied" || poll.error === "expired_token") {
      feishuSessions.delete(token);
      result = { status: "error", error: "error.integrations.auth_failed" };
    }
    session.lastPollResult = result;
    return respond(res, 200, result);
  }

  return respond(res, 405, { message: "GET or POST only" });
}
