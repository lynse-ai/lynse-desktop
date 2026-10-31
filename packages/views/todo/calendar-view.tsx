"use client";

import { useMemo, useState } from "react";
import { ChevronLeft, ChevronRight } from "../icons";
import { useTranslation } from "@lynse/core/i18n/react";
import { type TodoItem, todoClosed } from "./todo-api";
import { dayKey, monthGrid, startOfLocalDay } from "./grouping";

// ── Date helpers (hand-rolled, same style as page.tsx) ─────

function sameLocalDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/** The todo's calendar date, or null when undated (undated ones stay in the list view). */
function todoDate(todo: TodoItem): Date | null {
  const raw = todo.dueDate || todo.calendarStartAt;
  if (!raw) return null;
  const d = new Date(raw);
  return isNaN(d.getTime()) ? null : d;
}

const MAX_DAY_CHIPS = 3;

/**
 * Month-grid view of the todo page. Todos land on the day matching their
 * dueDate/calendarStartAt (same key the list grouping uses); clicking a chip
 * opens the shared edit sidebar via `onSelect`.
 */
export function TodoCalendarView({
  todos,
  selectedId,
  onSelect,
  onToggle,
}: {
  todos: TodoItem[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onToggle: (id: string) => void;
}) {
  const { t, i18n } = useTranslation();
  const [anchor, setAnchor] = useState(() => startOfLocalDay(new Date()));

  const locale = i18n.language || "en";
  const cells = useMemo(() => monthGrid(anchor), [anchor]);
  const byDay = useMemo(() => {
    const map = new Map<string, TodoItem[]>();
    for (const todo of todos) {
      const d = todoDate(todo);
      if (!d) continue;
      const key = dayKey(d);
      const list = map.get(key);
      if (list) list.push(todo);
      else map.set(key, [todo]);
    }
    return map;
  }, [todos]);

  const monthTitle = new Intl.DateTimeFormat(locale, { year: "numeric", month: "long" }).format(anchor);
  // 2023-01-01 was a Sunday — indices 0..6 walk exactly one week.
  const weekdayFormatter = useMemo(
    () => new Intl.DateTimeFormat(locale, { weekday: "short" }),
    [locale],
  );

  const now = startOfLocalDay(new Date());

  const shiftMonth = (delta: number) => {
    setAnchor(new Date(anchor.getFullYear(), anchor.getMonth() + delta, 1));
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Month header */}
      <div className="flex items-center justify-between px-6 pb-1 pt-1">
        <div className="flex items-center">
          <button
            onClick={() => shiftMonth(-1)}
            className="rounded p-1 text-muted-foreground hover:bg-accent/50"
            aria-label={t("todo.cal_prev_month")}
          >
            <ChevronLeft className="size-4" />
          </button>
          <button
            onClick={() => shiftMonth(1)}
            className="rounded p-1 text-muted-foreground hover:bg-accent/50"
            aria-label={t("todo.cal_next_month")}
          >
            <ChevronRight className="size-4" />
          </button>
        </div>
        <span className="text-sm font-medium tabular-nums text-foreground">{monthTitle}</span>
        <button
          onClick={() => setAnchor(startOfLocalDay(new Date()))}
          className="rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-accent/50"
        >
          {t("todo.cal_today")}
        </button>
      </div>

      {/* Weekday header */}
      <div className="grid grid-cols-7 border-b border-border/40">
        {Array.from({ length: 7 }, (_, i) => (
          <div key={i} className="px-1.5 pb-1 text-right text-3xs text-muted-foreground">
            {weekdayFormatter.format(new Date(2023, 0, 1 + i))}
          </div>
        ))}
      </div>

      {/* Month grid */}
      <div className="grid min-h-0 flex-1 grid-cols-7 overflow-y-auto overscroll-contain [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {cells.map((day) => {
          const key = dayKey(day);
          const items = byDay.get(key) ?? [];
          const inMonth = day.getMonth() === anchor.getMonth();
          const isToday = sameLocalDay(day, now);
          const isPast = day < now;
          const visible = items.slice(0, MAX_DAY_CHIPS);
          const overflow = items.length - visible.length;
          return (
            <div
              key={key}
              className={`flex min-h-[72px] flex-col gap-0.5 border-b border-border/40 px-1 py-1 [&:nth-child(7n)]:border-r-0 [&:not(:nth-child(7n))]:border-r ${
                inMonth ? "bg-background" : "bg-muted/20"
              }`}
            >
              <div className="flex justify-end">
                <span
                  className={`inline-flex size-5 items-center justify-center rounded-full text-2xs tabular-nums ${
                    isToday
                      ? "bg-primary font-semibold text-primary-foreground"
                      : inMonth
                        ? "text-muted-foreground"
                        : "text-muted-foreground/40"
                  }`}
                >
                  {day.getDate()}
                </span>
              </div>
              {visible.map((todo) => (
                <button
                  key={todo.id}
                  onClick={() => onSelect(todo.id)}
                  className={`flex w-full items-center gap-1 rounded px-0.5 py-0.5 text-left hover:bg-accent/40 ${
                    selectedId === todo.id ? "bg-accent/60" : ""
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={todo.completed}
                    onChange={(e) => { e.stopPropagation(); onToggle(todo.id); }}
                    onClick={(e) => e.stopPropagation()}
                    className="size-3 shrink-0 rounded border-border accent-primary"
                    aria-label={t("todo.completed_toggle")}
                  />
                  <span
                    className={`truncate text-3xs leading-tight ${
                      todoClosed(todo)
                        ? "text-muted-foreground/60 line-through"
                        : isPast
                          ? "text-destructive"
                          : "text-foreground"
                    }`}
                  >
                    {todo.title}
                  </span>
                </button>
              ))}
              {overflow > 0 && (
                <span className="px-1 text-3xs tabular-nums text-muted-foreground">+{overflow}</span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
