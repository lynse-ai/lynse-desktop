import { getWorkbenchApi, useWorkbench, type DesktopWorkbenchApi } from "@lynse/views/workbench";
import { api } from "@lynse/core/api";
import { getAuthStore } from "@lynse/core/auth";
import { memoryApi } from "@lynse/core/api/memory";
import { getDesktopLocalTranscriptionApi, getDesktopVaultApi } from "@lynse/views/workspace";
import { getDesktopInspirationApi } from "@lynse/views/inspiration";
import { isWikiEnabled } from "@lynse/views/feature-flags";

type Row = Record<string, unknown>;
type Args = Record<string, unknown>;
export interface McpDataDependencies {
  authorizeSources?: (ids: string[], kind: "meeting" | "note") => Promise<string[]>;
  memory?: DesktopWorkbenchApi | null;
  meetings: () => Promise<Row[]>;
  notes: () => Promise<Row[]>;
  todos: () => Promise<Row[]>;
  readMeetingNote: (id: string) => Promise<string | null>;
  cloud: {
    getToken: () => string | null;
    getBaseUrl: () => string;
    get: (path: string, params: Record<string, string | number>) => Promise<unknown>;
    post: (path: string, body: Row) => Promise<unknown>;
  };
  authenticated: () => boolean;
}

export class McpInputError extends Error {}
function stringArg(args: Args, key: string, required = false): string {
  const value = args[key];
  if (value === undefined && !required) return "";
  if (typeof value !== "string" || value.length > 200 || (required && !value.trim())) {
    throw new McpInputError(`Invalid ${key}`);
  }
  return value.trim();
}
function numberArg(args: Args, key: string, fallback: number, max: number): number {
  const value = args[key] ?? fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > max) {
    throw new McpInputError(`Invalid ${key}`);
  }
  return value;
}
function enumArg(args: Args, key: string, options: string[], fallback: string): string {
  const value = args[key] ?? fallback;
  if (typeof value !== "string" || !options.includes(value)) throw new McpInputError(`Invalid ${key}`);
  return value;
}
function pick(row: Row, keys: string[]): Row {
  return Object.fromEntries(keys.filter((key) => row[key] !== undefined).map((key) => [key, row[key]]));
}
function shareable(row: Row): boolean {
  return row.protection !== "e2ee" && !row.transition && row.locked !== true && row.aiContextEnabled !== false && row.sensitivity !== "restricted";
}
function find(rows: Row[], id: string): Row {
  const row = rows.find((item) => item.id === id);
  if (!row) throw new McpInputError("Record not found or not shared with AI");
  return row;
}
function list(rows: Row[], args: Args, keys: string[]): Row {
  const keyword = stringArg(args, "keyword").toLocaleLowerCase();
  const limit = numberArg(args, "limit", 20, 100);
  const filtered = rows.filter((row) => !keyword || [row.title, row.text, row.transcriptText]
    .some((text) => typeof text === "string" && text.toLocaleLowerCase().includes(keyword)));
  return { total: filtered.length, items: filtered.slice(0, limit).map((row) => pick(row, keys)) };
}

/** Snapshot cloud credentials so a logout/account change cannot return another account's data. */
export async function readDesktopMcpTool(name: string, args: Args, deps: McpDataDependencies): Promise<unknown> {
  if (!args || typeof args !== "object" || Array.isArray(args)) throw new McpInputError("Invalid arguments");
  const meetingKeys = ["id", "title", "createdAt", "updatedAt", "status", "durationMs"];
  const capturedToken = deps.cloud.getToken();
  const capturedOrigin = deps.cloud.getBaseUrl();
  async function eligible(rows: Row[], kind: "meeting" | "note"): Promise<Row[]> {
    if (deps.cloud.getToken() !== capturedToken || deps.cloud.getBaseUrl() !== capturedOrigin || !deps.authenticated()) throw new McpInputError("Account or server changed; retry");
    if (!deps.authenticated() || !capturedToken || !deps.authorizeSources) throw new McpInputError("Cloud source eligibility unavailable");
    const allowed = await deps.authorizeSources(rows.map(row => String(row.id)), kind);
    if (!deps.authenticated() || deps.cloud.getToken() !== capturedToken || deps.cloud.getBaseUrl() !== capturedOrigin) throw new McpInputError("Account or server changed; retry");
    return rows.filter(row => allowed.includes(String(row.id)));
  }
  async function eligiblePage(value: unknown): Promise<unknown> {
    if (!value || typeof value !== "object") throw new McpInputError("Unrecognized meeting page");
    if (Array.isArray(value)) return eligible(value as Row[], "meeting");
    const page = value as Row;
    for (const key of ["items", "records", "rows", "list"]) {
      if (Array.isArray(page[key])) return { ...page, [key]: await eligible(page[key] as Row[], "meeting") };
    }
    if (page.data && typeof page.data === "object") return { ...page, data: await eligiblePage(page.data) };
    throw new McpInputError("Unrecognized meeting page");
  }
  if (["search_local_memory", "get_local_memory", "get_local_memory_source"].includes(name)) {
    if (!isWikiEnabled()) throw new McpInputError("Wiki is only available in test mode");
    const bridge = deps.memory;
    if (!bridge) throw new McpInputError("Local meeting memory is unavailable");
    if (!bridge.readForAi) throw new McpInputError("Cloud source eligibility unavailable; update the desktop bridge");
    const status = await bridge.status();
    if (!status.enabled || !status.allowAi || !status.initialComplete) throw new McpInputError("Enable meeting memory and finish the initial knowledge-base sync first");
    let result: unknown;
    if (name === "search_local_memory") {
      const keyword = stringArg(args, "keyword");
      const limit = numberArg(args, "limit", 20, 100);
      const sources = await bridge.search(keyword, true);
      const wiki = await bridge.wiki({ action: "state" });
      const memories = [];
      for (const topic of wiki.topics.filter(topic => !!topic.published && !topic.excluded && !topic.stale && ["approved", "auto_validated"].includes(topic.published?.review ?? "") && topic.inScope !== false
        && (!keyword || `${topic.title} ${topic.published.markdown}`.toLocaleLowerCase().includes(keyword.toLocaleLowerCase()))).slice(0, limit)) {
        try {
          const record = await bridge.readForAi(`wiki:${topic.id}`);
          memories.push({ id: `wiki:${topic.id}`, text: record.markdown.slice(0, 12000), citations: record.document.citations ?? [] });
        } catch { /* Ineligible pages remain browsable but never enter MCP context. */ }
      }
      result = { sources: sources.items.slice(0, limit), memories };
    } else if (name === "get_local_memory") {
      const id = stringArg(args, "id", true);
      const wiki = await bridge.wiki({ action: "state" });
      const item = wiki.topics.find((topic) => `wiki:${topic.id}` === id && !topic.excluded && !topic.stale && ["approved", "auto_validated"].includes(topic.published?.review ?? "") && topic.inScope !== false);
      if (!item) throw new McpInputError("Wiki page not published, excluded or stale");
      const record = await bridge.readForAi(id);
      result = { id, text: record.markdown, citations: record.document.citations ?? [] };
    } else {
      const id = stringArg(args, "id", true);
      const source = status.entries.find((entry) => entry.id === id && !entry.excluded && entry.status === "synced");
      if (!source) throw new McpInputError("Source unavailable or excluded from AI");
      const record = await bridge.readForAi(id);
      if (record.document.aiContextEnabled === false) throw new McpInputError("Source excluded from AI");
      result = { document: record.document, markdown: record.markdown };
    }
    const current = await bridge.status();
    if (!isWikiEnabled() || !current.enabled || !current.allowAi || !current.initialComplete || current.scope !== status.scope || current.updatedAt !== status.updatedAt) throw new McpInputError("Account or sources changed; retry");
    return result;
  }
  switch (name) {
    case "list_local_meetings": return list(await eligible(await deps.meetings(), "meeting"), args, meetingKeys);
    case "get_local_meeting": {
      const id = stringArg(args, "id", true);
      const row = find(await eligible(await deps.meetings(), "meeting"), id);
      const content = enumArg(args, "content", ["info", "transcript", "notes"], "info");
      if (content === "notes") {
        const markdown = await deps.readMeetingNote(id);
        find(await eligible([row], "meeting"), id);
        return { id, markdown };
      }
      if (content === "transcript") return pick(row, [...meetingKeys, "transcriptText", "segments"]);
      return pick(row, meetingKeys);
    }
    case "list_local_notes": return list(await eligible((await deps.notes()).filter(shareable), "note"), args, ["id", "text", "tags", "createdAt", "updatedAt"]);
    case "get_local_note": return pick(find(await eligible((await deps.notes()).filter(shareable), "note"), stringArg(args, "id", true)), ["id", "text", "tags", "transcript", "createdAt", "updatedAt"]);
    case "list_local_todos": {
      const status = enumArg(args, "status", ["all", "open", "done"], "all");
      const rows = (await deps.todos()).filter((row) => status === "all" || (row.completed === true) === (status === "done"));
      return list(rows, args, ["id", "title", "completed", "notes", "dueDate", "createdAt", "updatedAt"]);
    }
  }
  if (!name.startsWith("get_cloud_") && !name.startsWith("list_cloud_")) throw new McpInputError("Unknown tool");
  const token = deps.cloud.getToken();
  const origin = deps.cloud.getBaseUrl();
  if (!deps.authenticated() || !token) throw new McpInputError("Sign in to Lynse Desktop to read cloud data");
  let result: unknown;
  switch (name) {
    case "get_cloud_user": {
      const user = await deps.cloud.get("/api/business/customer/current", {}) as Row;
      result = pick(user, ["id", "name", "nickname", "nickName", "avatar"]);
      break;
    }
    case "list_cloud_meetings":
      result = await eligiblePage(await deps.cloud.get("/api/business/file/page", {
        pageNum: numberArg(args, "page", 1, 1000), pageSize: numberArg(args, "page_size", 20, 100),
        originalFilename: stringArg(args, "keyword"),
      }));
      break;
    case "get_cloud_meeting": {
      const content = enumArg(args, "content", ["info", "summary", "outline", "transcript"], "info");
      const paths: Record<string, string> = { info:"info", summary:"conclusion/list", outline:"outline/get", transcript:"trans/get" };
      const id = stringArg(args, "id", true);
      find(await eligible([{ id }], "meeting"), id);
      result = await deps.cloud.get(`/api/business/file/${paths[content]}`, { fileId: id });
      find(await eligible([{ id }], "meeting"), id);
      break;
    }
    case "list_cloud_folders": result = await deps.cloud.get("/api/business/file/folder/list", {}); break;
    case "list_cloud_todos": {
      const status = enumArg(args, "status", ["all", "open", "done"], "all");
      result = await deps.cloud.post("/api/business/file/todo/list", {
        pageNum: numberArg(args, "page", 1, 1000), pageSize: numberArg(args, "page_size", 20, 100),
        ...(status === "all" ? {} : { isCompleted: status === "done" ? 1 : 0 }),
      });
      break;
    }
    default: throw new McpInputError("Unknown tool");
  }
  if (!deps.authenticated() || deps.cloud.getToken() !== token || deps.cloud.getBaseUrl() !== origin) {
    throw new McpInputError("Account or server changed; reconnect and retry");
  }
  return result;
}

export function currentMcpDependencies(): McpDataDependencies {
  return {
    authorizeSources: async (ids, kind) => {
      if (kind === "note") {
        const scope = (await getDesktopInspirationApi()?.privacy?.status())?.accountScope;
        if (!scope) return [];
        const key = (id: string) => `inspiration:${scope}:${id.replace(/^inspiration:/, "")}`;
        const keys = ids.map(key);
        const allowed = (await memoryApi.knownSourceEligibility(keys)).allowed_source_ids;
        return ids.filter(id => allowed.includes(key(id)));
      }
      const local = ids.filter(id => id.startsWith("local:"));
      const allowedLocal: string[] = [];
      for (const id of local) {
        try { await getWorkbenchApi()?.readForAi?.(id).then(() => allowedLocal.push(id)); } catch { /* Withdrawn sources stay out of MCP. */ }
      }
      const cloud = ids.filter(id => !id.startsWith("local:"));
      const allowed = cloud.length ? (await memoryApi.sourceEligibility(cloud.map(source_id => ({ source_id })))).allowed_source_ids : [];
      return [...allowedLocal, ...allowed];
    },
    memory: getWorkbenchApi(),
    meetings: async () => {
      const rows = await getDesktopLocalTranscriptionApi()?.list() as unknown as Row[] ?? [];
      const scope = useWorkbench.getState().status?.scope;
      return rows.filter((row) => shareable(row) && (!row.workbenchScope || row.workbenchScope === scope));
    },
    notes: async () => {
      const rows = await getDesktopInspirationApi()?.list() as unknown as Row[] ?? [];
      const scope = useWorkbench.getState().status?.scope;
      return rows.filter((row) => row.protection !== "e2ee" && !row.transition && (!row.workbenchScope || row.workbenchScope === scope));
    },
    todos: async () => {
      const bridge = (window as Window & { desktopAPI?: { todo?: { list: () => Promise<Row[]> } } }).desktopAPI;
      const rows = await bridge?.todo?.list() ?? [];
      const scope = useWorkbench.getState().status?.scope;
      return rows.filter((row) => !row.workbenchScope || row.workbenchScope === scope);
    },
    readMeetingNote: async (id) => await getDesktopVaultApi()?.readNote(id) ?? null,
    cloud: {
      getToken: () => api().getToken(), getBaseUrl: () => api().getBaseUrl(),
      get: (path, params) => api().getWithParams(path, params, { tokenOnly: true, sessionToken: api().getToken() ?? "" }),
      post: (path, body) => api().post(path, body, { tokenOnly: true, sessionToken: api().getToken() ?? "" }),
    },
    authenticated: () => getAuthStore()?.getState().isAuthenticated ?? false,
  };
}
