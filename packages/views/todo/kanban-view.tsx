"use client";

import { useMemo, useState } from "react";
import { Calendar, Star, User } from "../icons";
import { useTranslation } from "@lynse/core/i18n/react";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@lynse/ui/components/ui/dialog";
import { Button } from "@lynse/ui/components/ui/button";
import {
  type TodoItem,
  type KanbanLane,
  todoClosed,
} from "./todo-api";
import { dayKey, formatDueDisplay, isOverdueTodo, startOfLocalDay } from "./grouping";
import { MonthCalendarGrid, quickDateTargets } from "./date-time-picker";
import {
  KANBAN_COLUMNS,
  isGenericOwner,
  kanbanColumnFor,
  kanbanColumns,
  type KanbanColumnKey,
} from "./kanban";

/**
 * Kanban board view of the todo page — a triage workflow: 未整理 (no date
 * yet), 近期任务 (carries a due date), and the 重点追踪 starred watchlist.
 * 已完成 exists but is hidden behind a toolbar toggle. Native HTML5 drag &
 * drop between columns; dropping on 近期任务 always pops the date dialog so
 * the move lands on a concrete day; the card's star icon files it into
 * 重点追踪 with one click. Clicking a card opens the shared edit sidebar via
 * `onSelect`.
 */

/** A board move target: all fields optional — undefined keeps the current
 *  value, null/false clears (see moveTodoKanban). */
export type KanbanMoveTarget = {
  status?: "open" | "doing" | "done" | null;
  lane?: KanbanLane | null;
  dueDate?: string | null;
  starred?: boolean | null;
};

/** yyyy-MM-dd with the todo's existing time-of-day preserved (if any). */
function rebaseDate(todo: TodoItem, key: string): string {
  if (todo.dueDate && todo.dueDate.length > 10) {
    const d = new Date(todo.dueDate);
    if (!isNaN(d.getTime())) {
      const hh = String(d.getHours()).padStart(2, "0");
      const mm = String(d.getMinutes()).padStart(2, "0");
      return `${key}T${hh}:${mm}:00`;
    }
  }
  return key;
}

function KanbanCard({
  todo,
  active,
  dragging,
  onSelect,
  onToggle,
  onToggleStar,
  onDragStart,
  onDragEnd,
}: {
  todo: TodoItem;
  active: boolean;
  dragging: boolean;
  onSelect: () => void;
  onToggle: () => void;
  onToggleStar: () => void;
  onDragStart: (e: React.DragEvent) => void;
  onDragEnd: () => void;
}) {
  const { t } = useTranslation();
  const dueText = formatDueDisplay(todo);
  const closed = todoClosed(todo);
  const overdue = isOverdueTodo(todo);
  const owner = todo.owner && !isGenericOwner(todo.owner) ? todo.owner : null;

  return (
    <div
      role="button"
      tabIndex={0}
      draggable
      onDragStart={(e) => {
        // Standard payload — WKWebView drag sessions are more reliable when
        // the transfer carries data.
        e.dataTransfer.setData("text/plain", todo.id);
        e.dataTransfer.effectAllowed = "move";
        onDragStart(e);
      }}
      onDragEnd={onDragEnd}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect();
        }
      }}
      className={`flex cursor-pointer flex-col gap-1.5 rounded-lg border bg-card/60 p-2.5 text-left transition-colors ${
        active
          ? "border-ring/50 bg-accent/50"
          : "border-border/60 hover:border-ring/40 hover:bg-accent/30"
      } ${dragging ? "opacity-40" : ""}`}
    >
      <div className="flex items-start gap-2">
        <input
          type="checkbox"
          checked={todo.completed}
          onChange={(e) => { e.stopPropagation(); onToggle(); }}
          onClick={(e) => e.stopPropagation()}
          className="mt-0.5 size-4 shrink-0 rounded border-border accent-primary"
          aria-label={t("todo.completed_toggle")}
        />
        <span
          className={`line-clamp-2 min-w-0 flex-1 text-sm leading-snug ${
            closed ? "text-muted-foreground line-through" : "text-foreground"
          }`}
        >
          {todo.title}
        </span>
        {/* Star = file into 重点追踪. One click, no dialog; clicking again
            returns the card to its date-based column. */}
        <button
          onClick={(e) => {
            e.stopPropagation();
            onToggleStar();
          }}
          className="-m-0.5 shrink-0 rounded p-0.5 transition-colors hover:bg-accent/50"
          aria-label={t("todo.star_toggle")}
          aria-pressed={Boolean(todo.starred)}
          title={t("todo.star_toggle")}
        >
          <Star
            className={`size-3.5 transition-colors ${
              todo.starred
                ? "fill-warning text-warning"
                : "text-muted-foreground/35 hover:text-warning"
            }`}
          />
        </button>
      </div>

      {(dueText || owner) && (
        <div className="flex flex-wrap items-center gap-1 text-2xs text-muted-foreground">
          {dueText && (
            <span
              className={`inline-flex shrink-0 items-center gap-1 rounded-full px-1.5 py-0.5 tabular-nums ${
                overdue && !closed ? "bg-destructive/10 text-destructive" : "bg-muted/60"
              }`}
            >
              <Calendar className="size-3 shrink-0" />
              {dueText}
            </span>
          )}
          {owner && (
            <span
              className="inline-flex min-w-0 items-center gap-1 rounded-full bg-muted/60 px-1.5 py-0.5"
              title={owner}
            >
              <User className="size-3 shrink-0" />
              <span className="truncate">{owner}</span>
            </span>
          )}
        </div>
      )}
    </div>
  );
}

function KanbanColumn({
  columnKey,
  label,
  count,
  muted = false,
  fixedWidth = false,
  isDropTarget,
  hint,
  children,
  onDragOver,
  onDragLeave,
  onDrop,
}: {
  columnKey: KanbanColumnKey;
  label: string;
  count: number;
  /** Pool / done styling: slightly recessed so the workflow columns stand out. */
  muted?: boolean;
  fixedWidth?: boolean;
  isDropTarget: boolean;
  /** Shown when the column has no cards. */
  hint?: string;
  children: React.ReactNode;
  onDragOver: (e: React.DragEvent) => void;
  onDragLeave: () => void;
  onDrop: (e: React.DragEvent) => void;
}) {
  return (
    <div
      data-column={columnKey}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      className={`flex min-h-0 min-w-0 flex-col rounded-xl border ${
        fixedWidth ? "w-60 flex-none" : "flex-1"
      } ${
        isDropTarget
          ? "border-ring/50 bg-accent/20"
          : muted
            ? "border-border/40 bg-muted/20"
            : "border-border/40 bg-background"
      }`}
    >
      <div className="flex items-center gap-2 border-b border-border/40 px-3 py-2">
        <span className={`text-sm font-medium ${muted ? "text-muted-foreground" : "text-foreground"}`}>{label}</span>
        <span className="rounded-full px-1.5 text-xs tabular-nums text-muted-foreground">{count}</span>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto overscroll-contain p-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {children}
        {count === 0 && hint && (
          <div className="flex flex-1 items-center justify-center px-3">
            <p className="text-center text-2xs leading-relaxed text-muted-foreground/60">{hint}</p>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Drop follow-up for 近期任务: pick the concrete day the task moves to.
 * Quick slots (今天/明天/下周末/下周) prefill the selection; the month grid
 * picks anything else; 确认 commits — cancelling abandons the move entirely.
 */
function MoveDateDialog({
  todo,
  onConfirm,
  onCancel,
}: {
  todo: TodoItem;
  onConfirm: (dueDate: string) => void;
  onCancel: () => void;
}) {
  const { t, i18n } = useTranslation();
  const locale = i18n.language || "en";
  const dayFormatter = useMemo(
    () => new Intl.DateTimeFormat(locale, { month: "numeric", day: "numeric" }),
    [locale],
  );
  // Preselect the todo's own day when it has a parseable one, otherwise
  // suggest tomorrow.
  const [dateValue, setDateValue] = useState(() => {
    if (todo.dueDate) {
      const d = new Date(todo.dueDate);
      if (!isNaN(d.getTime())) return dayKey(d);
    }
    const tomorrow = startOfLocalDay(new Date());
    tomorrow.setDate(tomorrow.getDate() + 1);
    return dayKey(tomorrow);
  });
  const [anchor, setAnchor] = useState(() => {
    const d = new Date(`${dateValue}T00:00:00`);
    return isNaN(d.getTime()) ? startOfLocalDay(new Date()) : d;
  });

  const quickLabels: Record<string, string> = {
    today: t("todo.quick_today"),
    tomorrow: t("todo.quick_tomorrow"),
    weekend: t("todo.quick_next_weekend"),
    week: t("todo.quick_next_week"),
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onCancel(); }}>
      <DialogContent className="w-[19rem] gap-2">
        <DialogHeader>
          <DialogTitle className="text-sm">{t("todo.move_date_title")}</DialogTitle>
        </DialogHeader>
        <p className="line-clamp-2 text-xs leading-relaxed text-muted-foreground">{todo.title}</p>

        <div className="grid grid-cols-4 gap-1.5">
          {quickDateTargets().map(({ key, date }) => {
            const keyStr = dayKey(date);
            return (
              <button
                key={key}
                onClick={() => {
                  setDateValue(keyStr);
                  setAnchor(date);
                }}
                className={`flex flex-col items-center gap-0.5 rounded-md border px-1 py-1.5 text-center transition-colors ${
                  dateValue === keyStr
                    ? "border-primary/50 bg-primary/10 text-primary"
                    : "border-border/50 text-muted-foreground hover:bg-accent/40 hover:text-foreground"
                }`}
              >
                <span className="text-2xs font-medium">{quickLabels[key]}</span>
                <span className="text-3xs tabular-nums opacity-80">{dayFormatter.format(date)}</span>
              </button>
            );
          })}
        </div>

        <MonthCalendarGrid anchor={anchor} value={dateValue} onPick={setDateValue} onAnchorChange={setAnchor} />

        <DialogFooter className="gap-2">
          <Button variant="outline" size="sm" onClick={onCancel}>
            {t("todo.cancel")}
          </Button>
          <Button size="sm" onClick={() => onConfirm(dateValue)}>
            {t("todo.move_date_confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * The board itself. Drag & drop is plain HTML5 DnD (no dependency): cards
 * set data on dragstart, columns highlight while hovered and commit the
 * move on drop. Same-column drops are no-ops. Dropping on 近期任务 opens
 * the date dialog instead of moving blindly; 未整理 clears the date (that
 * is what "not organized yet" means); 重点追踪 stars the card.
 */
export function TodoKanbanView({
  todos,
  selectedId,
  onSelect,
  onToggle,
  onMoveKanban,
}: {
  todos: TodoItem[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onToggle: (id: string) => void;
  onMoveKanban: (todo: TodoItem, target: KanbanMoveTarget) => void;
}) {
  const { t } = useTranslation();
  const columns = useMemo(() => kanbanColumns(todos), [todos]);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [overColumn, setOverColumn] = useState<KanbanColumnKey | null>(null);
  // 已完成 is hidden by default — the board is about what's ahead.
  const [showDone, setShowDone] = useState(false);
  const [pendingMove, setPendingMove] = useState<TodoItem | null>(null);

  const doneCount = columns.get("done")!.length;

  const handleDrop = (columnKey: KanbanColumnKey) => {
    const todo = todos.find((x) => x.id === draggingId);
    setOverColumn(null);
    setDraggingId(null);
    if (!todo || kanbanColumnFor(todo) === columnKey) return;
    switch (columnKey) {
      // "Not organized yet" means no date and not tracked — parking here
      // clears both (explicit drag intent, same as picking 无 in the panel).
      case "unsorted":
        if (!todoClosed(todo)) onMoveKanban(todo, { dueDate: null, starred: false });
        break;
      case "near":
        // Always needs a concrete day — pop the dialog; the move commits on
        // confirm (and reopens closed cards).
        setPendingMove(todo);
        break;
      case "star":
        if (!todoClosed(todo)) onMoveKanban(todo, { starred: true });
        break;
      case "done":
        onMoveKanban(todo, { status: "done" });
        break;
    }
  };

  const columnLabels: Record<KanbanColumnKey, string> = {
    unsorted: t("todo.pool_title"),
    near: t("todo.kanban_near"),
    star: t("todo.kanban_star"),
    done: t("memory_manager.todo_done"),
  };

  const handleToggleStar = (todo: TodoItem) => {
    onMoveKanban(todo, { starred: !todo.starred });
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Board toolbar: the 已完成 toggle sits on the far left, i.e. right of
          the app's navigation sidebar. */}
      <div className="flex items-center px-4 pb-1">
        <button
          onClick={() => setShowDone((prev) => !prev)}
          className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs transition-colors ${
            showDone
              ? "border-border/50 bg-muted/40 text-foreground"
              : "border-border/40 bg-muted/20 text-muted-foreground hover:text-foreground"
          }`}
          title={t("todo.kanban_show_done")}
          aria-pressed={showDone}
        >
          {columnLabels.done}
          {doneCount > 0 && (
            <span className="rounded-full bg-muted px-1.5 text-3xs tabular-nums">{doneCount}</span>
          )}
        </button>
      </div>

      <div className="flex min-h-0 flex-1 gap-3 px-4 pb-3">
        {KANBAN_COLUMNS.map(({ key, optional }) => {
          if (optional && !showDone) return null;
          const isDone = key === "done";
          const items = columns.get(key)!;
          return (
            <KanbanColumn
              key={key}
              columnKey={key}
              label={columnLabels[key]}
              count={items.length}
              muted={isDone}
              fixedWidth={isDone}
              isDropTarget={overColumn === key}
              hint={key === "unsorted" ? t("todo.pool_hint") : undefined}
              onDragOver={(e) => {
                e.preventDefault();
                if (overColumn !== key) setOverColumn(key);
              }}
              onDragLeave={() => setOverColumn((prev) => (prev === key ? null : prev))}
              onDrop={(e) => {
                e.preventDefault();
                handleDrop(key);
              }}
            >
              {items.map((todo) => (
                <KanbanCard
                  key={todo.id}
                  todo={todo}
                  active={selectedId === todo.id}
                  dragging={draggingId === todo.id}
                  onSelect={() => onSelect(todo.id)}
                  onToggle={() => onToggle(todo.id)}
                  onToggleStar={() => handleToggleStar(todo)}
                  onDragStart={() => setDraggingId(todo.id)}
                  onDragEnd={() => {
                    setDraggingId(null);
                    setOverColumn(null);
                  }}
                />
              ))}
            </KanbanColumn>
          );
        })}
      </div>

      {pendingMove && (
        <MoveDateDialog
          todo={pendingMove}
          onCancel={() => setPendingMove(null)}
          onConfirm={(dateValue) => {
            const todo = pendingMove;
            setPendingMove(null);
            onMoveKanban(todo, {
              status: todoClosed(todo) ? "open" : undefined,
              dueDate: rebaseDate(todo, dateValue),
              starred: false,
            });
          }}
        />
      )}
    </div>
  );
}
