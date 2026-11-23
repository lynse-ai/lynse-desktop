import { todoClosed, type TodoItem } from "./todo-api";
import { dateGroup } from "./grouping";

/**
 * Smart filters + search for the todo page — the local answer to Reminders'
 * smart lists and Todoist's saved filters. Pure logic, unit-testable;
 * page.tsx owns the chips UI.
 */

export type SmartFilter =
  | { kind: "all" }
  | { kind: "overdue" }
  | { kind: "today" }
  | { kind: "week" }
  | { kind: "starred" }
  | { kind: "owner"; owner: string };

export const DEFAULT_FILTER: SmartFilter = { kind: "all" };

/** Smart filters are open-todo lenses: date filters exclude closed todos,
 *  starred/owner keep closed ones visible (watchlist triage wants them). */
export function matchesSmartFilter(todo: TodoItem, filter: SmartFilter): boolean {
  if (filter.kind === "all") return true;
  if (filter.kind === "starred") return todo.starred === true;
  if (filter.kind === "owner") return todo.owner === filter.owner;
  if (todoClosed(todo)) return false;
  const dateKey = todo.dueDate || todo.calendarStartAt;
  const group = dateGroup(dateKey, todo);
  if (filter.kind === "overdue") return group === "overdue";
  if (filter.kind === "today") return group === "today";
  return group === "thisWeek"; // week
}

/** Case-insensitive substring match over the human-visible fields. */
export function searchTodos(todos: TodoItem[], query: string): TodoItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return todos;
  return todos.filter((todo) =>
    [todo.title, todo.notes, todo.owner, todo.sourceTitle].some(
      (value) => typeof value === "string" && value.toLowerCase().includes(q),
    ),
  );
}

/** Combined smart filter + free-text search. */
export function applyTodoFilter(todos: TodoItem[], filter: SmartFilter, query: string): TodoItem[] {
  const filtered = filter.kind === "all" ? todos : todos.filter((todo) => matchesSmartFilter(todo, filter));
  return searchTodos(filtered, query);
}

/** Distinct owner labels present on the board, in first-seen order — drives
 *  the 负责人 filter chip's picker (includes anonymous speaker labels; the
 *  owner VIEW is where those become the organizing axis). */
export function collectOwners(todos: TodoItem[]): string[] {
  const seen = new Set<string>();
  for (const todo of todos) {
    if (todo.owner) seen.add(todo.owner);
  }
  return Array.from(seen);
}
