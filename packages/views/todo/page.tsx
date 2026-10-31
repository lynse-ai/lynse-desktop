"use client";

import { useState, useCallback, useMemo } from "react";
import { Plus, Calendar, Trash2, X, RefreshCw, Loader2, Upload, List } from "../icons";
import { useTranslation } from "@lynse/core/i18n/react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { Button } from "@lynse/ui/components/ui/button";
import { toast } from "sonner";
import { featureFlags, isConnectionsEnabled } from "../feature-flags";
import { getDesktopInspirationApi } from "../inspiration/desktop-api";
import { isWebPlatform } from "../platform";
import { useInspirationCaptureStore } from "../inspiration/capture-store";
import { type TodoItem, todoStatus, todoClosed, addTodoToSystemCalendar, isCalendarAvailable, saveTodo } from "./todo-api";
import { groupTodos, type GroupKey } from "./grouping";
import { DatePickerPopover, TimePickerPopover } from "./date-time-picker";
import { TodoStateControl } from "./state-control";
import { useTodos } from "./use-todos";
import { TodoExportBar, TodoExportDialog, useTodoExportSelection } from "./export-action-items";
import { TodoCalendarView } from "./calendar-view";
import { useWorkbench } from "../workbench";
import { useNavigation } from "../navigation";
import { getWorkspaceState } from "../workspace/store";
import { ResizableHandle } from "../workspace/resizable-handle";
import { TitleBarSlot } from "../layout/app-title-bar";

// ── Helpers ────────────────────────────────────────────────

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

/** Section render order; overdue is flagged so its label renders in danger color. */
const GROUP_SECTIONS: { key: GroupKey; labelKey: string; danger?: boolean }[] = [
  { key: "overdue", labelKey: "todo.group_overdue", danger: true },
  { key: "today", labelKey: "todo.group_today" },
  { key: "thisWeek", labelKey: "todo.group_this_week" },
  { key: "later", labelKey: "todo.group_later" },
];

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
          {isWebPlatform() ? "Enter" : "⌘↵"}
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
  selectable = false,
  isChecked = false,
  onCheck,
}: {
  todo: TodoItem;
  active: boolean;
  onSelect: () => void;
  onToggle: () => void;
  /** Export mode: a second checkbox appears and the row click selects. */
  selectable?: boolean;
  isChecked?: boolean;
  onCheck?: () => void;
}) {
  const { t } = useTranslation();
  const dueText = formatDueDisplay(todo);

  return (
    <button
      onClick={selectable ? (onCheck ?? onSelect) : onSelect}
      className={`flex w-full items-center gap-3 rounded-lg px-6 py-2.5 text-left transition-colors ${
        active ? "bg-accent/60" : "hover:bg-accent/30"
      }`}
    >
      {selectable && (
        <input
          type="checkbox"
          checked={isChecked}
          onChange={() => onCheck?.()}
          className="size-4 shrink-0 rounded border-border accent-primary"
          onClick={(e) => e.stopPropagation()}
          aria-label={t("todo.export_select_item")}
        />
      )}
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
          todoClosed(todo) ? "line-through text-muted-foreground" : "text-foreground"
        }`}
      >
        {todo.title}
      </span>
      {todo.status && <span className="text-xs text-muted-foreground">{t(`memory_manager.todo_${todoStatus(todo)}`)}</span>}
      {dueText && (
        <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{dueText}</span>
      )}
      {todo.owner && (
        <span className="shrink-0 text-xs text-muted-foreground/70">
          {todo.owner}
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
  labelClassName,
  children,
}: {
  label: string;
  count: number;
  labelClassName?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="py-2">
      <div className="flex items-center gap-2 px-6 pb-1 pt-1">
        <span className={`text-sm font-medium ${labelClassName ?? "text-foreground"}`}>{label}</span>
        <span className="text-xs text-muted-foreground tabular-nums">{count}</span>
      </div>
      <div className="flex flex-col gap-px">{children}</div>
    </div>
  );
}

// ── Edit Panel ─────────────────────────────────────────────

/** Width limits mirror the assistant chat panel so both right-hand panels feel alike. */
const TODO_PANEL_DEFAULT_WIDTH = 340;
const TODO_PANEL_MIN_WIDTH = 260;
const TODO_PANEL_MAX_WIDTH = 600;

/**
 * All todo actions (notes, date/time, add to calendar, delete) live in one
 * right-hand panel that squeezes the page content — same layout as the
 * assistant chat panel: inline in the page layout, draggable from the left
 * handle, no backdrop. The calendar confirmation is a second view inside
 * the same panel instead of a separate centered dialog.
 *
 * Takes a nullable todo and renders unconditionally so AnimatePresence
 * owns the slide-in/out animation. Other surfaces (the home feed) open
 * the same panel in place instead of bouncing to the todo page.
 */
export function TodoEditPanel({
  todo,
  calendarAvailable,
  onClose,
  onDelete,
  onCalendarAdded,
  onSaved,
  onToggle,
}: {
  todo: TodoItem | null;
  calendarAvailable: boolean;
  onClose: () => void;
  onDelete: () => void;
  onCalendarAdded: () => void;
  onSaved: (todo: TodoItem) => void;
  /** Flips completion — the same store entry the list and calendar views toggle. */
  onToggle: (id: string) => void;
}) {
  const { t } = useTranslation();
  const reduceMotion = useReducedMotion();
  const [width, setWidth] = useState(TODO_PANEL_DEFAULT_WIDTH);
  const [resizing, setResizing] = useState(false);

  const handlePanelResize = useCallback((delta: number) => {
    setWidth((prev) => Math.min(TODO_PANEL_MAX_WIDTH, Math.max(TODO_PANEL_MIN_WIDTH, prev + delta)));
  }, []);

  return (
    <AnimatePresence initial={false}>
      {todo && (
        <motion.div
          key="todo-edit-panel"
          className="flex shrink-0 overflow-hidden bg-background"
          initial={{ width: 0, opacity: 0 }}
          animate={{ width, opacity: 1 }}
          exit={{ width: 0, opacity: 0 }}
          transition={
            resizing || reduceMotion
              ? { duration: 0 }
              : { type: "spring", bounce: 0, duration: 0.3 }
          }
        >
          <ResizableHandle
            label={t("todo.resize_panel")}
            onResize={handlePanelResize}
            onResizeStart={() => setResizing(true)}
            onResizeEnd={() => setResizing(false)}
            side="left"
          />
          <div key={todo.id} className="h-full overflow-hidden" style={{ width }}>
            <TodoEditPanelContent
              todo={todo}
              calendarAvailable={calendarAvailable}
              onClose={onClose}
              onDelete={onDelete}
              onCalendarAdded={onCalendarAdded}
              onSaved={onSaved}
              onToggle={onToggle}
            />
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function TodoEditPanelContent({
  todo,
  calendarAvailable,
  onClose,
  onDelete,
  onCalendarAdded,
  onSaved,
  onToggle,
}: {
  todo: TodoItem;
  calendarAvailable: boolean;
  onClose: () => void;
  onDelete: () => void;
  onCalendarAdded: () => void;
  /** Called with the saved item after the panel persists edits on close. */
  onSaved: (todo: TodoItem) => void;
  onToggle: (id: string) => void;
}) {
  const sourceNavigation = useNavigation();
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
    // Full-ISO dueDate (cloud todos) carries the extracted time; date-only
    // due dates have none, so start empty there.
    if (todo.dueDate && todo.dueDate.length > 10) {
      try {
        const d = new Date(todo.dueDate);
        if (!isNaN(d.getTime())) return toLocalTimeInput(d);
      } catch { /* fall through */ }
    }
    return "";
  });
  const [pendingStart, setPendingStart] = useState<Date | null>(null);
  const [savingCalendar, setSavingCalendar] = useState(false);
  const [calendarError, setCalendarError] = useState<string | null>(null);

  const handleNotesChange = useCallback((value: string) => {
    setNotes(value);
    setNotesDirty(true);
  }, []);

  /** Persist dueDate immediately so list grouping and the calendar react. */
  const persistDueDate = useCallback(
    (date: string, time: string) => {
      const iso = date ? (time ? `${date}T${time}:00` : date) : undefined;
      const updated: TodoItem = { ...todo, dueDate: iso, updatedAt: new Date().toISOString() };
      void saveTodo(updated)
        .then(() => onSaved(updated))
        .catch((e) => console.error("[Todo] due date save failed:", e));
    },
    [todo, onSaved],
  );

  const handleDateChange = useCallback(
    (date: string) => {
      setDateValue(date);
      persistDueDate(date, timeValue);
    },
    [persistDueDate, timeValue],
  );

  const handleTimeChange = useCallback(
    (time: string) => {
      setTimeValue(time);
      // Picking a time with no date adopts today, like Reminders does.
      const date = dateValue || toLocalDateInput(new Date());
      if (!dateValue) setDateValue(date);
      persistDueDate(date, time);
    },
    [dateValue, persistDueDate],
  );

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

  return (
    <div className="flex h-full min-h-0 flex-col">
      {view === "calendar" ? (
        <div className="flex flex-col p-4 pt-3">
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
        <div className="flex min-h-0 flex-1 flex-col gap-2 p-4 pt-3">
          <TodoStateControl todo={todo} onSaved={onSaved} />
            {/* Header — the completion checkbox reads the live store entry, so
                checking in the list or calendar mirrors here (and vice versa);
                title is an inline editable field like the notes. */}
            <div className="flex items-start justify-between gap-2">
              <div className="flex min-w-0 flex-1 items-start gap-2">
                <input
                  type="checkbox"
                  checked={todo.completed}
                  onChange={() => onToggle(todo.id)}
                  className="mt-0.5 size-4 shrink-0 rounded border-border accent-primary"
                  aria-label={t("todo.completed_toggle")}
                />
                <input
                  value={title}
                  onChange={(e) => {
                    setTitle(e.target.value);
                    setTitleDirty(true);
                  }}
                  className={`min-w-0 flex-1 truncate rounded-md bg-transparent pr-2 text-sm font-semibold outline-none focus:bg-muted/40 ${
                    todoClosed(todo) ? "text-muted-foreground line-through" : "text-foreground"
                  }`}
                />
              </div>
              <button onClick={handleClose} className="shrink-0 rounded p-1 hover:bg-accent/50">
                <X className="size-4 text-muted-foreground" />
              </button>
            </div>

          {/* Source / owner */}
          {todo.sourceTitle && (
            <button type="button" className="text-left text-xs text-muted-foreground underline-offset-4 hover:underline" onClick={() => {
              if (todo.sourceRef) useWorkbench.getState().showSource(todo.sourceRef);
              else if (todo.sourceFileId) {
                getWorkspaceState().selectItem(todo.sourceFileId, "meeting", todo.sourceTitle);
                sourceNavigation.push("/notes");
                handleClose();
              }
            }}>
              {t("todo.source_from")}{todo.sourceTitle}
              {todo.sourceMeetingTime && (
                <span className="ml-2 tabular-nums text-muted-foreground/70">
                  {new Date(todo.sourceMeetingTime).toLocaleDateString("zh-CN")}{" "}
                  {formatSourceTime(Number(todo.sourceMeetingTime))}
                </span>
              )}
            </button>
          )}
          {todo.owner && <p className="text-xs text-muted-foreground">负责人：{todo.owner}</p>}

            {/* Date & time — Reminders-style quick menus; picking persists
                immediately so grouping and the calendar view react. */}
            <div className="flex flex-wrap items-center gap-2">
              <DatePickerPopover value={dateValue} onChange={handleDateChange} />
              <TimePickerPopover value={timeValue} onChange={handleTimeChange} />
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
    </div>
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
  const [viewMode, setViewMode] = useState<"list" | "calendar">("list");
  // Export selection (PRD FR-2). Only cloud todos carry an id the export
  // contract understands, so local ones stay unselectable.
  const exportSelection = useTodoExportSelection(todos);
  const [exportMode, setExportMode] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const rowSelectionProps = (todo: TodoItem) => ({
    selectable: exportMode && Boolean(todo.backend),
    isChecked: exportSelection.selected.has(todo.id),
    onCheck: () => exportSelection.toggle(todo.id),
  });
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
    <div className={`flex h-full flex-col min-w-0${isWebPlatform() ? " mx-auto w-full max-w-3xl" : ""}`}>
      {/* Refresh / clear actions live in the unified app title bar via the
          slot (no center title — the bar doesn't echo the page name). */}
      <TitleBarSlot
        actions={
          <>
            <button
              onClick={() => setViewMode((prev) => (prev === "list" ? "calendar" : "list"))}
              className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-accent/50"
              title={t(viewMode === "list" ? "todo.view_calendar" : "todo.view_list")}
            >
              {viewMode === "list" ? <Calendar className="size-3.5" /> : <List className="size-3.5" />}
              {t(viewMode === "list" ? "todo.view_calendar" : "todo.view_list")}
            </button>
            {isConnectionsEnabled() && exportSelection.exportableIds.size > 0 && (
              <button
                onClick={() => {
                  setExportMode((prev) => !prev);
                  if (exportMode) exportSelection.clear();
                }}
                className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-accent/50"
                title={t("todo.export_button")}
              >
                {exportMode ? <X className="size-3.5" /> : <Upload className="size-3.5" />}
                {t(exportMode ? "todo.export_exit" : "todo.export_button")}
              </button>
            )}
            <button
              onClick={() => load({ force: true })}
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
          </>
        }
      />

      {exportMode && (
        <TodoExportBar
          count={exportSelection.count}
          onSelectAll={exportSelection.selectAll}
          onClear={exportSelection.clear}
          onExport={() => setExportOpen(true)}
        />
      )}
      <TodoExportDialog
        open={exportOpen}
        onOpenChange={setExportOpen}
        actionItemIds={[...exportSelection.selected]}
      />

      {/* Error banner */}
      {error && (
        <div className="flex items-center justify-between gap-2 border-b border-destructive/30 bg-destructive/10 px-6 py-2 text-xs text-destructive">
          <span>{t("todo.load_error")}</span>
          <button onClick={() => load({ force: true })} className="underline decoration-from-font underline-offset-2">
            {t("todo.retry")}
          </button>
        </div>
      )}

      {/* Body: main column with the edit panel squeezing it from the
          right — same layout as the assistant chat panel. */}
      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
          {/* Add input — desktop pops the shared capture sheet (todo mode);
              web falls back to the inline input. */}
          {sheetAvailable ? <AddTodoTrigger onOpen={() => openCapture("todo")} /> : <AddTodoInput onAdd={handleAdd} />}

          {/* List / calendar — one view at a time; the edit panel works on both. */}
          {viewMode === "calendar" ? (
            <TodoCalendarView
              todos={todos}
              selectedId={selectedId}
              onSelect={setSelectedId}
              onToggle={handleToggle}
            />
          ) : (
            <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
              {loading ? (
                <div className="flex items-center justify-center py-12 text-sm text-muted-foreground">…</div>
              ) : todos.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-16 text-center">
                  <p className="text-sm font-medium text-foreground">{t("todo.empty")}</p>
                  <p className="mt-1 text-xs text-muted-foreground">{t("todo.empty_hint")}</p>
                </div>
              ) : (
                GROUP_SECTIONS.map(({ key, labelKey, danger }) => {
                  const items = groups.get(key)!;
                  if (items.length === 0) return null;
                  return (
                    <GroupSection
                      key={key}
                      label={t(labelKey)}
                      count={items.length}
                      labelClassName={danger ? "text-destructive" : undefined}
                    >
                      {items.map((todo) => (
                        <TodoItemRow
                          key={todo.id}
                          todo={todo}
                          active={selectedId === todo.id}
                          onSelect={() => setSelectedId(todo.id)}
                          onToggle={() => handleToggle(todo.id)}
                          {...rowSelectionProps(todo)}
                        />
                      ))}
                    </GroupSection>
                  );
                })
              )}
            </div>
          )}
        </div>

        <TodoEditPanel
          todo={selected}
          calendarAvailable={calendarAvailable}
          onClose={() => setSelectedId(null)}
          onDelete={() => {
            if (selected) void handleDelete(selected.id);
          }}
          onCalendarAdded={() => {
            void load({ force: true });
            setSelectedId(null);
          }}
          onSaved={patchLocal}
          onToggle={handleToggle}
        />
      </div>
    </div>
  );
}
