/**
 * Desktop Todo API — bridges the frontend to Tauri Rust commands
 * (todo_list / todo_save / todo_delete / todo_add_to_calendar).
 */

export interface TodoItem {
  id: string;
  title: string;
  completed: boolean;
  notes?: string;
  dueDate?: string;         // ISO-8601 date (YYYY-MM-DD or full datetime)
  sourceTitle?: string;     // e.g. "产品设计评审会"
  sourceMeetingTime?: string;
  createdAt: string;        // ISO-8601
  updatedAt: string;
  calendarEventId?: string; // populated after adding to system calendar
  calendarAddedAt?: string;
  calendarStartAt?: string;
  calendarEndAt?: string;
  [key: string]: unknown;
}

export interface DesktopTodoApi {
  list: () => Promise<TodoItem[]>;
  save: (todo: Partial<TodoItem>) => Promise<TodoItem>;
  delete: (id: string) => Promise<void>;
  addToCalendar: (id: string, startAt: string, endAt: string) => Promise<TodoItem>;
}

export function getDesktopTodoApi(): DesktopTodoApi | null {
  if (typeof window === "undefined") return null;
  const w = window as Window & { desktopAPI?: { todo?: Record<string, (...args: any[]) => Promise<unknown>> } };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const raw = w.desktopAPI?.todo as any;
  if (!raw) return null;

  // Wrap the raw invoke returns into typed methods.
  return {
    list: async () => (await raw.list()) as TodoItem[],
    save: async (todo) => (await raw.save(todo)) as TodoItem,
    delete: async (id) => { await raw.delete(id); },
    addToCalendar: async (id, startAt) =>
      (await raw.addToCalendar(id, startAt, "", true)) as TodoItem,
  };
}
