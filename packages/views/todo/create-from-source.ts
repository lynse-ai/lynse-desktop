import type { SourceRef } from "../workbench/types";
import {
  canCreateCloudTodos,
  createCloudTodos,
  saveTodo,
  todoIsCloudRepresentable,
  type TodoItem,
} from "./todo-api";
import { useTodoStore } from "./use-todos";

/**
 * Shared "convert to todos" path for the extraction surfaces (live-notes
 * panel, chat checklists): seeds the cloud insert contract can represent go
 * through `/api/business/file/todo/insert` (per lynse-cli `todos add`) so
 * they reach every device, while seeds carrying evidence notes or workbench
 * refs stay in the desktop local store like before — an insert never
 * silently drops content. Any cloud failure falls back to saving the whole
 * batch locally. The page / feed / heatmap pick the new items up through
 * the shared todo store without a manual reload. Callers own the toast +
 * duplicate guard.
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

  const store = useTodoStore.getState();
  // Cloud-first batch for the representable seeds; the rest keep the local
  // path. A failed insert moves the whole batch to the local store so the
  // caller's success/failure story stays atomic.
  const syncable = canCreateCloudTodos()
    ? pending.filter((todo) => todoIsCloudRepresentable(todo))
    : [];
  const localOnly = syncable.length > 0
    ? pending.filter((todo) => !syncable.includes(todo))
    : pending;
  let cloudSynced = false;
  if (syncable.length > 0) {
    try {
      await createCloudTodos(
        syncable.map((todo) => ({
          title: todo.title,
          dueDate: todo.dueDate,
          owner: todo.owner,
        })),
      );
      cloudSynced = true;
    } catch (e) {
      console.error("[Todo] cloud insert failed, falling back to local:", e);
      localOnly.push(...syncable);
    }
  }

  const saved: TodoItem[] = [];
  for (const todo of localOnly) {
    saved.push(await saveTodo(todo));
  }
  for (const item of saved) store.upsert(item);
  // Cloud-inserted items only exist server-side (with server-assigned ids
  // the client never sees from the insert response) — a forced reload is
  // what swaps the placeholders out of the UI for the authoritative copies.
  if (cloudSynced) await store.load({ force: true });
  // Callers only consume the count; cloud-path entries are the transient
  // placeholders that the reload replaces with backend items.
  return cloudSynced ? [...syncable, ...saved] : saved;
}
