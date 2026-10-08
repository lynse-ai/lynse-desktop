/**
 * Unified read endpoint (plan step 7): `POST /api/v2/integrations/{provider}/read`.
 *
 * Only product operations declared here are accepted — the gateway action id,
 * HTTP method and upstream URL are fixed by this table, so neither the model
 * nor the client can reach arbitrary actions, methods or proxy paths. Old
 * desktop accounts keep whatever scopes their grant has; this registry is an
 * additional read-only whitelist on top (plan step 7.5).
 *
 * Action ids and output field mappings follow the existing BFF calls (e.g.
 * `googlecalendar.list_events_all_calendars`) but still need per-action
 * verification against the deployed gateway (plan step 7.4) — mappers unwrap
 * defensively and README marks the verification pending.
 */

import { config, normalizeProvider } from "./env.mjs";
import { runAction, unwrap } from "./gateway.mjs";
import { resolveAccount } from "./accounts.mjs";
import { accountView } from "./views.mjs";

function op(name, { summary, required = [], optional = [], ints = [], bools = [], dates = [], caps = {} }) {
  return { name, summary, required, optional, ints, bools, dates, caps };
}

export const READ_REGISTRY = {
  "google-calendar": {
    service: "googlecalendar",
    operations: {
      list_calendars: op("list_calendars", { summary: "读取日历列表" }),
      list_events: op("list_events", {
        summary: "按时间范围读取日程事件",
        required: ["time_min", "time_max"],
        optional: ["calendar_id", "page_token", "max_results"],
        ints: ["max_results"],
        dates: ["time_min", "time_max"],
        caps: { max_results: 250 },
      }),
    },
  },
  "google-tasks": {
    service: "googletasks",
    operations: {
      list_task_lists: op("list_task_lists", { summary: "读取任务列表清单" }),
      list_tasks: op("list_tasks", {
        summary: "读取任务列表中的任务",
        required: ["task_list_id"],
        optional: ["page_token", "max_results", "show_completed"],
        ints: ["max_results"],
        bools: ["show_completed"],
        caps: { max_results: 100 },
      }),
    },
  },
  notion: {
    service: "notion",
    operations: {
      search: op("search", {
        summary: "搜索已共享给连接的页面",
        optional: ["query", "max_results"],
        ints: ["max_results"],
        caps: { max_results: 100 },
      }),
      read_page: op("read_page", {
        summary: "读取页面元数据与正文",
        required: ["page_id"],
      }),
    },
  },
};

export function lookupOperation(providerRaw, operationRaw) {
  const provider = normalizeProvider(providerRaw);
  const entry = READ_REGISTRY[provider];
  if (!entry) return { error: `unknown_provider ${providerRaw}` };
  if (!config.providersEnabled.includes(provider.replace(/-/g, "_"))) {
    return { error: `provider_disabled ${provider}` };
  }
  const operation = entry.operations[String(operationRaw ?? "").trim()];
  if (!operation) {
    return { error: `unknown_operation ${operationRaw}` };
  }
  return { provider, service: entry.service, operation };
}

export function validateArguments(operation, args) {
  const clean = { ...(args ?? {}) };
  const known = new Set([...operation.required, ...operation.optional]);
  for (const key of Object.keys(clean)) {
    if (!known.has(key)) return { error: `unknown_argument ${key}` };
  }
  for (const key of operation.required) {
    if (clean[key] === undefined || String(clean[key]).trim() === "") return { error: `missing_argument ${key}` };
  }
  for (const key of operation.ints) {
    if (clean[key] === undefined) continue;
    const value = Number(clean[key]);
    if (!Number.isFinite(value)) return { error: `bad_argument ${key}` };
    clean[key] = Math.max(1, Math.min(Math.trunc(value), operation.caps[key] ?? Number.MAX_SAFE_INTEGER));
  }
  for (const key of operation.bools) {
    if (clean[key] !== undefined) clean[key] = Boolean(clean[key]);
  }
  for (const key of operation.dates) {
    if (clean[key] === undefined) continue;
    const text = String(clean[key]).trim();
    const normalized = text.endsWith("Z") || /[+-]\d{2}:?\d{2}$/.test(text) ? text : `${text}Z`;
    if (Number.isNaN(Date.parse(normalized))) return { error: `bad_argument ${key}` };
    clean[key] = normalized;
  }
  return { args: clean };
}

// -- gateway input mapping ---------------------------------------------------

function mapInput(provider, operation, a) {
  if (provider === "google-calendar") {
    if (operation.name === "list_calendars") return { action: "googlecalendar.list_calendars", input: {} };
    if (a.calendar_id) {
      return {
        action: "googlecalendar.list_events",
        input: {
          calendarId: a.calendar_id,
          timeMin: a.time_min,
          timeMax: a.time_max,
          singleEvents: true,
          ...(a.max_results ? { maxResults: a.max_results } : {}),
          ...(a.page_token ? { pageToken: a.page_token } : {}),
        },
      };
    }
    return {
      action: "googlecalendar.list_events_all_calendars",
      input: {
        timeMin: a.time_min,
        timeMax: a.time_max,
        singleEvents: true,
        maxResultsPerCalendar: a.max_results ?? 250,
      },
    };
  }
  if (provider === "google-tasks") {
    if (operation.name === "list_task_lists") return { action: "googletasks.list_tasklists", input: {} };
    return {
      action: "googletasks.list_tasks",
      input: {
        tasklistId: a.task_list_id,
        showCompleted: Boolean(a.show_completed),
        ...(a.max_results ? { maxResults: a.max_results } : {}),
        ...(a.page_token ? { pageToken: a.page_token } : {}),
      },
    };
  }
  if (operation.name === "search") {
    return {
      action: "notion.search",
      input: { query: a.query ?? "", ...(a.max_results ? { maxResults: a.max_results } : {}) },
    };
  }
  return { action: "notion.read_page", input: { pageId: a.page_id } };
}

function rows(out, ...keys) {
  for (const key of keys) {
    const value = out?.[key];
    if (Array.isArray(value)) return value;
  }
  return Array.isArray(out) ? out : [];
}

function normalizeOutput(provider, operation, out) {
  if (provider === "google-calendar" && operation.name === "list_calendars") {
    return {
      calendars: rows(out, "calendars", "items", "data").map((c) => ({
        id: String(c.id ?? c.calendarId ?? "?"),
        summary: String(c.summary ?? c.name ?? "(calendar)"),
        primary: Boolean(c.primary),
        timezone: c.timeZone ?? c.timezone ?? null,
      })),
    };
  }
  if (provider === "google-calendar") {
    const source = out?.events ?? out;
    return {
      events: rows(source, "events", "items", "data").map((e) => ({
        id: String(e.id ?? `${e.summary ?? "event"}-${e.start?.dateTime ?? ""}`),
        title: String(e.summary ?? "(untitled)"),
        start: e.start?.dateTime ?? e.start?.date ?? e.start ?? null,
        end: e.end?.dateTime ?? e.end?.date ?? e.end ?? null,
        calendar_id: e.calendarId ?? e.calendar_id ?? null,
        meeting_url: e.hangoutLink ?? e.conferenceData?.entryPoints?.[0]?.uri ?? null,
      })),
      next_page_token: out?.nextPageToken ?? out?.next_page_token ?? null,
    };
  }
  if (operation.name === "list_task_lists") {
    return {
      task_lists: rows(out, "tasklists", "taskLists", "items", "data").map((t) => ({
        id: String(t.id ?? t.guid ?? "?"),
        title: String(t.title ?? t.name ?? "(list)"),
      })),
    };
  }
  if (operation.name === "list_tasks") {
    return {
      tasks: rows(out, "tasks", "items", "data").map((t) => ({
        id: String(t.id ?? t.guid ?? "?"),
        title: String(t.title ?? t.name ?? "(task)"),
        completed: Boolean(t.completed ?? t.status === "completed"),
        due: t.due ?? t.dueDate ?? null,
      })),
      next_page_token: out?.nextPageToken ?? out?.next_page_token ?? null,
    };
  }
  if (operation.name === "search") {
    return {
      pages: rows(out, "pages", "results", "items", "data").map((p) => ({
        id: String(p.id ?? p.pageId ?? "?"),
        title: String(p.title ?? p.name ?? "(page)"),
        url: p.url ?? null,
        last_edited: p.lastEditedTime ?? p.last_edited_time ?? null,
      })),
    };
  }
  const page = out?.page ?? out;
  return {
    page: {
      id: String(page.id ?? page.pageId ?? "?"),
      title: String(page.title ?? page.name ?? "(page)"),
      url: page.url ?? null,
      content: typeof page.content === "string" ? page.content : typeof page.markdown === "string" ? page.markdown : null,
      last_edited: page.lastEditedTime ?? page.last_edited_time ?? null,
    },
  };
}

/**
 * Execute one read. `owned` is the principal's account rows for the provider;
 * `connections` is the gateway connection list (for liveness filtering).
 */
export async function executeRead(store, { provider, operation, args, accountId, owned, connections }) {
  const resolution = resolveAccount(owned, accountId);
  if (!resolution.ok) {
    if (resolution.error === "account_selection_required") {
      return { httpStatus: 200, body: { status: "account_selection_required", accounts: resolution.accounts } };
    }
    if (resolution.error === "unknown_account") {
      return { httpStatus: 404, body: { status: "unknown_account", error: { code: "unknown_account" } } };
    }
    return { httpStatus: 200, body: { status: "connection_required" } };
  }
  const account = resolution.account;
  const stillLive = connections.some((c) => c.id === account.connection_id && !c.virtual && c.configured);
  if (!stillLive) {
    return { httpStatus: 200, body: { status: "connection_required" } };
  }
  const { action, input } = mapInput(provider, operation, args);
  const result = await runAction(action, input, account.connection_id, { readOnly: true });
  if (!result.ok) {
    return {
      httpStatus: 503,
      body: { status: "unavailable", error: { code: result.reason } },
    };
  }
  const run = result.run;
  if (!run.ok) {
    const code = run.status === 429 ? "rate_limited" : run.status === 401 || run.status === 403 ? "gateway_auth" : "action_failed";
    return {
      httpStatus: run.status === 429 ? 429 : 502,
      body: { status: code === "rate_limited" ? "rate_limited" : "unavailable", error: { code, gateway_status: run.status } },
    };
  }
  const data = normalizeOutput(provider, operation, unwrap(run.json));
  return {
    httpStatus: 200,
    body: {
      status: "ok",
      account: { account_id: account.id, display_name: account.display_name ?? account.email },
      data,
    },
  };
}
