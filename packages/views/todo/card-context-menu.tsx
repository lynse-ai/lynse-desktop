"use client";

import { useState } from "react";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@lynse/ui/components/ui/context-menu";
import { useTranslation } from "@lynse/core/i18n/react";
import { Check, FileText, FolderOpen, Pencil, Star, Trash2, Upload, Undo } from "../icons";
import { isConnectionsEnabled } from "../feature-flags";
import { type TodoItem, todoClosed } from "./todo-api";
import { kanbanColumnFor, type KanbanMoveTarget } from "./kanban";
import { MoveDateDialog, rebaseDate } from "./move-date-dialog";

/**
 * Right-click menu shared by every todo card (list grid + kanban board).
 * Items: edit (opens the sidebar panel), completion toggle, move-to-column
 * submenu, source note, export (cloud todos only), delete.
 *
 * Export stays gated on the card being a cloud todo (`backend`) — the export
 * contract keys items by their cloud id and local todos have none. The move
 * entries mirror the kanban drag rules: closed cards can't be parked into
 * 未整理, 近期任务 always asks for a concrete day via MoveDateDialog.
 */
export function TodoCardContextMenu({
  todo,
  onEdit,
  onToggle,
  onDelete,
  onMoveKanban,
  onExport,
  onOpenSource,
  children,
}: {
  todo: TodoItem;
  /** Open the shared edit sidebar for this card. */
  onEdit: () => void;
  /** Flip completion — same store entry the checkbox toggles. */
  onToggle: () => void;
  onDelete: () => void;
  onMoveKanban: (todo: TodoItem, target: KanbanMoveTarget) => void;
  /** Present when connections are enabled; the item hides for local todos. */
  onExport?: (todo: TodoItem) => void;
  /** Present only when the todo carries a resolvable source note. */
  onOpenSource?: () => void;
  children: React.ReactNode;
}) {
  const { t } = useTranslation();
  const closed = todoClosed(todo);
  const currentColumn = kanbanColumnFor(todo);
  const [pickingDate, setPickingDate] = useState(false);
  const exportable = Boolean(onExport && todo.backend && isConnectionsEnabled());

  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger>{children}</ContextMenuTrigger>
        <ContextMenuContent className="min-w-40">
          <ContextMenuItem onClick={onEdit}>
            <Pencil className="size-3.5 text-muted-foreground" strokeWidth={1.5} />
            <span>{t("todo.menu_edit")}</span>
          </ContextMenuItem>
          <ContextMenuItem onClick={onToggle}>
            {closed ? (
              <Undo className="size-3.5 text-muted-foreground" strokeWidth={1.5} />
            ) : (
              <Check className="size-3.5 text-muted-foreground" strokeWidth={1.5} />
            )}
            <span>{t(closed ? "todo.menu_mark_undone" : "todo.menu_mark_done")}</span>
          </ContextMenuItem>

          <ContextMenuSub>
            <ContextMenuSubTrigger>
              <FolderOpen className="size-3.5 text-muted-foreground" strokeWidth={1.5} />
              <span>{t("workspace.move_to")}</span>
            </ContextMenuSubTrigger>
            <ContextMenuSubContent className="max-h-64 overflow-y-auto">
              <ContextMenuItem
                disabled={currentColumn === "unsorted" || closed}
                onClick={() => onMoveKanban(todo, { dueDate: null, starred: false })}
              >
                {t("todo.pool_title")}
              </ContextMenuItem>
              <ContextMenuItem
                disabled={currentColumn === "near"}
                onClick={() => setPickingDate(true)}
              >
                {t("todo.kanban_near")}
              </ContextMenuItem>
              <ContextMenuItem
                onClick={() => onMoveKanban(todo, { starred: !todo.starred })}
              >
                <Star
                  className={`size-3.5 ${todo.starred ? "fill-warning text-warning" : "text-muted-foreground"}`}
                  strokeWidth={1.5}
                />
                <span>{t(todo.starred ? "todo.unstar_toggle" : "todo.kanban_star")}</span>
              </ContextMenuItem>
              <ContextMenuItem
                disabled={currentColumn === "done"}
                onClick={() => onMoveKanban(todo, { status: "done" })}
              >
                {t("memory_manager.todo_done")}
              </ContextMenuItem>
            </ContextMenuSubContent>
          </ContextMenuSub>

          {onOpenSource && (
            <ContextMenuItem onClick={onOpenSource}>
              <FileText className="size-3.5 text-muted-foreground" strokeWidth={1.5} />
              <span>{t("todo.menu_open_source")}</span>
            </ContextMenuItem>
          )}
          {exportable && (
            <ContextMenuItem onClick={() => onExport?.(todo)}>
              <Upload className="size-3.5 text-muted-foreground" strokeWidth={1.5} />
              <span>{t("todo.export_button")}</span>
            </ContextMenuItem>
          )}

          <ContextMenuSeparator />
          <ContextMenuItem variant="destructive" onClick={onDelete}>
            <Trash2 className="size-3.5 text-muted-foreground" strokeWidth={1.5} />
            <span>{t("todo.actions_delete")}</span>
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>

      {pickingDate && (
        <MoveDateDialog
          todo={todo}
          onCancel={() => setPickingDate(false)}
          onConfirm={(dateValue) => {
            setPickingDate(false);
            onMoveKanban(todo, {
              status: closed ? "open" : undefined,
              dueDate: rebaseDate(todo, dateValue),
              starred: false,
            });
          }}
        />
      )}
    </>
  );
}
