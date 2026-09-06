"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { motion, useReducedMotion } from "motion/react";
import { cn } from "@lynse/ui/lib/utils";
import { Button } from "@lynse/ui/components/ui/button";
import { toast } from "sonner";
import { useTranslation } from "@lynse/core/i18n/react";
import {
  AlertCircle,
  LayoutGrid,
  Lightbulb,
  List,
  Loader2,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Trash2,
} from "../icons";
import { getDesktopInspirationApi } from "./desktop-api";
import { useInspirationCaptureStore } from "./capture-store";
import { collectTags, splitByHashtags } from "./tags";
import { formatVoiceDuration } from "./use-inspiration-voice";
import type { InspirationImage, InspirationRecord } from "./types";

const VIEW_STORAGE_KEY = "lynse_inspiration_view_v1";
type FeedView = "masonry" | "list";

function readStoredView(): FeedView {
  if (typeof window === "undefined") return "masonry";
  return window.localStorage.getItem(VIEW_STORAGE_KEY) === "list" ? "list" : "masonry";
}

function formatCardDateTime(iso: string, language: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const sameYear = date.getFullYear() === new Date().getFullYear();
  return new Intl.DateTimeFormat(language, {
    ...(sameYear ? {} : { year: "numeric" }),
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function dayKey(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

function dayGroupLabel(iso: string, language: string, t: (key: string) => string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const key = dayKey(iso);
  const now = new Date();
  if (key === dayKey(now.toISOString())) return t("inspiration.group_today");
  if (key === dayKey(new Date(now.getTime() - 86_400_000).toISOString())) return t("inspiration.group_yesterday");
  const sameYear = date.getFullYear() === now.getFullYear();
  return new Intl.DateTimeFormat(language, {
    ...(sameYear ? {} : { year: "numeric" }),
    month: "long",
    day: "numeric",
  }).format(date);
}

/** Number of masonry columns for the current viewport width. */
function useColumnCount(): number {
  const [columns, setColumns] = useState(2);
  useEffect(() => {
    const update = () => setColumns(window.innerWidth >= 1180 ? 3 : 2);
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);
  return columns;
}

/** One saved image served through `local-media://`, with skeleton while loading. */
function RecordImage({
  record,
  image,
  className,
}: {
  record: InspirationRecord;
  image: InspirationImage;
  className?: string;
}) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    void getDesktopInspirationApi()?.getImageUrl(record.id, image.file).then((next) => {
      if (!cancelled) setUrl(next);
    });
    return () => {
      cancelled = true;
    };
  }, [record.id, image.file]);
  if (!url) return <div className={cn("animate-pulse bg-muted", className)} />;
  return <img src={url} alt="" loading="lazy" className={className} />;
}

/** Play/pause button for a memo's WAV served through `local-media://`. */
function InspirationAudioPlayer({ record }: { record: InspirationRecord }) {
  const [url, setUrl] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    void getDesktopInspirationApi()?.getAudioUrl(record.id).then((next) => {
      if (!cancelled) setUrl(next);
    });
    return () => {
      cancelled = true;
      audioRef.current?.pause();
      audioRef.current = null;
    };
  }, [record.id]);

  const toggle = () => {
    if (!url) return;
    if (!audioRef.current) {
      audioRef.current = new Audio(url);
      audioRef.current.onended = () => setPlaying(false);
    }
    if (playing) {
      audioRef.current.pause();
      setPlaying(false);
    } else {
      audioRef.current
        .play()
        .then(() => setPlaying(true))
        .catch(() => setPlaying(false));
    }
  };

  return (
    <button
      type="button"
      onClick={toggle}
      className="flex items-center gap-1.5 self-start rounded-full bg-muted/70 px-2.5 py-1 text-3xs text-muted-foreground transition-colors hover:bg-muted"
      title={record.audio ? formatVoiceDuration(record.audio.durationMs) : undefined}
    >
      {playing ? <Pause className="size-3" /> : <Play className="size-3" />}
      <span className="tabular-nums">
        {record.audio ? formatVoiceDuration(record.audio.durationMs) : "--:--"}
      </span>
    </button>
  );
}

/** Transcript block with its pending / failed / unavailable states. */
function InspirationTranscript({ record, onRetry, retrying }: {
  record: InspirationRecord;
  onRetry: (id: string) => void;
  retrying: boolean;
}) {
  const { t } = useTranslation();
  const status = record.transcriptStatus ?? "none";
  if (!record.audio || status === "none") return null;
  if (status === "pending") {
    return (
      <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Loader2 className="size-3 animate-spin" />
        {t("inspiration.transcript_pending")}
      </p>
    );
  }
  if (status === "unavailable" || status === "failed") {
    const failed = status === "failed";
    return (
      <div className={cn("flex items-center gap-2 text-xs", failed ? "text-destructive" : "text-muted-foreground")}>
        <AlertCircle className="size-3 shrink-0" />
        <span className="truncate">
          {record.transcriptError ||
            t(failed ? "inspiration.transcript_failed" : "inspiration.transcript_unavailable")}
        </span>
        <Button variant="ghost" size="xs" disabled={retrying} onClick={() => onRetry(record.id)}>
          {retrying ? <Loader2 className="size-3 animate-spin" /> : <RefreshCw className="size-3" />}
          {t("inspiration.transcript_retry")}
        </Button>
      </div>
    );
  }
  if (record.transcript) {
    return (
      <p className="border-l-2 border-border/60 pl-2 text-xs leading-relaxed text-muted-foreground whitespace-pre-wrap">
        {record.transcript}
      </p>
    );
  }
  return null;
}

function TagChips({ record }: { record: InspirationRecord }) {
  if (record.tags.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1">
      {record.tags.map((tag) => (
        <span
          key={tag}
          className="rounded-full bg-primary/10 px-2 py-0.5 text-3xs text-accent-brand-text"
        >
          #{tag}
        </span>
      ))}
    </div>
  );
}

function HighlightedText({ text, className }: { text: string; className?: string }) {
  return (
    <p className={cn("leading-relaxed whitespace-pre-wrap text-foreground", className)}>
      {splitByHashtags(text).map((segment, index) =>
        segment.tag ? (
          <span key={index} className="text-accent-brand-text">
            {segment.text}
          </span>
        ) : (
          <span key={index}>{segment.text}</span>
        ),
      )}
    </p>
  );
}

/** Xiaohongshu-style waterfall card: cover image, clamped text, meta row. */
function MasonryCard({ record, dateTime }: { record: InspirationRecord; dateTime: string }) {
  const { t } = useTranslation();
  const cover = record.images?.[0];
  const extraCount = Math.max(0, (record.images?.length ?? 0) - 1);
  return (
    <article className="overflow-hidden rounded-xl border border-border/50 bg-card/60 p-2.5 transition-shadow hover:shadow-md">
      {cover && (
        <div className="relative mb-2 overflow-hidden rounded-lg">
          <RecordImage
            record={record}
            image={cover}
            className="w-full object-cover"
          />
          {extraCount > 0 && (
            <span className="absolute bottom-1.5 right-1.5 rounded-full bg-black/50 px-2 py-0.5 text-3xs text-white">
              {t("inspiration.images_count", { count: extraCount + 1 })}
            </span>
          )}
        </div>
      )}
      {record.text.trim() && (
        <HighlightedText text={record.text} className="text-[13px] line-clamp-6" />
      )}
      <div className="mt-2 flex flex-col gap-1.5">
        <TagChips record={record} />
        <div className="flex items-center justify-between">
          <span className="text-3xs text-muted-foreground/70">{dateTime}</span>
          {record.audio && <InspirationAudioPlayer record={record} />}
        </div>
      </div>
    </article>
  );
}

/** Detailed list card, grouped under day headers. */
function ListCard({ record, dateTime, onRetry, retrying }: {
  record: InspirationRecord;
  dateTime: string;
  onRetry: (id: string) => void;
  retrying: boolean;
}) {
  return (
    <article className="rounded-xl border border-border/50 bg-card/60 p-3.5">
      <span className="text-3xs text-muted-foreground/70">{dateTime}</span>
      {record.text.trim() && <HighlightedText text={record.text} className="mt-1 text-sm" />}
      {record.images && record.images.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {record.images.slice(0, 3).map((image) => (
            <RecordImage
              key={image.file}
              record={record}
              image={image}
              className="h-20 w-20 rounded-lg object-cover"
            />
          ))}
          {record.images.length > 3 && (
            <div className="flex h-20 w-20 items-center justify-center rounded-lg bg-muted text-xs text-muted-foreground">
              +{record.images.length - 3}
            </div>
          )}
        </div>
      )}
      <div className="mt-2 flex flex-col items-start gap-2">
        {record.audio && <InspirationAudioPlayer record={record} />}
        <TagChips record={record} />
        <InspirationTranscript record={record} onRetry={onRetry} retrying={retrying} />
      </div>
    </article>
  );
}

/** flomo-style feed with Xiaohongshu masonry and grouped list layouts. */
export function InspirationPage() {
  const { t, i18n } = useTranslation();
  const queryClient = useQueryClient();
  const openCapture = useInspirationCaptureStore((state) => state.openCapture);
  const [view, setView] = useState<FeedView>(readStoredView);
  const [activeTag, setActiveTag] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [retryingId, setRetryingId] = useState<string | null>(null);
  const reduceMotion = useReducedMotion();
  const desktopApi = getDesktopInspirationApi();
  const columns = useColumnCount();

  const { data: inspirations = [], isLoading } = useQuery({
    queryKey: ["inspirations"],
    queryFn: () => desktopApi!.list(),
    enabled: Boolean(desktopApi),
    // While any memo is awaiting its transcript, poll so completed texts
    // appear without a manual refresh.
    refetchInterval: (query) =>
      ((query.state.data as InspirationRecord[] | undefined) ?? []).some(
        (record) => record.transcriptStatus === "pending",
      )
        ? 3_000
        : false,
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["inspirations"] });
  const deleteMutation = useMutation({
    mutationFn: (id: string) => desktopApi!.delete(id),
    onSuccess: () => {
      toast.success(t("inspiration.toast_deleted"));
      void invalidate();
    },
    onSettled: () => setDeletingId(null),
  });
  const retryMutation = useMutation({
    mutationFn: (id: string) => desktopApi!.transcribe(id),
    onSuccess: () => void invalidate(),
    onError: (error) => toast.error(String(error)),
    onSettled: () => setRetryingId(null),
  });

  const allTags = useMemo(() => collectTags(inspirations.map((record) => record.text)), [inspirations]);
  const filtered = useMemo(
    () => (activeTag ? inspirations.filter((record) => record.tags.includes(activeTag)) : inspirations),
    [activeTag, inspirations],
  );

  const setViewAndPersist = (next: FeedView) => {
    setView(next);
    try {
      window.localStorage.setItem(VIEW_STORAGE_KEY, next);
    } catch {
      /* storage unavailable — the in-memory state still works */
    }
  };

  // List view groups the feed under sticky day headers (今天 / 昨天 / 日期).
  const listGroups = useMemo(() => {
    const groups: Array<{ label: string; records: InspirationRecord[] }> = [];
    for (const record of filtered) {
      const label = dayGroupLabel(record.createdAt, i18n.language, t);
      const last = groups[groups.length - 1];
      if (last && last.label === label) last.records.push(record);
      else groups.push({ label, records: [record] });
    }
    return groups;
  }, [filtered, i18n.language, t]);

  // Round-robin distributes records left-to-right so the waterfall roughly
  // preserves chronological scanning order (CSS columns would fill downward).
  const masonryColumns = useMemo(
    () =>
      Array.from({ length: columns }, (_, column) =>
        filtered.filter((_, index) => index % columns === column),
      ),
    [columns, filtered],
  );

  const renderCard = (record: InspirationRecord, index: number) => (
    <motion.div
      key={record.id}
      initial={reduceMotion ? false : { opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={
        reduceMotion
          ? { duration: 0 }
          : { type: "spring", bounce: 0, duration: 0.3, delay: Math.min(index * 0.03, 0.15) }
      }
      className="group relative"
    >
      <MasonryCard record={record} dateTime={formatCardDateTime(record.createdAt, i18n.language)} />
      <button
        type="button"
        title={t("inspiration.delete")}
        disabled={deletingId === record.id}
        onClick={() => {
          setDeletingId(record.id);
          deleteMutation.mutate(record.id);
        }}
        className="absolute right-2 top-2 z-10 rounded-md bg-background/70 p-1 text-muted-foreground/60 opacity-0 backdrop-blur transition-opacity hover:bg-muted hover:text-foreground group-hover:opacity-100"
      >
        {deletingId === record.id ? (
          <Loader2 className="size-3.5 animate-spin" />
        ) : (
          <Trash2 className="size-3.5" />
        )}
      </button>
    </motion.div>
  );

  return (
    <div className="flex h-full flex-col">
      <header
        className="flex shrink-0 items-center justify-between border-b border-border/50 px-4 py-3 select-none"
        data-tauri-drag-region
      >
        <h2 className="text-sm font-medium text-foreground">{t("inspiration.title")}</h2>
        {desktopApi && (
          <div className="flex items-center gap-2">
            <div className="flex items-center rounded-lg border border-border/50 p-0.5">
              <button
                type="button"
                title={t("inspiration.view_masonry")}
                onClick={() => setViewAndPersist("masonry")}
                className={cn(
                  "rounded-md p-1 transition-colors",
                  view === "masonry" ? "bg-foreground/80 text-background" : "text-muted-foreground hover:text-foreground",
                )}
              >
                <LayoutGrid className="size-3.5" />
              </button>
              <button
                type="button"
                title={t("inspiration.view_list")}
                onClick={() => setViewAndPersist("list")}
                className={cn(
                  "rounded-md p-1 transition-colors",
                  view === "list" ? "bg-foreground/80 text-background" : "text-muted-foreground hover:text-foreground",
                )}
              >
                <List className="size-3.5" />
              </button>
            </div>
            <Button size="sm" className="gap-1.5" onClick={openCapture}>
              <Plus className="size-3.5" />
              {t("inspiration.new")}
            </Button>
          </div>
        )}
      </header>

      {!desktopApi ? (
        <div className="flex flex-1 flex-col items-center justify-center text-center">
          <div className="mx-auto mb-4 flex size-12 items-center justify-center rounded-full bg-muted">
            <Lightbulb className="size-5 text-muted-foreground" />
          </div>
          <p className="mt-1 max-w-xs text-xs text-muted-foreground">{t("inspiration.desktop_only")}</p>
        </div>
      ) : (
        <div className="flex flex-1 flex-col overflow-hidden">
          {allTags.length > 0 && (
            <div className="flex shrink-0 flex-wrap gap-1.5 border-b border-border/40 px-4 py-2.5">
              <button
                type="button"
                onClick={() => setActiveTag(null)}
                className={cn(
                  "rounded-full px-2.5 py-1 text-3xs transition-colors",
                  activeTag === null
                    ? "bg-foreground/80 text-background"
                    : "bg-muted/60 text-muted-foreground hover:bg-muted",
                )}
              >
                {t("inspiration.filter_all")}
              </button>
              {allTags.map((tag) => (
                <button
                  key={tag}
                  type="button"
                  onClick={() => setActiveTag(activeTag === tag ? null : tag)}
                  className={cn(
                    "rounded-full px-2.5 py-1 text-3xs transition-colors",
                    activeTag === tag
                      ? "bg-foreground/80 text-background"
                      : "bg-muted/60 text-muted-foreground hover:bg-muted",
                  )}
                >
                  #{tag}
                </button>
              ))}
            </div>
          )}

          <div className="flex-1 overflow-y-auto px-4 py-4">
            {isLoading ? (
              <div className="flex h-full items-center justify-center">
                <Loader2 className="size-5 animate-spin text-muted-foreground" />
              </div>
            ) : filtered.length === 0 ? (
              <div className="flex h-full flex-col items-center justify-center text-center">
                <div className="mx-auto mb-4 flex size-12 items-center justify-center rounded-full bg-muted">
                  <Lightbulb className="size-5 text-muted-foreground" />
                </div>
                <h3 className="text-sm font-medium text-foreground">{t("inspiration.title")}</h3>
                <p className="mt-1 max-w-xs text-xs text-muted-foreground">
                  {t("inspiration.empty_hint")}
                </p>
                <Button size="sm" className="mt-4 gap-1.5" onClick={openCapture}>
                  <Plus className="size-3.5" />
                  {t("inspiration.new")}
                </Button>
              </div>
            ) : view === "masonry" ? (
              <div className="mx-auto flex max-w-5xl gap-3">
                {masonryColumns.map((column, columnIndex) => (
                  <div key={columnIndex} className="flex min-w-0 flex-1 flex-col gap-3">
                    {column.map((record, index) => renderCard(record, index))}
                  </div>
                ))}
              </div>
            ) : (
              <div className="mx-auto max-w-2xl">
                {listGroups.map((group) => (
                  <div key={group.label} className="mb-2">
                    <div className="sticky top-0 z-10 -mx-1 mb-2 bg-background/80 px-1 py-1 text-3xs font-medium text-muted-foreground backdrop-blur">
                      {group.label}
                    </div>
                    <div className="flex flex-col gap-3">
                      {group.records.map((record) => (
                        <div key={record.id} className="group relative">
                          <ListCard
                            record={record}
                            dateTime={formatCardDateTime(record.createdAt, i18n.language)}
                            retrying={retryingId === record.id}
                            onRetry={(id) => {
                              setRetryingId(id);
                              retryMutation.mutate(id);
                            }}
                          />
                          <button
                            type="button"
                            title={t("inspiration.delete")}
                            disabled={deletingId === record.id}
                            onClick={() => {
                              setDeletingId(record.id);
                              deleteMutation.mutate(record.id);
                            }}
                            className="absolute right-2 top-2 rounded-md p-1 text-muted-foreground/50 opacity-0 transition-opacity hover:bg-muted hover:text-foreground group-hover:opacity-100"
                          >
                            {deletingId === record.id ? (
                              <Loader2 className="size-3.5 animate-spin" />
                            ) : (
                              <Trash2 className="size-3.5" />
                            )}
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
