import type { SourceRef } from "../workbench/types";
import { saveTodo, type TodoItem } from "./todo-api";
import { useTodoStore } from "./use-todos";

/**
 * Shared "convert to todos" path for the extraction surfaces (live-notes
 * panel, chat checklists): persist local todos through the same store the
 * capture sheet uses and publish them into the shared todo store so the
 * page / feed / heatmap pick them up without a reload. Callers own the
 * toast + duplicate guard.
 */

export interface TodoSeed {
  title: string;
  owner?: string;
  /** Free-text context carried onto the todo (e.g. evidence lines). */
  notes?: string;
  /** Display label of the extraction source, if known. */
  sourceTitle?: string;
  /** Workbench source reference, when the surface can open the source. */
  sourceRef?: SourceRef;
}

/** Mirrors `use-todos.ts` — client-minted ids keep the localStorage fallback
 *  usable (the Rust bridge preserves provided ids too). */
function newTodoId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `local-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export async function createTodosFromSeeds(seeds: TodoSeed[]): Promise<TodoItem[]> {
  const now = new Date().toISOString();
  const pending: TodoItem[] = [];
  for (const seed of seeds) {
    const title = seed.title.trim();
    if (!title) continue;
    pending.push({
      id: newTodoId(),
      title,
      completed: false,
      ...(seed.owner ? { owner: seed.owner } : {}),
      ...(seed.notes ? { notes: seed.notes } : {}),
      ...(seed.sourceTitle ? { sourceTitle: seed.sourceTitle } : {}),
      ...(seed.sourceRef ? { sourceRef: seed.sourceRef } : {}),
      createdAt: now,
      updatedAt: now,
      backend: false,
    });
  }
  if (pending.length === 0) return [];

  const saved: TodoItem[] = [];
  for (const todo of pending) {
    saved.push(await saveTodo(todo));
  }
  const store = useTodoStore.getState();
  for (const item of saved) store.upsert(item);
  return saved;
}
