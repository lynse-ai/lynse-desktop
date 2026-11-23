"use client";

import { useMemo, useState } from "react";
import { Calendar, Check, CheckCircle2, Clock, Inbox, Star, User, X } from "../icons";
import { useTranslation } from "@lynse/core/i18n/react";
import {
  type TodoItem,
  todoClosed,
} from "./todo-api";
import { formatDueDisplay, isOverdueTodo } from "./grouping";
import {
  KANBAN_COLUMNS,
  isGenericOwner,
  kanbanColumnFor,
  kanbanColumns,
  type KanbanColumnKey,
  type KanbanMoveTarget,
} from "./kanban";
import { MoveDateDialog, rebaseDate } from "./move-date-dialog";
import { TodoCardContextMenu } from "./card-context-menu";

/**
 * Kanban board view of the todo page — a triage workflow: 未整理 (no date
 * yet), 近期任务 (carries a due date), and the 重点追踪 starred watchlist.
 * 已完成 exists but is hidden behind a toolbar toggle. Native HTML5 drag &
 * drop between columns; dropping on 近期任务 always pops the date dialog so
 * the move lands on a concrete day; the card's star icon files it into
 * 重点追踪 with one click. Clicking a card opens the shared edit sidebar via
 * `onSelect`; right-clicking opens the shared card context menu.
 */

const EMPTY_STATE_CONFIG: Record<
  KanbanColumnKey,
  {
    icon: typeof Inbox;
    titleKey: string;
    descKey: string;
    iconClass: string;
  }
> = {
  unsorted: {
    icon: Inbox,
    titleKey: "todo.kanban_empty_unsorted",
    descKey: "todo.kanban_empty_unsorted_desc",
    iconClass: "text-muted-foreground",
  },
  near: {
    icon: Clock,
    titleKey: "todo.kanban_empty_near",
    descKey: "todo.kanban_empty_near_desc",
    iconClass: "text-sky-500",
  },
  star: {
    icon: Star,
    titleKey: "todo.kanban_empty_star",
    descKey: "todo.kanban_empty_star_desc",
    iconClass: "text-warning fill-warning/30",
  },
  done: {
    icon: CheckCircle2,
    titleKey: "todo.kanban_empty_done",
    descKey: "todo.kanban_empty_done_desc",
    iconClass: "text-emerald-500",
  },
};

const COLUMN_ICONS: Record<KanbanColumnKey, React.ComponentType<{ className?: string }>> = {
  unsorted: Inbox,
  near: Clock,
  star: Star,
  done: CheckCircle2,
};

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
      className={`group flex cursor-pointer flex-col gap-2 rounded-lg border bg-card/75 p-3 text-left shadow-2xs transition-all duration-150 ${
        active
          ? "border-primary/50 bg-accent/40 ring-1 ring-primary/25 shadow-xs"
          : "border-border/50 hover:border-border hover:bg-card hover:shadow-xs"
      } ${dragging ? "scale-98 opacity-30" : ""}`}
    >
      <div className="flex items-start gap-2.5">
        <button
          type="button"
          role="checkbox"
          aria-checked={todo.completed}
          onClick={(e) => {
            e.stopPropagation();
            onToggle();
          }}
          className={`mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-[5px] border transition-all duration-150 ${
            todo.completed
              ? "border-primary bg-primary text-primary-foreground shadow-2xs"
              : "border-border/80 bg-background/50 hover:border-primary/60 hover:bg-primary/5 active:scale-90"
          }`}
          aria-label={t("todo.completed_toggle")}
        >
          {todo.completed && <Check className="size-2.5 stroke-[3]" />}
        </button>

        <span
          className={`line-clamp-2 min-w-0 flex-1 text-[13px] leading-snug font-medium ${
            closed ? "text-muted-foreground/60 line-through" : "text-foreground/90"
          }`}
        >
          {todo.title}
        </span>

        {/* Star = file into 重点追踪. One click, no dialog; clicking again
            returns the card to its date-based column. */}
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onToggleStar();
          }}
          className="-m-1 shrink-0 rounded p-1 text-muted-foreground/35 transition-colors hover:bg-accent/60 hover:text-warning"
          aria-label={t("todo.star_toggle")}
          aria-pressed={Boolean(todo.starred)}
          title={todo.starred ? t("todo.unstar_toggle") : t("todo.star_toggle")}
        >
          <Star
            className={`size-3.5 transition-transform active:scale-125 ${
              todo.starred
                ? "fill-warning text-warning"
                : "hover:text-warning"
            }`}
          />
        </button>
      </div>

      {(dueText || owner) && (
        <div className="flex flex-wrap items-center gap-1.5 text-3xs text-muted-foreground">
          {dueText && (
            <span
              className={`inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 font-medium tabular-nums ${
                overdue && !closed
                  ? "border border-destructive/25 bg-destructive/10 text-destructive/90"
                  : "border border-border/30 bg-muted/40 text-muted-foreground"
              }`}
            >
              <Calendar className="size-2.5 shrink-0" />
              {dueText}
            </span>
          )}
          {owner && (
            <span
              className="inline-flex min-w-0 items-center gap-1 rounded-md border border-border/30 bg-muted/40 px-1.5 py-0.5 text-muted-foreground"
              title={owner}
            >
              <User className="size-2.5 shrink-0 text-muted-foreground/70" />
              <span className="truncate max-w-28">{owner}</span>
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
  onClose,
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
  onClose?: () => void;
  children: React.ReactNode;
  onDragOver: (e: React.DragEvent) => void;
  onDragLeave: () => void;
  onDrop: (e: React.DragEvent) => void;
}) {
  const { t } = useTranslation();
  const Icon = COLUMN_ICONS[columnKey];
  const empty = EMPTY_STATE_CONFIG[columnKey];
  const EmptyIcon = empty.icon;

  return (
    <div
      data-column={columnKey}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      className={`flex min-h-0 min-w-0 flex-col rounded-xl border transition-colors ${
        fixedWidth ? "w-64 flex-none" : "flex-1"
      } ${
        isDropTarget
          ? "border-primary/50 bg-primary/5 ring-1 ring-primary/20"
          : muted
            ? "border-border/40 bg-muted/20"
            : "border-border/40 bg-card/30"
      }`}
    >
      <div className="flex items-center justify-between border-b border-border/40 px-3.5 py-2.5">
        <div className="flex items-center gap-2">
          <Icon
            className={`size-3.5 ${
              columnKey === "star"
                ? "text-warning fill-warning/20"
                : columnKey === "done"
                  ? "text-emerald-500/80"
                  : "text-muted-foreground"
            }`}
          />
          <span className={`text-xs font-semibold tracking-tight ${muted ? "text-muted-foreground" : "text-foreground"}`}>
            {label}
          </span>
          <span className="rounded-full border border-border/30 bg-muted/60 px-1.5 py-0.2 text-3xs font-medium tabular-nums text-muted-foreground">
            {count}
          </span>
        </div>
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            className="rounded p-0.5 text-muted-foreground/60 transition-colors hover:bg-accent/50 hover:text-foreground"
            title={t("todo.kanban_hide_done")}
          >
            <X className="size-3" />
          </button>
        )}
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto overscroll-contain p-2.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {children}
        {count === 0 && (
          <div className="flex flex-1 flex-col items-center justify-center rounded-lg border border-dashed border-border/40 p-4 text-center">
            <div className={`mb-2 flex size-8 items-center justify-center rounded-full bg-muted/40 ${empty.iconClass}`}>
              <EmptyIcon className="size-4" />
            </div>
            <p className="text-xs font-medium text-muted-foreground/80">{t(empty.titleKey)}</p>
            <p className="mt-1 max-w-44 text-3xs leading-relaxed text-muted-foreground/50">{t(empty.descKey)}</p>
          </div>
        )}
      </div>
    </div>
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
  showDone: controlledShowDone,
  onToggleShowDone,
  onSelect,
  onToggle,
  onMoveKanban,
  onDelete,
  onExport,
  onOpenSource,
}: {
  todos: TodoItem[];
  selectedId: string | null;
  showDone?: boolean;
  onToggleShowDone?: () => void;
  onSelect: (id: string) => void;
  onToggle: (id: string) => void;
  onMoveKanban: (todo: TodoItem, target: KanbanMoveTarget) => void;
  /** Card context menu actions — see TodoCardContextMenu. */
  onDelete: (id: string) => void;
  /** Present when connections are enabled; per-card export gating happens in the menu. */
  onExport?: (todo: TodoItem) => void;
  /** Present only when the todo carries a resolvable source note. */
  onOpenSource?: (todo: TodoItem) => void;
}) {
  const { t } = useTranslation();
  const columns = useMemo(() => kanbanColumns(todos), [todos]);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [overColumn, setOverColumn] = useState<KanbanColumnKey | null>(null);
  // 已完成 is hidden by default — the board is about what's ahead.
  const [internalShowDone, setInternalShowDone] = useState(false);
  const isControlled = controlledShowDone !== undefined;
  const showDone = isControlled ? controlledShowDone : internalShowDone;
  const [pendingMove, setPendingMove] = useState<TodoItem | null>(null);

  const doneCount = columns.get("done")!.length;

  const handleToggleDone = () => {
    if (onToggleShowDone) {
      onToggleShowDone();
    } else {
      setInternalShowDone((prev) => !prev);
    }
  };

  const handleCloseDone = () => {
    if (onToggleShowDone && showDone) {
      onToggleShowDone();
    } else {
      setInternalShowDone(false);
    }
  };

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
      {/* Fallback toolbar: only rendered when showDone is NOT controlled externally */}
      {!isControlled && (
        <div className="flex items-center justify-end px-6 pb-2">
          <button
            onClick={handleToggleDone}
            className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs font-medium transition-colors ${
              showDone
                ? "border-primary/40 bg-primary/10 text-primary"
                : "border-border/60 bg-muted/30 text-muted-foreground hover:bg-muted/60 hover:text-foreground"
            }`}
            title={showDone ? t("todo.kanban_hide_done") : t("todo.kanban_show_done")}
            aria-pressed={showDone}
          >
            <CheckCircle2 className="size-3.5" />
            <span>{showDone ? t("todo.kanban_hide_done") : t("todo.kanban_show_done")}</span>
            {doneCount > 0 && (
              <span className="rounded-full bg-muted/80 px-1.5 py-0.2 text-3xs font-medium tabular-nums text-muted-foreground">
                {doneCount}
              </span>
            )}
          </button>
        </div>
      )}

      <div className="flex min-h-0 flex-1 gap-3 px-6 pb-4">
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
              onClose={isDone ? handleCloseDone : undefined}
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
                <TodoCardContextMenu
                  key={todo.id}
                  todo={todo}
                  onEdit={() => onSelect(todo.id)}
                  onToggle={() => onToggle(todo.id)}
                  onDelete={() => onDelete(todo.id)}
                  onMoveKanban={onMoveKanban}
                  onExport={onExport}
                  onOpenSource={onOpenSource ? () => onOpenSource(todo) : undefined}
                >
                  <KanbanCard
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
                </TodoCardContextMenu>
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
