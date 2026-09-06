"use client";

import { useMemo, type ReactNode } from "react";
import { cn } from "@lynse/ui/lib/utils";
import { useTranslation } from "@lynse/core/i18n/react";
import { useNotes } from "../workspace/hooks/use-files";
import { useTodos } from "../todo/use-todos";
import { CalendarDays, Mic, ListChecks } from "../icons";

/* ── Layout constants ────────────────────────────────────
 * The dropdown is w-72 (288px) with px-4 padding → 256px usable.
 * 18 columns at 10px + 3px gaps = 18*10 + 17*3 = 231px, which leaves
 * room for the month label row above without clipping. */
const WEEKS = 18;
const CELL = 10;
const GAP = 3;
const GRID_WIDTH = WEEKS * CELL + (WEEKS - 1) * GAP;

/** Fill intensity steps; index 0 is "no activity that day". */
const LEVEL_CLASS = [
  "bg-muted-foreground/10",
  "bg-primary/25",
  "bg-primary/45",
  "bg-primary/70",
  "bg-primary",
];

interface Cell {
  date: Date;
  /** Local-time `YYYY-MM-DD` bucket key. */
  key: string;
  /** Days after today — rendered as empty placeholders. */
  future: boolean;
}

function startOfToday(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

function addDays(base: Date, days: number): Date {
  const d = new Date(base);
  d.setDate(d.getDate() + days);
  return d;
}

/** Local-time day bucket. Returns null for empty/unparseable timestamps. */
function toDayKey(value: string | Date): string | null {
  const d = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(d.getTime())) return null;
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** 0 = empty, 1..4 = intensity, scaled against the busiest day in range. */
function levelOf(count: number, max: number): number {
  if (count <= 0 || max <= 0) return 0;
  return Math.min(4, Math.max(1, Math.ceil((count / max) * 4)));
}

/**
 * Notes-activity heatmap for the user profile dropdown.
 *
 * A GitHub-style contribution grid where every cell is a day and the fill
 * intensity is that day's meeting count, followed by three headline stats:
 * today's meetings, total recordings and total to-dos.
 *
 * Data is pulled from the same sources the Notes page renders, so the numbers
 * always agree with what the user sees there:
 * - meetings/recordings → `useNotes` (cloud `timeRange/list` + local records)
 * - to-dos              → `useTodos` (cloud + desktop-local store)
 *
 * `enabled` gates every request: the parent passes the dropdown's open state so
 * nothing is fetched until the user actually opens the menu.
 */
export function UserActivityHeatmap({ enabled = true }: { enabled?: boolean }) {
  const { t, i18n } = useTranslation();

  // Stable for the session — a bare `new Date()` in the query key would miss
  // the cache and refetch on every render.
  const endTime = useMemo(() => {
    const d = new Date();
    d.setHours(23, 59, 59, 0);
    const p = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  }, []);

  const { data: notes, isLoading: notesLoading } = useNotes({
    // Wide range → effectively "all my meetings"; the grid window is applied
    // client-side so the totals below are true all-time numbers.
    startTime: "2020-01-01T00:00:00",
    endTime,
    enabled,
  });
  const { todos, loading: todosLoading } = useTodos({ enabled });

  /* ── Grid skeleton: WEEKS columns × 7 rows, weeks starting Sunday ── */
  const columns = useMemo<Cell[][]>(() => {
    const today = startOfToday();
    // End on the Saturday of the current week so the last column is complete.
    const end = addDays(today, 6 - today.getDay());
    const start = addDays(end, -(WEEKS * 7 - 1));
    const cols: Cell[][] = [];
    for (let w = 0; w < WEEKS; w++) {
      const col: Cell[] = [];
      for (let d = 0; d < 7; d++) {
        const date = addDays(start, w * 7 + d);
        col.push({
          date,
          key: toDayKey(date) ?? "",
          future: date.getTime() > today.getTime(),
        });
      }
      cols.push(col);
    }
    return cols;
  }, []);

  /* ── Meeting count per day ─────────────────────────────── */
  const countsByDay = useMemo(() => {
    const map = new Map<string, number>();
    for (const item of notes ?? []) {
      const key = toDayKey(item.createdAt);
      if (!key) continue;
      map.set(key, (map.get(key) ?? 0) + 1);
    }
    return map;
  }, [notes]);

  const maxPerDay = useMemo(() => {
    let max = 0;
    for (const col of columns) {
      for (const cell of col) {
        if (cell.future) continue;
        const c = countsByDay.get(cell.key) ?? 0;
        if (c > max) max = c;
      }
    }
    return max;
  }, [columns, countsByDay]);

  /* ── Month labels above the grid ───────────────────────── */
  const monthLabels = useMemo(() => {
    const fmt = new Intl.DateTimeFormat(i18n.language, { month: "short" });
    const labels: { left: number; label: string }[] = [];
    let lastMonth = -1;
    for (let i = 0; i < columns.length; i++) {
      const first = columns[i]?.[0];
      if (!first) continue;
      if (first.date.getMonth() === lastMonth) continue;
      lastMonth = first.date.getMonth();
      // Skip the very last column: its label would overflow the grid.
      if (i <= columns.length - 2) {
        labels.push({ left: i * (CELL + GAP), label: fmt.format(first.date) });
      }
    }
    return labels;
  }, [columns, i18n.language]);

  /* ── Headline stats ────────────────────────────────────── */
  const todayCount = countsByDay.get(toDayKey(new Date()) ?? "") ?? 0;
  const recordingsTotal = notes?.length ?? 0;
  const todosTotal = todos.length;
  const todosOpen = useMemo(() => todos.filter((item) => !item.completed).length, [todos]);

  const dateFmt = useMemo(
    () => new Intl.DateTimeFormat(i18n.language, { month: "short", day: "numeric" }),
    [i18n.language],
  );

  const loading = notesLoading || todosLoading;

  return (
    <div className="px-4 pb-3 pt-1">
      {/* ── Header ───────────────────────────────────────── */}
      <div className="mb-2 flex items-baseline justify-between">
        <span className="text-xs font-medium text-muted-foreground">
          {t("layout.activity_title")}
        </span>
        <span className="text-3xs tabular-nums text-muted-foreground/70">
          {t("layout.activity_range", { weeks: WEEKS })}
        </span>
      </div>

      {loading ? (
        <div className="animate-pulse">
          <div className="mx-auto mb-1 h-2 w-20 rounded bg-muted-foreground/10" />
          <div
            className="mx-auto rounded-md bg-muted-foreground/10"
            style={{ width: GRID_WIDTH, height: 7 * CELL + 6 * GAP }}
          />
        </div>
      ) : (
        <>
          {/* ── Month label row ────────────────────────────── */}
          <div className="relative mx-auto mb-0.5 h-3" style={{ width: GRID_WIDTH }}>
            {monthLabels.map((m) => (
              <span
                key={`${m.left}-${m.label}`}
                className="absolute top-0 text-3xs leading-3 text-muted-foreground"
                style={{ left: m.left }}
              >
                {m.label}
              </span>
            ))}
          </div>

          {/* ── Grid: 7 rows (Sun→Sat), one column per week ── */}
          <div
            className="mx-auto grid grid-rows-7 grid-flow-col gap-[3px]"
            style={{ width: GRID_WIDTH }}
          >
            {columns.map((col, w) =>
              col.map((cell, d) => {
                const count = cell.future ? 0 : (countsByDay.get(cell.key) ?? 0);
                const level = levelOf(count, maxPerDay);
                return (
                  <div
                    key={`${w}-${d}`}
                    className={cn(
                      "size-[10px] rounded-[2px] ring-1 ring-transparent transition-shadow hover:ring-foreground/30",
                      cell.future ? "bg-transparent" : LEVEL_CLASS[level],
                    )}
                    title={
                      cell.future
                        ? undefined
                        : `${dateFmt.format(cell.date)} · ${
                            count > 0
                              ? t("layout.activity_meeting_count", { n: count })
                              : t("layout.activity_no_meetings")
                          }`
                    }
                  />
                );
              }),
            )}
          </div>

          {/* ── Legend removed: the 5-step color ramp is self-explanatory ── */}
        </>
      )}

      {/* ── Stats ──────────────────────────────────────────── */}
      <div className="mt-2.5 grid grid-cols-3 gap-1 px-1 py-1.5">
        <Stat
          icon={<CalendarDays className="size-3" />}
          value={loading ? "—" : String(todayCount)}
          label={t("layout.activity_today_meetings")}
        />
        <Stat
          icon={<Mic className="size-3" />}
          value={loading ? "—" : String(recordingsTotal)}
          label={t("layout.activity_recordings_total")}
        />
        <Stat
          icon={<ListChecks className="size-3" />}
          value={loading ? "—" : String(todosTotal)}
          label={t("layout.activity_todos_total")}
          title={t("layout.activity_todo_detail", { open: todosOpen, total: todosTotal })}
        />
      </div>
    </div>
  );
}

function Stat({
  icon,
  value,
  label,
  title,
}: {
  icon: ReactNode;
  value: string;
  label: string;
  title?: string;
}) {
  return (
    <div className="flex min-w-0 flex-col items-center gap-0.5" title={title}>
      <span className="flex items-center gap-1 text-muted-foreground">
        {icon}
        <span className="text-13 font-semibold tabular-nums text-foreground">{value}</span>
      </span>
      {/* 10px + full muted contrast: this dropdown rides on the native
          vibrancy material, where tiny low-contrast text falls apart. */}
      <span className="w-full truncate text-center text-3xs leading-tight text-muted-foreground">
        {label}
      </span>
    </div>
  );
}
