"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { motion, useReducedMotion } from "motion/react";
import { cn } from "@lynse/ui/lib/utils";
import { Button } from "@lynse/ui/components/ui/button";
import { toast } from "sonner";
import { useTranslation } from "@lynse/core/i18n/react";
import {
  AlertCircle,
  BookOpen,
  LayoutGrid,
  Lightbulb,
  Loader2,
  Plus,
  RefreshCw,
  Trash2,
  ShieldCheck,
} from "../icons";
import { getDesktopInspirationApi } from "./desktop-api";
import { useInspirationCaptureStore } from "./capture-store";
import { useInspirationDetailStore } from "./detail-store";
import { collectTags, splitByHashtags } from "./tags";
import { dayGroupLabel, formatCardDateTime } from "./format";
import { InspirationAudioPlayer } from "./audio-player";
import { InspirationLightbox, type LightboxSlide } from "./lightbox";
import { InspirationDetailDialog } from "./detail-dialog";
import { InspirationFiles, InspirationLockButton, ProtectedRecordLabel } from "./privacy-controls";
import { ensureInspirationUnlocked, openPrivacyDialog, privacyError, useInspirationPrivacy } from "./privacy-state";
import { useInspirationCloud } from "./use-inspiration-cloud";
import type { InspirationImage, InspirationRecord } from "./types";

const VIEW_STORAGE_KEY = "lynse_inspiration_view_v1";
type FeedView = "journal" | "masonry";

function readStoredView(): FeedView {
  if (typeof window === "undefined") return "journal";
  // "list" was the pre-journal timeline; migrate it to the journal view.
  return window.localStorage.getItem(VIEW_STORAGE_KEY) === "masonry" ? "masonry" : "journal";
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

function imageKey(recordId: string, file: string): string {
  return `${recordId}/${file}`;
}

/** One saved image served through `local-media://`, with skeleton while loading. */
function RecordImage({
  record,
  image,
  className,
  onResolved,
  onClick,
  title,
}: {
  record: InspirationRecord;
  image: InspirationImage;
  className?: string;
  onResolved?: (key: string, url: string) => void;
  /** When set the image becomes a click target (lightbox), stopping card nav. */
  onClick?: () => void;
  title?: string;
}) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    void getDesktopInspirationApi()?.getImageUrl(record.id, image.file).then((next) => {
      if (!cancelled && next) {
        setUrl(next);
        onResolved?.(imageKey(record.id, image.file), next);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [image.file, onResolved, record.id]);

  if (!url) return <div className={cn("animate-pulse bg-muted", className)} />;
  if (onClick) {
    return (
      <button
        type="button"
        title={title}
        onClick={(event) => {
          event.stopPropagation();
          onClick();
        }}
        className={cn("block cursor-zoom-in", className)}
      >
        <img src={url} alt="" loading="lazy" className={cn("size-full", className?.includes("object-cover") ? "object-cover" : "object-contain")} />
      </button>
    );
  }
  return <img src={url} alt="" loading="lazy" className={className} />;
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

/** Per-card masonry layout, picked by `masonryLayout`. */
interface MasonryCardLayout {
  /** Cover frame ratio — empty when the record has no images. */
  ratioClass: string;
  /** Text clamp applied to the card body. */
  clampClass: string;
  /** Edge-to-edge cover (no inset padding) for a mixed-card feel. */
  bare: boolean;
}

/** Deterministic pseudo-random 0..1 from a string seed. Stable for a given
 * record id so the scattered layout doesn't reshuffle on re-render. */
function seededUnit(seed: string): number {
  let hash = 2166136261;
  for (let i = 0; i < seed.length; i += 1) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) / 4294967296;
}

const COVER_RATIOS = ["aspect-[4/3]", "aspect-square", "aspect-[3/4]", "aspect-[4/5]"] as const;
const SHORT_CLAMPS = ["line-clamp-2", "line-clamp-3", "line-clamp-4"] as const;
const LONG_CLAMPS = ["line-clamp-4", "line-clamp-6", "line-clamp-[8]"] as const;

/** Pick a pseudo-random element of a non-empty list; `unit` is 0..1. */
function pickFrom<T>(list: readonly T[], unit: number): T {
  const index = Math.min(Math.floor(unit * list.length), list.length - 1);
  return list[index] as T;
}

/** Content-driven masonry variety: cover ratio, text clamp and card chrome
 * are pseudo-randomly picked per record but biased by the content — long
 * notes pair with shorter covers, text-only records clamp later so they
 * don't collapse into stubs. */
function masonryLayout(record: InspirationRecord): MasonryCardLayout {
  const hasCover = (record.images?.length ?? 0) > 0;
  const textLength = record.text.trim().length;
  const seed = seededUnit(record.id);
  // Long text pairs with a short cover; short notes can afford tall ones.
  const tallness = textLength > 140 ? seed * 0.5 : seed;
  const clampSeed = seededUnit(`${record.id}:clamp`);
  return {
    ratioClass: hasCover ? pickFrom(COVER_RATIOS, tallness) : "",
    clampClass: hasCover ? pickFrom(SHORT_CLAMPS, clampSeed) : pickFrom(LONG_CLAMPS, clampSeed),
    bare: hasCover && seededUnit(`${record.id}:chrome`) > 0.65,
  };
}

/** Xiaohongshu-style waterfall card: cover image, clamped text, meta row.
 *  The layout comes pre-computed from `masonryLayout` so cards vary
 *  organically instead of reading as one uniform grid. */
function MasonryCard({ record, layout, dateTime, cardCountLabel, onImageResolved, onOpen, onOpenImage }: {
  record: InspirationRecord;
  layout: MasonryCardLayout;
  dateTime: string;
  cardCountLabel: string | null;
  onImageResolved: (key: string, url: string) => void;
  onOpen: () => void;
  onOpenImage: (index: number) => void;
}) {
  const cover = record.images?.[0];
  return (
    <article
      className={cn(
        "cursor-pointer overflow-hidden rounded-xl border border-border/50 bg-card/60 transition-shadow hover:shadow-md",
        layout.bare ? "p-0" : "p-2.5",
      )}
      onClick={onOpen}
    >
      {cover && (
        <div className={cn("relative overflow-hidden", !layout.bare && "mb-2 rounded-lg")}>
          <RecordImage
            record={record}
            image={cover}
            className={cn("w-full object-cover", layout.ratioClass)}
            onResolved={onImageResolved}
            onClick={() => onOpenImage(0)}
            title={cardCountLabel ?? undefined}
          />
          {cardCountLabel && (
            <span className="pointer-events-none absolute bottom-1.5 right-1.5 rounded-full bg-black/50 px-2 py-0.5 text-3xs text-white">
              {cardCountLabel}
            </span>
          )}
        </div>
      )}
      <div className={cn(layout.bare && "px-2.5 pb-2.5 pt-2")}>
        {record.protection === "e2ee" && <ProtectedRecordLabel />}
        {record.text.trim() && (
          <HighlightedText text={record.text} className={cn("text-[13px]", layout.clampClass)} />
        )}
        <div className="mt-2 flex flex-col gap-1.5">
          <TagChips record={record} />
          <div className="flex items-center justify-between">
            <span className="text-3xs text-muted-foreground/70">{dateTime}</span>
            {record.audio && (
              <span onClick={(event) => event.stopPropagation()}>
                <InspirationAudioPlayer record={record} />
              </span>
            )}
          </div>
        </div>
      </div>
    </article>
  );
}

/** Media block of a journal card: 1 image full-width, else a 2-column grid of
 *  up to four photos with a "+N" overlay on the last cell. */
function JournalMedia({
  record,
  cardCountLabel,
  onImageResolved,
  onOpenImage,
}: {
  record: InspirationRecord;
  cardCountLabel: string | null;
  onImageResolved: (key: string, url: string) => void;
  onOpenImage: (index: number) => void;
}) {
  const images = record.images ?? [];
  if (images.length === 0) return null;
  const cover = images[0];
  if (!cover) return null;
  if (images.length === 1) {
    return (
      <div className="relative">
        <RecordImage
          record={record}
          image={cover}
          className="h-48 w-full object-cover"
          onResolved={onImageResolved}
          onClick={() => onOpenImage(0)}
          title={cardCountLabel ?? undefined}
        />
        {cardCountLabel && (
          <span className="pointer-events-none absolute bottom-2 right-2 rounded-full bg-black/50 px-2 py-0.5 text-3xs text-white">
            {cardCountLabel}
          </span>
        )}
      </div>
    );
  }
  const shown = images.slice(0, 4);
  return (
    <div className="grid grid-cols-2 gap-px bg-border/40">
      {shown.map((image, index) => (
        <div key={image.file} className="relative">
          <RecordImage
            record={record}
            image={image}
            className="h-36 w-full object-cover"
            onResolved={onImageResolved}
            onClick={() => onOpenImage(index)}
            title={cardCountLabel ?? undefined}
          />
          {index === shown.length - 1 && images.length > 4 && (
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                onOpenImage(index);
              }}
              className="absolute inset-0 flex items-center justify-center bg-black/45 text-lg font-medium text-white"
            >
              +{images.length - 3}
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

/** Apple-Journal-style card: media on top, text + tags + voice below, in a
 *  rounded sheet card floating on the day column. */
function JournalCard({ record, dateTime, cardCountLabel, onImageResolved, onOpen, onOpenImage, onRetry, retrying }: {
  record: InspirationRecord;
  dateTime: string;
  cardCountLabel: string | null;
  onImageResolved: (key: string, url: string) => void;
  onOpen: () => void;
  onOpenImage: (index: number) => void;
  onRetry: (id: string) => void;
  retrying: boolean;
}) {
  return (
    <article
      className="cursor-pointer overflow-hidden rounded-2xl border border-border/50 bg-card shadow-[0_1px_2px_rgba(0,0,0,0.03)] transition-shadow hover:shadow-md"
      onClick={onOpen}
    >
      <JournalMedia
        record={record}
        cardCountLabel={cardCountLabel}
        onImageResolved={onImageResolved}
        onOpenImage={onOpenImage}
      />
      <div className="p-4">
        <span className="text-3xs font-medium tracking-wide text-muted-foreground/70 uppercase">
          {dateTime}
        </span>
        {record.protection === "e2ee" && <ProtectedRecordLabel />}
        <InspirationFiles record={record} />
        {record.text.trim() && <HighlightedText text={record.text} className="mt-1.5 text-sm" />}
        <div className="mt-2.5 flex flex-col items-start gap-2.5">
          {record.audio && (
            <span onClick={(event) => event.stopPropagation()}>
              <InspirationAudioPlayer record={record} />
            </span>
          )}
          <TagChips record={record} />
          <InspirationTranscript record={record} onRetry={onRetry} retrying={retrying} />
        </div>
      </div>
    </article>
  );
}

/** Loading skeleton matching the journal layout: a centered day header over
 *  varied-height card blocks, so the feed doesn't jump when data arrives. */
function FeedSkeleton() {
  return (
    <div className="mx-auto max-w-2xl pb-16" aria-hidden>
      <div className="mb-3 flex items-baseline justify-center gap-2">
        <span className="h-5 w-14 animate-pulse rounded bg-muted-foreground/10" />
        <span className="h-3 w-20 animate-pulse rounded bg-muted-foreground/10" />
      </div>
      <div className="flex flex-col gap-3.5">
        {[176, 96, 232, 128].map((mediaHeight, i) => (
          <div
            key={i}
            className="overflow-hidden rounded-2xl border border-border/50 bg-card shadow-[0_1px_2px_rgba(0,0,0,0.03)]"
          >
            <div
              className="animate-pulse bg-muted-foreground/10"
              style={{ height: mediaHeight }}
            />
            <div className="p-4">
              <span className="block h-2.5 w-20 animate-pulse rounded bg-muted-foreground/10" />
              <span className="mt-3 block h-3.5 w-full animate-pulse rounded bg-muted-foreground/10" />
              <span
                className="mt-2 block h-3.5 animate-pulse rounded bg-muted-foreground/10"
                style={{ width: `${45 + seededUnit(String(i)) * 40}%` }}
              />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/** flomo-style feed with Xiaohongshu masonry and grouped list layouts. */
export function InspirationPage() {
  const { t, i18n } = useTranslation();
  const queryClient = useQueryClient();
  const openCapture = useInspirationCaptureStore((state) => state.openCapture);
  const openDetail = useInspirationDetailStore((state) => state.openDetail);
  const [view, setView] = useState<FeedView>(readStoredView);
  const [activeTag, setActiveTag] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [retryingId, setRetryingId] = useState<string | null>(null);
  const [imageUrls, setImageUrls] = useState<Record<string, string>>({});
  const [lightbox, setLightbox] = useState<{ record: InspirationRecord; index: number } | null>(null);
  const reduceMotion = useReducedMotion();
  const desktopApi = getDesktopInspirationApi();
  const columns = useColumnCount();
  const accountScope = useInspirationPrivacy((s) => s.accountScope);
  const generation = useInspirationPrivacy((s) => s.generation);
  const binding = useInspirationPrivacy((s) => s.binding);
  useEffect(() => { setImageUrls({}); setLightbox(null); setActiveTag(null); }, [accountScope, generation, binding]);
  const queryKey = ["inspirations", accountScope];
  const openRecord = async (record: InspirationRecord) => {
    try { if (record.protection === "e2ee" && !(await ensureInspirationUnlocked())) return; openDetail(record.id); } catch (error) { toast.error(privacyError(error, t)); }
  };
  // Lynse Memory cloud sync (plan T7/T8): binding, trigger points and the
  // 仅本机/同步中/已同步/冲突 status for the header pill.
  const { status: cloudStatus, scheduleSync } = useInspirationCloud();

  const { data: inspirations = [], isLoading } = useQuery({
    queryKey,
    queryFn: () => desktopApi!.list(),
    enabled: Boolean(desktopApi) && !binding,
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
    mutationFn: async (id: string) => {
      const record = inspirations.find((item) => item.id === id);
      if (record?.protection === "e2ee" && !(await ensureInspirationUnlocked())) throw new Error("vault_locked");
      return desktopApi!.delete(id);
    },
    // Optimistic removal: the card disappears immediately instead of sitting
    // with a spinner; the snapshot is restored if the delete fails.
    onMutate: async (id: string) => {
      await queryClient.cancelQueries({ queryKey: ["inspirations"] });
      const previous = queryClient.getQueryData<InspirationRecord[]>(queryKey);
      queryClient.setQueryData<InspirationRecord[]>(queryKey, (old) =>
        (old ?? []).filter((record) => record.id !== id),
      );
      return { previous };
    },
    onError: (_error, _id, context) => {
      if (context?.previous) {
        queryClient.setQueryData(queryKey, context.previous);
      }
      toast.error(t("inspiration.delete_failed"));
    },
    onSuccess: () => {
      toast.success(t("inspiration.toast_deleted"));
      void invalidate();
      scheduleSync();
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

  // Any local change (capture sheet saves, edits, retries) lands in this
  // list — debounce a sync pass whenever the newest updatedAt moves.
  const lastActivity = useMemo(
    () => inspirations.map((record) => record.updatedAt).sort().at(-1) ?? "",
    [inspirations],
  );
  const lastActivityRef = useRef(lastActivity);
  useEffect(() => {
    if (lastActivity && lastActivity !== lastActivityRef.current) {
      lastActivityRef.current = lastActivity;
      scheduleSync();
    }
  }, [lastActivity, scheduleSync]);

  const setViewAndPersist = (next: FeedView) => {
    setView(next);
    try {
      window.localStorage.setItem(VIEW_STORAGE_KEY, next);
    } catch {
      /* storage unavailable — the in-memory state still works */
    }
  };

  const trackImageUrl = useCallback((key: string, url: string) => {
    setImageUrls((prev) => (prev[key] === url ? prev : { ...prev, [key]: url }));
  }, []);

  /** Slides for the lightbox: every image of the record we have a URL for. */
  const lightboxSlides = (record: InspirationRecord): LightboxSlide[] =>
    (record.images ?? [])
      .map((image) => ({ url: imageUrls[imageKey(record.id, image.file)] ?? "", label: image.file }))
      .filter((slide) => slide.url);

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

  const renderCard = (record: InspirationRecord, index: number) => {
    const extraCount = Math.max(0, (record.images?.length ?? 0) - 1);
    return (
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
        <MasonryCard
          record={record}
          layout={masonryLayout(record)}
          dateTime={formatCardDateTime(record.createdAt, i18n.language)}
          cardCountLabel={extraCount > 0 ? t("inspiration.images_count", { count: extraCount + 1 }) : null}
          onImageResolved={trackImageUrl}
          onOpen={() => void openRecord(record)}
          onOpenImage={(imageIndex) => setLightbox({ record, index: imageIndex })}
        />
        <InspirationLockButton record={record} className="absolute right-10 top-2 z-10 rounded-md bg-background/80 p-1.5 text-muted-foreground hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring" />
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
  };

  return (
    <div className="relative flex h-full flex-col">
      <header
        className="flex shrink-0 items-center justify-between border-b border-border/50 px-6 py-3 select-none"
        data-tauri-drag-region
      >
        <h2 className="text-sm font-medium text-foreground">{t("inspiration.title")}</h2>
        {desktopApi && (
          <div className="flex items-center gap-2">
            {desktopApi.privacy && <Button variant="ghost" size="icon-sm" title={t("inspiration_private.manage")} aria-label={t("inspiration_private.manage")} onClick={() => void openPrivacyDialog("manage")}><ShieldCheck className="size-4" /></Button>}
            {cloudStatus?.bound && (
              <button
                type="button"
                title={cloudStatus.lastError ?? cloudStatus.apiBase ?? ""}
                onClick={() => void navigator.clipboard?.writeText(JSON.stringify(cloudStatus))}
                className={cn(
                  "rounded-full px-2 py-0.5 text-3xs transition-colors",
                  cloudStatus.paused
                    ? "bg-amber-500/15 text-amber-600"
                    : (cloudStatus.conflicts ?? 0) > 0
                      ? "bg-destructive/10 text-destructive"
                      : (cloudStatus.pendingOps ?? 0) > 0
                        ? "bg-muted text-muted-foreground"
                        : "bg-emerald-500/10 text-emerald-600",
                )}
              >
                {cloudStatus.paused
                  ? t("inspiration.cloud_paused")
                  : (cloudStatus.conflicts ?? 0) > 0
                    ? t("inspiration.cloud_conflicts", { count: cloudStatus.conflicts ?? 0 })
                    : (cloudStatus.pendingOps ?? 0) > 0
                      ? t("inspiration.cloud_syncing", { count: cloudStatus.pendingOps ?? 0 })
                      : t("inspiration.cloud_synced")}
              </button>
            )}
            <div className="flex items-center rounded-lg border border-border/50 p-0.5">
              <button
                type="button"
                title={t("inspiration.view_journal")}
                onClick={() => setViewAndPersist("journal")}
                className={cn(
                  "rounded-md p-1 transition-colors",
                  view === "journal" ? "bg-foreground/80 text-background" : "text-muted-foreground hover:text-foreground",
                )}
              >
                <BookOpen className="size-3.5" />
              </button>
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
            </div>
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
            <div className="flex shrink-0 flex-wrap gap-1.5 border-b border-border/40 px-6 py-2.5">
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

          <div className="flex-1 overflow-y-auto overscroll-contain px-6 py-4">
            {isLoading ? (
              <FeedSkeleton />
            ) : filtered.length === 0 ? (
              <div className="flex h-full flex-col items-center justify-center text-center">
                <div className="mx-auto mb-4 flex size-12 items-center justify-center rounded-full bg-muted">
                  <Lightbulb className="size-5 text-muted-foreground" />
                </div>
                <h3 className="text-sm font-medium text-foreground">{t("inspiration.title")}</h3>
                <p className="mt-1 max-w-xs text-xs text-muted-foreground">
                  {t("inspiration.empty_hint")}
                </p>
                <Button size="sm" className="mt-4 gap-1.5" onClick={() => openCapture()}>
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
              /* Journal timeline: day columns with centered serif day headers
                 (今天 · 9月9日 周二), each holding the day's cards. */
              <div className="mx-auto max-w-2xl pb-16">
                {listGroups.map((group) => {
                  const first = group.records[0];
                  const dateLabel = first
                    ? new Intl.DateTimeFormat(i18n.language, {
                        month: "long",
                        day: "numeric",
                        weekday: "short",
                      }).format(new Date(first.createdAt))
                    : "";
                  return (
                    <section key={group.label} className="mb-7">
                      <div className="mb-3 flex items-baseline justify-center gap-2">
                        <h3 className="font-serif text-lg font-semibold text-foreground">
                          {group.label}
                        </h3>
                        <span className="text-xs text-muted-foreground">{dateLabel}</span>
                      </div>
                      <div className="flex flex-col gap-3.5">
                        {group.records.map((record) => (
                          <div key={record.id} className="group relative">
                            <JournalCard
                              record={record}
                              dateTime={formatCardDateTime(record.createdAt, i18n.language)}
                              cardCountLabel={
                                record.images && record.images.length > 4
                                  ? t("inspiration.images_count", { count: record.images.length })
                                  : null
                              }
                              onImageResolved={trackImageUrl}
                              onOpen={() => void openRecord(record)}
                              onOpenImage={(imageIndex) => setLightbox({ record, index: imageIndex })}
                              retrying={retryingId === record.id}
                              onRetry={(id) => {
                                setRetryingId(id);
                                retryMutation.mutate(id);
                              }}
                            />
                            <InspirationLockButton record={record} className="absolute right-10 top-2.5 z-10 rounded-md bg-background/80 p-1.5 text-muted-foreground hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring" />
                            <button
                              type="button"
                              title={t("inspiration.delete")}
                              disabled={deletingId === record.id}
                              onClick={() => {
                                setDeletingId(record.id);
                                deleteMutation.mutate(record.id);
                              }}
                              className="absolute right-2.5 top-2.5 rounded-md bg-background/70 p-1 text-muted-foreground/60 opacity-0 backdrop-blur transition-opacity hover:bg-muted hover:text-foreground group-hover:opacity-100"
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
                    </section>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Journal-style compose button: the bottom-center "+" pops the capture
          sheet (same bottom-up panel as the home page's 记录 entry). Hidden
          while the feed is empty — the empty state carries its own inline
          button, so the page never shows two capture entries at once. */}
      {desktopApi && filtered.length > 0 && (
        <div className="pointer-events-none absolute inset-x-0 bottom-5 z-20 flex justify-center">
          <Button
            size="icon"
            aria-label={t("inspiration.new")}
            className="pointer-events-auto size-12 rounded-full shadow-lg shadow-primary/30"
            onClick={() => openCapture()}
          >
            <Plus className="size-5" />
          </Button>
        </div>
      )}

      <InspirationLightbox
        key={`${accountScope}:${generation}`}
        slides={lightbox ? lightboxSlides(lightbox.record) : []}
        index={lightbox ? lightbox.index : null}
        onIndexChange={(index) => setLightbox((current) => (current ? { ...current, index } : current))}
        onClose={() => setLightbox(null)}
      />

      <InspirationDetailDialog />
    </div>
  );
}
