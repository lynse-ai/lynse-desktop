"use client";

import { useEffect } from "react";
import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";
import { getAuthStore, useAuthStore } from "@lynse/core/auth";
import {
  type TodoItem,
  fetchTodos,
  saveTodo,
  deleteTodo,
  clearCloudCompleted,
  deleteCloudTodos,
  getLocalTodos,
} from "./todo-api";

function newLocalId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `local-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Shared todo store. Cloud items come from the lynse.ai backend (the same
 * API the lynse-cli skill wraps); manually added items live in the desktop's
 * local Rust store (`desktopAPI.todo` → `local-todos`). Todo add / toggle /
 * delete / clear are persisted to their respective store, so "refresh"
 * re-reads the real stores and "clear completed" actually removes the items.
 *
 * One module-level store instead of per-hook state, so every consumer —
 * home summary strip, home feed, global search, activity heatmap, todo
 * page — shares one list and a toggle is reflected everywhere instantly.
 *
 * Startup cache: device-local items seed the store, and account-owned items
 * are loaded for the active session. Remount loads are throttled (TODO_LOAD_
 * THROTTLE_MS) — every consumer mount used to re-fetch the whole cloud list;
 * now only loads outside the window, auth flips, errors and explicit
 * `force` refreshes hit the network.
 */
interface TodoStore {
  todos: TodoItem[];
  /** Full skeleton — only while the store's very first load is in flight. */
  loading: boolean;
  /** Manual refresh / reconcile (button spinner). */
  refreshing: boolean;
  /** Clearing completed (button busy). */
  clearing: boolean;
  error: string | null;
  /** Set once the first load attempt has landed (or a cached list seeded). */
  loaded: boolean;
  /** When the last successful load finished — drives the remount throttle. */
  lastLoadedAt: number;
  /** Auth state the last load ran under; an auth flip must bypass the
   *  throttle so a new session never inherits the previous user's list. */
  lastLoadedAuthed: boolean | null;
  load: (opts?: { initial?: boolean; force?: boolean }) => Promise<void>;
  /** `extra` carries optional seed fields (e.g. a parsed dueDate from
   *  natural-language quick-add) layered onto the fresh item. */
  addLocal: (title: string, extra?: Partial<TodoItem>) => Promise<void>;
  toggle: (todo: TodoItem) => Promise<void>;
  remove: (todo: TodoItem) => Promise<void>;
  patchLocal: (updated: TodoItem) => void;
  clearCompleted: () => Promise<void>;
  /** Insert or replace one item in state without a reload — for producers
   *  that persist directly through todo-api (e.g. the capture sheet). */
  upsert: (todo: TodoItem) => void;
}

/** Concurrent load dedupe: several consumers mount together and each fires
 *  the initial load; they share one fetch instead of racing. */
let loadInFlight: Promise<void> | null = null;
let sessionGeneration = 0;

/** Re-fetch window for consumer remounts. Explicit refreshes (`force`) and
 *  auth flips always reload. */
export const TODO_LOAD_THROTTLE_MS = 60_000;

// Device-local startup cache.

const TODO_CACHE_KEY = "lynse.todos.cache.v1";
/** The persisted copy exists for instant paint; real stores stay the source
 *  of truth and every load refreshes from them. */
const TODO_CACHE_LIMIT = 2000;

function readTodoCache(): TodoItem[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(TODO_CACHE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (entry): entry is TodoItem =>
          typeof entry === "object" &&
          entry !== null &&
          typeof (entry as TodoItem).id === "string" &&
          !(entry as TodoItem).backend &&
          !(entry as TodoItem).workbenchScope &&
          typeof (entry as TodoItem).title === "string",
      )
      .slice(0, TODO_CACHE_LIMIT);
  } catch {
    return [];
  }
}

function writeTodoCache(items: TodoItem[]): void {
  if (typeof window === "undefined") return;
  try {
    const local = items.filter((item) => !item.backend && !item.workbenchScope);
    localStorage.setItem(TODO_CACHE_KEY, JSON.stringify(local.slice(0, TODO_CACHE_LIMIT)));
  } catch {
    /* quota / privacy mode — the cache is best-effort */
  }
}

const initialTodos = readTodoCache();

const useTodoStore = create<TodoStore>((set, get) => ({
  todos: initialTodos,
  loading: false,
  refreshing: false,
  clearing: false,
  error: null,
  loaded: initialTodos.length > 0,
  lastLoadedAt: 0,
  lastLoadedAuthed: null,

  load: (opts = {}) => {
    const { initial = false, force = false } = opts;
    const authed = getAuthStore()?.getState().isAuthenticated ?? false;
    // Remount throttle: inside the window the store's list is fresh enough;
    // skip the cloud round-trip entirely. Errors and auth flips never skip.
    if (
      !force &&
      get().loaded &&
      !get().error &&
      get().lastLoadedAuthed === authed &&
      Date.now() - get().lastLoadedAt < TODO_LOAD_THROTTLE_MS
    ) {
      return Promise.resolve();
    }
    if (loadInFlight) return loadInFlight;
    const generation = sessionGeneration;
    const request = (async () => {
      // Full skeleton only before the first load has landed; later loads
      // (remounts, auth flips) keep the list visible behind the refresh
      // spinner.
      if (initial && !get().loaded) set({ loading: true });
      else set({ refreshing: true });
      set({ error: null });
      try {
        const { items, cloudFailed } = await fetchTodos();
        if (generation !== sessionGeneration) return;
        set({ todos: items, loaded: true, lastLoadedAt: Date.now(), lastLoadedAuthed: authed });
        // Only surface the failure when the user is signed in — otherwise
        // the cloud being unreachable is expected (local-only mode).
        if (cloudFailed && getAuthStore()?.getState().isAuthenticated) {
          set({ error: "云端待办获取失败，已显示本地待办" });
        }
      } catch (e) {
        if (generation !== sessionGeneration) return;
        // Keep whatever we already had; surface the failure.
        set({ todos: getLocalTodos(), loaded: true });
        set({
          error: e instanceof Error ? `待办加载失败：${e.message}` : "待办加载失败",
        });
      } finally {
        if (generation === sessionGeneration) set({ loading: false, refreshing: false });
      }
    })().finally(() => {
      if (loadInFlight === request) loadInFlight = null;
    });
    loadInFlight = request;
    return request;
  },

  addLocal: async (title, extra) => {
    const t: TodoItem = {
      id: newLocalId(),
      title,
      completed: false,
      ...extra,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      backend: false,
    };
    set((s) => ({ todos: [t, ...s.todos] })); // optimistic
    try {
      const saved = await saveTodo(t);
      set((s) => ({ todos: s.todos.map((x) => (x.id === t.id ? saved : x)) }));
    } catch (e) {
      console.error("[Todo] add failed:", e);
    }
  },

  toggle: async (todo) => {
    const updated = { ...todo, completed: !todo.completed, updatedAt: nowIso() };
    set((s) => ({ todos: s.todos.map((x) => (x.id === todo.id ? updated : x)) })); // optimistic
    try {
      const saved = await saveTodo(updated);
      set((s) => ({ todos: s.todos.map((x) => (x.id === todo.id ? saved : x)) }));
    } catch (e) {
      console.error("[Todo] toggle failed:", e);
      // Reconcile with the real store so the checkbox reflects the truth.
      await get().load({ force: true });
    }
  },

  remove: async (todo) => {
    set((s) => ({ todos: s.todos.filter((x) => x.id !== todo.id) })); // optimistic
    try {
      await deleteTodo(todo);
    } catch (e) {
      console.error("[Todo] remove failed:", e);
      await get().load({ force: true });
    }
  },

  patchLocal: (updated) => {
    set((s) => ({ todos: s.todos.map((x) => (x.id === updated.id ? updated : x)) }));
  },

  clearCompleted: async () => {
    const generation = sessionGeneration;
    const completed = get().todos.filter((t) => t.completed);
    if (completed.length === 0) return;
    set({ clearing: true });
    // Optimistic removal so the UI feels instant.
    set((s) => ({ todos: s.todos.filter((x) => !x.completed) }));

    // Try the bulk endpoint first. Individual fallback preserves partial success.
    const cloudIds = completed.filter((t) => t.backend).map((t) => t.id);
    const localCompleted = completed.filter((t) => !t.backend);
    const failures: string[] = [];
    if (cloudIds.length > 0) {
      try {
        await clearCloudCompleted();
      } catch (e) {
        if (generation !== sessionGeneration) return;
        console.error("[Todo] cloud clear failed, falling back to individual deletes:", e);
        await Promise.all(cloudIds.map(async (id) => {
          try {
            await deleteCloudTodos([id]);
          } catch {
            failures.push(id);
          }
        }));
      }
    }
    // Local: per-item delete through the bridge.
    await Promise.all(
      localCompleted.map((t) =>
        deleteTodo(t).catch((e) => {
          failures.push(t.id);
          console.error("[Todo] clear failed:", t.id, e);
        }),
      ),
    );
    if (generation !== sessionGeneration) return;
    set({ clearing: false });
    // Reconcile with the real stores so any item whose deletion failed
    // reappears instead of silently staying gone.
    await get().load({ force: true });
    if (generation === sessionGeneration && failures.length > 0) {
      set({ error: `有 ${failures.length} 条已完成待办未能删除，已为您重新载入。` });
    }
  },

  upsert: (todo) => {
    set((s) =>
      s.todos.some((x) => x.id === todo.id)
        ? { todos: s.todos.map((x) => (x.id === todo.id ? todo : x)) }
        : { todos: [todo, ...s.todos] },
    );
  },
}));

// Write-through: any todos change (load, toggle, add, remove, upsert) lands
// in the startup cache after a short debounce, so the next app launch paints
// this list immediately.
let cacheWriteTimer: ReturnType<typeof setTimeout> | null = null;
useTodoStore.subscribe((state, prev) => {
  if (state.todos === prev.todos) return;
  if (cacheWriteTimer) clearTimeout(cacheWriteTimer);
  cacheWriteTimer = setTimeout(() => writeTodoCache(state.todos), 800);
});

let observedAuthStore: ReturnType<typeof getAuthStore>;

function observeTodoSession() {
  const auth = getAuthStore();
  if (!auth?.subscribe || observedAuthStore === auth) return;
  observedAuthStore = auth;
  auth.subscribe((current, previous) => {
    if (current.isAuthenticated === previous.isAuthenticated
      && (!previous.user || previous.user.id === current.user?.id)) return;
    sessionGeneration += 1;
    loadInFlight = null;
    if (cacheWriteTimer) clearTimeout(cacheWriteTimer);
    const todos = useTodoStore.getState().todos.filter((todo) => !todo.backend && !todo.workbenchScope);
    useTodoStore.setState({
      todos, loaded: todos.length > 0, lastLoadedAt: 0, lastLoadedAuthed: null,
      loading: false, refreshing: false, clearing: false, error: null,
    });
    writeTodoCache(todos);
  });
}

/**
 * Hook façade over the shared store. `enabled: false` skips triggering the
 * initial load from this mount — used by consumers that mount eagerly but
 * should only fetch once they become visible (e.g. the profile dropdown's
 * activity heatmap); they still read whatever the store already holds.
 */
export function useTodos({ enabled = true }: { enabled?: boolean } = {}) {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const userId = useAuthStore((s) => s.user?.id);
  const store = useTodoStore(useShallow((state) => ({
    todos: state.todos,
    loading: state.loading,
    refreshing: state.refreshing,
    clearing: state.clearing,
    error: state.error,
    loaded: state.loaded,
    load: state.load,
    addLocal: state.addLocal,
    toggle: state.toggle,
    remove: state.remove,
    patchLocal: state.patchLocal,
    clearCompleted: state.clearCompleted,
  })));
  const { load } = store;

  useEffect(() => {
    observeTodoSession();
    if (!enabled) return;
    void load({ initial: true });
  }, [enabled, isAuthenticated, userId, load]);

  // Skeleton from the very first paint for mounts that will trigger the
  // initial load — the store's own `loading` only flips inside the effect.
  const loading = (enabled && !store.loaded) || store.loading;

  return {
    todos: store.todos,
    loading,
    refreshing: store.refreshing,
    clearing: store.clearing,
    error: store.error,
    load,
    addLocal: store.addLocal,
    toggle: store.toggle,
    remove: store.remove,
    patchLocal: store.patchLocal,
    clearCompleted: store.clearCompleted,
  };
}

export { useTodoStore };
