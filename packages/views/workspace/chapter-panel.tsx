import { useEffect, useMemo, useState } from "react";
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
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`;
}

export interface ChaptersPanelProps {
  /** Canonical view segments (localRecordToTranscription.records) — the same
   *  shape generation hashed, so staleness checks agree with the engine. */
  segments: ChapterSegment[];
  document: ChapterDocument | null;
  status: ChaptersStatus | undefined;
  error: string | null;
  isLocal: boolean;
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
  isLocal,
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

  // Staleness is derived, not stored: hash the live segments and compare.
  useEffect(() => {
    let cancelled = false;
    if (!isLocal || !hasTranscript) {
      setCurrentHash(null);
      return;
    }
    void computeTranscriptHash(segments).then((hash) => {
      if (!cancelled) setCurrentHash(hash);
    });
    return () => {
      cancelled = true;
    };
  }, [segments, isLocal, hasTranscript]);

  const stale = useMemo(
    () => isChapterDocumentStale(document, currentHash ?? document?.transcriptHash ?? ""),
    [document, currentHash],
  );
  const chapters = document?.chapters ?? [];
  const generating = busy || status === "generating";
  const manualEdits = hasManualEdits(document);

  if (!isLocal) {
    return <CloudUnsupportedState label={t("workspace.chapters_cloud_unsupported")} />;
  }
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
          return (
            <div
              key={chapter.id}
              role={seekable ? "button" : undefined}
              tabIndex={seekable ? 0 : undefined}
              onClick={() => {
                if (seekable && chapter.startMs != null) onSeekChapter(chapter);
              }}
              onKeyDown={(event) => {
                if (seekable && (event.key === "Enter" || event.key === " ")) {
                  event.preventDefault();
                  onSeekChapter(chapter);
                }
              }}
              className={`group rounded-lg border border-border/60 bg-card/60 p-3 transition-colors ${
                seekable ? "cursor-pointer hover:border-primary/40 hover:bg-accent/40" : ""
              }`}
            >
              <div className="flex items-center gap-2">
                <span className="flex size-5 shrink-0 items-center justify-center rounded-md bg-muted text-2xs font-semibold tabular-nums text-muted-foreground">
                  {chapter.order + 1}
                </span>
                <span className="shrink-0 text-2xs tabular-nums text-muted-foreground">
                  {formatChapterTime(chapter.startMs)}
                </span>
                <p className="min-w-0 flex-1 truncate text-sm font-medium">{chapter.title || t("workspace.chapters_untitled")}</p>
                {seekable && (
                  <Play className="size-3 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
                )}
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
                <p className="mt-1 pl-7 text-xs leading-relaxed text-muted-foreground">{chapter.summary}</p>
              )}
              {chapter.keywords.length > 0 && (
                <div className="mt-1.5 flex flex-wrap gap-1 pl-7">
                  {chapter.keywords.map((keyword) => (
                    <span key={keyword} className="rounded-full bg-muted/70 px-1.5 py-0.5 text-2xs text-muted-foreground">
                      {keyword}
                    </span>
                  ))}
                </div>
              )}
            </div>
          );
        })}
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
