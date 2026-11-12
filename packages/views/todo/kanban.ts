import { type TodoItem, todoStatus } from "./todo-api";
import { dateGroup, isOverdueTodo } from "./grouping";

/**
 * Kanban column model — the pure half of kanban-view.tsx, kept separate so
 * the board logic is unit-testable without rendering.
 *
 * The board is a time-triage workflow, not a status pipeline: 今日执行 (due
 * today or earlier — overdue piles on top in red), 近期执行 (dated this week
 * or explicitly promoted), and the 需求池 backlog pool absorbing everything
 * else. 已完成 is real but hidden by default (a toolbar toggle reveals it);
 * cancelled cards group under it like done ones.
 */

export type KanbanColumnKey = "pool" | "today" | "week" | "done";

/** Columns in board order; done is opt-in via the toolbar toggle. */
export const KANBAN_COLUMNS: { key: KanbanColumnKey; optional?: boolean }[] = [
  { key: "pool" },
  { key: "today" },
  { key: "week" },
  { key: "done", optional: true },
];

/** The column a todo belongs to. An explicit kanbanLane pins open todos
 *  against the default date triage; done/cancelled todos land in done. */
export function kanbanColumnFor(todo: TodoItem): KanbanColumnKey {
  const status = todoStatus(todo);
  if (status === "done" || status === "cancelled") return "done";
  if (todo.kanbanLane === "pool") return "pool";
  const bucket = dateGroup(todo.dueDate || todo.calendarStartAt, todo);
  if (bucket === "overdue" || bucket === "today") return "today";
  if (bucket === "thisWeek") return "week";
  // Active work has no date home — it belongs in today's focus column.
  if (status === "doing") return "today";
  if (bucket === null || bucket === "later") {
    // Undated / beyond this week: promoted ones stay near-term, the rest parks.
    return todo.kanbanLane === "ready" ? "week" : "pool";
  }
  return "today";
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

/** Soft WIP ceiling for the today column — beyond this the count turns amber. */
export const TODAY_WIP_HINT = 5;
