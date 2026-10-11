import { api } from "@lynse/core/api";
import { getAuthStore } from "@lynse/core/auth";
import { getDesktopLocalTranscriptionApi, getDesktopVaultApi } from "@lynse/views/workspace";
import { getDesktopInspirationApi } from "@lynse/views/inspiration";

type Row = Record<string, unknown>;
type Args = Record<string, unknown>;
export interface McpDataDependencies {
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
  return row.aiContextEnabled !== false && row.sensitivity !== "restricted";
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
  switch (name) {
    case "list_local_meetings": return list(await deps.meetings(), args, meetingKeys);
    case "get_local_meeting": {
      const id = stringArg(args, "id", true);
      const row = find(await deps.meetings(), id);
      const content = enumArg(args, "content", ["info", "transcript", "notes"], "info");
      if (content === "notes") return { id, markdown: await deps.readMeetingNote(id) };
      if (content === "transcript") return pick(row, [...meetingKeys, "transcriptText", "segments"]);
      return pick(row, meetingKeys);
    }
    case "list_local_notes": return list((await deps.notes()).filter(shareable), args, ["id", "text", "tags", "createdAt", "updatedAt"]);
    case "get_local_note": return pick(find((await deps.notes()).filter(shareable), stringArg(args, "id", true)), ["id", "text", "tags", "transcript", "createdAt", "updatedAt"]);
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
      result = await deps.cloud.get("/api/business/file/page", {
        pageNum: numberArg(args, "page", 1, 1000), pageSize: numberArg(args, "page_size", 20, 100),
        originalFilename: stringArg(args, "keyword"),
      });
      break;
    case "get_cloud_meeting": {
      const content = enumArg(args, "content", ["info", "summary", "outline", "transcript"], "info");
      const paths: Record<string, string> = { info:"info", summary:"conclusion/list", outline:"outline/get", transcript:"trans/get" };
      result = await deps.cloud.get(`/api/business/file/${paths[content]}`, { fileId: stringArg(args, "id", true) });
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
    meetings: async () => await getDesktopLocalTranscriptionApi()?.list() as unknown as Row[] ?? [],
    notes: async () => await getDesktopInspirationApi()?.list() as unknown as Row[] ?? [],
    todos: async () => {
      const bridge = (window as Window & { desktopAPI?: { todo?: { list: () => Promise<Row[]> } } }).desktopAPI;
      return await bridge?.todo?.list() ?? [];
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
