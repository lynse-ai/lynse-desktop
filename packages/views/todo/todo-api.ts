/**
 * Todo data layer.
 *
 * Primary source of truth is the lynse.ai cloud — the same backend the
 * lynse-cli skill wraps (`/api/business/file/todo/...`, two-layer
 * API-key + token auth handled by the shared ApiClient). Todos extracted
 * from meetings live there, so the page shows them without any local setup.
 *
 * A local Rust-backed store (`desktopAPI.todo` → `local-todos`) remains for
 * manually added todos (and their calendar metadata). On every load the two
 * sources are merged: cloud items carry `backend: true`, local ones do not.
 * When the cloud is unreachable or the user is not signed in, we silently
 * fall back to the local store only.
 */

import { api, ApiError } from "@lynse/core/api/client";
import { getAuthStore } from "@lynse/core/auth";
import { getActiveQueryClient } from "@lynse/core/query-client";
import {
  fetchNotesList,
  NOTES_WIDE_WINDOW_START,
  notesWideWindowEnd,
  LIST_STALE_TIME_MS,
} from "../workspace/hooks/use-files";
import { isLocalFileId } from "../workspace/local-transcription";
import type { WorkspaceItem } from "../workspace/types";

import type { SourceRef } from "../workbench/types";
import { useWorkbench } from "../workbench/api";

export interface TodoItem {
  status?: TodoStatus;
  statusVersion?: number;
  statusHistory?: { from: TodoStatus; to: TodoStatus; at: string; version: number }[];
  sourceRef?: SourceRef;
  workbenchScope?: string;
  id: string;
  title: string;
  completed: boolean;
  notes?: string;
  dueDate?: string; // ISO-8601 date used for grouping
  sourceTitle?: string; // e.g. "产品设计评审会"
  sourceFileId?: string; // cloud-only: id of the note the todo was extracted from
  sourceMeetingTime?: string;
  createdAt: string; // ISO-8601
  updatedAt: string;
  calendarEventId?: string; // populated after adding to system calendar (local todos only)
  calendarAddedAt?: string;
  calendarStartAt?: string;
  calendarEndAt?: string;
  owner?: string; // cloud-only: team / person responsible
  backend?: boolean; // true when sourced from the lynse.ai cloud
  [key: string]: unknown;
}

export type TodoStatus = "open" | "doing" | "done" | "cancelled";
export function todoStatus(todo: Pick<TodoItem, "status" | "completed">): TodoStatus {
  return todo.status ?? (todo.completed ? "done" : "open");
}
export function todoClosed(todo: Pick<TodoItem, "status" | "completed">): boolean {
  return ["done", "cancelled"].includes(todoStatus(todo));
}

// ── Cloud (lynse.ai) layer — same API as lynse-cli ────────

interface CloudTodo {
  id?: string | number;
  todoContent?: string;
  isCompleted?: number | boolean;
  expectedCompleteTime?: string | null;
  owner?: string | null;
  fileId?: string | null;
  createTime?: string | null;
  updateTime?: string | null;
  [key: string]: unknown;
}

/** The server returns "YYYY-MM-DD HH:mm:ss"; convert to an ISO-ish string
 * that `new Date()` can parse in every engine (Safari rejects the space form). */
function normalizeCloudDate(value: string | null | undefined): string | undefined {
  const raw = value ? String(value).trim() : "";
  if (!raw) return undefined;
  const iso = raw.replace(" ", "T");
  const d = new Date(iso);
  return isNaN(d.getTime()) ? undefined : d.toISOString();
}

/** Coerce a cloud record into the app's TodoItem shape. */
export function mapCloudTodo(raw: CloudTodo): TodoItem {
  return {
    id: String(raw.id ?? ""),
    title: String(raw.todoContent ?? "").trim() || "(无标题待办)",
    completed: raw.isCompleted === 1 || raw.isCompleted === true,
    dueDate: normalizeCloudDate(raw.expectedCompleteTime),
    owner: raw.owner ? String(raw.owner) : undefined,
    sourceFileId: raw.fileId ? String(raw.fileId) : undefined,
    sourceTitle: undefined,
    createdAt: normalizeCloudDate(raw.createTime) ?? new Date().toISOString(),
    updatedAt: normalizeCloudDate(raw.updateTime) ?? new Date().toISOString(),
    backend: true,
  };
}

/** Fetch all todos from the lynse.ai cloud. Throws on network/auth errors. */
export async function fetchCloudTodos(): Promise<TodoItem[]> {
  const data = await api().post<CloudTodo[] | null>("/api/business/file/todo/listall", {});
  return (Array.isArray(data) ? data : []).map(mapCloudTodo);
}

// ── Source-note title resolution ──────────────────────────
// The todo API only returns the source `fileId`, never the note title, so
// "提取自哪个笔记" is resolved client-side in one notes-list request per load.

/** Fill in `sourceTitle` for cloud todos by looking their `sourceFileId` up in
 *  `titles`. Mutates in place — the items are per-load copies. */
export function applySourceTitles(items: TodoItem[], titles: Map<string, string>): void {
  for (const item of items) {
    if (item.backend && item.sourceFileId && !item.sourceTitle) {
      const title = titles.get(item.sourceFileId);
      if (title) item.sourceTitle = title;
    }
  }
}

/** fileId → note title, resolved through the SHARED notes list cache — the
 *  notes page and the heatmap already maintain a wide-window list under the
 *  `["notes", …]` key, so most loads cost zero extra transfer. When nothing
 *  is cached we fetch once through the same query key, so the result lands
 *  in the shared cache (and its disk mirror) instead of a private copy.
 *  Throws on network/auth errors so callers can degrade gracefully. */
async function fetchNoteTitleMap(): Promise<Map<string, string>> {
  const queryClient = getActiveQueryClient();
  const authenticated = getAuthStore()?.getState().isAuthenticated ?? false;

  if (queryClient) {
    const cached = queryClient
      .getQueryCache()
      .getAll()
      .find(
        (query) =>
          query.queryKey[0] === "notes" &&
          query.queryKey[1] === NOTES_WIDE_WINDOW_START &&
          Array.isArray(query.state.data) &&
          query.state.data.length > 0,
      );
    if (cached) return noteTitleMapFromItems(cached.state.data as WorkspaceItem[]);

    if (authenticated) {
      const items = await queryClient.fetchQuery({
        queryKey: ["notes", NOTES_WIDE_WINDOW_START, notesWideWindowEnd(), true],
        queryFn: () =>
          fetchNotesList({ startTime: NOTES_WIDE_WINDOW_START, endTime: notesWideWindowEnd() }),
        staleTime: LIST_STALE_TIME_MS,
      });
      return noteTitleMapFromItems(items);
    }
  }

  // No react-query runtime (tests, exotic embeds): one direct fetch.
  const items = await fetchNotesList({
    startTime: NOTES_WIDE_WINDOW_START,
    endTime: notesWideWindowEnd(),
  });
  return noteTitleMapFromItems(items);
}

/** Extract fileId → note title from slim list items (local transcriptions
 *  have no cloud note and are skipped). */
export function noteTitleMapFromItems(items: WorkspaceItem[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const item of items) {
    if (isLocalFileId(item.id)) continue;
    const title = item.title.trim();
    if (item.id && title) map.set(item.id, title);
  }
  return map;
}

/** Toggle a cloud todo's completed state (server-side update). */
export async function updateCloudTodo(todo: TodoItem): Promise<void> {
  await api().post("/api/business/file/todo/update", {
    todoUpdateList: [
      {
        todoId: todo.id,
        isCompleted: todo.completed ? 1 : 0,
      },
    ],
  });
}

/** Delete cloud todos by ids (single request, comma-safe list). */
export async function deleteCloudTodos(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await api().post("/api/business/file/todo/delete", { todoIds: ids });
}

/** Clear every completed todo on the server. */
export async function clearCloudCompleted(): Promise<void> {
  await api().post("/api/business/file/todo/clear", {});
}

// ── Desktop local store bridge ────────────────────────────

type TodoBridge = {
  capabilities?: () => Promise<{ fourStates: boolean }>;
  statusAction?: (id: string, request: { status: TodoStatus; baseVersion: number; operationId: string }) => Promise<unknown>;
  list: () => Promise<unknown[]>;
  save: (todo: unknown) => Promise<unknown>;
  delete: (id: string) => Promise<void>;
};

function getTodoBridge(): TodoBridge | null {
  if (typeof window === "undefined") return null;
  const bridge = (window as unknown as { desktopAPI?: { todo?: Partial<TodoBridge> } }).desktopAPI
    ?.todo;
  if (
    bridge &&
    typeof bridge.list === "function" &&
    typeof bridge.save === "function" &&
    typeof bridge.delete === "function"
  ) {
    return bridge as TodoBridge;
  }
  return null;
}

/** Coerce a stored JSON object into the app's TodoItem shape. */
export function normalizeStored(raw: unknown): TodoItem {
  const t = (raw ?? {}) as Record<string, unknown>;
  return {
    ...(typeof t.status === "string" && ["open", "doing", "done", "cancelled"].includes(t.status) ? { status: t.status as TodoStatus, statusVersion: Number(t.statusVersion ?? 0), statusHistory: t.statusHistory as TodoItem["statusHistory"] } : {}),
    id: String(t.id ?? (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `todo-${Date.now()}`)),
    title: String(t.title ?? "").trim() || "(无标题待办)",
    completed: typeof t.status === "string" && ["open", "doing", "done", "cancelled"].includes(t.status) ? t.status === "done" : t.completed === true || t.completed === 1,
    notes: t.notes ? String(t.notes) : undefined,
    dueDate: t.dueDate ? String(t.dueDate) : undefined,
    sourceRef: t.sourceRef && typeof t.sourceRef === "object" ? t.sourceRef as SourceRef : undefined,
    workbenchScope: typeof t.workbenchScope === "string" ? t.workbenchScope : undefined,
    sourceTitle: t.sourceTitle ? String(t.sourceTitle) : undefined,
    sourceFileId: t.sourceFileId ? String(t.sourceFileId) : undefined,
    sourceMeetingTime: t.sourceMeetingTime ? String(t.sourceMeetingTime) : undefined,
    createdAt: t.createdAt ? String(t.createdAt) : new Date().toISOString(),
    updatedAt: t.updatedAt ? String(t.updatedAt) : new Date().toISOString(),
    calendarEventId: t.calendarEventId ? String(t.calendarEventId) : undefined,
    calendarAddedAt: t.calendarAddedAt ? String(t.calendarAddedAt) : undefined,
    calendarStartAt: t.calendarStartAt ? String(t.calendarStartAt) : undefined,
    calendarEndAt: t.calendarEndAt ? String(t.calendarEndAt) : undefined,
    backend: false,
  };
}

async function fetchLocalTodos(): Promise<TodoItem[]> {
  const bridge = getTodoBridge();
  if (bridge) {
    const raw = await bridge.list();
    return (Array.isArray(raw) ? raw : []).map(normalizeStored);
  }
  return getLocalTodos();
}

/**
 * Fetch the full todo list: cloud items first (meetings-extracted), then
 * locally-created ones. If the cloud is unavailable (signed out, offline,
 * API client missing) we degrade to local-only without failing the load.
 */
export async function fetchTodos(): Promise<{ items: TodoItem[]; cloudFailed: boolean }> {
  let cloud: TodoItem[] = [];
  let cloudFailed = false;
  try {
    cloud = await fetchCloudTodos();
  } catch {
    cloudFailed = true;
  }
  let local: TodoItem[] = [];
  try {
    local = await fetchLocalTodos();
  } catch {
    local = getLocalTodos();
  }
  // Cloud todos have no local Rust store, so their calendar metadata
  // (added when the user puts them on the system calendar) lives in
  // localStorage overrides and is merged back in here.
  const overrides = getOverrides();
  const scope = useWorkbench.getState().status?.scope;
  const items = [...cloud, ...local.filter((item) => !item.workbenchScope || item.workbenchScope === scope)].map((item) => {
    const override = overrides[item.id];
    return override ? { ...item, ...override } : item;
  });
  // Resolve "which note was this todo extracted from" — only cloud items
  // carry a sourceFileId, and only they need the extra notes request. Fired
  // only when the cloud gave us todos; signed-out / offline loads skip it.
  const needsTitles = items.some((item) => item.backend && item.sourceFileId && !item.sourceTitle);
  if (needsTitles) {
    try {
      applySourceTitles(items, await fetchNoteTitleMap());
    } catch (e) {
      // Best-effort: todos still load, they just show no source note.
      console.warn("[Todo] source note titles unavailable:", e);
    }
  }
  return { items, cloudFailed };
}

/** Create or update a todo. Cloud items are updated server-side; local ones
 * go through the desktop bridge (upsert by id). */
export async function saveTodo(todo: TodoItem): Promise<TodoItem> {
  if (todo.backend) {
    await updateCloudTodo(todo);
    return todo;
  }
  const bridge = getTodoBridge();
  if (bridge) {
    if (todo.statusVersion && todo.completed !== (todo.status === "done")) {
      return setTodoStatus(todo, todo.completed ? "done" : "open", crypto.randomUUID());
    }
    const saved = await bridge.save({ ...todo });
    return normalizeStored(saved);
  }
  const next = getLocalTodos().filter((x) => x.id !== todo.id);
  next.unshift(todo);
  saveLocalTodos(next);
  return todo;
}

export async function localTodoFourStates(): Promise<boolean> {
  try { return !!(await getTodoBridge()?.capabilities?.())?.fourStates; } catch { return false; }
}
export async function setTodoStatus(todo: TodoItem, status: TodoStatus, operationId: string): Promise<TodoItem> {
  const bridge = getTodoBridge();
  if (todo.backend || !bridge?.statusAction || !await localTodoFourStates()) throw new Error("Todo state capability unavailable");
  return normalizeStored(await bridge.statusAction(todo.id, { status, baseVersion: todo.statusVersion ?? 0, operationId }));
}

/** Delete a single todo (cloud or local). */
export async function deleteTodo(todo: TodoItem): Promise<void> {
  if (todo.backend) {
    await deleteCloudTodos([todo.id]);
    removeOverride(todo.id);
    return;
  }
  const bridge = getTodoBridge();
  if (bridge) {
    await bridge.delete(todo.id);
    return;
  }
  saveLocalTodos(getLocalTodos().filter((x) => x.id !== todo.id));
}

// ── Local layer (fallback when no bridge) ─────────────────

const LOCAL_KEY = "lynse.todos.local";
const OVERRIDE_KEY = "lynse.todos.overrides";

function safeGet(key: string): unknown {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function safeSet(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* ignore quota / privacy errors */
  }
}

export function getLocalTodos(): TodoItem[] {
  return (safeGet(LOCAL_KEY) as TodoItem[]) ?? [];
}

export function saveLocalTodos(items: TodoItem[]) {
  safeSet(LOCAL_KEY, items);
}

export function getOverrides(): Record<string, Partial<TodoItem>> {
  return (safeGet(OVERRIDE_KEY) as Record<string, Partial<TodoItem>>) ?? {};
}

export function saveOverrides(overrides: Record<string, Partial<TodoItem>>) {
  safeSet(OVERRIDE_KEY, overrides);
}

function removeOverride(id: string) {
  const overrides = getOverrides();
  if (!overrides[id]) return;
  delete overrides[id];
  saveOverrides(overrides);
}

export { ApiError };

/**
 * Whether "add to system calendar" can be offered in this environment:
 * desktop bridge present and running on macOS (the Rust command is a no-op
 * stub elsewhere, so the affordance is hidden there).
 */
export function isCalendarAvailable(): boolean {
  if (typeof window === "undefined") return false;
  const desktop = (window as unknown as {
    desktopAPI?: { todo?: { addToCalendar?: unknown }; appInfo?: { platform?: string } };
  }).desktopAPI;
  if (typeof desktop?.todo?.addToCalendar !== "function") return false;
  const platform = desktop.appInfo?.platform;
  return !platform || platform === "darwin";
}

/**
 * Write a todo into the macOS system Calendar (desktop only). Works for both
 * local todos (the Rust side reads title/source from the local store and
 * persists the calendar metadata there) and cloud ones (title/source travel
 * with the call; the returned metadata is remembered in localStorage
 * overrides and merged back on load).
 */
export async function addTodoToSystemCalendar(
  todo: TodoItem,
  startAt: string,
  endAt: string,
): Promise<TodoItem> {
  if (typeof window === "undefined") throw new Error("calendar not available");
  const raw = (window as unknown as { desktopAPI?: { todo?: Record<string, (...a: unknown[]) => Promise<unknown>> } })
    .desktopAPI?.todo;
  if (!raw?.addToCalendar) throw new Error("calendar not available");
  const updated = (await raw.addToCalendar(
    todo.id,
    todo.title,
    todo.sourceTitle ?? null,
    startAt,
    endAt,
    true,
  )) as Record<string, unknown>;

  const calendarFields = [
    "calendarEventId",
    "calendarAddedAt",
    "calendarStartAt",
    "calendarEndAt",
    "updatedAt",
  ] as const;
  const patch: Partial<TodoItem> = {};
  for (const key of calendarFields) {
    const value = updated[key];
    if (typeof value === "string" && value) patch[key] = value;
  }
  if (todo.backend) {
    const overrides = getOverrides();
    overrides[todo.id] = { ...overrides[todo.id], ...patch };
    saveOverrides(overrides);
  }
  return { ...todo, ...patch };
}
