"use client";

import { useState, useCallback, useMemo } from "react";
import { Plus, Calendar, Trash2, X, RefreshCw, Loader2 } from "../icons";
import { useTranslation } from "@lynse/core/i18n/react";
import { Sheet, SheetContent } from "@lynse/ui/components/ui/sheet";
import { Button } from "@lynse/ui/components/ui/button";
import { toast } from "sonner";
import { featureFlags } from "../feature-flags";
import { getDesktopInspirationApi } from "../inspiration/desktop-api";
import { useInspirationCaptureStore } from "../inspiration/capture-store";
import { type TodoItem, addTodoToSystemCalendar, isCalendarAvailable, saveTodo } from "./todo-api";
import { useTodos } from "./use-todos";

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

const pad2 = (n: number): string => String(n).padStart(2, "0");

/** Local-time yyyy-MM-dd for <input type="date"> (ISO slicing would shift a day across timezones). */
function toLocalDateInput(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** Local-time HH:mm for <input type="time"> / display. */
function toLocalTimeInput(d: Date): string {
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
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
    <div className="px-6 pb-2 pt-3">
      <div className="flex h-9 items-center gap-2 rounded-full border border-border/60 bg-muted/40 px-3.5 transition-colors focus-within:border-ring/60 focus-within:bg-background focus-within:ring-3 focus-within:ring-ring/20">
        <Plus className="size-4 shrink-0 text-muted-foreground" />
        <input
          className="h-full flex-1 bg-transparent text-sm text-foreground placeholder:text-muted-foreground outline-none"
          placeholder={t("todo.add_placeholder")}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={onKeyDown}
        />
        <kbd className="pointer-events-none inline-flex h-5 items-center gap-0.5 rounded border border-border/50 bg-muted/60 px-1.5 text-3xs font-medium text-muted-foreground">
          ⌘↵
        </kbd>
      </div>
    </div>
  );
}

/**
 * Desktop add bar: clicking it pops the shared capture sheet (the same
 * bottom-up panel the journal uses) pre-set to todo mode, so creating a
 * todo feels identical to writing a journal entry. Web (no capture sheet)
 * falls back to the inline input above.
 */
function AddTodoTrigger({ onOpen }: { onOpen: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="px-6 pb-2 pt-3">
      <div
        role="button"
        tabIndex={0}
        onClick={onOpen}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onOpen();
          }
        }}
        className="flex h-9 cursor-pointer items-center gap-2 rounded-full border border-border/60 bg-muted/40 px-3.5 transition-colors hover:border-ring/50 hover:bg-accent/40"
      >
        <Plus className="size-4 shrink-0 text-muted-foreground" />
        <span className="flex-1 truncate text-sm text-muted-foreground/80">
          {t("inspiration.todo_placeholder")}
        </span>
      </div>
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
      className={`flex w-full items-center gap-3 rounded-lg px-6 py-2.5 text-left transition-colors ${
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
      {todo.owner && (
        <span className="shrink-0 text-xs text-muted-foreground/70">
          {todo.owner}
        </span>
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
      <div className="flex items-center gap-2 px-6 pb-1 pt-1">
        <span className="text-sm font-medium text-foreground">{label}</span>
        <span className="text-xs text-muted-foreground tabular-nums">{count}</span>
      </div>
      <div className="flex flex-col gap-px">{children}</div>
    </div>
  );
}

// ── Edit Sheet ─────────────────────────────────────────────

/**
 * Floating positioning shared by every bottom sheet in the app — identical
 * to the inspiration capture sheet, so all popups have the same width,
 * rounding, and slide-up/fade animation.
 */
const SHEET_FLOAT_CLASS =
  "data-[side=bottom]:inset-x-auto data-[side=bottom]:bottom-4 data-[side=bottom]:left-1/2 data-[side=bottom]:w-[min(560px,calc(100vw-2rem))] data-[side=bottom]:-translate-x-1/2 data-[side=bottom]:rounded-2xl data-[side=bottom]:border";

/**
 * All todo actions (notes, date/time, add to calendar, delete) live in one
 * bottom-up floating sheet, mirroring the capture sheet. The calendar
 * confirmation is a second view inside the same sheet — same size, same
 * animation — instead of a separate centered dialog.
 *
 * Exported so other surfaces (the home feed) can open the same detail sheet
 * in place instead of bouncing to the todo page.
 */
export function TodoEditSheet({
  todo,
  calendarAvailable,
  onClose,
  onDelete,
  onCalendarAdded,
  onSaved,
}: {
  todo: TodoItem;
  calendarAvailable: boolean;
  onClose: () => void;
  onDelete: () => void;
  onCalendarAdded: () => void;
  /** Called with the saved item after the sheet persists edits on close. */
  onSaved: (todo: TodoItem) => void;
}) {
  const { t } = useTranslation();
  const [view, setView] = useState<"edit" | "calendar">("edit");
  const [title, setTitle] = useState(todo.title);
  const [titleDirty, setTitleDirty] = useState(false);
  const [notes, setNotes] = useState(todo.notes ?? "");
  const [notesDirty, setNotesDirty] = useState(false);
  const [dateValue, setDateValue] = useState(() => {
    if (todo.calendarStartAt) {
      try {
        const d = new Date(todo.calendarStartAt);
        if (!isNaN(d.getTime())) return toLocalDateInput(d);
      } catch { /* fall through */ }
    }
    // Date-only due dates are already yyyy-MM-dd; parse the full form in
    // local time so the picked day matches what the user saw.
    if (todo.dueDate) {
      if (todo.dueDate.length <= 10) return todo.dueDate;
      try {
        const d = new Date(todo.dueDate);
        if (!isNaN(d.getTime())) return toLocalDateInput(d);
      } catch { /* fall through */ }
    }
    return "";
  });
  const [timeValue, setTimeValue] = useState(() => {
    if (todo.calendarStartAt) {
      try {
        const d = new Date(todo.calendarStartAt);
        if (!isNaN(d.getTime())) return toLocalTimeInput(d);
      } catch { /* fall through */ }
    }
    return "14:00";
  });
  const [pendingStart, setPendingStart] = useState<Date | null>(null);
  const [savingCalendar, setSavingCalendar] = useState(false);
  const [calendarError, setCalendarError] = useState<string | null>(null);

  const handleNotesChange = useCallback((value: string) => {
    setNotes(value);
    setNotesDirty(true);
  }, []);

  const handleClose = useCallback(() => {
    // Persist edited title/notes on the way out; onSaved patches the visible
    // list with the saved item since the title shows in list rows.
    if (titleDirty || notesDirty) {
      const updated: TodoItem = {
        ...todo,
        title: title.trim() ? title.trim() : todo.title,
        notes,
        updatedAt: new Date().toISOString(),
      };
      void saveTodo(updated)
        .then(() => onSaved(updated))
        .catch((e) => console.error("[Todo] edit save failed:", e));
    }
    onClose();
  }, [title, titleDirty, notes, notesDirty, onClose, onSaved, todo]);

  const handleJoinCalendarClick = useCallback(() => {
    const datePart = dateValue || toLocalDateInput(new Date());
    const timePart = timeValue || "14:00";
    const start = new Date(`${datePart}T${timePart}`); // local time per spec
    if (isNaN(start.getTime())) return;
    setPendingStart(start);
    setCalendarError(null);
    setView("calendar");
  }, [dateValue, timeValue]);

  const handleConfirmCalendar = useCallback(async () => {
    if (!pendingStart || savingCalendar) return;
    // Default 1-hour duration. Full ISO strings with offset so the Rust
    // side can parse them as RFC 3339.
    const end = new Date(pendingStart.getTime() + 60 * 60 * 1000);
    setSavingCalendar(true);
    setCalendarError(null);
    try {
      await addTodoToSystemCalendar(todo, pendingStart.toISOString(), end.toISOString());
      toast.success(t("todo.added_to_calendar"));
      onCalendarAdded();
    } catch (err) {
      // Tauri v2 rejects command errors with the raw error *string*, not an
      // Error object — `err.message` is undefined there and the Rust detail
      // would be lost.
      const message = typeof err === "string" ? err : err instanceof Error ? err.message : "";
      console.error("[Todo] add to system calendar failed:", err);
      setCalendarError(
        message
          ? `${t("todo.calendar_add_failed")}${message}`
          : t("todo.calendar_add_failed"),
      );
    } finally {
      setSavingCalendar(false);
    }
  }, [onCalendarAdded, pendingStart, savingCalendar, t, todo]);

  const inputClass =
    "mt-1 w-full rounded-md border border-border/60 bg-transparent px-3 py-2 text-sm outline-none focus:border-primary/50";

  return (
    <Sheet
      open
      onOpenChange={(next) => {
        if (!next) handleClose();
      }}
    >
      <SheetContent side="bottom" showCloseButton={false} className={SHEET_FLOAT_CLASS}>
        {view === "calendar" ? (
          <div className="flex min-h-[208px] flex-col p-4 pt-3">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold text-foreground">{t("todo.calendar_dialog_title")}</h2>
              <button
                onClick={() => setView("edit")}
                className="shrink-0 rounded p-1 hover:bg-accent/50"
              >
                <X className="size-4 text-muted-foreground" />
              </button>
            </div>
            <p className="mt-1 text-sm text-muted-foreground">{t("todo.calendar_dialog_confirm")}</p>

            <div className="mt-2 space-y-2 rounded-lg bg-muted/40 p-3 text-sm">
              <div className="flex items-start justify-between gap-4">
                <span className="shrink-0 text-xs text-muted-foreground">{t("todo.calendar_dialog_title_label")}</span>
                <span className="text-right text-foreground">{title}</span>
              </div>
              <div className="flex items-start justify-between gap-4">
                <span className="shrink-0 text-xs text-muted-foreground">{t("todo.calendar_dialog_date_label")}</span>
                <span className="text-right tabular-nums text-foreground">
                  {pendingStart && !isNaN(pendingStart.getTime())
                    ? pendingStart.toLocaleDateString(undefined, {
                        weekday: "short",
                        year: "numeric",
                        month: "numeric",
                        day: "numeric",
                      })
                    : ""}
                </span>
              </div>
              <div className="flex items-start justify-between gap-4">
                <span className="shrink-0 text-xs text-muted-foreground">{t("todo.calendar_dialog_time_label")}</span>
                <span className="text-right tabular-nums text-foreground">
                  {pendingStart && !isNaN(pendingStart.getTime()) ? toLocalTimeInput(pendingStart) : ""}
                </span>
              </div>
            </div>

            {calendarError && <p className="text-xs text-destructive">{calendarError}</p>}

            <div className="mt-auto flex justify-end gap-2 pt-2">
              <Button variant="outline" size="sm" onClick={() => setView("edit")}>
                {t("todo.cancel")}
              </Button>
              <Button size="sm" disabled={savingCalendar} onClick={() => void handleConfirmCalendar()}>
                {savingCalendar && <Loader2 className="size-3.5 animate-spin" />}
                {t("todo.confirm_add_to_calendar")}
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex min-h-[208px] flex-col gap-2 p-4 pt-3">
            {/* Header — title is an inline editable field like the notes */}
            <div className="flex items-start justify-between gap-2">
              <input
                value={title}
                onChange={(e) => {
                  setTitle(e.target.value);
                  setTitleDirty(true);
                }}
                className="min-w-0 flex-1 truncate rounded-md bg-transparent pr-2 text-sm font-semibold text-foreground outline-none focus:bg-muted/40"
              />
              <button onClick={handleClose} className="shrink-0 rounded p-1 hover:bg-accent/50">
                <X className="size-4 text-muted-foreground" />
              </button>
            </div>

            {/* Source / owner */}
            {todo.sourceTitle && (
              <p className="text-xs text-muted-foreground">
                {t("todo.source_from")}{todo.sourceTitle}
                {todo.sourceMeetingTime && (
                  <span className="ml-2 tabular-nums text-muted-foreground/70">
                    {new Date(todo.sourceMeetingTime).toLocaleDateString("zh-CN")}{" "}
                    {formatSourceTime(Number(todo.sourceMeetingTime))}
                  </span>
                )}
              </p>
            )}
            {todo.owner && <p className="text-xs text-muted-foreground">负责人：{todo.owner}</p>}

            {/* Date & time */}
            <div className="grid grid-cols-2 gap-2">
              <label className="block">
                <span className="text-xs font-medium text-muted-foreground">{t("todo.date_label")}</span>
                <input
                  type="date"
                  value={dateValue}
                  onChange={(e) => setDateValue(e.target.value)}
                  className={inputClass}
                />
              </label>
              <label className="block">
                <span className="select-none text-xs font-medium text-transparent">·</span>
                <input
                  type="time"
                  value={timeValue}
                  onChange={(e) => setTimeValue(e.target.value)}
                  className={inputClass}
                />
              </label>
            </div>

            {/* Notes — borderless and transparent, same treatment as the
                capture sheet's textarea on the glass panel. */}
            <textarea
              className="max-h-40 min-h-[56px] w-full flex-1 resize-none bg-transparent text-sm leading-relaxed text-foreground outline-none placeholder:text-muted-foreground/70"
              rows={2}
              placeholder={t("todo.notes_placeholder")}
              value={notes}
              onChange={(e) => handleNotesChange(e.target.value)}
            />

            {/* Actions — calendar + delete share one centered row */}
            <div className="mt-auto flex items-center gap-2 border-t border-border/40 pt-2">
              {calendarAvailable &&
                (!todo.calendarEventId ? (
                  <Button variant="default" className="flex-1 gap-2" onClick={handleJoinCalendarClick}>
                    <Calendar className="size-4" />
                    {t("todo.actions_join_calendar")}
                  </Button>
                ) : (
                  <div className="flex flex-1 items-center justify-center gap-2 rounded-full bg-success/10 px-3 py-2 text-xs text-success">
                    <Calendar className="size-3.5" />
                    {t("todo.added_to_calendar")}
                  </div>
                ))}
              <Button variant="destructive" className="flex-1" onClick={onDelete}>
                <Trash2 className="size-4" />
                {t("todo.actions_delete")}
              </Button>
            </div>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}

// ── Main Page ──────────────────────────────────────────────

export function TodoPage() {
  const { t } = useTranslation();
  const { todos, loading, refreshing, clearing, error, load, addLocal, toggle, remove, patchLocal, clearCompleted } = useTodos();
  const openCapture = useInspirationCaptureStore((state) => state.openCapture);
  // The capture sheet needs the desktop bridge; web keeps the inline input.
  const sheetAvailable = featureFlags.inspiration && Boolean(getDesktopInspirationApi());
  const completedCount = todos.filter((x) => x.completed).length;
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const calendarAvailable = useMemo(() => isCalendarAvailable(), []);

  const handleAdd = useCallback(
    (title: string) => {
      addLocal(title);
      setSelectedId(null);
    },
    [addLocal],
  );

  const handleToggle = useCallback(
    (id: string) => {
      const todo = todos.find((x) => x.id === id);
      if (todo) toggle(todo);
    },
    [todos, toggle],
  );

  const handleDelete = useCallback(
    async (id: string) => {
      const todo = todos.find((x) => x.id === id);
      if (todo) await remove(todo);
      if (selectedId === id) setSelectedId(null);
    },
    [todos, remove, selectedId],
  );

  const groups = useMemo(() => groupTodos(todos), [todos]);
  const selected = todos.find((x) => x.id === selectedId) ?? null;

  // ── Render ────────────────────────────────────────────────
  return (
    <div className="flex h-full flex-col min-w-0">
      {/* Header */}
      <div
        className="flex shrink-0 items-center justify-between border-b border-stroke-secondary px-6 select-none"
        style={{ height: 44 }}
        data-tauri-drag-region
      >
        <h1 className="text-base font-semibold text-foreground">{t("todo.page_title")}</h1>
        <div className="flex items-center gap-1">
          <button
            onClick={() => load()}
            disabled={refreshing}
            className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-accent/50 disabled:opacity-50"
            title={t("todo.refresh")}
          >
            <RefreshCw className={`size-3.5 ${refreshing ? "animate-spin" : ""}`} />
            {t("todo.refresh")}
          </button>
          <button
            onClick={() => clearCompleted()}
            disabled={clearing || completedCount === 0}
            className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-accent/50 disabled:opacity-40"
            title={t("todo.clear_completed")}
          >
            <Trash2 className="size-3.5" />
            {clearing ? t("todo.clearing") : t("todo.clear_completed")}
            {completedCount > 0 && !clearing && (
              <span className="ml-0.5 rounded-full bg-muted px-1.5 text-3xs tabular-nums">
                {completedCount}
              </span>
            )}
          </button>
        </div>
      </div>

      {/* Error banner */}
      {error && (
        <div className="flex items-center justify-between gap-2 border-b border-destructive/30 bg-destructive/10 px-6 py-2 text-xs text-destructive">
          <span>{t("todo.load_error")}</span>
          <button onClick={() => load()} className="underline decoration-from-font underline-offset-2">
            {t("todo.retry")}
          </button>
        </div>
      )}

      {/* Add input — desktop pops the shared capture sheet (todo mode);
          web falls back to the inline input. */}
      {sheetAvailable ? <AddTodoTrigger onOpen={() => openCapture("todo")} /> : <AddTodoInput onAdd={handleAdd} />}

      {/* List */}
      <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {loading ? (
          <div className="flex items-center justify-center py-12 text-sm text-muted-foreground">…</div>
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

      {/* Edit sheet — all todo actions (notes, date/time, calendar, delete)
          happen in the same bottom-up floating sheet as the capture sheet. */}
      {selected && (
        <TodoEditSheet
          key={selected.id}
          todo={selected}
          calendarAvailable={calendarAvailable}
          onClose={() => setSelectedId(null)}
          onDelete={() => void handleDelete(selected.id)}
          onCalendarAdded={() => {
            void load();
            setSelectedId(null);
          }}
          onSaved={patchLocal}
        />
      )}
    </div>
  );
}
