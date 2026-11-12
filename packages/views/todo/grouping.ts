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
function isOverdue(dateKey: string, todo: Pick<TodoItem, "status" | "completed">): boolean {
  if (todoClosed(todo)) return false;
  const d = new Date(dateKey);
  if (isNaN(d.getTime())) return false;
  return d < startOfLocalDay(new Date());
}

/** Time bucket for a due date, or null when undated / unparseable. Closed
 *  todos never land in overdue (same rule the list grouping applies). */
export function dateGroup(dateKey: string | undefined, todo: Pick<TodoItem, "status" | "completed">): GroupKey | null {
  if (!dateKey) return null;
  const d = new Date(dateKey);
  if (isNaN(d.getTime())) return null;
  if (isOverdue(dateKey, todo)) return "overdue";
  if (isToday(dateKey)) return "today";
  if (isThisWeek(dateKey)) return "thisWeek";
  return "later";
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
    const key = dateGroup(dateKey, todo) ?? "later";
    map.get(key)!.push(todo);
  }
  return map;
}

/** Human due-date label shared by the list cards and the kanban cards:
 *  HH:mm when a calendar start exists, otherwise "M月D日 周x" (+ time when
 *  the stored value carries one). Empty string when nothing is parseable. */
export function formatDueDisplay(todo: Pick<TodoItem, "dueDate" | "calendarStartAt">): string {
  if (todo.calendarStartAt) {
    try {
      const d = new Date(todo.calendarStartAt);
      if (!isNaN(d.getTime())) {
        const hh = String(d.getHours()).padStart(2, "0");
        const mm = String(d.getMinutes()).padStart(2, "0");
        return `${hh}:${mm}`;
      }
    } catch { /* fall through */ }
  }
  if (!todo.dueDate) return "";
  try {
    const d = new Date(todo.dueDate);
    if (isNaN(d.getTime())) return "";
    const month = d.getMonth() + 1;
    const day = d.getDate();
    const weekdays = ["日", "一", "二", "三", "四", "五", "六"];
    const wd = weekdays[d.getDay()];
    if (todo.dueDate.length <= 10) return `${month}月${day}日 周${wd}`;
    const hh = String(d.getHours()).padStart(2, "0");
    const mm = String(d.getMinutes()).padStart(2, "0");
    return `${month}月${day}日 周${wd} ${hh}:${mm}`;
  } catch { return ""; }
}

/** True when an open todo's due date lies before today (danger styling). */
export function isOverdueTodo(todo: Pick<TodoItem, "dueDate" | "calendarStartAt" | "status" | "completed">): boolean {
  if (todoClosed(todo)) return false;
  const dateKey = todo.dueDate || todo.calendarStartAt;
  if (!dateKey) return false;
  const d = new Date(dateKey);
  if (isNaN(d.getTime())) return false;
  return d < startOfLocalDay(new Date());
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
