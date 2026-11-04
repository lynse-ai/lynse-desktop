import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { AlertCircle, Check, Clock, Loader2, Pencil, Play, RefreshCw, X } from "../icons";
import { Button } from "@lynse/ui/components/ui/button";
import { Input } from "@lynse/ui/components/ui/input";
import { Textarea } from "@lynse/ui/components/ui/textarea";
import {
  computeTranscriptHash,
  editChapter,
  hasManualEdits,
  isChapterDocumentStale,
  type ChapterSegment,
} from "./semantic-chapters";
import type { ChapterDocument, ChaptersStatus, SemanticChapter } from "./types";

function formatChapterTime(ms: number | null): string {
  if (ms == null || ms < 0) return "--:--";
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function chapterSegments(chapter: SemanticChapter, allSegments: ChapterSegment[]): ChapterSegment[] {
  const start = allSegments.findIndex((segment) => segment.id === chapter.startSegmentId);
  const end = allSegments.findIndex((segment) => segment.id === chapter.endSegmentId);
  if (start < 0 || end < start) return [];
  return allSegments.slice(start, end + 1);
}

function renderSpeakerMentions(
  text: string,
  speakers: string[],
  expandedKey: string,
  onToggleSpeaker: (key: string) => void,
): ReactNode[] {
  if (!text) return [];
  const [speaker, ...remainingSpeakers] = speakers;
  if (!speaker) return [text];

  const boundary = String.raw`(^|[^\p{L}\p{N}_])`;
  const trailingBoundary = String.raw`(?=$|[^\p{L}\p{N}_])`;
  const pattern = new RegExp(`${boundary}(${escapeRegExp(speaker)})${trailingBoundary}`, "gu");
  const nodes: ReactNode[] = [];
  let cursor = 0;
  let mentionIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text)) !== null) {
    const prefix = match[1] ?? "";
    const mentionStart = match.index + prefix.length;
    nodes.push(text.slice(cursor, mentionStart));
    const mentionKey = `${expandedKey}:${mentionStart}`;
    nodes.push(
      <button
        key={mentionKey}
        type="button"
        onClick={() => onToggleSpeaker(mentionKey)}
        className="text-primary underline decoration-primary/50 underline-offset-2 transition-colors hover:decoration-primary"
      >
        {speaker}
      </button>,
    );
    cursor = mentionStart + speaker.length;
    mentionIndex += 1;
    if (match.index === pattern.lastIndex) pattern.lastIndex += 1;
  }
  const remaining = text.slice(cursor);
  nodes.push(...renderSpeakerMentions(remaining, remainingSpeakers, `${expandedKey}:${mentionIndex}`, onToggleSpeaker));
  return nodes;
}

export interface ChaptersPanelProps {
  /** Canonical view segments (localRecordToTranscription.records) — the same
   *  shape generation hashed, so staleness checks agree with the engine. */
  segments: ChapterSegment[];
  document: ChapterDocument | null;
  status: ChaptersStatus | undefined;
  error: string | null;
  /** True while a generation request is in flight (drives button spinners). */
  busy: boolean;
  hasTranscript: boolean;
  onGenerate: (force: boolean) => void;
  onSeekChapter: (chapter: SemanticChapter) => void;
  onSaveEdits: (document: ChapterDocument) => Promise<boolean>;
}

/**
 * 「章节」tab body: AI semantic chapters with click-to-seek. Renders all six
 * lifecycle states (idle / generating / ready / error / stale / cloud-unsupported);
 * seek is disabled for chapters whose anchor segments carry no timestamps.
 */
export function ChaptersPanel({
  segments,
  document,
  status,
  error,
  busy,
  hasTranscript,
  onGenerate,
  onSeekChapter,
  onSaveEdits,
}: ChaptersPanelProps) {
  const { t } = useTranslation();
  const [currentHash, setCurrentHash] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [editSummary, setEditSummary] = useState("");
  const [confirmingRegenerate, setConfirmingRegenerate] = useState(false);
  const [savingEdits, setSavingEdits] = useState(false);
  const [expandedSpeakers, setExpandedSpeakers] = useState<Record<string, boolean>>({});

  const toggleSpeaker = (key: string) => {
    setExpandedSpeakers((current) => ({ ...current, [key]: !current[key] }));
  };

  // Staleness is derived, not stored: hash the live segments and compare.
  useEffect(() => {
    let cancelled = false;
    if (!hasTranscript) {
      setCurrentHash(null);
      return;
    }
    void computeTranscriptHash(segments).then((hash) => {
      if (!cancelled) setCurrentHash(hash);
    });
    return () => {
      cancelled = true;
    };
  }, [segments, hasTranscript]);

  const stale = useMemo(
    () => isChapterDocumentStale(document, currentHash ?? document?.transcriptHash ?? ""),
    [document, currentHash],
  );
  const chapters = document?.chapters ?? [];
  const generating = busy || status === "generating";
  const manualEdits = hasManualEdits(document);

  if (!hasTranscript) {
    return <CloudUnsupportedState label={t("workspace.chapters_need_transcript")} />;
  }

  if (generating) {
    return (
      <div className="flex flex-1 items-center justify-center py-12">
        <div className="flex flex-col items-center gap-3 text-center">
          <div className="relative flex size-12 items-center justify-center">
            <span className="absolute size-12 rounded-full border border-primary/20" />
            <span className="absolute size-10 animate-ping rounded-full bg-primary/10" />
            <Loader2 className="relative size-5 animate-spin text-primary" />
          </div>
          <p className="text-sm font-medium">{t("workspace.chapters_generating")}</p>
          <p className="mt-1 text-xs text-muted-foreground">{t("workspace.chapters_generating_hint")}</p>
        </div>
      </div>
    );
  }

  if (!document && status === "error") {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 py-10 text-center">
        <div className="flex size-12 items-center justify-center rounded-2xl bg-destructive/10 text-destructive">
          <AlertCircle className="size-6" />
        </div>
        <p className="text-sm text-muted-foreground">{error || t("workspace.chapters_failed")}</p>
        <Button size="sm" variant="outline" onClick={() => onGenerate(true)} disabled={busy}>
          <RefreshCw className="size-3.5" />
          {t("workspace.chapters_retry")}
        </Button>
      </div>
    );
  }

  if (chapters.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 py-10 text-center">
        <div className="flex size-12 items-center justify-center rounded-2xl bg-muted text-muted-foreground">
          <Clock className="size-6" />
        </div>
        <p className="max-w-xs text-sm text-muted-foreground">{t("workspace.chapters_empty_hint")}</p>
        <Button size="sm" onClick={() => onGenerate(false)} disabled={busy}>
          <Clock className="size-3.5" />
          {t("workspace.chapters_generate")}
        </Button>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {stale && (
        <div className="mb-2 flex w-full shrink-0 flex-wrap items-center gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-foreground">
          <span>{t("workspace.chapters_stale_banner")}</span>
          {manualEdits && <span className="text-muted-foreground">· {t("workspace.chapters_manual_edits_kept")}</span>}
          <button
            type="button"
            disabled={busy}
            onClick={() => onGenerate(true)}
            className="rounded-md bg-accent px-2 py-0.5 text-xs text-accent-foreground disabled:opacity-60"
          >
            {t("workspace.chapters_regenerate")}
          </button>
        </div>
      )}
      <div className="mb-2 flex shrink-0 items-center justify-between">
        <p className="text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
          {t("workspace.chapters_count", { count: chapters.length })}
        </p>
        {confirmingRegenerate ? (
          <div className="flex items-center gap-1.5">
            <span className="text-2xs text-muted-foreground">{t("workspace.chapters_regenerate_confirm")}</span>
            <Button
              size="sm"
              variant="destructive"
              className="h-6 px-2 text-2xs"
              onClick={() => {
                setConfirmingRegenerate(false);
                onGenerate(true);
              }}
            >
              {t("workspace.chapters_confirm")}
            </Button>
            <Button size="sm" variant="ghost" className="h-6 px-2 text-2xs" onClick={() => setConfirmingRegenerate(false)}>
              {t("workspace.chapters_cancel")}
            </Button>
          </div>
        ) : (
          <Button
            size="sm"
            variant="ghost"
            className="h-6 gap-1 px-2 text-2xs text-muted-foreground"
            disabled={busy}
            onClick={() => (manualEdits ? setConfirmingRegenerate(true) : onGenerate(true))}
          >
            <RefreshCw className="size-3" />
            {t("workspace.chapters_regenerate")}
          </Button>
        )}
      </div>
      <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto pb-4">
        <div className="space-y-7">
        {chapters.map((chapter) => {
          const seekable = chapter.startMs != null;
          const editing = editingId === chapter.id;
          if (editing) {
            return (
              <div key={chapter.id} className="rounded-lg border border-primary/40 bg-accent/30 p-3">
                <Input
                  value={editTitle}
                  onChange={(event) => setEditTitle(event.target.value)}
                  className="h-8 text-sm font-medium"
                  placeholder={t("workspace.chapters_title_placeholder")}
                  autoFocus
                />
                <Textarea
                  value={editSummary}
                  onChange={(event) => setEditSummary(event.target.value)}
                  className="mt-2 min-h-16 text-xs"
                  placeholder={t("workspace.chapters_summary_placeholder")}
                />
                <div className="mt-2 flex items-center justify-end gap-1.5">
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 px-2 text-xs"
                    onClick={() => setEditingId(null)}
                  >
                    <X className="size-3.5" />
                    {t("workspace.chapters_cancel")}
                  </Button>
                  <Button
                    size="sm"
                    className="h-7 gap-1 px-2 text-xs"
                    disabled={savingEdits}
                    onClick={async () => {
                      if (!document) return;
                      setSavingEdits(true);
                      const ok = await onSaveEdits(
                        editChapter(document, chapter.id, { title: editTitle, summary: editSummary }),
                      );
                      setSavingEdits(false);
                      if (ok) setEditingId(null);
                    }}
                  >
                    <Check className="size-3.5" />
                    {t("workspace.chapters_save")}
                  </Button>
                </div>
              </div>
            );
          }
          const spanSegments = chapterSegments(chapter, segments);
          const speakers = [...new Set(
            spanSegments
              .map((segment) => segment.speaker?.trim())
              .filter((speaker): speaker is string => !!speaker && speaker.length > 0),
          )].sort((left, right) => right.length - left.length);
          return (
            <section key={chapter.id} className="group">
              <button
                type="button"
                disabled={!seekable}
                onClick={() => {
                  if (seekable && chapter.startMs != null) onSeekChapter(chapter);
                }}
                className="inline-flex items-center gap-1 rounded bg-primary/10 px-1.5 py-0.5 text-2xs font-medium tabular-nums text-primary transition-colors hover:bg-primary/15 disabled:cursor-default disabled:opacity-70"
                title={seekable ? t("workspace.chapters_seek") : undefined}
              >
                <Play className="size-2.5" />
                {formatChapterTime(chapter.startMs)}
              </button>
              <div className="mt-1 flex items-center gap-1">
                <h3 className="inline rounded bg-primary/10 px-1 text-base font-semibold leading-7 decoration-primary/40 underline-offset-4">
                  {chapter.title || t("workspace.chapters_untitled")}
                </h3>
                <button
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation();
                    setEditingId(chapter.id);
                    setEditTitle(chapter.title);
                    setEditSummary(chapter.summary);
                  }}
                  className="shrink-0 rounded p-1 text-muted-foreground opacity-0 transition-opacity hover:bg-accent hover:text-foreground group-hover:opacity-100"
                  title={t("workspace.chapters_edit")}
                >
                  <Pencil className="size-3" />
                </button>
              </div>
              {chapter.summary && (
                <p className="mt-2 text-sm leading-7 text-foreground">
                  {renderSpeakerMentions(chapter.summary, speakers, chapter.id, toggleSpeaker)}
                </p>
              )}
              {Object.entries(expandedSpeakers)
                .filter(([key, expanded]) => expanded && key.startsWith(`${chapter.id}:`) && speakers.some((speaker) => key.endsWith(`:${speaker}`)))
                .map(([key]) => {
                  const speaker = speakers.find((item) => key.endsWith(`:${item}`));
                  if (!speaker) return null;
                  const speakerLines = spanSegments.filter((segment) => segment.speaker?.trim() === speaker);
                  return (
                    <div key={key} className="mt-3 space-y-2 border-l-2 border-primary/30 pl-3">
                      {speakerLines.map((segment) => (
                        <p key={segment.id} className="text-xs leading-6 text-muted-foreground">
                          {segment.text}
                        </p>
                      ))}
                    </div>
                  );
                })}
            </section>
          );
        })}
        </div>
      </div>
    </div>
  );
}

/** Shared empty-state shell for "not available here" cases. */
function CloudUnsupportedState({ label }: { label: string }) {
  return (
    <div className="flex items-center justify-center py-12">
      <p className="text-xs text-muted-foreground">{label}</p>
    </div>
  );
}
