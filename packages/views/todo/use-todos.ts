"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  type TodoItem,
  fetchBackendTodos,
  deleteBackendTodo,
  clearCompletedBackendTodos,
  getLocalTodos,
  saveLocalTodos,
  getOverrides,
  saveOverrides,
  ApiError,
} from "./todo-api";

function newLocalId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `local-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/**
 * Unified todo store: backend todos (from lynse.ai) merged with a local
 * (localStorage) layer for manual add / completed overrides.
 */
export function useTodos() {
  const [backendTodos, setBackendTodos] = useState<TodoItem[]>([]);
  const [localTodos, setLocalTodos] = useState<TodoItem[]>([]);
  const [overrides, setOverrides] = useState<Record<string, Partial<TodoItem>>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [b, l, o] = [await fetchBackendTodos(), getLocalTodos(), getOverrides()];
      setBackendTodos(b);
      setLocalTodos(l);
      setOverrides(o);
    } catch (e) {
      // Still surface local todos even if the backend call fails.
      setLocalTodos(getLocalTodos());
      setOverrides(getOverrides());
      setError(e instanceof ApiError ? "待办加载失败：请检查登录状态或网络" : "待办加载失败");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const todos = useMemo(() => {
    const merged = [...backendTodos, ...localTodos].map((t) => {
      const o = t.backend ? overrides[t.id] : undefined;
      return o ? { ...t, ...o } : t;
    });
    merged.sort((a, b) => {
      if (a.completed !== b.completed) return a.completed ? 1 : -1;
      return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    });
    return merged;
  }, [backendTodos, localTodos, overrides]);

  const addLocal = useCallback((title: string) => {
    const t: TodoItem = {
      id: newLocalId(),
      title,
      completed: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      backend: false,
    };
    const next = [t, ...getLocalTodos()];
    saveLocalTodos(next);
    setLocalTodos(next);
  }, []);

  const toggle = useCallback(
    (todo: TodoItem) => {
      if (todo.backend) {
        const nextCompleted = !todo.completed;
        setOverrides((prev) => {
          const o = {
            ...prev,
            [todo.id]: {
              ...prev[todo.id],
              completed: nextCompleted,
              updatedAt: new Date().toISOString(),
            },
          };
          saveOverrides(o);
          return o;
        });
      } else {
        const next = localTodos.map((x) =>
          x.id === todo.id
            ? { ...x, completed: !x.completed, updatedAt: new Date().toISOString() }
            : x,
        );
        saveLocalTodos(next);
        setLocalTodos(next);
      }
    },
    [localTodos],
  );

  const remove = useCallback(
    async (todo: TodoItem) => {
      if (todo.backend) {
        try {
          await deleteBackendTodo(todo.id);
        } catch {
          /* ignore — still drop from view */
        }
        setBackendTodos((prev) => prev.filter((x) => x.id !== todo.id));
      } else {
        const next = localTodos.filter((x) => x.id !== todo.id);
        saveLocalTodos(next);
        setLocalTodos(next);
      }
    },
    [localTodos],
  );

  const clearCompleted = useCallback(async () => {
    try {
      await clearCompletedBackendTodos();
    } catch {
      /* ignore */
    }
    setBackendTodos((prev) => prev.filter((x) => !x.completed));
    const next = localTodos.filter((x) => !x.completed);
    saveLocalTodos(next);
    setLocalTodos(next);
  }, [localTodos]);

  return { todos, loading, error, load, addLocal, toggle, remove, clearCompleted };
}
