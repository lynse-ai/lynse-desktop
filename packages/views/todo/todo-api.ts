/**
 * Todo data layer.
 *
 * Todos are sourced from the Lynse backend (lynse.ai) — the same backend the
 * lynse-cli talks to. The CLI exposes three todo endpoints:
 *   POST /api/business/file/todo/listall   -> list all todos
 *   POST /api/business/file/todo/delete    -> delete by ids
 *   POST /api/business/file/todo/clear     -> clear completed
 * (there is no create/update endpoint — todos are generated from meetings)
 *
 * Manual add / toggle-complete are kept as a *local* layer (localStorage) on
 * top of the backend list, so the page stays fully usable for quick notes
 * while the real (meeting-generated) todos come from the cloud.
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
  backend?: boolean; // true when sourced from lynse.ai
  [key: string]: unknown;
}

interface BackendTodo {
  todoId?: string;
  id?: string;
  todoContent?: string;
  content?: string;
  isCompleted?: number | boolean;
  expectedCompleteTime?: string;
  createTime?: string;
  updateTime?: string;
  fileName?: string;
  meetingName?: string;
  source?: string;
  [key: string]: unknown;
}

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

/** Map a backend todo object into the app's TodoItem shape. */
export function mapBackendTodo(raw: BackendTodo): TodoItem {
  const completed = raw.isCompleted === 1 || raw.isCompleted === true;
  const id = String(raw.todoId ?? raw.id ?? crypto.randomUUID());
  const createdAt = raw.createTime || new Date().toISOString();
  const updatedAt = raw.updateTime || createdAt;
  const sourceTitle = raw.fileName || raw.meetingName || raw.source;
  return {
    id,
    title: (raw.todoContent ?? raw.content ?? "").toString().trim() || "(无标题待办)",
    completed,
    dueDate: raw.expectedCompleteTime || undefined,
    sourceTitle: sourceTitle ? String(sourceTitle) : undefined,
    createdAt,
    updatedAt,
    backend: true,
  };
}

/** Fetch the full todo list from the Lynse backend. */
export async function fetchBackendTodos(): Promise<TodoItem[]> {
  const data = await api().post<BackendTodo[] | { data: BackendTodo[] }>(
    "/api/business/file/todo/listall",
    {},
  );
  const arr = Array.isArray(data) ? data : ((data as { data?: BackendTodo[] })?.data ?? []);
  return arr.map(mapBackendTodo);
}

/** Delete a single todo on the backend. */
export async function deleteBackendTodo(id: string): Promise<void> {
  await api().post("/api/business/file/todo/delete", { todoIds: [id] });
}

/** Clear all completed todos on the backend. */
export async function clearCompletedBackendTodos(): Promise<void> {
  await api().post("/api/business/file/todo/clear", {});
}

// ── Local layer (manual add + completed overrides) ─────────

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
 * Requires a *local* todo (the Rust bridge looks the todo up by id in the
 * local store), so this is only meaningful for locally-created todos.
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
