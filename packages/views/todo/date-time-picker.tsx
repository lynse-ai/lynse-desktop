"use client";

import { useEffect, useMemo, useState } from "react";
import { Calendar, ChevronLeft, ChevronRight, Clock } from "../icons";
import { useTranslation } from "@lynse/core/i18n/react";
import { Popover, PopoverContent, PopoverTrigger } from "@lynse/ui/components/ui/popover";
import { dayKey, monthGrid, startOfLocalDay } from "./grouping";

/** Shared trigger style for the empty (add) state of both pickers. */
const TRIGGER_CLASS =
  "flex min-w-0 flex-1 items-center gap-2 rounded-md border border-border/60 bg-transparent px-3 py-2 text-sm text-foreground outline-none transition-colors hover:border-primary/40 hover:bg-accent/30";

/** yyyy-MM-dd → local midnight. Appending T00:00:00 avoids the UTC parse of bare dates. */
function parseDayKey(value: string): Date | null {
  if (!value) return null;
  const d = new Date(`${value}T00:00:00`);
  return isNaN(d.getTime()) ? null : d;
}

function addDays(d: Date, n: number): Date {
  const next = new Date(d);
  next.setDate(d.getDate() + n);
  return next;
}

/**
 * The Reminders quick list: 今天 / 明天 / 下周末 / 下周. 下周 is the coming
 * Monday and 下周末 the Saturday of that week (Monday-based weeks), matching
 * Apple Reminders.
 */
function quickDateTargets(): { key: string; date: Date }[] {
  const start = startOfLocalDay(new Date());
  const nextMonday = addDays(start, 7 - ((start.getDay() + 6) % 7));
  return [
    { key: "today", date: start },
    { key: "tomorrow", date: addDays(start, 1) },
    { key: "weekend", date: addDays(nextMonday, 5) },
    { key: "week", date: nextMonday },
  ];
}

/**
 * Date field styled after Apple Reminders: an "add date" field that opens a
 * quick-pick menu (none / today / tomorrow / next weekend / next week /
 * custom), where custom swaps in the month grid. Once set, the trigger
 * becomes a clearable chip.
 */
export function DatePickerPopover({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const { t, i18n } = useTranslation();
  const [open, setOpen] = useState(false);
  const [custom, setCustom] = useState(false);
  const [anchor, setAnchor] = useState(() => parseDayKey(value) ?? new Date());

  const locale = i18n.language || "en";
  const cells = useMemo(() => monthGrid(anchor), [anchor]);
  const monthTitle = new Intl.DateTimeFormat(locale, { year: "numeric", month: "long" }).format(anchor);
  const weekdayFormatter = useMemo(() => new Intl.DateTimeFormat(locale, { weekday: "short" }), [locale]);
  const chipFormatter = useMemo(() => new Intl.DateTimeFormat(locale, { month: "short", day: "numeric" }), [locale]);
  const dateFormatter = useMemo(
    () => new Intl.DateTimeFormat(locale, { year: "numeric", month: "numeric", day: "numeric" }),
    [locale],
  );

  const todayKey = dayKey(new Date());
  const tomorrowKey = dayKey(addDays(startOfLocalDay(new Date()), 1));
  const chipLabel =
    value === todayKey
      ? t("todo.quick_today")
      : value === tomorrowKey
        ? t("todo.quick_tomorrow")
        : value
          ? chipFormatter.format(parseDayKey(value)!)
          : "";
  const quickLabel = (key: string) =>
    key === "today"
      ? t("todo.quick_today")
      : key === "tomorrow"
        ? t("todo.quick_tomorrow")
        : key === "weekend"
          ? t("todo.quick_next_weekend")
          : t("todo.quick_next_week");

  const pick = (key: string) => {
    onChange(key);
    setCustom(false);
    setOpen(false);
  };

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (next) {
          setAnchor(parseDayKey(value) ?? new Date());
          // Start from the quick menu unless a date is already set.
          if (!value) setCustom(false);
        }
        setOpen(next);
      }}
    >
      <PopoverTrigger className={`${TRIGGER_CLASS}${value ? " border-primary/30 bg-primary/5" : ""}`}>
        <Calendar className={`size-4 shrink-0 ${value ? "text-primary" : "text-muted-foreground"}`} />
        <span
          className={`flex-1 truncate text-left ${value ? "font-medium text-primary" : "text-muted-foreground/70"}`}
        >
          {value ? chipLabel : t("todo.date_add")}
        </span>
      </PopoverTrigger>
      <PopoverContent className="w-auto gap-0 p-1.5" align="start">
        {!custom ? (
          <div className="flex w-60 flex-col">
            <button
              onClick={() => pick("")}
              className="rounded-md px-2 py-1.5 text-left text-sm text-foreground hover:bg-accent/50"
            >
              {t("todo.date_none")}
            </button>
            {quickDateTargets().map(({ key, date }) => {
              const keyStr = dayKey(date);
              return (
                <button
                  key={key}
                  onClick={() => pick(keyStr)}
                  className={`flex items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-accent/50 ${
                    keyStr === value ? "bg-accent/70" : ""
                  }`}
                >
                  <Calendar className="size-4 shrink-0 text-muted-foreground" />
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate text-sm text-foreground">{quickLabel(key)}</span>
                    <span className="text-3xs tabular-nums text-muted-foreground">{dateFormatter.format(date)}</span>
                  </span>
                </button>
              );
            })}
            <div className="my-1 border-t border-border/40" />
            <button
              onClick={() => setCustom(true)}
              className="flex items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-accent/50"
            >
              <Calendar className="size-4 shrink-0 text-muted-foreground" />
              <span className="flex min-w-0 flex-col">
                <span className="truncate text-sm text-foreground">{t("todo.date_custom")}</span>
                <span className="truncate text-3xs text-muted-foreground">{t("todo.date_custom_hint")}</span>
              </span>
            </button>
          </div>
        ) : (
          <div>
            <div className="flex items-center justify-between px-1 pb-1">
              <button
                onClick={() => setAnchor(new Date(anchor.getFullYear(), anchor.getMonth() - 1, 1))}
                className="rounded p-1 text-muted-foreground hover:bg-accent/50"
                aria-label={t("todo.cal_prev_month")}
              >
                <ChevronLeft className="size-4" />
              </button>
              <span className="text-sm font-medium tabular-nums text-foreground">{monthTitle}</span>
              <button
                onClick={() => setAnchor(new Date(anchor.getFullYear(), anchor.getMonth() + 1, 1))}
                className="rounded p-1 text-muted-foreground hover:bg-accent/50"
                aria-label={t("todo.cal_next_month")}
              >
                <ChevronRight className="size-4" />
              </button>
            </div>
            <div className="grid grid-cols-7">
              {Array.from({ length: 7 }, (_, i) => (
                <span key={i} className="flex h-6 w-8 items-center justify-center text-3xs text-muted-foreground">
                  {/* 2023-01-01 was a Sunday — indices 0..6 walk exactly one week. */}
                  {weekdayFormatter.format(new Date(2023, 0, 1 + i))}
                </span>
              ))}
            </div>
            <div className="grid grid-cols-7 gap-y-0.5">
              {cells.map((day) => {
                const key = dayKey(day);
                const selected = key === value;
                const inMonth = day.getMonth() === anchor.getMonth();
                const isToday = key === todayKey;
                return (
                  <button
                    key={key}
                    onClick={() => pick(key)}
                    className={`inline-flex size-8 items-center justify-center rounded-full text-xs tabular-nums transition-colors ${
                      selected
                        ? "bg-primary font-semibold text-primary-foreground"
                        : isToday
                          ? "font-semibold text-primary ring-1 ring-inset ring-primary/50 hover:bg-accent/50"
                          : inMonth
                            ? "text-foreground hover:bg-accent/50"
                            : "text-muted-foreground/40 hover:bg-accent/40"
                    }`}
                  >
                    {day.getDate()}
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}

/** Reminders' suggestion list: fixed clock times with day-part labels. */
const TIME_SUGGESTIONS: { time: string; periodKey: string }[] = [
  { time: "09:00", periodKey: "todo.time_morning" },
  { time: "12:00", periodKey: "todo.time_noon" },
  { time: "15:00", periodKey: "todo.time_afternoon" },
  { time: "18:00", periodKey: "todo.time_evening" },
  { time: "21:00", periodKey: "todo.time_night" },
];

/** Accepts 9:05 / 09:05 … returns canonical HH:mm, or null when malformed. */
function normalizeTime(raw: string): string | null {
  const m = raw.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return `${String(h).padStart(2, "0")}:${m[2]}`;
}

/**
 * Time field styled after Apple Reminders: an "add time" field opening a
 * suggestion menu, and once set, a directly editable chip (type any HH:mm)
 * with a clock button that reopens the menu.
 */
export function TimePickerPopover({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(value);

  // Keep the inline editor in sync when a value is picked from the menu.
  useEffect(() => setDraft(value), [value]);

  const commit = () => {
    const next = normalizeTime(draft);
    if (next) {
      if (next !== value) onChange(next);
    } else {
      setDraft(value);
    }
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <div className={`${TRIGGER_CLASS}${value ? " border-primary/30 bg-primary/5" : ""}`}>
        {value ? (
          <>
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={commit}
              onKeyDown={(e) => {
                if (e.key === "Enter") e.currentTarget.blur();
              }}
              className="min-w-0 flex-1 bg-transparent text-sm font-medium tabular-nums text-primary outline-none"
              aria-label={t("todo.time_add")}
            />
            <PopoverTrigger
              className="shrink-0 rounded p-0.5 text-primary/70 transition-colors hover:bg-accent/50 hover:text-primary"
              aria-label={t("todo.time_add")}
            >
              <Clock className="size-4" />
            </PopoverTrigger>
          </>
        ) : (
          <PopoverTrigger className="flex min-w-0 flex-1 items-center gap-2 text-left">
            <Clock className="size-4 shrink-0 text-muted-foreground" />
            <span className="flex-1 truncate text-muted-foreground/70">{t("todo.time_add")}</span>
          </PopoverTrigger>
        )}
      </div>
      <PopoverContent className="w-auto gap-0 p-1.5" align="start">
        <div className="flex w-52 flex-col">
          <button
            onClick={() => {
              onChange("");
              setOpen(false);
            }}
            className="rounded-md px-2 py-1.5 text-left text-sm text-foreground hover:bg-accent/50"
          >
            {t("todo.time_none")}
          </button>
          {TIME_SUGGESTIONS.map(({ time, periodKey }) => (
            <button
              key={time}
              onClick={() => {
                onChange(time);
                setOpen(false);
              }}
              className={`flex items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-accent/50 ${
                time === value ? "bg-accent/70" : ""
              }`}
            >
              <Clock className="size-4 shrink-0 text-muted-foreground" />
              <span className="flex flex-col">
                <span className="text-sm tabular-nums text-foreground">{time}</span>
                <span className="text-3xs text-muted-foreground">{t(periodKey)}</span>
              </span>
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}
