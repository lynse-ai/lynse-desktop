import { todoClosed, type TodoItem } from "./todo-api";

/**
 * Pure half of the due-reminder watcher (due-reminders.tsx): which open
 * todos have passed their due instant, and a localStorage ledger so each
 * (todo, due instant) pair fires exactly once — re-fires only when the
 * deadline itself moves.
 */

/** Date-only deadlines remind at 09:00 local — Apple Reminders' default. */
export const REMINDER_DEFAULT_HOUR = 9;

/** The instant a todo becomes due. A date-only `dueDate` lands at 09:00
 *  local that day; anything with a time (full ISO dueDate, or the calendar
 *  event start when no due date exists) keeps its own instant. Null when
 *  nothing is parseable. */
export function todoDueAt(
  todo: Pick<TodoItem, "dueDate" | "calendarStartAt">,
): Date | null {
  const raw = todo.dueDate ?? todo.calendarStartAt;
  if (!raw) return null;
  if (todo.dueDate && todo.dueDate.length <= 10) {
    const hh = String(REMINDER_DEFAULT_HOUR).padStart(2, "0");
    const d = new Date(`${raw}T${hh}:00:00`);
    return isNaN(d.getTime()) ? null : d;
  }
  const d = new Date(raw);
  return isNaN(d.getTime()) ? null : d;
}

export interface DueCandidate {
  todo: TodoItem;
  dueAt: Date;
}

/** Open todos whose due instant has passed. */
export function collectDueTodos(todos: TodoItem[], now: Date = new Date()): DueCandidate[] {
  const out: DueCandidate[] = [];
  for (const todo of todos) {
    if (todoClosed(todo)) continue;
    const dueAt = todoDueAt(todo);
    if (dueAt && dueAt.getTime() <= now.getTime()) out.push({ todo, dueAt });
  }
  return out;
}

// ── Fired-once ledger ─────────────────────────────────────

export const NOTIFIED_KEY = "lynse.todos.notified.v1";

/** todo id → the ISO due instant that was last announced. */
export type NotifiedMap = Record<string, string>;

export function readNotifiedMap(): NotifiedMap {
  if (typeof localStorage === "undefined") return {};
  try {
    const raw = localStorage.getItem(NOTIFIED_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>)
        .filter((entry): entry is [string, string] => typeof entry[1] === "string"),
    );
  } catch {
    return {};
  }
}

export function writeNotifiedMap(map: NotifiedMap): void {
  try {
    localStorage.setItem(NOTIFIED_KEY, JSON.stringify(map));
  } catch {
    /* quota / privacy mode — worst case a reminder fires twice */
  }
}

/** Candidates not yet announced: an entry matches only on the exact due
 *  instant, so moving a deadline re-arms the reminder. */
export function pickUnnotified(
  candidates: DueCandidate[],
  notified: NotifiedMap,
): DueCandidate[] {
  return candidates.filter(({ todo, dueAt }) => notified[todo.id] !== dueAt.toISOString());
}

/** Ledger after firing `fired`: keep entries only for live open todos (a
 *  completed/deleted todo's entry is pruned so recreating it reminds again),
 *  then stamp every fired candidate with its due instant. */
export function updateNotified(
  fired: DueCandidate[],
  current: TodoItem[],
  notified: NotifiedMap,
): NotifiedMap {
  const next: NotifiedMap = {};
  const liveIds = new Set(
    current.filter((todo) => !todoClosed(todo)).map((todo) => todo.id),
  );
  for (const [id, iso] of Object.entries(notified)) {
    if (liveIds.has(id)) next[id] = iso;
  }
  for (const { todo, dueAt } of fired) next[todo.id] = dueAt.toISOString();
  return next;
}
