"use client";

import { useCallback, useEffect, useState } from "react";
import { useAuthStore } from "@lynse/core/auth";
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
 * Unified todo store. Cloud items come from the lynse.ai backend (the same
 * API the lynse-cli skill wraps); manually added items live in the desktop's
 * local Rust store (`desktopAPI.todo` → `local-todos`). Todo add / toggle /
 * delete / clear are persisted to their respective store, so "refresh"
 * re-reads the real stores and "clear completed" actually removes the items.
 */
export function useTodos() {
  const [todos, setTodos] = useState<TodoItem[]>([]);
  const [loading, setLoading] = useState(true); // initial mount skeleton
  const [refreshing, setRefreshing] = useState(false); // manual refresh / reconcile (button spinner)
  const [clearing, setClearing] = useState(false); // clearing completed (button busy)
  const [error, setError] = useState<string | null>(null);
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);

  /**
   * Re-read both stores (cloud + local). `initial=true` shows the full
   * skeleton (first paint); otherwise it only flips the lightweight
   * `refreshing` flag so the list stays visible with a spinner on the
   * refresh button.
   */
  const load = useCallback(async (initial = false) => {
    if (initial) setLoading(true);
    else setRefreshing(true);
    setError(null);
    try {
      const { items, cloudFailed } = await fetchTodos();
      setTodos(items);
      // Only surface the failure when the user is signed in — otherwise the
      // cloud being unreachable is expected (local-only mode).
      if (cloudFailed && isAuthenticated) {
        setError("云端待办获取失败，已显示本地待办");
      }
    } catch (e) {
      // Keep whatever we already had; surface the failure.
      setTodos(getLocalTodos());
      setError(e instanceof Error ? `待办加载失败：${e.message}` : "待办加载失败");
    } finally {
      if (initial) setLoading(false);
      else setRefreshing(false);
    }
  }, [isAuthenticated]);

  useEffect(() => {
    load(true);
  }, [load]);

  const addLocal = useCallback(async (title: string) => {
    const t: TodoItem = {
      id: newLocalId(),
      title,
      completed: false,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      backend: false,
    };
    setTodos((prev) => [t, ...prev]); // optimistic
    try {
      const saved = await saveTodo(t);
      setTodos((prev) => prev.map((x) => (x.id === t.id ? saved : x)));
    } catch (e) {
      console.error("[Todo] add failed:", e);
    }
  }, []);

  const toggle = useCallback(
    async (todo: TodoItem) => {
      const updated = { ...todo, completed: !todo.completed, updatedAt: nowIso() };
      setTodos((prev) => prev.map((x) => (x.id === todo.id ? updated : x))); // optimistic
      try {
        await saveTodo(updated);
      } catch (e) {
        console.error("[Todo] toggle failed:", e);
        // Reconcile with the real store so the checkbox reflects the truth.
        await load();
      }
    },
    [load],
  );

  const remove = useCallback(
    async (todo: TodoItem) => {
      setTodos((prev) => prev.filter((x) => x.id !== todo.id)); // optimistic
      try {
        await deleteTodo(todo);
      } catch (e) {
        console.error("[Todo] remove failed:", e);
        await load();
      }
    },
    [load],
  );

  const clearCompleted = useCallback(async () => {
    const completed = todos.filter((t) => t.completed);
    if (completed.length === 0) return;
    setClearing(true);
    // Optimistic removal so the UI feels instant.
    setTodos((prev) => prev.filter((x) => !x.completed));

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
    setClearing(false);
    if (failures.length > 0) {
      setError(`有 ${failures.length} 条已完成待办未能删除，已为您重新载入。`);
    }
    // Reconcile with the real stores so any item whose deletion failed
    // reappears instead of silently staying gone.
    await load();
  }, [todos, load]);

  return { todos, loading, refreshing, clearing, error, load, addLocal, toggle, remove, clearCompleted };
}
