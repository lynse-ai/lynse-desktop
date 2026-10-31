import { type TodoItem, todoClosed } from "./todo-api";

export type GroupKey = "overdue" | "today" | "thisWeek" | "later";

export function startOfLocalDay(d: Date): Date {
  const start = new Date(d);
  start.setHours(0, 0, 0, 0);
  return start;
}

function isToday(dateStr: string): boolean {
  const d = new Date(dateStr);
  const now = new Date();
  return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
}

function isThisWeek(dateStr: string): boolean {
  const d = new Date(dateStr);
  const now = new Date();
  const startOfWeek = new Date(now);
  startOfWeek.setDate(now.getDate() - now.getDay());
  startOfWeek.setHours(0, 0, 0, 0);
  const endOfWeek = new Date(startOfWeek);
  endOfWeek.setDate(startOfWeek.getDate() + 7);
  return d >= startOfWeek && d < endOfWeek;
}

/** Still-open todo dated before today. Closed ones keep normal date grouping. */
function isOverdue(dateKey: string, todo: TodoItem): boolean {
  if (todoClosed(todo)) return false;
  const d = new Date(dateKey);
  if (isNaN(d.getTime())) return false;
  return d < startOfLocalDay(new Date());
}

/** Group order: overdue → today → this week → catch-all (undated / beyond this week). */
export function groupTodos(todos: TodoItem[]): Map<GroupKey, TodoItem[]> {
  const map = new Map<GroupKey, TodoItem[]>();
  map.set("overdue", []);
  map.set("today", []);
  map.set("thisWeek", []);
  map.set("later", []);
  for (const todo of todos) {
    // Undated todos always land in the catch-all group; no createdAt fallback.
    const dateKey = todo.dueDate || todo.calendarStartAt;
    let key: GroupKey = "later";
    if (dateKey) {
      if (isOverdue(dateKey, todo)) key = "overdue";
      else if (isToday(dateKey)) key = "today";
      else if (isThisWeek(dateKey)) key = "thisWeek";
    }
    map.get(key)!.push(todo);
  }
  return map;
}

// ── Calendar grid helpers (shared by the month view and the date picker) ──

const pad2 = (n: number): string => String(n).padStart(2, "0");

/** Local yyyy-MM-dd key for a calendar day. */
export function dayKey(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** Sunday-start 6×7 grid of days covering the month `anchor` falls in. */
export function monthGrid(anchor: Date): Date[] {
  const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
  const start = new Date(first);
  start.setDate(first.getDate() - first.getDay());
  const cells: Date[] = [];
  for (let i = 0; i < 42; i++) {
    cells.push(new Date(start.getFullYear(), start.getMonth(), start.getDate() + i));
  }
  return cells;
}
