import { type TodoItem, todoStatus } from "./todo-api";
import { isOverdueTodo } from "./grouping";

/**
 * Kanban column model — the pure half of kanban-view.tsx, kept separate so
 * the board logic is unit-testable without rendering.
 *
 * The board is a triage workflow: 未整理 (no date yet — the default landing
 * spot for fresh open todos), 近期任务 (carries a due date; dropping a card
 * here always pops the date dialog), and 重点追踪 (the starred watchlist —
 * star precedence over everything, so a dated card you star moves here).
 * 已完成 is real but hidden by default (a toolbar toggle reveals it);
 * cancelled cards group under it like done ones.
 */

export type KanbanColumnKey = "unsorted" | "near" | "star" | "done";

/** Columns in board order; done is opt-in via the toolbar toggle. */
export const KANBAN_COLUMNS: { key: KanbanColumnKey; optional?: boolean }[] = [
  { key: "unsorted" },
  { key: "near" },
  { key: "star" },
  { key: "done", optional: true },
];

/** The column a todo belongs to: star beats date, date beats undated. */
export function kanbanColumnFor(todo: TodoItem): KanbanColumnKey {
  const status = todoStatus(todo);
  if (status === "done" || status === "cancelled") return "done";
  if (todo.starred) return "star";
  const dated = Boolean(todo.dueDate || todo.calendarStartAt);
  return dated ? "near" : "unsorted";
}

/**
 * In-column order: overdue first (the triage queue), then dated todos by
 * due date ascending, undated last. Ties keep the store order (stable sort).
 */
function compareTodos(a: TodoItem, b: TodoItem): number {
  const aOverdue = isOverdueTodo(a);
  const bOverdue = isOverdueTodo(b);
  if (aOverdue !== bOverdue) return aOverdue ? -1 : 1;
  const aDate = a.dueDate || a.calendarStartAt;
  const bDate = b.dueDate || b.calendarStartAt;
  if (aDate && bDate) {
    const diff = new Date(aDate).getTime() - new Date(bDate).getTime();
    if (diff !== 0) return diff;
  }
  if (aDate !== bDate) return aDate ? -1 : 1; // dated before undated
  return 0;
}

/** Split todos into the board columns, each sorted for triage. */
export function kanbanColumns(todos: TodoItem[]): Map<KanbanColumnKey, TodoItem[]> {
  const map = new Map<KanbanColumnKey, TodoItem[]>();
  for (const { key } of KANBAN_COLUMNS) map.set(key, []);
  for (const todo of todos) map.get(kanbanColumnFor(todo))!.push(todo);
  for (const list of map.values()) list.sort(compareTodos);
  return map;
}

/**
 * Meeting extraction fills `owner` with anonymous speaker labels; those
 * carry no assignment information, so the board hides them instead of
 * showing a column of identical "发言人 1" chips.
 */
export function isGenericOwner(owner: string): boolean {
  return /^(发言人|说话人|Speaker)\s*\d+$/i.test(owner.trim());
}
