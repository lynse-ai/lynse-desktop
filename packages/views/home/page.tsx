"use client";

/**
 * Home (主页) — the app's launch page: a reverse-chronological feed of the
 * last three days of notes (recordings / meetings), near-term todos, and
 * flash notes, grouped by day, with a greeting + summary header and a
 * rotating daily-quote line. Navigation lives in the sidebar; every feed
 * row deep-links to its own module.
 */

import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "@lynse/core/i18n/react";
import { cn } from "@lynse/ui/lib/utils";
import { useNavigation } from "../navigation";
import { getWorkspaceState } from "../workspace/store";
import { getDesktopLocalTranscriptionApi } from "../workspace/local-transcription";
import { useUserCredits } from "../layout/use-user-credits";
import { useTodos } from "../todo/use-todos";
import type { TodoItem } from "../todo/todo-api";
import type { WorkspaceItem } from "../workspace/types";
import {
  FileText,
  Lightbulb,
  ListChecks,
  Zap,
  ChevronRight,
  Loader2,
  Quote,
} from "../icons";
import { featureFlags } from "../feature-flags";
import {
  getDesktopInspirationApi,
  useInspirationCaptureStore,
} from "../inspiration";
import { useHomeFeed, groupByDay, type DayGroup, type FeedEntry, type FeedKind } from "./feed";
import { useDailyQuotes, QUOTE_ROTATE_MS } from "./daily-quote";
import { WeatherStrip } from "./weather-card";

type FeedFilter = "all" | FeedKind;

const FILTERS: Array<{ value: FeedFilter; labelKey: string }> = [
  { value: "all", labelKey: "home.filter_all" },
  { value: "note", labelKey: "home.filter_note" },
  { value: "flash", labelKey: "home.filter_flash" },
  { value: "todo", labelKey: "home.filter_todo" },
];

function greetingKey(hour: number): string {
  if (hour >= 5 && hour < 12) return "home.greeting_morning";
  if (hour >= 12 && hour < 18) return "home.greeting_afternoon";
  if (hour >= 18 && hour < 24) return "home.greeting_evening";
  return "home.greeting_night";
}

/** Web has no /notes route — its workspace lives under /recordings. */
function useNotesPath(): string {
  return getDesktopLocalTranscriptionApi() ? "/notes" : "/recordings";
}

export function HomePage() {
  const { t, i18n } = useTranslation();
  const { data: userInfo } = useUserCredits();
  const nickname = userInfo?.nickname;
  const { entries, summary, loading } = useHomeFeed();
  const todosStore = useTodos();
  const [filter, setFilter] = useState<FeedFilter>("all");
  const openCapture = useInspirationCaptureStore((state) => state.openCapture);
  // Same guard as the sidebar's inspiration entry — web has no capture sheet.
  const captureAvailable = featureFlags.inspiration && Boolean(getDesktopInspirationApi());

  const now = new Date();
  const dateLine = new Intl.DateTimeFormat(i18n.language, {
    year: "numeric",
    month: "long",
    day: "numeric",
    weekday: "long",
  }).format(now);
  const quotes = useDailyQuotes();
  const [quoteIndex, setQuoteIndex] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setQuoteIndex((i) => i + 1), QUOTE_ROTATE_MS);
    return () => clearInterval(timer);
  }, []);
  const quote = quotes[quoteIndex % quotes.length]!;

  const visible = filter === "all" ? entries : entries.filter((e) => e.kind === filter);
  const visibleGroups = useMemo(
    () => groupByDay(visible, now),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [visible, now.getDate()],
  );

  const summaryParts = [
    summary.meetings > 0 ? t("home.summary_meetings", { count: summary.meetings }) : null,
    summary.todos > 0 ? t("home.summary_todos", { count: summary.todos }) : null,
    summary.flashes > 0 ? t("home.summary_flashes", { count: summary.flashes }) : null,
  ].filter(Boolean);
  const summaryLine =
    summaryParts.length > 0
      ? `${dateLine} · ${summaryParts.join(" · ")}`
      : `${dateLine} · ${t("home.summary_empty")}`;

  return (
    <div className="mx-auto flex h-full w-full max-w-3xl flex-col overflow-y-auto px-6 pb-10 pt-10">
      {/* ── Header ─────────────────────────────────────── */}
      <header className="mb-5 flex items-start justify-between gap-6">
        <div className="min-w-0 flex-1">
          <h1 className="text-xl font-semibold text-foreground">
            {nickname
              ? t("home.greeting_named", {
                  name: nickname,
                  greeting: t(greetingKey(now.getHours())),
                })
              : t(greetingKey(now.getHours()))}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">{summaryLine}</p>
          {quote && (
            <p
              key={quoteIndex}
              className="mt-3 flex animate-in fade-in items-start gap-1.5 text-xs italic text-muted-foreground/80 duration-700"
            >
              <Quote className="mt-0.5 size-3 shrink-0" strokeWidth={1.5} />
              <span className="font-serif">
                {quote.text}
                {quote.source ? ` —— ${quote.source}` : ""}
              </span>
            </p>
          )}
        </div>
        <WeatherStrip />
      </header>

      {/* ── Quick capture bar ──────────────────────────── */}
      {captureAvailable && (
        <div
          role="button"
          tabIndex={0}
          onClick={() => openCapture("note")}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              openCapture("note");
            }
          }}
          className="mb-3 flex h-10 cursor-pointer items-center gap-2.5 rounded-xl border border-border/60 bg-muted/40 px-3.5 transition-colors hover:border-ring/50 hover:bg-accent/40"
        >
          <Lightbulb className="size-4 shrink-0 text-muted-foreground" strokeWidth={1.8} />
          <span className="flex-1 truncate text-sm text-muted-foreground/80">
            {t("home.capture_placeholder")}
          </span>
          <button
            type="button"
            aria-label={t("inspiration.mode_todo")}
            onClick={(event) => {
              event.stopPropagation();
              openCapture("todo");
            }}
            className="flex shrink-0 items-center gap-1 rounded-full border border-border/60 bg-background px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:border-primary/50 hover:text-foreground"
          >
            <ListChecks className="size-3.5" />
            {t("inspiration.mode_todo")}
          </button>
        </div>
      )}

      {/* ── Filter chips ───────────────────────────────── */}
      <div className="mb-3 flex items-center gap-2">
        {FILTERS.map((f) => (
          <button
            key={f.value}
            type="button"
            onClick={() => setFilter(f.value)}
            className={cn(
              "rounded-full border px-3 py-1 text-xs font-medium transition-colors",
              filter === f.value
                ? "border-foreground bg-foreground text-background"
                : "border-border text-muted-foreground hover:bg-accent hover:text-foreground",
            )}
          >
            {t(f.labelKey)}
          </button>
        ))}
      </div>

      {/* ── Feed ───────────────────────────────────────── */}
      {loading ? (
        <div className="flex flex-1 items-center justify-center text-muted-foreground">
          <Loader2 className="size-5 animate-spin" />
        </div>
      ) : visible.length === 0 ? (
        <EmptyState filter={filter} />
      ) : (
        <div>
          {visibleGroups.map((group) => (
            <section key={groupLabelKey(group)} className="mt-4">
              <div className="mb-1 flex items-center gap-3">
                <h2 className="text-sm font-semibold text-foreground">
                  {groupTitle(group, t, i18n.language)}
                </h2>
                <span className="text-2xs text-muted-foreground">
                  {t("home.item_count", { count: group.entries.length })}
                </span>
                <div className="h-px flex-1 bg-border/60" />
              </div>
              {group.entries.map((entry) => (
                <FeedRow
                  key={entry.key}
                  entry={entry}
                  onToggleTodo={todosStore.toggle}
                />
              ))}
            </section>
          ))}
        </div>
      )}
    </div>
  );
}

function groupLabelKey(group: DayGroup): string {
  return group.dayKey ?? group.dateLabel ?? "";
}

function groupTitle(
  group: DayGroup,
  t: (key: string, params?: Record<string, unknown>) => string,
  locale: string,
): string {
  if (group.dayKey) return t(`home.group_${group.dayKey}`);
  const sample = group.entries[0]?.at;
  if (!sample) return "";
  return new Intl.DateTimeFormat(locale, { month: "long", day: "numeric" }).format(sample);
}

function EmptyState({ filter }: { filter: FeedFilter }) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 py-16 text-center">
      <div className="flex size-12 items-center justify-center rounded-2xl bg-accent">
        <FileText className="size-5 text-muted-foreground" strokeWidth={1.5} />
      </div>
      {filter === "all" ? (
        <>
          <p className="mt-2 text-sm font-medium text-foreground">{t("home.empty_all_title")}</p>
          <p className="text-xs text-muted-foreground">{t("home.empty_all_hint")}</p>
        </>
      ) : (
        <p className="mt-2 text-sm text-muted-foreground">
          {t("home.empty_filtered", { type: t(`home.filter_${filter}`) })}
        </p>
      )}
    </div>
  );
}

const KIND_STYLE: Record<FeedKind, { icon: typeof FileText; chip: string }> = {
  note: { icon: FileText, chip: "bg-primary/10 text-primary" },
  flash: { icon: Zap, chip: "bg-amber-500/15 text-amber-600 dark:text-amber-400" },
  todo: { icon: ListChecks, chip: "bg-sky-500/15 text-sky-600 dark:text-sky-400" },
};

const TONE_STYLE: Record<string, string> = {
  ok: "bg-success/10 text-success",
  busy: "bg-primary/10 text-primary",
  warn: "bg-orange-500/10 text-orange-600 dark:text-orange-400",
  danger: "bg-destructive/10 text-destructive",
};

function FeedRow({
  entry,
  onToggleTodo,
}: {
  entry: FeedEntry;
  onToggleTodo: (todo: TodoItem) => void;
}) {
  const { t } = useTranslation();
  const { push } = useNavigation();
  const notesPath = useNotesPath();

  const time = new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(entry.at);

  const kind = KIND_STYLE[entry.kind];
  const Icon = kind.icon;

  const description =
    typeof entry.description === "string"
      ? entry.description
      : entry.description
        ? t(entry.description.i18nKey, entry.description.params)
        : undefined;

  // Click-through: every kind jumps to its module. Notes additionally get
  // preselected in the workspace store so the detail panel opens on them.
  let onClick: (() => void) | undefined;
  if (entry.kind === "note") {
    onClick = () => {
      const item = entry.data as WorkspaceItem;
      getWorkspaceState().selectItem(item.id, "file", item.title);
      push(notesPath);
    };
  } else if (entry.kind === "todo") {
    // The todo page is desktop-only today; on web the row stays inert.
    onClick = notesPath === "/notes" ? () => push("/todo") : undefined;
  } else {
    onClick = notesPath === "/notes" ? () => push("/inspiration") : undefined;
  }

  return (
    <div
      role={onClick ? "button" : undefined}
      tabIndex={onClick ? 0 : undefined}
      onClick={onClick}
      onKeyDown={
        onClick
          ? (e) => {
              if (e.key === "Enter" || e.key === " ") onClick();
            }
          : undefined
      }
      className={cn(
        "group -mx-2 flex items-start gap-3 rounded-xl px-2 py-2.5 transition-colors",
        onClick && "cursor-pointer hover:bg-accent/60",
      )}
    >
      <span className="w-10 shrink-0 pt-1 text-xs tabular-nums text-muted-foreground">
        {time}
      </span>
      <span
        className={cn(
          "flex size-7 shrink-0 flex-col items-center justify-center rounded-lg",
          kind.chip,
        )}
        title={t(`home.type_${entry.kind}`)}
      >
        <Icon className="size-3.5" strokeWidth={1.8} />
      </span>

      {entry.kind === "todo" && (
        <button
          type="button"
          aria-label={t("todo.completed_toggle")}
          onClick={(e) => {
            e.stopPropagation();
            onToggleTodo(entry.data as TodoItem);
          }}
          className="mt-0.5 flex size-4 shrink-0 items-center justify-center rounded border border-input transition-colors hover:border-primary"
        />
      )}

      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-foreground">{entry.title}</p>
        {description && (
          <p className="mt-0.5 truncate text-xs text-muted-foreground">{description}</p>
        )}
      </div>

      {entry.badge && (
        <span
          className={cn(
            "shrink-0 rounded px-1.5 py-0.5 text-2xs font-medium",
            TONE_STYLE[entry.badge.tone],
          )}
        >
          {t(entry.badge.labelKey, entry.badge.params)}
        </span>
      )}
      {onClick && (
        <ChevronRight className="mt-1 size-4 shrink-0 text-muted-foreground/40 transition-colors group-hover:text-muted-foreground" />
      )}
    </div>
  );
}
