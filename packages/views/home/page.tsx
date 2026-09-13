"use client";

/**
 * Home (主页) — the app's launch page, following the reference layout:
 * a greeting header (date / greeting) with an inline weather line and a
 * search entry on the right, a today-summary strip underneath that
 * carousels the summary parts plus the nearest due todo, and the "recent
 * records" feed grouped by day under text tabs. A floating Dynamic-Island
 * capsule pins to the page bottom — plus (hover for import / paste-link),
 * record, quick note. A rotating daily quote sits under the greeting; the
 * footer carries "view all records".
 */

import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "@lynse/core/i18n/react";
import { cn } from "@lynse/ui/lib/utils";
import { useNavigation } from "../navigation";
import { IconSwap } from "../icon-swap";
import { getWorkspaceState } from "../workspace/store";
import { getDesktopLocalTranscriptionApi } from "../workspace/local-transcription";
import { UploadDialog } from "../workspace/upload-dialog";
import { useUserCredits } from "../layout/use-user-credits";
import { useTodos } from "../todo/use-todos";
import { useQuickRecording } from "../live-translation/quick-recording";
import type { TodoItem } from "../todo/todo-api";
import type { WorkspaceItem } from "../workspace/types";
import {
  ArrowRight,
  Clock,
  FileText,
  Lightbulb,
  Link,
  ListChecks,
  Mic,
  Search,
  ChevronRight,
  Loader2,
  Pencil,
  Plus,
  Quote,
  Upload,
} from "../icons";
import { featureFlags } from "../feature-flags";
import {
  getDesktopInspirationApi,
  useInspirationCaptureStore,
  useInspirationDetailStore,
  InspirationDetailDialog,
  type InspirationRecord,
} from "../inspiration";
import { TodoEditSheet } from "../todo";
import { isCalendarAvailable } from "../todo/todo-api";
import { useHomeFeed, groupByDay, type DayGroup, type FeedEntry, type FeedKind } from "./feed";
import { useDailyQuotes, QUOTE_ROTATE_MS } from "./daily-quote";
import { WeatherStrip } from "./weather-card";
import { GlobalSearchDialog } from "./global-search-dialog";
import { PasteLinkDialog } from "./paste-link-dialog";

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

/** The today-summary strip under the hero card rotates one item every 5s. */
const SUMMARY_ROTATE_MS = 5_000;
/** Crossfade length for the strip's enter/exit transition. */
const SUMMARY_CROSSFADE_MS = 1_000;

/** Web has no /notes route — its workspace lives under /recordings. */
function useNotesPath(): string {
  return getDesktopLocalTranscriptionApi() ? "/notes" : "/recordings";
}

export function HomePage() {
  const { t, i18n } = useTranslation();
  const { push } = useNavigation();
  const { data: userInfo } = useUserCredits();
  const nickname = userInfo?.nickname;
  const { entries, summary, loading } = useHomeFeed();
  const todosStore = useTodos();
  const [filter, setFilter] = useState<FeedFilter>("all");
  const openCapture = useInspirationCaptureStore((state) => state.openCapture);
  // Same guard as the sidebar's inspiration entry — web has no capture sheet.
  const captureAvailable = featureFlags.inspiration && Boolean(getDesktopInspirationApi());
  const quick = useQuickRecording();
  const [startingRecord, setStartingRecord] = useState(false);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const notesPath = useNotesPath();
  // Todos and flash records have popup details (the todo edit sheet and the
  // inspiration detail dialog) — clicked on home they open in place instead
  // of navigating away. The id resolves against the live store so edits made
  // elsewhere are reflected, and a deleted item closes the sheet.
  const [editingTodoId, setEditingTodoId] = useState<string | null>(null);
  const editingTodo = editingTodoId
    ? todosStore.todos.find((todo) => todo.id === editingTodoId) ?? null
    : null;
  const calendarAvailable = useMemo(() => isCalendarAvailable(), []);
  const openTodoDetail = (todo: TodoItem) => setEditingTodoId(todo.id);

  const startRecording = async () => {
    if (startingRecord) return;
    setStartingRecord(true);
    try {
      if (await quick.start()) push("/recording");
    } finally {
      setStartingRecord(false);
    }
  };

  // ⌘K / Ctrl+K opens the global search palette from anywhere on the page.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setSearchOpen((open) => !open);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

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

  // The nearest unfinished due todo powers the "due soon" banner.
  const upcomingTodo = useMemo(() => {
    const withDue = todosStore.todos
      .filter((todo) => !todo.completed && todo.dueDate)
      .sort(
        (a, b) => new Date(a.dueDate!).getTime() - new Date(b.dueDate!).getTime(),
      );
    return withDue[0] ?? null;
  }, [todosStore.todos]);

  const summaryParts = [
    summary.meetings > 0 ? t("home.summary_meetings", { count: summary.meetings }) : null,
    summary.todos > 0 ? t("home.summary_todos", { count: summary.todos }) : null,
    summary.flashes > 0 ? t("home.summary_flashes", { count: summary.flashes }) : null,
  ].filter(Boolean);
  // One strip under the hero card: the today-summary parts and the nearest
  // due todo carousel through, one every SUMMARY_ROTATE_MS, and only when
  // there is more than one item. Hovering pauses the rotation so the todo's
  // checkbox and link stay reachable. Each step crossfades — the incoming
  // item rises from below while the outgoing one fades up and away.
  const rotateCount = summaryParts.length + (upcomingTodo ? 1 : 0);
  const [strip, setStrip] = useState<{ current: number; leaving: number | null }>({
    current: 0,
    leaving: null,
  });
  const [stripPaused, setStripPaused] = useState(false);
  useEffect(() => {
    if (rotateCount <= 1 || stripPaused) return;
    const timer = setInterval(() => {
      setStrip((s) => ({ current: (s.current + 1) % rotateCount, leaving: s.current }));
    }, SUMMARY_ROTATE_MS);
    return () => clearInterval(timer);
  }, [rotateCount, stripPaused]);
  // Drop the outgoing layer once its exit animation has finished.
  useEffect(() => {
    if (strip.leaving === null) return;
    const timer = setTimeout(
      () => setStrip((s) => (s.leaving === strip.leaving ? { ...s, leaving: null } : s)),
      SUMMARY_CROSSFADE_MS,
    );
    return () => clearTimeout(timer);
  }, [strip.leaving]);
  const stripCurrent = rotateCount > 0 ? strip.current % rotateCount : 0;
  const upcomingDueLabel = upcomingTodo ? dueTodoLabel(upcomingTodo, t, i18n.language) : "";

  /** Content of one carousel slot: a summary text line or the due todo row. */
  const renderStripItem = (index: number) => {
    if (upcomingTodo && index >= summaryParts.length) {
      return (
        <>
          <button
            type="button"
            aria-label={t("todo.completed_toggle")}
            onClick={() => todosStore.toggle(upcomingTodo)}
            className="flex size-[18px] shrink-0 items-center justify-center rounded-full border border-input transition-colors hover:border-primary"
          />
          <button
            type="button"
            disabled={!todoPageAvailable}
            onClick={() => todoPageAvailable && openTodoDetail(upcomingTodo)}
            className="min-w-0 flex-1 truncate text-left text-sm text-foreground transition-colors hover:text-primary disabled:cursor-default"
          >
            {upcomingTodo.title}
          </button>
          {upcomingDueLabel && (
            <span className="flex shrink-0 items-center gap-1 text-xs tabular-nums text-muted-foreground">
              <Clock className="size-3" strokeWidth={1.8} />
              {upcomingDueLabel}
            </span>
          )}
          {todoPageAvailable && (
            <ChevronRight className="size-4 shrink-0 text-muted-foreground/40" />
          )}
        </>
      );
    }
    const text =
      summaryParts.length > 0
        ? summaryParts[index % summaryParts.length]!
        : t("home.summary_empty");
    return <p className="min-w-0 flex-1 truncate text-sm text-muted-foreground">{text}</p>;
  };

  const todoPageAvailable = notesPath === "/notes";

  return (
    <div className="mx-auto flex h-full w-full max-w-4xl flex-col overflow-y-auto overscroll-contain px-6 pb-6">
      {/* ── Header ───────────────────────────────────────
          Doubles as the window drag region (same as the other pages' title
          bars). Tauri only starts a drag when the exact mousedown target has
          the attribute, so it is repeated on the greeting text elements;
          the search button and weather stay interactive. */}
      <header
        className="-mx-6 mb-5 flex select-none items-start justify-between gap-6 px-6 pt-6"
        data-tauri-drag-region
      >
        <div className="min-w-0 flex-1" data-tauri-drag-region>
          <p className="text-xs text-muted-foreground" data-tauri-drag-region>
            {dateLine}
          </p>
          <h1
            className="mt-1.5 text-2xl font-semibold tracking-tight text-foreground"
            data-tauri-drag-region
          >
            {nickname
              ? t("home.greeting_named", {
                  name: nickname,
                  greeting: t(greetingKey(now.getHours())),
                })
              : t(greetingKey(now.getHours()))}
          </h1>
          {quote && (
            <p
              key={quoteIndex}
              className="mt-3 flex animate-in fade-in items-start gap-1.5 text-xs italic text-muted-foreground/80 duration-700"
              data-tauri-drag-region
            >
              <Quote className="mt-0.5 size-3 shrink-0" strokeWidth={1.5} />
              <span className="font-serif" data-tauri-drag-region>
                {quote.text}
                {quote.source ? ` —— ${quote.source}` : ""}
              </span>
            </p>
          )}
        </div>
        <div className="flex shrink-0 flex-col items-end gap-3">
          <button
            type="button"
            aria-label={t("home.search_records")}
            title={`${t("home.search_records")} (⌘K)`}
            onClick={() => setSearchOpen(true)}
            className="flex size-8 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <Search className="size-4" strokeWidth={1.8} />
          </button>
          <WeatherStrip />
        </div>
      </header>

      {/* ── Today summary strip (carousel incl. due todo) ─ */}
      <div
        className="flex items-center gap-3 rounded-xl border border-border/50 bg-muted/20 px-4 py-2.5"
        onMouseEnter={() => setStripPaused(true)}
        onMouseLeave={() => setStripPaused(false)}
      >
        <span className="shrink-0 text-xs font-medium text-primary">
          {t("home.summary_title")}
        </span>
        <span className="h-4 w-px shrink-0 bg-border/60" />
        <div className="relative min-w-0 flex-1 overflow-hidden">
          {rotateCount > 1 ? (
            <>
              {/* Incoming layer — rises from below while fading in. */}
              <div
                key={`in-${stripCurrent}`}
                className="flex min-w-0 items-center gap-3 animate-in fade-in slide-in-from-bottom-4 duration-1000"
              >
                {renderStripItem(stripCurrent)}
              </div>
              {strip.leaving !== null && (
                /* Outgoing layer — fades away while sliding up, clipped. */
                <div
                  key={`out-${strip.leaving}`}
                  className="absolute inset-0 flex items-center gap-3 animate-out fade-out slide-out-to-top-4 fill-mode-forwards pointer-events-none duration-1000"
                >
                  {renderStripItem(strip.leaving)}
                </div>
              )}
            </>
          ) : (
            <div className="flex min-w-0 items-center gap-3">
              {renderStripItem(stripCurrent)}
            </div>
          )}
        </div>
      </div>

      {/* ── Recent records ─────────────────────────────── */}
      <section className="mt-7">
        <div className="flex items-center justify-between border-b border-border/60">
          <h2 className="pb-2 text-lg font-semibold text-foreground">
            {t("home.recent_title")}
            {entries.length > 0 && (
              <span className="ml-2 text-sm font-normal tabular-nums text-muted-foreground">
                {entries.length}
              </span>
            )}
          </h2>
          <div className="flex items-center gap-0.5">
            {FILTERS.map((f) => (
              <button
                key={f.value}
                type="button"
                onClick={() => setFilter(f.value)}
                className={cn(
                  "relative px-2 pb-2.5 text-sm transition-colors",
                  filter === f.value
                    ? "font-medium text-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {t(f.labelKey)}
                {filter === f.value && (
                  <span className="absolute inset-x-2 bottom-0 h-0.5 rounded-full bg-primary" />
                )}
              </button>
            ))}
          </div>
        </div>

        {/* ── Feed ─────────────────────────────────────── */}
        {loading ? (
          <FeedSkeleton />
        ) : visible.length === 0 ? (
          <EmptyState filter={filter} />
        ) : (
          <div className="pb-2">
            {visibleGroups.map((group) => (
              <section key={groupLabelKey(group)} className="mt-4">
                <div className="mb-1 flex items-center gap-3">
                  <h3 className="text-sm font-semibold text-foreground">
                    {groupTitle(group, t, i18n.language)}
                  </h3>
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
                    onOpenTodo={openTodoDetail}
                  />
                ))}
              </section>
            ))}
          </div>
        )}
      </section>

      {/* ── Footer: view-all link ──────────────────────── */}
      <footer className="mt-auto flex justify-center pb-20 pt-6">
        <button
          type="button"
          onClick={() => push(notesPath)}
          className="flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          {t("home.view_all_records")}
          <ArrowRight className="size-3.5" />
        </button>
      </footer>

      {/* ── Floating capture capsule (Dynamic-Island style) ─
          Pins to the bottom of the page: plus on the left (hover reveals
          import / paste-link entries), record in the middle, quick note on
          the right. */}
      <div className="pointer-events-none sticky bottom-2 z-40 flex justify-center">
        <div className="pointer-events-auto flex items-center gap-1 rounded-full border border-border/40 bg-popover/60 p-1 shadow-md backdrop-blur-lg">
          <div className="group relative flex">
            <button
              type="button"
              aria-label={t("home.capture_more")}
              className="flex size-9 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <Plus className="size-[18px]" strokeWidth={1.8} />
            </button>
            <div className="pointer-events-none absolute bottom-full left-0 z-50 translate-y-1 pb-2 opacity-0 transition-[translate,opacity] duration-150 group-hover:pointer-events-auto group-hover:translate-y-0 group-hover:opacity-100">
              <div className="w-48 rounded-xl border border-border/60 bg-popover p-1.5 shadow-lg">
                <button
                  type="button"
                  onClick={() => setUploadOpen(true)}
                  className="flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-sm text-foreground transition-colors hover:bg-accent"
                >
                  <Upload className="size-4 shrink-0 text-muted-foreground" strokeWidth={1.8} />
                  {t("home.import_audio")}
                </button>
                <button
                  type="button"
                  onClick={() => setPasteOpen(true)}
                  className="flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-sm text-foreground transition-colors hover:bg-accent"
                >
                  <Link className="size-4 shrink-0 text-muted-foreground" strokeWidth={1.8} />
                  {t("home.paste_link")}
                </button>
              </div>
            </div>
          </div>
          {quick.available && (
            <RecordAction
              starting={startingRecord}
              recording={quick.recording}
              paused={quick.paused}
              onStart={() => void startRecording()}
            />
          )}
          {captureAvailable && (
            <button
              type="button"
              aria-label={t("home.quick_note")}
              title={t("home.quick_note")}
              onClick={() => openCapture("note")}
              className="flex size-9 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <Pencil className="size-4" strokeWidth={1.6} />
            </button>
          )}
        </div>
      </div>

      {/* ── Overlays ───────────────────────────────────── */}
      <GlobalSearchDialog open={searchOpen} onOpenChange={setSearchOpen} />
      <UploadDialog open={uploadOpen} onOpenChange={setUploadOpen} />
      <PasteLinkDialog open={pasteOpen} onOpenChange={setPasteOpen} />
      {/* Details open in place on home: the flash record's dialog and the
          todo's edit sheet are popups on their own pages too, so a click on
          a feed row (or the summary strip's due todo) shows them here. */}
      <InspirationDetailDialog />
      {editingTodo && (
        <TodoEditSheet
          key={editingTodo.id}
          todo={editingTodo}
          calendarAvailable={calendarAvailable}
          onClose={() => setEditingTodoId(null)}
          onDelete={() => {
            void todosStore.remove(editingTodo);
            setEditingTodoId(null);
          }}
          onCalendarAdded={() => {
            void todosStore.load();
            setEditingTodoId(null);
          }}
          onSaved={todosStore.patchLocal}
        />
      )}
    </div>
  );
}

/** The pill bar's record button: idle it is the red circle — click to start a
 *  session and land on the recording page. While a session is live (started
 *  from anywhere: this button, the dock, the tray, auto-record) it morphs into
 *  a compact recording indicator so re-entering home mid-recording still shows
 *  the running state; tapping it returns to the session instead of starting a
 *  new one. */
function RecordAction({
  starting,
  recording,
  paused,
  onStart,
}: {
  starting: boolean;
  recording: boolean;
  paused: boolean;
  onStart: () => void;
}) {
  const { t } = useTranslation();
  const active = recording || paused;
  const label = active
    ? t("recording_mode.expand")
    : t("recording_mode.start_recording");
  return (
    <button
      type="button"
      disabled={starting}
      onClick={onStart}
      aria-label={label}
      title={label}
      className={cn(
        "flex h-10 shrink-0 items-center justify-center rounded-full transition-[width,padding,gap,background-color,border-color,box-shadow,transform] duration-300 active:scale-[0.96] disabled:opacity-60",
        active
          ? "gap-2 border border-border/50 bg-popover/80 px-3.5 shadow-sm backdrop-blur-md hover:bg-accent"
          : "w-10 bg-destructive text-destructive-foreground shadow-lg shadow-destructive/25 hover:bg-destructive/90",
      )}
    >
      {/* `starting` only spins on the idle→starting path; while a session is
          live the click just navigates back, so keep the indicator visible. */}
      <IconSwap stateKey={starting && !active ? "starting" : active ? "active" : "idle"}>
        {starting && !active ? (
          <Loader2 className="size-4 animate-spin" />
        ) : active ? (
          <>
            <span
              className={cn(
                "size-2.5 rounded-full",
                paused ? "bg-warning" : "animate-pulse bg-destructive",
              )}
            />
            <span className="text-xs font-medium text-foreground">
              {t(paused ? "recording_mode.state_paused" : "recording_mode.recording_label")}
            </span>
          </>
        ) : (
          <Mic className="size-[18px]" />
        )}
      </IconSwap>
    </button>
  );
}

/** "今天 14:00"-style due label for the nearest due todo shown in the
 *  today-summary strip carousel. */
function dueTodoLabel(
  todo: TodoItem,
  t: (key: string, params?: Record<string, unknown>) => string,
  language: string,
): string {
  const due = todo.calendarStartAt || todo.dueDate || "";
  const dueDate = due ? new Date(due) : null;
  if (!dueDate || Number.isNaN(dueDate.getTime())) return "";
  const now = new Date();
  const dayDiff = Math.round(
    (new Date(dueDate.getFullYear(), dueDate.getMonth(), dueDate.getDate()).getTime() -
      new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()) /
      86_400_000,
  );
  const dayLabel =
    dayDiff === 0
      ? t("home.group_today")
      : dayDiff === 1
        ? t("home.group_tomorrow")
        : new Intl.DateTimeFormat(language, { month: "short", day: "numeric" }).format(dueDate);
  const timeLabel =
    due.length > 10
      ? new Intl.DateTimeFormat(language, {
          hour: "2-digit",
          minute: "2-digit",
          hour12: false,
        }).format(dueDate)
      : null;
  return timeLabel ? `${dayLabel} ${timeLabel}` : dayLabel;
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
  // Same lightbulb glyph as the sidebar's 记录 (inspiration) entry — the
  // feed's flash rows are that module's records.
  flash: { icon: Lightbulb, chip: "bg-feed-flash/15 text-feed-flash" },
  todo: { icon: ListChecks, chip: "bg-feed-todo/15 text-feed-todo" },
};

const TONE_STYLE: Record<string, string> = {
  ok: "bg-success/10 text-success",
  busy: "bg-primary/10 text-primary",
  warn: "bg-warning/10 text-warning-text",
  danger: "bg-destructive/10 text-destructive",
};

/** Skeleton matching the feed layout: two day groups of FeedRow-shaped rows. */
function FeedSkeleton() {
  return (
    <div className="pb-2" aria-hidden>
      {[3, 2].map((rows, g) => (
        <section key={g} className="mt-4">
          <div className="mb-1 flex items-center gap-3">
            <span className="h-3.5 w-16 animate-pulse rounded bg-muted-foreground/10" />
            <div className="h-px flex-1 bg-border/60" />
          </div>
          {Array.from({ length: rows }, (_, i) => (
            <div key={i} className="flex items-start gap-3 px-2 py-2.5">
              <span className="h-3 w-10 animate-pulse rounded bg-muted-foreground/10" />
              <span className="size-7 shrink-0 animate-pulse rounded-lg bg-muted-foreground/10" />
              <div className="min-w-0 flex-1 pt-0.5">
                <span className="block h-3.5 w-2/5 animate-pulse rounded bg-muted-foreground/10" />
                <span className="mt-2 block h-3 w-3/5 animate-pulse rounded bg-muted-foreground/10" />
              </div>
            </div>
          ))}
        </section>
      ))}
    </div>
  );
}

function FeedRow({
  entry,
  onToggleTodo,
  onOpenTodo,
}: {
  entry: FeedEntry;
  onToggleTodo: (todo: TodoItem) => void;
  onOpenTodo: (todo: TodoItem) => void;
}) {
  const { t } = useTranslation();
  const { push } = useNavigation();
  const notesPath = useNotesPath();
  const openInspirationDetail = useInspirationDetailStore((state) => state.openDetail);

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

  // Click-through: notes jump to the notes module (preselected in the
  // workspace store so the detail panel opens on them — their detail is a
  // page, not a popup). Flash records and todos have popup details (the
  // inspiration detail dialog / the todo edit sheet), so those open in
  // place on the home page.
  let onClick: (() => void) | undefined;
  if (entry.kind === "note") {
    onClick = () => {
      const item = entry.data as WorkspaceItem;
      getWorkspaceState().selectItem(item.id, "file", item.title);
      push(notesPath);
    };
  } else if (entry.kind === "todo") {
    // The todo page is desktop-only today; on web the row stays inert.
    onClick = notesPath === "/notes" ? () => onOpenTodo(entry.data as TodoItem) : undefined;
  } else if (entry.kind === "flash") {
    // Flash entries only exist where the inspiration bridge does, so the
    // detail dialog can always open for them.
    onClick = () => openInspirationDetail((entry.data as InspirationRecord).id);
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
          // -mt-1 centers the 28px chip on the 20px title line (rows are
          // top-aligned so two-line entries keep the icon on the first line).
          "-mt-1 flex size-7 shrink-0 flex-col items-center justify-center rounded-lg",
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
        <ChevronRight className="size-4 shrink-0 text-muted-foreground/40 transition-colors group-hover:text-muted-foreground" />
      )}
    </div>
  );
}
