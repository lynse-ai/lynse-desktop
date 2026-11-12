"use client";

import { useMemo, useState } from "react";
import { useTranslation } from "@lynse/core/i18n/react";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@lynse/ui/components/ui/dialog";
import { Button } from "@lynse/ui/components/ui/button";
import { type TodoItem } from "./todo-api";
import { dayKey, startOfLocalDay } from "./grouping";
import { MonthCalendarGrid, quickDateTargets } from "./date-time-picker";

/** yyyy-MM-dd with the todo's existing time-of-day preserved (if any). */
export function rebaseDate(todo: TodoItem, key: string): string {
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

/**
 * Drop follow-up for 近期任务: pick the concrete day the task moves to.
 * Quick slots (今天/明天/下周末/下周) prefill the selection; the month grid
 * picks anything else; 确认 commits — cancelling abandons the move entirely.
 * Shared by the kanban drag flow and the card context menu's 近期任务 entry.
 */
export function MoveDateDialog({
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
