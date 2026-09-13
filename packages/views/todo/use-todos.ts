"use client";

import { useEffect } from "react";
import { create } from "zustand";
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
  /** Set once the first load attempt has landed. */
  loaded: boolean;
  load: (initial?: boolean) => Promise<void>;
  addLocal: (title: string) => Promise<void>;
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

const useTodoStore = create<TodoStore>((set, get) => ({
  todos: [],
  loading: false,
  refreshing: false,
  clearing: false,
  error: null,
  loaded: false,

  load: (initial = false) => {
    if (loadInFlight) return loadInFlight;
    loadInFlight = (async () => {
      // Full skeleton only before the first load has landed; later loads
      // (remounts, auth flips) keep the list visible behind the refresh
      // spinner.
      if (initial && !get().loaded) set({ loading: true });
      else set({ refreshing: true });
      set({ error: null });
      try {
        const { items, cloudFailed } = await fetchTodos();
        set({ todos: items, loaded: true });
        // Only surface the failure when the user is signed in — otherwise
        // the cloud being unreachable is expected (local-only mode).
        if (cloudFailed && getAuthStore()?.getState().isAuthenticated) {
          set({ error: "云端待办获取失败，已显示本地待办" });
        }
      } catch (e) {
        // Keep whatever we already had; surface the failure.
        set({ todos: getLocalTodos(), loaded: true });
        set({
          error: e instanceof Error ? `待办加载失败：${e.message}` : "待办加载失败",
        });
      } finally {
        set({ loading: false, refreshing: false });
      }
    })().finally(() => {
      loadInFlight = null;
    });
    return loadInFlight;
  },

  addLocal: async (title) => {
    const t: TodoItem = {
      id: newLocalId(),
      title,
      completed: false,
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
      await saveTodo(updated);
    } catch (e) {
      console.error("[Todo] toggle failed:", e);
      // Reconcile with the real store so the checkbox reflects the truth.
      await get().load();
    }
  },

  remove: async (todo) => {
    set((s) => ({ todos: s.todos.filter((x) => x.id !== todo.id) })); // optimistic
    try {
      await deleteTodo(todo);
    } catch (e) {
      console.error("[Todo] remove failed:", e);
      await get().load();
    }
  },

  patchLocal: (updated) => {
    set((s) => ({ todos: s.todos.map((x) => (x.id === updated.id ? updated : x)) }));
  },

  clearCompleted: async () => {
    const completed = get().todos.filter((t) => t.completed);
    if (completed.length === 0) return;
    set({ clearing: true });
    // Optimistic removal so the UI feels instant.
    set((s) => ({ todos: s.todos.filter((x) => !x.completed) }));

    // Cloud: one server call clears every completed todo; fall back to
    // per-item deletes if the bulk endpoint fails.
    const cloudIds = completed.filter((t) => t.backend).map((t) => t.id);
    const localCompleted = completed.filter((t) => !t.backend);
    const failures: string[] = [];
    if (cloudIds.length > 0) {
      try {
        await clearCloudCompleted();
      } catch (e) {
        console.error("[Todo] cloud clear failed, falling back to per-item delete:", e);
        await Promise.all(
          cloudIds.map((id) =>
            deleteCloudTodos([id]).catch(() => {
              failures.push(id);
            }),
          ),
        );
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
    set({ clearing: false });
    if (failures.length > 0) {
      set({ error: `有 ${failures.length} 条已完成待办未能删除，已为您重新载入。` });
    }
    // Reconcile with the real stores so any item whose deletion failed
    // reappears instead of silently staying gone.
    await get().load();
  },

  upsert: (todo) => {
    set((s) =>
      s.todos.some((x) => x.id === todo.id)
        ? { todos: s.todos.map((x) => (x.id === todo.id ? todo : x)) }
        : { todos: [todo, ...s.todos] },
    );
  },
}));

/**
 * Hook façade over the shared store. `enabled: false` skips triggering the
 * initial load from this mount — used by consumers that mount eagerly but
 * should only fetch once they become visible (e.g. the profile dropdown's
 * activity heatmap); they still read whatever the store already holds.
 */
export function useTodos({ enabled = true }: { enabled?: boolean } = {}) {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const store = useTodoStore();

  // Reload on auth flips (login / logout) so the list matches the session.
  useEffect(() => {
    if (!enabled) return;
    void store.load(true);
  }, [enabled, isAuthenticated, store.load]);

  // Skeleton from the very first paint for mounts that will trigger the
  // initial load — the store's own `loading` only flips inside the effect.
  const loading = (enabled && !store.loaded) || store.loading;

  return {
    todos: store.todos,
    loading,
    refreshing: store.refreshing,
    clearing: store.clearing,
    error: store.error,
    load: store.load,
    addLocal: store.addLocal,
    toggle: store.toggle,
    remove: store.remove,
    patchLocal: store.patchLocal,
    clearCompleted: store.clearCompleted,
  };
}

export { useTodoStore };
