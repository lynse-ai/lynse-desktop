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

export interface TodoItem {
  id: string;
  title: string;
  completed: boolean;
  notes?: string;
  dueDate?: string; // ISO-8601 date used for grouping
  sourceTitle?: string; // e.g. "产品设计评审会"
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
    id: String(t.id ?? (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `todo-${Date.now()}`)),
    title: String(t.title ?? "").trim() || "(无标题待办)",
    completed: t.completed === true || t.completed === 1,
    notes: t.notes ? String(t.notes) : undefined,
    dueDate: t.dueDate ? String(t.dueDate) : undefined,
    sourceTitle: t.sourceTitle ? String(t.sourceTitle) : undefined,
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
  return { items: [...cloud, ...local], cloudFailed };
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
    const saved = await bridge.save({ ...todo });
    return normalizeStored(saved);
  }
  const next = getLocalTodos().filter((x) => x.id !== todo.id);
  next.unshift(todo);
  saveLocalTodos(next);
  return todo;
}

/** Delete a single todo (cloud or local). */
export async function deleteTodo(todo: TodoItem): Promise<void> {
  if (todo.backend) {
    await deleteCloudTodos([todo.id]);
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

export { ApiError };

/**
 * Write a todo into the macOS system Calendar (desktop only).
 * Requires the Rust bridge (it looks the todo up by id in the local store).
 */
export async function addTodoToSystemCalendar(
  todo: TodoItem,
  startAt: string,
  endAt: string,
): Promise<TodoItem> {
  if (typeof window === "undefined") throw new Error("not supported");
  const raw = (window as unknown as { desktopAPI?: { todo?: Record<string, (...a: unknown[]) => Promise<unknown>> } })
    .desktopAPI?.todo;
  if (!raw?.addToCalendar) throw new Error("calendar not available");
  const updated = (await raw.addToCalendar(todo.id, startAt, endAt, true)) as TodoItem;
  return updated;
}
