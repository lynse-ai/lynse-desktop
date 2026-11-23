"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Calendar, User, Check } from "../icons";
import { useTranslation } from "@lynse/core/i18n/react";
import { useNavigation } from "../navigation";
import { useWorkbench } from "../workbench";
import { getWorkspaceState } from "../workspace/store";
import { type TodoItem, todoClosed, todoStatus } from "./todo-api";
import { formatDueDisplay } from "./grouping";

/**
 * Card-level primitives shared by the todo page's list view and the owner
 * view: one todo as a card in the responsive grid, the section header that
 * groups them, and the source-note jump both rely on. Extracted from
 * page.tsx so the owner view reuses the exact same card without a
 * page ↔ view import cycle.
 */

/** True when the todo carries a resolvable extraction source. */
export function hasTodoSource(todo: TodoItem): boolean {
  return Boolean(todo.sourceRef || todo.sourceFileId);
}

/**
 * Jump to the note a todo was extracted from. Capture-sheet todos carry a
 * workbench sourceRef; cloud ones only a fileId whose display title was
 * resolved against the notes list on load. Returns false when there is
 * nothing to open — callers keep their chip hidden in that case.
 */
export function openTodoSource(todo: TodoItem, push: (path: string) => void): boolean {
  if (todo.sourceRef) {
    useWorkbench.getState().showSource(todo.sourceRef);
    return true;
  }
  if (todo.sourceFileId) {
    getWorkspaceState().selectItem(todo.sourceFileId, "meeting", todo.sourceTitle);
    push("/notes");
    return true;
  }
  return false;
}

/**
 * One todo as a card in the responsive grid. A plain div with role=button so
 * the source chip (a real button), the checkbox and the inline title
 * editor can nest inside without invalid button-in-button markup.
 *
 * The title edits in place on double-click (same entry point as the edit
 * panel; both persist through saveTodo).
 */
export function TodoItemCard({
  todo,
  active,
  overdue = false,
  onSelect,
  onToggle,
  onRename,
}: {
  todo: TodoItem;
  active: boolean;
  /** Set for the overdue section — the due date renders in danger color. */
  overdue?: boolean;
  onSelect: () => void;
  onToggle: () => void;
  /** Persist a new title (optimistic patch + saveTodo). */
  onRename: (todo: TodoItem, title: string) => void;
}) {
  const { t } = useTranslation();
  const navigate = useNavigation();
  const dueText = formatDueDisplay(todo);
  const closed = todoClosed(todo);

  // ── Inline title editing ──
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(todo.title);
  // Set when Escape backs out, so the blur-triggered commit keeps the old title.
  const skipCommitRef = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Follow store-side title changes (edit panel saves) while not editing.
  useEffect(() => {
    if (!editing) setDraft(todo.title);
  }, [todo.title, editing]);

  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  const startEdit = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setDraft(todo.title);
    skipCommitRef.current = false;
    setEditing(true);
  }, [todo.title]);

  const commitEdit = useCallback(() => {
    setEditing(false);
    if (skipCommitRef.current) {
      skipCommitRef.current = false;
      setDraft(todo.title);
      return;
    }
    const trimmed = draft.trim();
    if (trimmed && trimmed !== todo.title) onRename(todo, trimmed);
  }, [draft, todo, onRename]);

  const handleSourceClick = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      openTodoSource(todo, (path) => navigate.push(path));
    },
    [todo, navigate],
  );

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect();
        }
      }}
      className={`flex cursor-pointer flex-col gap-2 rounded-xl border p-3 text-left transition-colors ${
        active
          ? "border-ring/40 bg-accent/50"
          : "border-border/60 bg-card/40 hover:border-ring/40 hover:bg-accent/30"
      }`}
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
        {editing ? (
          <input
            ref={inputRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commitEdit}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Enter") {
                e.preventDefault();
                inputRef.current?.blur();
              } else if (e.key === "Escape") {
                skipCommitRef.current = true;
                inputRef.current?.blur();
              }
            }}
            className="mt-px min-w-0 flex-1 rounded-md bg-muted/50 px-1 py-0.5 text-sm leading-snug text-foreground outline-none focus:ring-2 focus:ring-ring/30"
            aria-label={t("todo.rename_hint")}
          />
        ) : (
          <span
            onDoubleClick={startEdit}
            title={t("todo.rename_hint")}
            className={`line-clamp-2 min-w-0 flex-1 cursor-text text-sm leading-snug ${
              closed ? "line-through text-muted-foreground" : "text-foreground"
            }`}
          >
            {todo.title}
          </span>
        )}
      </div>

      {/* Meta chips: date + owner pinned to one line, source and status follow. */}
      <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
        <span className="flex min-w-0 items-center gap-1.5">
          {dueText && (
            <span
              className={`inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-3xs font-medium tabular-nums ${
                overdue && !closed
                  ? "border border-destructive/25 bg-destructive/10 text-destructive/90"
                  : "border border-border/30 bg-muted/40 text-muted-foreground"
              }`}
            >
              <Calendar className="size-2.5 shrink-0" />
              {dueText}
            </span>
          )}
          {todo.owner && (
            <span
              className="inline-flex min-w-0 items-center gap-1 rounded-md border border-border/30 bg-muted/40 px-1.5 py-0.5 text-3xs"
              title={todo.owner}
            >
              <User className="size-2.5 shrink-0 text-muted-foreground/70" />
              <span className="truncate max-w-28">{todo.owner}</span>
            </span>
          )}
        </span>
        {hasTodoSource(todo) && (
          <button
            type="button"
            onClick={handleSourceClick}
            title={`${t("todo.source_from")}${todo.sourceTitle ?? t("todo.source_note")}`}
            className="inline-flex max-w-full items-center truncate rounded-full bg-muted/60 px-2 py-0.5 text-left underline-offset-2 transition-colors hover:bg-accent hover:text-foreground hover:underline"
          >
            {t("todo.source_from")}{todo.sourceTitle ?? t("todo.source_note")}
          </button>
        )}
        {todo.status && (
          <span className="shrink-0 rounded-full bg-muted/60 px-2 py-0.5">
            {t(`memory_manager.todo_${todoStatus(todo)}`)}
          </span>
        )}
        {!todo.calendarEventId && (
          <Calendar className="ml-auto size-3.5 shrink-0 text-muted-foreground/40" />
        )}
      </div>
    </div>
  );
}

/** Section header grouping a grid of cards (list + owner views). */
export function GroupSection({
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
