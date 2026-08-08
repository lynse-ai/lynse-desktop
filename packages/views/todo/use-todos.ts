"use client";

import { useCallback, useEffect, useState } from "react";
import {
  type TodoItem,
  fetchTodos,
  saveTodo,
  deleteTodo,
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
 * Unified todo store backed by the desktop's local Rust store
 * (`desktopAPI.todo` → `local-todos`). Todo add / toggle / delete / clear are
 * persisted through the bridge, so "refresh" re-reads the real store and
 * "clear completed" actually removes the items.
 */
export function useTodos() {
  const [todos, setTodos] = useState<TodoItem[]>([]);
  const [loading, setLoading] = useState(true); // initial mount skeleton
  const [refreshing, setRefreshing] = useState(false); // manual refresh / reconcile (button spinner)
  const [clearing, setClearing] = useState(false); // clearing completed (button busy)
  const [error, setError] = useState<string | null>(null);

  /**
   * Re-read the real store. `initial=true` shows the full skeleton (first
   * paint); otherwise it only flips the lightweight `refreshing` flag so the
   * list stays visible with a spinner on the refresh button.
   */
  const load = useCallback(async (initial = false) => {
    if (initial) setLoading(true);
    else setRefreshing(true);
    setError(null);
    try {
      const items = await fetchTodos();
      setTodos(items);
    } catch (e) {
      // Keep whatever we already had; surface the failure.
      setTodos(getLocalTodos());
      setError(e instanceof Error ? `待办加载失败：${e.message}` : "待办加载失败");
    } finally {
      if (initial) setLoading(false);
      else setRefreshing(false);
    }
  }, []);

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
        const saved = await saveTodo(updated);
        setTodos((prev) => prev.map((x) => (x.id === saved.id ? saved : x)));
      } catch (e) {
        console.error("[Todo] toggle failed:", e);
      }
    },
    [],
  );

  const remove = useCallback(
    async (todo: TodoItem) => {
      setTodos((prev) => prev.filter((x) => x.id !== todo.id)); // optimistic
      try {
        await deleteTodo(todo.id);
      } catch (e) {
        console.error("[Todo] remove failed:", e);
      }
    },
    [],
  );

  const clearCompleted = useCallback(async () => {
    const completed = todos.filter((t) => t.completed);
    if (completed.length === 0) return;
    setClearing(true);
    // Optimistic removal so the UI feels instant.
    setTodos((prev) => prev.filter((x) => !x.completed));
    const failures: string[] = [];
    await Promise.all(
      completed.map((t) =>
        deleteTodo(t.id).catch((e) => {
          failures.push(t.id);
          console.error("[Todo] clear failed:", t.id, e);
        }),
      ),
    );
    setClearing(false);
    if (failures.length > 0) {
      setError(`有 ${failures.length} 条已完成待办未能删除，已为您重新载入。`);
    }
    // Reconcile with the real store so any item whose deletion failed
    // reappears instead of silently staying gone.
    await load();
  }, [todos, load]);

  return { todos, loading, refreshing, clearing, error, load, addLocal, toggle, remove, clearCompleted };
}
