"use client";

import { useMemo } from "react";
import { useTranslation } from "@lynse/core/i18n/react";
import { type TodoItem, todoClosed } from "./todo-api";
import { compareTodos, type KanbanMoveTarget } from "./kanban";
import { isOverdueTodo } from "./grouping";
import { GroupSection, TodoItemCard } from "./todo-card";
import { TodoCardContextMenu } from "./card-context-menu";

/**
 * Owner view — the meeting-follow-up lens ("谁的事还没做完"). Groups open
 * todos by their owner label; meeting extraction fills owner with speaker
 * labels, and unlike the kanban (which hides the anonymous ones as chips)
 * this view is exactly where they become the organizing axis. Closed todos
 * are excluded — the question the view answers is about outstanding work,
 * not history.
 *
 * Read-only surface by design: the kanban stays the triage/DnD board, this
 * view selects, toggles and renames.
 */
export function TodoOwnerView({
  todos,
  selectedId,
  onSelect,
  onToggle,
  onRename,
  onDelete,
  onMoveKanban,
  onExport,
  onOpenSource,
}: {
  todos: TodoItem[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onToggle: (id: string) => void;
  onRename: (todo: TodoItem, title: string) => void;
  onDelete: (id: string) => void;
  onMoveKanban: (todo: TodoItem, target: KanbanMoveTarget) => void;
  onExport: (todo: TodoItem) => void;
  onOpenSource: (todo: TodoItem) => void;
}) {
  const { t } = useTranslation();

  const sections = useMemo(() => {
    const open = todos.filter((todo) => !todoClosed(todo));
    const map = new Map<string, TodoItem[]>();
    for (const todo of open) {
      const key = todo.owner?.trim() || "";
      const list = map.get(key);
      if (list) list.push(todo);
      else map.set(key, [todo]);
    }
    const groups = Array.from(map.entries()).map(([owner, items]) => ({
      owner,
      label: owner || t("todo.owner_none"),
      items: [...items].sort(compareTodos),
    }));
    // Owners with overdue work first, then a stable name order.
    groups.sort((a, b) => {
      const aOverdue = a.items.some(isOverdueTodo) ? 0 : 1;
      const bOverdue = b.items.some(isOverdueTodo) ? 0 : 1;
      if (aOverdue !== bOverdue) return aOverdue - bOverdue;
      return a.label.localeCompare(b.label, "zh-CN");
    });
    return groups;
  }, [todos, t]);

  if (sections.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-center">
        <p className="text-sm font-medium text-foreground">{t("todo.empty")}</p>
        <p className="mt-1 text-xs text-muted-foreground">{t("todo.empty_hint")}</p>
      </div>
    );
  }

  return (
    <div className="@container flex-1 min-h-0 overflow-y-auto overscroll-contain [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      {sections.map((section) => (
        <GroupSection
          key={section.owner || "(none)"}
          label={section.label}
          count={section.items.length}
        >
          <div className="grid grid-cols-1 gap-2 @min-[24rem]:grid-cols-2 @min-[72rem]:grid-cols-3">
            {section.items.map((todo) => (
              <TodoCardContextMenu
                key={todo.id}
                todo={todo}
                onEdit={() => onSelect(todo.id)}
                onToggle={() => onToggle(todo.id)}
                onDelete={() => onDelete(todo.id)}
                onMoveKanban={onMoveKanban}
                onExport={onExport}
                onOpenSource={todo.sourceRef || todo.sourceFileId ? () => onOpenSource(todo) : undefined}
              >
                <TodoItemCard
                  todo={todo}
                  active={selectedId === todo.id}
                  overdue={isOverdueTodo(todo)}
                  onSelect={() => onSelect(todo.id)}
                  onToggle={() => onToggle(todo.id)}
                  onRename={onRename}
                />
              </TodoCardContextMenu>
            ))}
          </div>
        </GroupSection>
      ))}
    </div>
  );
}
