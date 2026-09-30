"use client";

/**
 * Home feed aggregation: merges the last three days of notes (recordings /
 * meetings — the unified file entity), todos due in the near window, and
 * flash notes (desktop-only) into one reverse-chronological list grouped by
 * local calendar day.
 */

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "@lynse/core/i18n/react";
import { useNotes } from "../workspace/hooks/use-files";
import type { WorkspaceItem } from "../workspace/types";
import { useTodos } from "../todo/use-todos";
import type { TodoItem } from "../todo/todo-api";
import { getDesktopInspirationApi } from "../inspiration";
import { LINK_RECORD_TAG } from "../inspiration/types";
import type { InspirationRecord } from "../inspiration/types";

export type FeedKind = "note" | "flash" | "todo";

export type FeedTone = "ok" | "busy" | "warn" | "danger";

export interface FeedBadge {
  /** i18n key under the `home.` namespace, e.g. "home.badge_done". */
  labelKey: string;
  params?: Record<string, unknown>;
  tone: FeedTone;
}

/** Plain text, or an i18n key (full path) with interpolation params. */
export type FeedDescription = string | { i18nKey: string; params?: Record<string, unknown> };

export interface FeedEntry {
  key: string;
  kind: FeedKind;
  /** Timestamp the entry is placed at on the timeline. */
  at: Date;
  title: string;
  description?: FeedDescription;
  badge?: FeedBadge;
  data: WorkspaceItem | InspirationRecord | TodoItem;
}

export type DayGroupKey = "today" | "yesterday" | "day_before" | "tomorrow" | "day_after";

export interface DayGroup {
  /** Named day label key under `home.group_*`, or null when `dateLabel` is set. */
  dayKey: DayGroupKey | null;
  /** Absolute "M/D" label for days outside the named window. */
  dateLabel?: string;
  entries: FeedEntry[];
}

/** The feed window: two days back through two days forward. */
const PAST_DAYS = 2;
const FUTURE_DAYS = 2;

/** Format a Date as the backend's `YYYY-MM-DDTHH:MM:SS` (no timezone suffix). */
function toApiDateTime(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(
    d.getHours(),
  )}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** Parse the mix of backend (`YYYY-MM-DDTHH:MM:SS`) and ISO timestamps. */
function parseTime(value: string | undefined | null): Date | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function addDays(d: Date, n: number): Date {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}

/** "1:05" / "1:02:07" clock duration — locale-neutral by design. */
export function formatClockDuration(seconds: number | undefined): string | null {
  if (!seconds || seconds <= 0) return null;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/** Day offset between two dates in local calendar days (b - a). */
function dayOffset(a: Date, b: Date): number {
  return Math.round((startOfDay(b).getTime() - startOfDay(a).getTime()) / 86_400_000);
}

type Translate = (key: string, params?: Record<string, unknown>) => string;

function noteEntries(
  items: WorkspaceItem[],
  windowStart: Date,
  now: Date,
  t: Translate,
): FeedEntry[] {
  const entries: FeedEntry[] = [];
  for (const item of items) {
    const at = parseTime(item.createdAt) ?? parseTime(item.updatedAt);
    if (!at || at < windowStart || at > now) continue;

    const duration = formatClockDuration(item.durationSeconds);
    const modeLabel = item.recordingMode ? t(`notes.recording_${item.recordingMode}`) : null;

    let badge: FeedBadge | undefined;
    if (item.localStatus === "queued" || item.localStatus === "transcribing") {
      badge = { labelKey: "home.badge_transcribing", tone: "busy" };
    } else if (item.localStatus === "completed") {
      badge = { labelKey: "home.badge_done", tone: "ok" };
    } else if (item.localStatus === "failed") {
      badge = { labelKey: "home.badge_waiting", tone: "warn" };
    }

    entries.push({
      key: `note:${item.id}`,
      kind: "note",
      at,
      title: item.title,
      description: [duration, modeLabel].filter(Boolean).join(" · ") || undefined,
      badge,
      data: item,
    });
  }
  return entries;
}

function todoEntries(todos: TodoItem[], windowStart: Date, windowEnd: Date): FeedEntry[] {
  const entries: FeedEntry[] = [];
  for (const todo of todos) {
    if (todo.completed) continue;
    const due = parseTime(todo.dueDate);
    if (!due || due < windowStart || due > windowEnd) continue;

    const diff = dayOffset(new Date(), due);
    let badge: FeedBadge;
    if (diff < 0) {
      badge = { labelKey: "home.badge_overdue", params: { count: -diff }, tone: "danger" };
    } else if (diff === 0) {
      badge = { labelKey: "home.badge_due_today", tone: "warn" };
    } else if (diff === 1) {
      badge = { labelKey: "home.badge_due_tomorrow", tone: "warn" };
    } else {
      badge = {
        labelKey: "home.badge_due_date",
        params: { date: `${due.getMonth() + 1}/${due.getDate()}` },
        tone: "warn",
      };
    }

    entries.push({
      key: `todo:${todo.id}`,
      kind: "todo",
      // Place the todo at its due date on the timeline.
      at: due,
      title: todo.title,
      badge,
      data: todo,
    });
  }
  return entries;
}

function flashEntries(records: InspirationRecord[], windowStart: Date, now: Date): FeedEntry[] {
  const entries: FeedEntry[] = [];
  for (const record of records) {
    const at = parseTime(record.createdAt);
    if (!at || at < windowStart || at > now) continue;

    const title = record.text.split("\n")[0]?.trim() || record.text;
    // Records carrying the reserved link tag are pasted-link collections:
    // badge them so they read as links queued for AI analysis.
    const isLink = record.tags?.includes(LINK_RECORD_TAG) ?? false;
    const badge =
      record.transcriptStatus === "pending"
        ? ({ labelKey: "home.badge_transcribing", tone: "busy" } as FeedBadge)
        : isLink
          ? ({ labelKey: "home.badge_link", tone: "busy" } as FeedBadge)
          : undefined;

    entries.push({
      key: `flash:${record.id}`,
      kind: "flash",
      at,
      title,
      description: isLink ? { i18nKey: "home.desc_link_ai" } : undefined,
      badge,
      data: record,
    });
  }
  return entries;
}

/** Bucket entries by local calendar day, newest day first. */
export function groupByDay(entries: FeedEntry[], now: Date): DayGroup[] {
  const buckets = new Map<number, FeedEntry[]>();
  for (const entry of entries) {
    const offset = dayOffset(now, entry.at);
    const list = buckets.get(offset) ?? [];
    list.push(entry);
    buckets.set(offset, list);
  }

  const named: Record<number, { dayKey: DayGroupKey }> = {
    0: { dayKey: "today" },
    [-1]: { dayKey: "yesterday" },
    [-2]: { dayKey: "day_before" },
    1: { dayKey: "tomorrow" },
    2: { dayKey: "day_after" },
  };

  return [...buckets.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([offset, list]) => {
      const named_ = named[offset];
      const sample = list[0]?.at;
      return {
        dayKey: named_?.dayKey ?? null,
        dateLabel: named_ || !sample
          ? undefined
          : `${sample.getMonth() + 1}/${sample.getDate()}`,
        entries: [...list].sort((a, b) => b.at.getTime() - a.at.getTime()),
      };
    });
}

export interface HomeFeed {
  entries: FeedEntry[];
  groups: DayGroup[];
  /** Today's counts for the header summary line. */
  summary: { meetings: number; todos: number; flashes: number };
  loading: boolean;
}

export function useHomeFeed(): HomeFeed {
  const { t } = useTranslation();
  const now = new Date();
  const windowStart = startOfDay(addDays(now, -PAST_DAYS));
  const windowEnd = endOfDay(addDays(now, FUTURE_DAYS));

  const notesQuery = useNotes({
    startTime: toApiDateTime(windowStart),
    endTime: toApiDateTime(windowEnd),
  });

  const todos = useTodos();

  const desktopInspirationApi = getDesktopInspirationApi();
  const inspirationsQuery = useQuery({
    queryKey: ["inspirations"],
    queryFn: () => desktopInspirationApi!.list(),
    enabled: Boolean(desktopInspirationApi),
  });

  const entries = useMemo(() => {
    const merged = [
      ...noteEntries(notesQuery.data ?? [], windowStart, now, t),
      ...todoEntries(todos.todos, windowStart, windowEnd),
      ...flashEntries(inspirationsQuery.data ?? [], windowStart, now),
    ];
    return merged.sort((a, b) => b.at.getTime() - a.at.getTime());
    // `now` is intentionally captured once per render pass.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [notesQuery.data, todos.todos, inspirationsQuery.data, t]);

  const groups = useMemo(() => groupByDay(entries, now), [entries]);

  const summary = useMemo(() => {
    const today = dayOffset(now, now);
    let meetings = 0;
    let todoCount = 0;
    let flashCount = 0;
    for (const entry of entries) {
      if (dayOffset(now, entry.at) !== today) continue;
      if (entry.kind === "note") meetings += 1;
      else if (entry.kind === "todo") todoCount += 1;
      else flashCount += 1;
    }
    return { meetings, todos: todoCount, flashes: flashCount };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entries]);

  return {
    entries,
    groups,
    summary,
    loading: notesQuery.isLoading || (todos.loading && todos.todos.length === 0),
  };
}

function endOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999);
}
