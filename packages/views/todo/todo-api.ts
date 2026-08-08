/**
 * Todo data layer.
 *
 * On the desktop the store of record is the Rust-backed local store exposed by
 * the Tauri bridge (`desktopAPI.todo` → `todo_list` / `todo_save` /
 * `todo_delete`, persisted under the `local-todos` key in the app data dir).
 *
 * The UI used to talk to the lynse.ai cloud (`/api/business/file/todo/...`),
 * which the desktop cannot reach without an account session — that made
 * "refresh" and "clear completed" no-ops. We now source todos from the local
 * store whenever the bridge is present, and fall back to localStorage-only on
 * environments where the bridge is unavailable (e.g. plain web).
 */

import { ApiError } from "@lynse/core/api/client";

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
  backend?: boolean; // true when sourced from lynse.ai (unused on desktop)
  [key: string]: unknown;
}

// ── Desktop store bridge ──────────────────────────────────

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

/** Fetch the full todo list (desktop store, or localStorage fallback). */
export async function fetchTodos(): Promise<TodoItem[]> {
  const bridge = getTodoBridge();
  if (bridge) {
    const raw = await bridge.list();
    return (Array.isArray(raw) ? raw : []).map(normalizeStored);
  }
  return getLocalTodos();
}

/** Create or update a todo (upsert by id). */
export async function saveTodo(todo: TodoItem): Promise<TodoItem> {
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

/** Delete a single todo by id. */
export async function deleteTodo(id: string): Promise<void> {
  const bridge = getTodoBridge();
  if (bridge) {
    await bridge.delete(id);
    return;
  }
  saveLocalTodos(getLocalTodos().filter((x) => x.id !== id));
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
