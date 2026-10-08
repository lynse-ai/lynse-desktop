/**
 * Lynse Connections BFF — adapts the Pocket-style contract
 * (`/api/v2/integrations/*`, `/api/v2/calendar/*`, see
 * docs/connections-api-contract.md) onto a self-hosted OpenConnector gateway
 * (https://github.com/oomol-lab/open-connector).
 *
 * Response shapes intentionally mirror `e2e/fixtures/integrations-mock.ts`:
 * the desktop client (`packages/core/integrations/*`) and its error predicates
 * were written against that fixture. Successes are plain JSON; failures are
 * HTTP-status errors whose body carries `{ code, message: "error.integrations.<key>" }`.
 *
 * Provider rows are service-scoped (contract §1: google-calendar, outlook-
 * calendar, notion, todoist, google-tasks + the feishu set) while the gateway
 * services behind them may be shared — the four feishu-* rows all ride ONE
 * `feishu` connection, so disconnecting any feishu row drops all four.
 *
 * Feishu is Model B self-serve: the user's own org app (created via the
 * launcher link) rides the connect request as connection-level custom OAuth
 * (`OOMOL_CONNECT_ALLOWED_CUSTOM_OAUTH`); the BFF forwards the credentials and
 * never persists them. Third-party access/refresh tokens never leave the
 * gateway; this BFF persists only account metadata, toggles and destinations.
 *
 * Deploy (see README.md in this directory): single node process, no deps,
 * state in one JSON file.
 */

import { createServer } from "node:http";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { gzipSync } from "node:zlib";

import { config } from "./src/env.mjs";
import { Store } from "./src/store.mjs";
import { createStoreBoundHandler } from "./src/routes.mjs";

const PORT = config.port;

/**
 * CONNECTORS_MULTIUSER=1 routes every request through the per-principal
 * registry (verified identity, SQLite state, alias-matched OAuth, explicit
 * connection selection). The default keeps the legacy single-tenant debug
 * behaviour below untouched — the flag flip happens after the state
 * migration (`tools/migrate-state.mjs`), per the rollout plan (step 12.3).
 */
let multiuserHandler = null;
if (config.multiuser) {
  try {
    const store = new Store(config.dbFile);
    multiuserHandler = createStoreBoundHandler(store);
    console.log(`[bff] multiuser registry at ${config.dbFile}, identity ${config.identityUrl || "UNCONFIGURED"}`);
    if (!config.identityUrl) {
      console.error("[bff] refusing multiuser mode without IDENTITY_URL — every request would 401");
      process.exit(1);
    }
  } catch (error) {
    console.error("[bff] multiuser registry unavailable (node >= 22.5 with node:sqlite required):", error?.message ?? error);
    process.exit(1);
  }
}
const GW = (process.env.GW ?? "http://127.0.0.1:3100/oc").replace(/\/+$/, "");
const ADMIN_TOKEN = process.env.ADMIN_TOKEN ?? "";
const RUNTIME_TOKEN = process.env.RUNTIME_TOKEN ?? ADMIN_TOKEN;
const STATE_FILE = process.env.STATE_FILE ?? "/data/state.json";

/** Contract provider → gateway service name (src/providers/<name>). The four
 *  feishu-* contract providers share ONE gateway connection (one Feishu
 *  account powers calendar/docs/tasks/mail), so disconnecting any of them
 *  drops all four — deliberate for the debug deployment. */
const SERVICES = {
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

/** Free-tier providers per contract §4; everything else would be Pro once the
 *  real entitlement matrix exists. Debug deployment: nobody is paywalled. */
const REQUIRES_PRO = new Set();

/** Export body key per provider (contract §2.7). */
const DESTINATION_KEY = {
  todoist: "default_project_id",
  "google-tasks": "default_task_list_id",
  notion: "default_database_id",
  "feishu-tasks": "default_task_list_id",
  "feishu-docs": "default_database_id",
};

/** Providers whose export wiring is complete in this phase. feishu-docs is
 *  export-summary only (export of bare action items stays 503 for it). */
const WIRED = new Set(["todoist", "feishu-tasks"]);

/** Feishu user-token scopes requested for the connector set. The user creates
 *  their own org app via the launcher link (Model B), so these ride the
 *  connection-level custom OAuth credentials on every connect. */
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

/** Feishu org apps are per-tenant (Model B), so the desktop shows a guided
 *  setup until the user's own app credentials have produced a connection.
 *  Cached briefly — /api/oauth/configs is a large listing. */
let feishuConfiguredCache = { value: false, at: 0 };

async function feishuAppConfigured() {
  if (Date.now() - feishuConfiguredCache.at < 60_000) return feishuConfiguredCache.value;
  const { json } = await gw("/api/oauth/configs");
  const entry = Array.isArray(json) ? json.find((c) => c.service === "feishu") : undefined;
  feishuConfiguredCache = { value: Boolean(entry?.configured), at: Date.now() };
  return feishuConfiguredCache.value;
}

// ---------------------------------------------------------------------------
// Feishu one-click app creation (device-code registration, RFC 8628 style).
// Mirrors larksuite/node-sdk scene/registration: `action=begin` issues a
// short-lived user_code, the user confirms in Feishu, and `action=poll`
// returns the created app's client_id/client_secret — so the credentials
// flow server-side (BFF → gateway) and the user never copies anything.
// ---------------------------------------------------------------------------

const FEISHU_REGISTRATION_BASE = "https://accounts.feishu.cn";
const FEISHU_REGISTRATION_ENDPOINT = "/oauth/v1/app/registration";
const LYNSE_REDIRECT_URI = "https://www.lynse.ai/oc/oauth/callback";

/**
 * Auto-register our OAuth callback on the user's freshly created org app:
 * PATCH /application/v7/applications/:app_id/config with
 * security.add.redirect_urls accepts the app's own tenant token and applies
 * IMMEDIATELY (no version release) — so the one manual paste disappears
 * whenever the app carries application:application:patch. Returns
 * { ok:false, grantUrl } (caller surfaces the one-click grant deep link) on
 * any failure; never throws.
 */
/** Feishu's scope-denied errors embed a one-click console URL that grants the
 *  missing app-identity scope — surface it so the client can offer a single
 *  "enable permission" click instead of any pasting. */
function extractGrantUrl(message) {
  if (typeof message !== "string") return null;
  const match = message.match(/https:\/\/open\.feishu\.cn\/app\/[a-z0-9_]+\/auth\?[^\s]+/);
  return match ? match[0] : null;
}

async function ensureFeishuRedirect(clientId, clientSecret) {
  try {
    const tokenRes = await fetch(
      "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ app_id: clientId, app_secret: clientSecret }),
        signal: AbortSignal.timeout(15_000),
      },
    );
    const tokenJson = await tokenRes.json().catch(() => ({}));
    const tenantToken = tokenJson.tenant_access_token;
    if (!tenantToken) {
      console.error("[bff] feishu tenant token failed:", tokenJson.code, tokenJson.msg);
      return { ok: false, grantUrl: extractGrantUrl(tokenJson.msg) };
    }
    // v7 config PATCH is the self-built-app endpoint: security.add is
    // additive and redirect URLs apply IMMEDIATELY (no version release).
    // The v6 applications PATCH writes a draft layer instead and never takes
    // effect for OAuth — do not fall back to it.
    const patchRes = await fetch(
      `https://open.feishu.cn/open-apis/application/v7/applications/${encodeURIComponent(clientId)}/config`,
      {
        method: "PATCH",
        headers: { Authorization: `Bearer ${tenantToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          security: { add: { redirect_urls: [LYNSE_REDIRECT_URI] } },
        }),
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
  // `preset:false` = minimal base plus exactly our scopes. User-identity
  // scopes power the gateway's user_token actions; the one tenant scope
  // (`application:application`) lets the app patch its own security settings
  // (redirect URLs) via the application-config OpenAPI — without it the
  // auto-registered callback falls back to the guided manual paste.
  const manifest = {
    preset: false,
    scopes: {
      tenant: ["application:application"],
      user: FEISHU_SCOPES,
    },
  };
  return gzipSync(Buffer.from(JSON.stringify(manifest))).toString("base64url");
}

// ---------------------------------------------------------------------------
// state
// ---------------------------------------------------------------------------

let state = { seq: 0, accounts: {}, oauth: {}, summaryDocs: {}, feishuApp: null };
if (existsSync(STATE_FILE)) {
  try {
    state = JSON.parse(readFileSync(STATE_FILE, "utf8"));
  } catch {
    // Corrupt state starts fresh; toggles/destinations are re-pickable.
  }
}

function saveState() {
  mkdirSync(dirname(STATE_FILE), { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// ---------------------------------------------------------------------------
// gateway access
// ---------------------------------------------------------------------------

async function gw(path, { method = "GET", body, token = ADMIN_TOKEN } = {}) {
  const res = await fetch(`${GW}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20_000),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }
  return { status: res.status, ok: res.ok, json };
}

async function listConnections() {
  const { json } = await gw("/api/connections");
  return Array.isArray(json) ? json : [];
}

/** Gateway connection entries that represent a real (non-virtual) connection. */
function realConnections(connections, service) {
  return connections.filter((c) => c.service === service && !c.virtual && c.configured);
}

// ---------------------------------------------------------------------------
// account model
// ---------------------------------------------------------------------------

function accountFor(provider, connection) {
  const existing = Object.values(state.accounts).find(
    (a) => a.provider === provider && a.connectionId === connection.id,
  );
  if (existing) return existing;

  state.seq += 1;
  const accountId = `acct-${provider}-${state.seq}`;
  const profile = connection.profile ?? {};
  const label = profile.displayName || profile.accountId || `${SERVICES[provider] ?? provider} account`;
  const account = {
    id: accountId,
    provider,
    connectionId: connection.id,
    email: label.includes("@") ? label : `${label}`,
    display_name: label,
    workspace_name: provider === "notion" ? label : undefined,
    is_primary: !Object.values(state.accounts).some((a) => a.provider === provider),
    sync_enabled: true,
    notify_enabled: true,
    auto_export: false,
    default_destination_id: null,
  };
  state.accounts[accountId] = account;
  saveState();
  return account;
}

function accountView(account) {
  return {
    id: account.id,
    email: account.email,
    display_name: account.display_name,
    ...(account.workspace_name ? { workspace_name: account.workspace_name } : {}),
    is_primary: account.is_primary,
    sync_enabled: account.sync_enabled,
    notify_enabled: account.notify_enabled,
    auto_export: account.auto_export,
    default_destination_id: account.default_destination_id,
  };
}

// ---------------------------------------------------------------------------
// contract responses (mock-faithful)
// ---------------------------------------------------------------------------

function respond(res, status, body) {
  const payload = JSON.stringify(body ?? {});
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers":
      "Authorization, Content-Type, X-API-Key, X-Client-Platform, X-Lynse-Api-Url",
    "Cache-Control": "no-store",
  });
  res.end(payload);
}

const notConfigured = (res, provider) =>
  respond(res, 503, { code: "not_configured", message: "error.integrations.not_configured", provider });
const notConnected = (res) =>
  respond(res, 409, { code: "not_connected", message: "error.integrations.not_connected" });

// ---------------------------------------------------------------------------
// routing
// ---------------------------------------------------------------------------

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return {};
  }
}

async function handle(req, res) {
  const url = new URL(req.url, "http://localhost");
  const method = req.method ?? "GET";
  const path = url.pathname;

  if (method === "OPTIONS") return respond(res, 204, {});
  if (!path.startsWith("/api/v2/integrations/") && !path.startsWith("/api/v2/calendar/")) {
    return respond(res, 404, { message: `unhandled route ${method} ${path}` });
  }

  // ---- /api/v2/calendar ----------------------------------------------------
  if (path === "/api/v2/calendar/events" && method === "GET") {
    return calendarEvents(res, url);
  }
  const toggleMatch = path.match(/^\/api\/v2\/calendar\/accounts\/([^/]+)\/toggles$/);
  if (toggleMatch && method === "PUT") {
    const account = state.accounts[decodeURIComponent(toggleMatch[1])];
    if (!account) {
      return respond(res, 404, { code: "unknown_account", message: "error.integrations.unknown_account" });
    }
    const body = await readBody(req);
    if (typeof body.sync_enabled === "boolean") account.sync_enabled = body.sync_enabled;
    if (typeof body.notify_enabled === "boolean") account.notify_enabled = body.notify_enabled;
    saveState();
    return respond(res, 200, { ok: true });
  }

  // ---- /api/v2/integrations/feishu-app-setup (Model B self-serve) ----------
  if (path === "/api/v2/integrations/feishu-app-setup") {
    return feishuAppSetup(req, res, method, url);
  }

  // ---- /api/v2/integrations/{provider}/... ---------------------------------
  const match = path.match(
    /^\/api\/v2\/integrations\/([^/]+)\/(status|accounts|oauth-state|oauth-result|exchange-code|disconnect|auto-export|default-destination|destinations|export|export-summary)$/,
  );
  if (!match) return respond(res, 404, { message: `unhandled route ${method} ${path}` });

  const provider = decodeURIComponent(match[1]);
  const verb = match[2];
  const service = SERVICES[provider];
  if (!service) return notConfigured(res, provider);

  try {
    return await handleProviderRoute(req, res, method, provider, service, verb, url);
  } catch (error) {
    // Gateway unreachable / timeout: a 5xx keeps the client retrying instead
    // of killing the status query (isTransientIntegrationsError treats >=500
    // as transient).
    console.error(`[bff] ${method} ${path} failed:`, error?.message ?? error);
    return respond(res, 502, { code: "gateway_unavailable", message: "gateway unavailable" });
  }
}

async function handleProviderRoute(req, res, method, provider, service, verb, url) {
  switch (verb) {
    case "status": {
      const connections = await listConnections();
      const accounts = realConnections(connections, service).map((c) => accountFor(provider, c));
      let setupRequired = false;
      if (provider.startsWith("feishu-") && !accounts.length && !(await feishuAppConfigured())) {
        setupRequired = true;
      }
      return respond(res, 200, {
        connected: accounts.length > 0,
        provider,
        requires_pro: REQUIRES_PRO.has(provider),
        accounts: accounts.map(accountView),
        ...(setupRequired ? { setup_required: true } : {}),
      });
    }

    case "accounts": {
      const connections = await listConnections();
      const accounts = realConnections(connections, service).map((c) => accountFor(provider, c));
      return respond(res, 200, { accounts: accounts.map(accountView) });
    }

    case "oauth-state": {
      // GET = ride the gateway's globally configured OAuth app (Google path).
      // POST = Model B self-serve: the body carries the user's own org-app
      // credentials, which ride the connection as custom OAuth (gateway keeps
      // them for refresh; this BFF never persists them).
      let body = {};
      if (method === "POST") {
        body = await readBody(req);
      } else if (method !== "GET") {
        return respond(res, 405, { message: "GET or POST only" });
      }
      // Snapshot connection ids so oauth-result can spot the newly added one
      // (the gateway's OAuth completion lands in its connection store).
      const before = new Set((await listConnections()).map((c) => c.id));
      const authBody = { service };
      if (provider.startsWith("feishu-") && body.client_id && body.client_secret) {
        authBody.clientId = String(body.client_id);
        authBody.clientSecret = String(body.client_secret);
        authBody.requestedScopes = FEISHU_SCOPES;
      }
      const auth = await gw("/api/oauth/authorizations", {
        method: "POST",
        body: authBody,
      });
      if (!auth.ok) {
        console.error("[bff] oauth authorizations failed:", auth.status, auth.json);
        return notConfigured(res, provider);
      }
      const j = auth.json ?? {};
      const authorizationUrl = j.authorizationUrl ?? j.authorization_url ?? j.url;
      if (!authorizationUrl) return notConfigured(res, provider);
      const stateToken = `state-${provider}-${++state.seq}`;
      state.oauth[stateToken] = {
        kind: "oauth",
        provider,
        service,
        before: [...before],
        issuedAt: Date.now(),
      };
      saveState();
      return respond(res, 200, {
        state: stateToken,
        client_id: j.clientId ?? `${service}-client`,
        scope: j.scope ?? "",
        redirect_uri: j.redirectUri ?? "https://www.lynse.ai/oc/oauth/callback",
        authorization_url: authorizationUrl,
      });
    }

    case "oauth-result": {
      const token = url.searchParams.get("state");
      const session = token ? state.oauth[token] : undefined;
      if (!session || session.kind !== "oauth" || session.provider !== provider) {
        return respond(res, 404, { code: "state_invalid", message: "error.integrations.state_invalid" });
      }
      const connections = await listConnections();
      const fresh = connections.find(
        (c) => c.service === session.service && !c.virtual && c.configured && !session.before.includes(c.id),
      );
      if (!fresh) return respond(res, 200, { status: "pending" });
      const account = accountFor(provider, fresh);
      delete state.oauth[token];
      saveState();
      return respond(res, 200, { status: "done", account_id: account.id });
    }

    case "exchange-code": {
      // P1 deep-link path: the desktop posts the code it caught itself. The
      // gateway already owns the code exchange via its callback, so this only
      // reports the resulting account (contract §2.2 ③).
      const body = await readBody(req);
      const session = state.oauth[String(body.state ?? "")];
      if (!session || session.kind !== "oauth" || session.provider !== provider) {
        return respond(res, 400, { code: "state_invalid", message: "error.integrations.state_invalid" });
      }
      const connections = await listConnections();
      const fresh = connections.find(
        (c) => c.service === session.service && !c.virtual && c.configured && !session.before.includes(c.id),
      );
      if (!fresh) return respond(res, 400, { code: "state_invalid", message: "error.integrations.state_invalid" });
      const account = accountFor(provider, fresh);
      delete state.oauth[String(body.state)];
      saveState();
      return respond(res, 200, { connected: true, account: accountView(account) });
    }

    case "disconnect": {
      if (method !== "DELETE") return respond(res, 405, { message: "DELETE only" });
      const accountId = url.searchParams.get("account_id") ?? "";
      const account = state.accounts[accountId];
      if (!account || account.provider !== provider) {
        return respond(res, 404, { code: "unknown_account", message: "error.integrations.unknown_account" });
      }
      const del = await gw(`/api/connections/${service}`, { method: "DELETE" });
      if (!del.ok && del.status !== 404) {
        console.error("[bff] disconnect failed:", del.status, del.json);
        return respond(res, 502, { code: "gateway_unavailable", message: "gateway unavailable" });
      }
      delete state.accounts[accountId];
      // One Feishu connection backs all four feishu-* contract rows — drop
      // every one of them together with the shared gateway connection.
      if (provider.startsWith("feishu-")) {
        for (const [id, a] of Object.entries(state.accounts)) {
          if (String(a.provider ?? "").startsWith("feishu-")) delete state.accounts[id];
        }
      }
      saveState();
      const remaining = Object.values(state.accounts).filter((a) => a.provider === provider).length;
      return respond(res, 200, { connected: remaining > 0, remaining });
    }

    case "auto-export": {
      if (method !== "PUT") return respond(res, 405, { message: "PUT only" });
      const body = await readBody(req);
      const account = state.accounts[String(body.account_id ?? "")];
      if (!account || account.provider !== provider) {
        return respond(res, 404, { code: "unknown_account", message: "error.integrations.unknown_account" });
      }
      account.auto_export = Boolean(body.auto_export);
      saveState();
      return respond(res, 200, { ok: true, auto_export: account.auto_export });
    }

    case "default-destination": {
      if (method !== "PUT") return respond(res, 405, { message: "PUT only" });
      const body = await readBody(req);
      const account = state.accounts[String(body.account_id ?? "")];
      if (!account || account.provider !== provider) {
        return respond(res, 404, { code: "unknown_account", message: "error.integrations.unknown_account" });
      }
      if (!body.destination_id) {
        return respond(res, 400, { code: "unknown_destination", message: "error.integrations.unknown_destination" });
      }
      account.default_destination_id = String(body.destination_id);
      saveState();
      return respond(res, 200, { ok: true, destination_id: account.default_destination_id });
    }

    case "destinations": {
      // feishu-docs exports to the drive root; feishu-mail has no export
      // consumer yet — both answer an empty catalogue instead of 503 so the
      // connected row stays configurable.
      if (provider === "feishu-docs") {
        return respond(res, 200, { destinations: [{ id: "root", name: "云空间根目录" }] });
      }
      if (provider === "feishu-mail") return respond(res, 200, { destinations: [] });
      if (!WIRED.has(provider)) return notConfigured(res, provider);
      const connections = await listConnections();
      const accounts = realConnections(connections, service);
      if (!accounts.length) return notConnected(res);
      // Action result envelopes vary across executors; unwrap defensively.
      // feishu.search_tasklists requires query or ownerIds — scope the search
      // to the connected user's own lists via their open_id.
      const input = {};
      if (provider === "feishu-tasks") {
        const ownerId = accounts[0]?.profile?.accountId;
        if (ownerId) input.ownerIds = [ownerId];
        else input.query = "";
      }
      const actionId = provider === "feishu-tasks" ? "feishu.search_tasklists" : `${service}.list_projects`;
      const run = await gw(`/v1/actions/${actionId}`, {
        method: "POST",
        body: { input },
        token: RUNTIME_TOKEN,
      });
      if (!run.ok) {
        console.error("[bff] destinations failed:", run.status, run.json);
        return notConnected(res);
      }
      const out = unwrap(run.json);
      const rows = Array.isArray(out) ? out : (out?.items ?? out?.projects ?? out?.tasklists ?? out?.data ?? []);
      return respond(res, 200, {
        destinations: rows.map((r) => ({
          id: String(r.guid ?? r.id ?? r.uid),
          name: String(r.name ?? r.title ?? r.summary ?? r.guid ?? r.id ?? "?"),
        })),
      });
    }

    case "export": {
      if (method !== "POST") return respond(res, 405, { message: "POST only" });
      if (!WIRED.has(provider)) return notConfigured(res, provider);
      const body = await readBody(req);
      const connections = await listConnections();
      const accounts = realConnections(connections, service);
      if (!accounts.length) return notConnected(res);
      const account = accountFor(provider, accounts[0]);
      const destinationId = body[DESTINATION_KEY[provider]] ?? account?.default_destination_id ?? null;
      if (!destinationId) {
        return respond(res, 409, { code: "no_destination", message: "error.integrations.no_destination" });
      }
      const ids = Array.isArray(body.action_item_ids) ? body.action_item_ids.map(String) : [];
      const succeeded = [];
      const failed = [];
      for (const id of ids) {
        // The business backend owns action-item rows, so the BFF cannot resolve
        // text — placeholder title until the real backend takes over (README).
        const input =
          provider === "feishu-tasks"
            ? { summary: `Lynse action item: ${id}`, tasklistGuids: [destinationId], clientToken: `lynse-${id}` }
            : { content: `Lynse action item: ${id}`, project_id: destinationId };
        const run = await gw(`/v1/actions/${service}.create_task`, {
          method: "POST",
          body: { input },
          token: RUNTIME_TOKEN,
        });
        const external = unwrap(run.json);
        if (run.ok) {
          succeeded.push({
            id,
            external_id: String(
              external?.task?.guid ?? external?.guid ?? external?.task?.id ?? external?.id ?? id,
            ),
          });
        } else {
          console.error("[bff] create_task failed:", run.status, run.json);
          failed.push({ id, reason: "error.integrations.export_item_failed" });
        }
      }
      return respond(res, 200, { succeeded, failed, destination_id: String(destinationId) });
    }

    case "export-summary": {
      if (method !== "POST") return respond(res, 405, { message: "POST only" });
      if (provider !== "feishu-docs") return notConfigured(res, provider);
      const body = await readBody(req);
      const connections = await listConnections();
      const accounts = realConnections(connections, service);
      if (!accounts.length) return notConnected(res);
      const fileId = String(body.file_id ?? "");
      if (!fileId) {
        return respond(res, 400, { code: "missing_file", message: "error.integrations.missing_file" });
      }
      const items = Array.isArray(body.action_items) ? body.action_items.map(String) : [];
      const markdown = [
        String(body.summary ?? "").trim() || `Lynse summary ${fileId}`,
        ...(items.length ? ["", "## Action items", ...items.map((i) => `- ${i}`)] : []),
      ].join("\n");

      // Upsert (PRD FR-3 AC): the first export creates the Drive markdown file,
      // later exports of the same note overwrite it via the stored file token.
      const existing = state.summaryDocs[fileId];
      const fileName = existing?.fileName ?? `Lynse-${fileId}.md`;
      let fileToken;
      let docUrl;
      if (existing?.fileToken) {
        const run = await gw("/v1/actions/feishu.overwrite_markdown_file", {
          method: "POST",
          body: { input: { fileToken: existing.fileToken, markdown } },
          token: RUNTIME_TOKEN,
        });
        if (!run.ok) {
          console.error("[bff] overwrite_markdown_file failed:", run.status, run.json);
          return respond(res, 502, { code: "gateway_unavailable", message: "gateway unavailable" });
        }
        fileToken = existing.fileToken;
        docUrl = existing.url;
      } else {
        const run = await gw("/v1/actions/feishu.create_markdown_file", {
          method: "POST",
          body: { input: { fileName, markdown } },
          token: RUNTIME_TOKEN,
        });
        if (!run.ok) {
          console.error("[bff] create_markdown_file failed:", run.status, run.json);
          return respond(res, 502, { code: "gateway_unavailable", message: "gateway unavailable" });
        }
        const out = unwrap(run.json) ?? {};
        const doc = out.data ?? out;
        fileToken = String(doc?.token ?? doc?.fileToken ?? doc?.document?.token ?? fileId);
        docUrl = String(doc?.url ?? doc?.document?.url ?? `https://feishu.cn/docx/${fileToken}`);
      }
      state.summaryDocs[fileId] = { fileToken, url: docUrl, fileName };
      saveState();
      return respond(res, 200, {
        page_id: fileToken,
        url: docUrl,
        created: !existing,
        updated: Boolean(existing),
      });
    }

    default:
      return respond(res, 404, { message: `unhandled verb ${verb}` });
  }
}

function unwrap(json) {
  if (json == null) return null;
  return json.output ?? json.result ?? json.data ?? json;
}

/**
 * POST = begin a one-click app creation: mints a short-lived Feishu
 * confirmation URL (user_code inside) and stores the device session.
 * GET  = poll: relays the poll to Feishu (throttled to its interval); when the
 * user has confirmed, Feishu answers with the created app's client_id/secret,
 * which this BFF immediately spends on a custom-OAuth authorization — the
 * response hands the desktop the authorize URL and the desktop never sees the
 * credentials.
 */
async function feishuAppSetup(req, res, method, url) {
  if (method === "POST") {
    const body = await readBody(req).catch(() => ({}));
    // Reuse path: an org app already exists (created in an earlier run) — skip
    // registration and mint a fresh user authorization from the saved
    // credentials. Returns the same `ready` shape as the poll so the desktop
    // dialog flow is identical.
    if (body.reuse === true) {
      const saved = state.feishuApp;
      if (!saved) {
        return respond(res, 409, { code: "no_saved_app", message: "no saved feishu app" });
      }
      // The callback may have been registered on a previous attempt; try to
      // (re-)ensure it so the authorize jump cannot bounce with 20029.
      const redirect = await ensureFeishuRedirect(saved.clientId, saved.clientSecret);
      const before = new Set((await listConnections()).map((c) => c.id));
      const auth = await gw("/api/oauth/authorizations", {
        method: "POST",
        body: {
          service: "feishu",
          clientId: saved.clientId,
          clientSecret: saved.clientSecret,
          requestedScopes: FEISHU_SCOPES,
        },
      });
      if (!auth.ok) {
        console.error("[bff] reuse authorization failed:", auth.status, auth.json);
        return respond(res, 502, { code: "gateway_unavailable", message: "gateway unavailable" });
      }
      const authUrl = auth.json?.authorizationUrl ?? auth.json?.authorization_url ?? null;
      if (!authUrl) return respond(res, 502, { code: "gateway_unavailable", message: "gateway unavailable" });
      const oauthToken = `state-feishu-calendar-${++state.seq}`;
      state.oauth[oauthToken] = {
        kind: "oauth",
        provider: "feishu-calendar",
        service: "feishu",
        before: [...before],
        issuedAt: Date.now(),
      };
      saveState();
      return respond(res, 200, {
        status: "ready",
        oauth_state: oauthToken,
        authorization_url: authUrl,
        client_id: saved.clientId,
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
    const token = `setup-feishu-${++state.seq}`;
    state.oauth[token] = {
      kind: "feishu-registration",
      deviceCode: begin.device_code,
      baseUrl: FEISHU_REGISTRATION_BASE,
      interval: (begin.interval ?? 5) * 1000,
      expiresAt: Date.now() + (begin.expires_in ?? 600) * 1000,
      provider: "feishu-calendar",
      lastPolledAt: 0,
    };
    saveState();
    return respond(res, 200, {
      state: token,
      url: confirmUrl.toString(),
      expire_in: begin.expires_in ?? 600,
    });
  }

  if (method === "GET") {
    const token = url.searchParams.get("state");
    const session = token ? state.oauth[token] : undefined;
    if (!session || session.kind !== "feishu-registration") {
      return respond(res, 404, { code: "state_invalid", message: "error.integrations.state_invalid" });
    }
    if (Date.now() > session.expiresAt) {
      delete state.oauth[token];
      saveState();
      return respond(res, 200, { status: "error", error: "error.integrations.state_invalid" });
    }
    // Respect Feishu's poll interval — desktop polls come in faster.
    if (Date.now() - session.lastPolledAt < session.interval && session.lastPollResult) {
      return respond(res, 200, session.lastPollResult);
    }
    session.lastPolledAt = Date.now();

    const poll = await feishuRegistration(session.baseUrl, {
      action: "poll",
      device_code: session.deviceCode,
    });

    if (poll.client_id && poll.client_secret) {
      // Persist the org app's credentials: the user may not finish the
      // redirect-URL paste before this session (and the gateway's pending
      // OAuth state) expires — without this, a half-finished bind would force
      // creating a whole new app on the next attempt.
      state.feishuApp = {
        clientId: poll.client_id,
        clientSecret: poll.client_secret,
        createdAt: Date.now(),
      };
      // Register the OAuth callback right after creation (application-config
      // OpenAPI with the app's own tenant token) — when this lands, the whole
      // bind is zero-touch. On failure the guided paste step takes over.
      const redirect = await ensureFeishuRedirect(poll.client_id, poll.client_secret);
      // App created: spend the credentials immediately on the user-token
      // authorization (custom OAuth rides the connection for later refresh).
      const before = new Set((await listConnections()).map((c) => c.id));
      const auth = await gw("/api/oauth/authorizations", {
        method: "POST",
        body: {
          service: "feishu",
          clientId: poll.client_id,
          clientSecret: poll.client_secret,
          requestedScopes: FEISHU_SCOPES,
        },
      });
      if (!auth.ok) {
        console.error("[bff] post-registration authorization failed:", auth.status, auth.json);
        delete state.oauth[token];
        saveState();
        return respond(res, 200, { status: "error", error: "error.integrations.not_configured" });
      }
      const authUrl = auth.json?.authorizationUrl ?? auth.json?.authorization_url ?? null;
      if (!authUrl) {
        delete state.oauth[token];
        saveState();
        return respond(res, 200, { status: "error", error: "error.integrations.not_configured" });
      }
      const oauthToken = `state-${session.provider}-${++state.seq}`;
      state.oauth[oauthToken] = {
        kind: "oauth",
        provider: session.provider,
        service: "feishu",
        before: [...before],
        issuedAt: Date.now(),
      };
      delete state.oauth[token];
      saveState();
      return respond(res, 200, {
        status: "ready",
        oauth_state: oauthToken,
        authorization_url: authUrl,
        client_id: poll.client_id,
        redirect_uri: LYNSE_REDIRECT_URI,
        redirect_configured: redirect.ok,
        permission_grant_url: redirect.grantUrl,
      });
    }

    if (poll.user_info?.tenant_brand === "lark") {
      // International (Lark) tenant: the confirmation domain switches once.
      session.baseUrl = "https://accounts.larksuite.com";
    }
    let result = { status: "waiting" };
    if (poll.error === "slow_down") {
      session.interval += 5000;
    }
    if (poll.error === "access_denied" || poll.error === "expired_token") {
      delete state.oauth[token];
      result = { status: "error", error: "error.integrations.auth_failed" };
    }
    session.lastPollResult = result;
    saveState();
    return respond(res, 200, result);
  }

  return respond(res, 405, { message: "GET or POST only" });
}

/**
 * Calendar consumption (contract §2.8): merge events from every connected
 * calendar provider (Google across all its calendars, Feishu primary calendar)
 * and reshape to the contract rows. `meeting_url` non-null is the desktop's
 * "has a join link" predicate — conference entry points first, then legacy
 * hangoutLink, then a URL inside the location string.
 */
let feishuEventLogged = false;

async function calendarEvents(res, url) {
  const connections = await listConnections();
  const from = url.searchParams.get("from") ?? new Date().toISOString();
  const to = url.searchParams.get("to") ?? new Date(Date.now() + 7 * 86_400_000).toISOString();

  const google = realConnections(connections, "googlecalendar");
  const feishu = realConnections(connections, "feishu");
  if (!google.length && !feishu.length) {
    return respond(res, 200, { connected: false, events: [] });
  }

  const events = [];
  if (google.length) {
    const run = await gw("/v1/actions/googlecalendar.list_events_all_calendars", {
      method: "POST",
      body: { input: { timeMin: from, timeMax: to, singleEvents: true, maxResultsPerCalendar: 250 } },
      token: RUNTIME_TOKEN,
    });
    if (!run.ok) {
      // Token expired and refresh failed, quota, etc. An empty window keeps the
      // reminder pipeline idle instead of surfacing an error toast every poll.
      console.error("[bff] list_events failed:", run.status, run.json);
    } else {
      const out = unwrap(run.json) ?? {};
      const rows = Array.isArray(out.events) ? out.events : [];
      const account = accountFor("google-calendar", google[0]);
      for (const e of rows) {
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
  }

  if (feishu.length) {
    const run = await gw("/v1/actions/feishu.list_calendar_agenda", {
      method: "POST",
      body: { input: { calendarId: "primary", startTime: from, endTime: to } },
      token: RUNTIME_TOKEN,
    });
    if (!run.ok) {
      console.error("[bff] feishu agenda failed:", run.status, run.json);
    } else {
      const out = unwrap(run.json) ?? {};
      const rows = Array.isArray(out) ? out : (out.events ?? out.items ?? out.data ?? []);
      if (rows.length && !feishuEventLogged) {
        feishuEventLogged = true;
        console.log("[bff] feishu event sample:", JSON.stringify(rows[0]).slice(0, 600));
      }
      const account = accountFor("feishu-calendar", feishu[0]);
      for (const e of rows) {
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
  }

  return respond(res, 200, { connected: true, events });
}

function eventTime(t) {
  if (!t) return null;
  if (typeof t === "string") return t;
  if (typeof t.dateTime === "string") return t.dateTime;
  // Feishu uses { timestamp: "<seconds|ms>" } or { date: "YYYY-MM-DD" }.
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

const server = createServer((req, res) => {
  if (multiuserHandler) {
    multiuserHandler(req, res).catch((error) => {
      console.error("[bff] unhandled:", error);
      respond(res, 500, { message: "internal error" });
    });
    return;
  }
  handle(req, res).catch((error) => {
    console.error("[bff] unhandled:", error);
    respond(res, 500, { message: "internal error" });
  });
});

server.listen(PORT, process.env.HOST ?? "0.0.0.0", () => {
  console.log(`[bff] listening on ${process.env.HOST ?? "0.0.0.0"}:${PORT}, gateway ${GW}`);
});
