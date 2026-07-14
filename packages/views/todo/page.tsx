"use client";

import { useState, useCallback, useEffect, useMemo } from "react";
import { Plus, Calendar, Trash2, X } from "../icons";
import { useTranslation } from "@lynse/core/i18n/react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@lynse/ui/components/ui/dialog";
import { Button } from "@lynse/ui/components/ui/button";
import { getDesktopTodoApi, type TodoItem } from "./todo-api";

// ── Helpers ────────────────────────────────────────────────

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

function formatDueDisplay(todo: TodoItem): string {
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

function formatSourceTime(seconds: number | undefined): string {
  if (!seconds || seconds <= 0) return "";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

type GroupKey = "today" | "thisWeek" | "later";

function groupTodos(todos: TodoItem[]): Map<GroupKey, TodoItem[]> {
  const map = new Map<GroupKey, TodoItem[]>();
  map.set("today", []);
  map.set("thisWeek", []);
  map.set("later", []);
  for (const todo of todos) {
    // Use dueDate or calendarStartAt for grouping; fallback to createdAt
    const dateKey = todo.dueDate || todo.calendarStartAt || todo.createdAt;
    let key: GroupKey = "later";
    if (isToday(dateKey)) key = "today";
    else if (isThisWeek(dateKey)) key = "thisWeek";
    map.get(key)!.push(todo);
  }
  return map;
}

// ── Sub-components ─────────────────────────────────────────

function AddTodoInput({ onAdd }: { onAdd: (title: string) => void }) {
  const { t } = useTranslation();
  const [value, setValue] = useState("");

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" && value.trim()) {
        onAdd(value.trim());
        setValue("");
      }
    },
    [value, onAdd],
  );

  return (
    <div className="flex items-center gap-2 border-b border-stroke-secondary px-4 py-3">
      <Plus className="size-4 shrink-0 text-muted-foreground" />
      <input
        className="flex-1 bg-transparent text-sm text-foreground placeholder:text-muted-foreground outline-none"
        placeholder={t("todo.add_placeholder")}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={onKeyDown}
      />
      <kbd className="pointer-events-none inline-flex h-5 items-center gap-0.5 rounded border border-border/50 bg-muted/60 px-1.5 text-[10px] font-medium text-muted-foreground">
        ⌘↵
      </kbd>
    </div>
  );
}

function TodoItemRow({
  todo,
  active,
  onSelect,
  onToggle,
}: {
  todo: TodoItem;
  active: boolean;
  onSelect: () => void;
  onToggle: () => void;
}) {
  const { t } = useTranslation();
  const dueText = formatDueDisplay(todo);

  return (
    <button
      onClick={onSelect}
      className={`flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-colors ${
        active ? "bg-accent/60" : "hover:bg-accent/30"
      }`}
    >
      <input
        type="checkbox"
        checked={todo.completed}
        onChange={(e) => { e.stopPropagation(); onToggle(); }}
        className="size-4 shrink-0 rounded border-border accent-primary"
        onClick={(e) => e.stopPropagation()}
        aria-label={t("todo.completed_toggle")}
      />
      <span
        className={`flex-1 truncate text-sm leading-tight ${
          todo.completed ? "line-through text-muted-foreground" : "text-foreground"
        }`}
      >
        {todo.title}
      </span>
      {dueText && (
        <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{dueText}</span>
      )}
      {todo.sourceTitle && (
        <span className="shrink-0 text-xs text-muted-foreground/70">
          来源：{todo.sourceTitle}
          {formatSourceTime(todo.sourceMeetingTime as any)}
        </span>
      )}
      {!todo.calendarEventId && (
        <Calendar className="size-4 shrink-0 text-muted-foreground/40" />
      )}
    </button>
  );
}

function GroupSection({
  label,
  count,
  children,
}: {
  label: string;
  count: number;
  children: React.ReactNode;
}) {
  return (
    <div className="py-2">
      <div className="flex items-center gap-2 px-4 pb-1 pt-1">
        <span className="text-sm font-medium text-foreground">{label}</span>
        <span className="text-xs text-muted-foreground tabular-nums">{count}</span>
      </div>
      <div className="flex flex-col gap-px">{children}</div>
    </div>
  );
}

// ── Detail Panel ───────────────────────────────────────────

function DetailPanel({
  todo,
  onClose,
  onDelete,
  onAddToCalendar,
}: {
  todo: TodoItem;
  onClose: () => void;
  onDelete: () => void;
  onAddToCalendar: (startAt: string, endAt: string) => void;
}) {
  const { t } = useTranslation();
  const [notes, setNotes] = useState(todo.notes ?? "");
  const [dateValue, setDateValue] = useState(() => {
    if (todo.calendarStartAt) {
      try {
        const d = new Date(todo.calendarStartAt);
        if (isNaN(d.getTime())) return "";
        return d.toISOString().slice(0, 16); // yyyy-MM-ddTHH:mm
      } catch { return ""; }
    }
    if (todo.dueDate) {
      try {
        const d = new Date(todo.dueDate);
        if (isNaN(d.getTime())) return "";
        return d.toISOString().slice(0, 10); // yyyy-MM-dd
      } catch { return ""; }
    }
    return "";
  });
  const [timeValue, setTimeValue] = useState(() => {
    if (todo.calendarStartAt) {
      try {
        const d = new Date(todo.calendarStartAt);
        if (isNaN(d.getTime())) return "14:00";
        return d.toISOString().slice(11, 16);
      } catch { return "14:00"; }
    }
    return "14:00";
  });

  const handleAddToCalendar = useCallback(() => {
    const datePart = dateValue || new Date().toISOString().slice(0, 10);
    const timePart = timeValue || "14:00";
    const startAt = `${datePart}T${timePart}:00`;
    // Default 1-hour duration
    const end = new Date(`${datePart}T${timePart}:00`);
    end.setHours(end.getHours() + 1);
    const endAt = end.toISOString();
    onAddToCalendar(startAt, endAt);
  }, [dateValue, timeValue, onAddToCalendar]);

  return (
    <div className="flex h-full w-80 shrink-0 flex-col border-l border-stroke-secondary bg-background">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3">
        <h2 className="truncate text-sm font-semibold text-foreground pr-2">{todo.title}</h2>
        <button onClick={onClose} className="shrink-0 p-1 rounded hover:bg-accent/50">
          <X className="size-4 text-muted-foreground" />
        </button>
      </div>

      {/* Source */}
      {todo.sourceTitle && (
        <div className="px-4 pb-3">
          <p className="text-xs text-muted-foreground mb-1">{t("todo.source_from")}{todo.sourceTitle}</p>
          {todo.sourceMeetingTime && (
            <p className="text-xs text-muted-foreground/70 tabular-nums">
              {new Date(todo.sourceMeetingTime).toLocaleDateString("zh-CN")}{" "}
              {formatSourceTime(Number(todo.sourceMeetingTime))}
            </p>
          )}
        </div>
      )}

      {/* Divider */}
      <div className="border-t border-border/40 mx-4" />

      {/* Date & Time */}
      <div className="px-4 py-3 space-y-3">
        <label className="block">
          <span className="text-xs font-medium text-muted-foreground">{t("todo.date_label")}</span>
          <input
            type="date"
            value={dateValue}
            onChange={(e) => setDateValue(e.target.value)}
            className="mt-1 w-full rounded-md border border-border/60 bg-background px-3 py-2 text-sm outline-none focus:border-primary/50"
          />
        </label>
        <input
          type="time"
          value={timeValue}
          onChange={(e) => setTimeValue(e.target.value)}
          className="w-full rounded-md border border-border/60 bg-background px-3 py-2 text-sm outline-none focus:border-primary/50"
        />
      </div>

      {/* Notes */}
      <div className="px-4 pb-3">
        <textarea
          className="w-full resize-none rounded-md border border-border/60 bg-background px-3 py-2 text-sm outline-none placeholder:text-muted-foreground/50"
          rows={3}
          placeholder={t("todo.notes_placeholder")}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
        />
      </div>

      {/* Actions */}
      <div className="mt-auto border-t border-border/40 px-4 py-3 space-y-2">
        {!todo.calendarEventId ? (
          <Button
            variant="default"
            size="sm"
            className="w-full justify-start gap-2"
            onClick={handleAddToCalendar}
          >
            <Calendar className="size-4" />
            {t("todo.actions_join_calendar")}
          </Button>
        ) : (
          <div className="flex items-center gap-2 text-xs text-green-600 dark:text-green-400 px-2 py-1.5 rounded bg-green-50 dark:bg-green-950/30">
            <Calendar className="size-3.5" />
            {t("todo.added_to_calendar")}
          </div>
        )}
        <button
          onClick={onDelete}
          className="flex w-full items-center justify-start gap-2 rounded-md px-3 py-2 text-sm text-destructive hover:bg-destructive/10 transition-colors"
        >
          <Trash2 className="size-4" />
          {t("todo.actions_delete")}
        </button>
      </div>
    </div>
  );
}

// ── Calendar Confirmation Dialog ──────────────────────────

function CalendarConfirmDialog({
  open,
  onOpenChange,
  todo,
  startAt,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  todo: TodoItem;
  startAt: string;
  onConfirm: () => void;
}) {
  const { t } = useTranslation();

  const displayDate = useMemo(() => {
    try {
      const d = new Date(startAt);
      if (isNaN(d.getTime())) return "";
      return d.toLocaleDateString("zh-CN", { weekday: "short", year: "numeric", month: "numeric", day: "numeric" });
    } catch { return ""; }
  }, [startAt]);

  const displayTime = useMemo(() => {
    try {
      const d = new Date(startAt);
      if (isNaN(d.getTime())) return "14:00";
      return d.toISOString().slice(11, 16);
    } catch { return "14:00"; }
  }, [startAt]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[400px]">
        <DialogHeader>
          <DialogTitle>{t("todo.calendar_dialog_title")}</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">{t("todo.calendar_dialog_confirm")}</p>

        <div className="space-y-3 py-2 text-sm">
          <div>
            <label className="text-xs font-medium text-muted-foreground">{t("todo.calendar_dialog_title_label")}</label>
            <p className="mt-0.5 text-foreground">{todo.title}</p>
          </div>
          <div>
            <label className="text-xs font-medium text-muted-foreground">{t("todo.calendar_dialog_date_label")}</label>
            <p className="mt-0.5 text-foreground">{displayDate}</p>
          </div>
          <div>
            <label className="text-xs font-medium text-muted-foreground">{t("todo.calendar_dialog_time_label")}</label>
            <p className="mt-0.5 text-foreground">{displayTime}</p>
          </div>
          <div>
            <label className="text-xs font-medium text-muted-foreground">{t("todo.calendar_dialog_calendar_label")}</label>
            <select className="mt-0.5 w-full rounded-md border border-border/60 bg-background px-3 py-1.5 text-sm">
              <option>{t("todo.calendar_default_name")}</option>
            </select>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("todo.cancel")}
          </Button>
          <Button onClick={() => { onConfirm(); onOpenChange(false); }}>
            {t("todo.confirm_add_to_calendar")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Main Page ──────────────────────────────────────────────

export function TodoPage() {
  const { t } = useTranslation();
  const api = getDesktopTodoApi();
  const [todos, setTodos] = useState<TodoItem[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [calendarOpen, setCalendarOpen] = useState(false);
  const [pendingCalendarStart, setPendingCalendarStart] = useState("");
  const [loading, setLoading] = useState(true);

  const loadTodos = useCallback(async () => {
    if (!api) { setLoading(false); return; }
    try {
      const list = await api.list();
      // Sort: incomplete first, then by createdAt desc
      list.sort((a, b) => {
        if (a.completed !== b.completed) return a.completed ? 1 : -1;
        return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
      });
      setTodos(list);
    } catch { /* silently fail */ }
    setLoading(false);
  }, [api]);

  useEffect(() => { loadTodos(); }, [loadTodos]);

  const handleAdd = useCallback(
    async (title: string) => {
      if (!api) return;
      const saved = await api.save({ title });
      setTodos((prev) => [saved, ...prev]);
      setSelectedId(saved.id);
    },
    [api],
  );

  const handleToggle = useCallback(
    async (id: string) => {
      if (!api) return;
      const todo = todos.find((x) => x.id === id);
      if (!todo) return;
      await api.save({ ...todo, completed: !todo.completed });
      setTodos((prev) =>
        prev.map((x) => (x.id === id ? { ...x, completed: !x.completed, updatedAt: new Date().toISOString() } : x)),
      );
    },
    [api, todos],
  );

  const handleDelete = useCallback(
    async (id: string) => {
      if (!api) return;
      await api.delete(id);
      setTodos((prev) => prev.filter((x) => x.id !== id));
      if (selectedId === id) setSelectedId(null);
    },
    [api, selectedId],
  );

  const handleAddToCalendar = useCallback(
    (startAt: string) => {
      if (!api || !selectedId) return;
      setPendingCalendarStart(startAt);
      setCalendarOpen(true);
    },
    [api, selectedId],
  );

  const confirmAddToCalendar = useCallback(async () => {
    if (!api || !selectedId || !pendingCalendarStart) return;
    try {
      const end = new Date(pendingCalendarStart);
      end.setHours(end.getHours() + 1);
      const updated = await api.addToCalendar(selectedId, pendingCalendarStart, end.toISOString());
      setTodos((prev) => prev.map((x) => (x.id === selectedId ? updated : x)));
    } catch (err) {
      console.error("[Todo] addToCalendar failed:", err);
    }
  }, [api, selectedId, pendingCalendarStart]);

  const groups = useMemo(() => groupTodos(todos), [todos]);
  const selected = todos.find((x) => x.id === selectedId) ?? null;

  // ── Render ────────────────────────────────────────────────
  return (
    <div className="flex h-full flex-col min-w-0">
      {/* Header */}
      <div className="flex shrink-0 items-center border-b border-stroke-secondary px-4" style={{ height: 44 }}>
        <h1 className="text-base font-semibold text-foreground">{t("todo.page_title")}</h1>
      </div>

      {/* Add input */}
      <AddTodoInput onAdd={handleAdd} />

      {/* List */}
      <div className="flex-1 min-h-0 overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {loading ? (
          <div className="flex items-center justify-center py-12 text-sm text-muted-foreground">...</div>
        ) : todos.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-center">
            <p className="text-sm font-medium text-foreground">{t("todo.empty")}</p>
            <p className="mt-1 text-xs text-muted-foreground">{t("todo.empty_hint")}</p>
          </div>
        ) : (
          <>
            {groups.get("today")!.length > 0 && (
              <GroupSection label={t("todo.group_today")} count={groups.get("today")!.length}>
                {groups.get("today")!.map((todo) => (
                  <TodoItemRow
                    key={todo.id}
                    todo={todo}
                    active={selectedId === todo.id}
                    onSelect={() => setSelectedId(todo.id)}
                    onToggle={() => handleToggle(todo.id)}
                  />
                ))}
              </GroupSection>
            )}
            {groups.get("thisWeek")!.length > 0 && (
              <GroupSection label={t("todo.group_this_week")} count={groups.get("thisWeek")!.length}>
                {groups.get("thisWeek")!.map((todo) => (
                  <TodoItemRow
                    key={todo.id}
                    todo={todo}
                    active={selectedId === todo.id}
                    onSelect={() => setSelectedId(todo.id)}
                    onToggle={() => handleToggle(todo.id)}
                  />
                ))}
              </GroupSection>
            )}
            {groups.get("later")!.length > 0 && (
              <GroupSection label={t("todo.group_later")} count={groups.get("later")!.length}>
                {groups.get("later")!.map((todo) => (
                  <TodoItemRow
                    key={todo.id}
                    todo={todo}
                    active={selectedId === todo.id}
                    onSelect={() => setSelectedId(todo.id)}
                    onToggle={() => handleToggle(todo.id)}
                  />
                ))}
              </GroupSection>
            )}
          </>
        )}
      </div>

      {/* Detail panel */}
      {selected && (
        <DetailPanel
          todo={selected}
          onClose={() => setSelectedId(null)}
          onDelete={() => handleDelete(selected.id)}
          onAddToCalendar={handleAddToCalendar}
        />
      )}

      {/* Calendar confirmation dialog */}
      <CalendarConfirmDialog
        open={calendarOpen}
        onOpenChange={setCalendarOpen}
        todo={selected!}
        startAt={pendingCalendarStart}
        onConfirm={confirmAddToCalendar}
      />
    </div>
  );
}
