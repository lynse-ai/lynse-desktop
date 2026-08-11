"use client";

import { useCallback, useMemo, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { useTranslation } from "@lynse/core/i18n/react";
import { Button } from "@lynse/ui/components/ui/button";
import { cn } from "@lynse/ui/lib/utils";
import { useRecordingSession } from "./use-recording-session";
import { AudioVisualizer } from "./audio-visualizer";
import { RecordingCompleteDialog } from "./recording-complete-dialog";
import {
  Bookmark,
  Captions,
  Eye,
  FileAudio,
  Loader2,
  Pause,
  Pencil,
  Play,
  Save,
  Square,
  Volume2,
} from "../icons";
import {
  SOURCE_LANGUAGE_OPTIONS,
  TARGET_LANGUAGE_OPTIONS,
} from "./language-options";
import type { LiveTranslationSegment } from "./types";
import type { RecordMode } from "./use-recording-session";

function formatTime(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1_000));
  const hours = Math.floor(seconds / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  const rest = seconds % 60;
  return [hours, minutes, rest].map((value) => String(value).padStart(2, "0")).join(":");
}

/** All mode options for the segmented control. */
const MODE_OPTIONS: readonly RecordMode[] = ["record", "transcribe", "translate"];

// ───────────────────────────────────────────────────────────────
// Unified recording + live-transcription page.
//
// Merges the old "开始录音" page and the "实时转录" page into a single
// view, with the live-transcription layout as the basis (top → bottom):
//   A. Header (title + two icon toggles: 显示原文 / 实时转录)
//   B. Mode selector (纯录音 / 实时转写 / 同声翻译)
//   C. Recording timestamp
//   D. Language + translation selectors
//   E. Waveform band (ElevenLabs-style live visual)
//   F. Transcript content (flex-1, scrollable)
//   G. Note input
//   H. Bottom control bar (bookmark · pause/resume/stop · status)
// ───────────────────────────────────────────────────────────────

export function TranscriptDetailPage() {
  const { t } = useTranslation();
  const session = useRecordingSession();

  // ── icon toggle state ──
  const [showSource, setShowSource] = useState(true); // 显示原文
  const [liveTranscribe, setLiveTranscribe] = useState(true); // 实时转录
  const [frozenSegments, setFrozenSegments] = useState<readonly LiveTranslationSegment[]>([]);
  const [note, setNote] = useState("");

  const transcriptRef = useRef<HTMLDivElement>(null);

  // Freeze the transcript snapshot when live transcription is toggled off.
  const visibleSegments = useMemo(() => {
    if (liveTranscribe) return session.segments;
    return frozenSegments.length ? frozenSegments : session.segments;
  }, [liveTranscribe, frozenSegments, session.segments]);

  function handleToggleLive() {
    if (liveTranscribe) setFrozenSegments(session.segments);
    setLiveTranscribe((v) => !v);
  }

  const recording = session.recording;
  const paused = session.paused;
  const displayMode = recording ? session.activeMode : session.mode;
  const timestamp = useMemo(() => {
    const d = session.sessionId ? new Date() : new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }, [session.sessionId]);

  function saveNote() {
    if (!note.trim()) {
      toast.warning(t("transcript_detail.note_empty"));
      return;
    }
    // TODO: persist note against the session (e.g. api.saveNote).
    toast.success(t("transcript_detail.note_saved"));
    setNote("");
  }

  // Completion dialog handlers (recording finished → save / dismiss).
  const handleSave = useCallback(() => {
    // TODO: wire to actual file-save logic (e.g. copy to user-chosen dir).
    // The recording is already persisted locally by the Rust sidecar.
    toast.success(t("recording_mode.saved_toast"));
  }, [t]);
  const handleDismiss = useCallback(() => {
    // User chose "不需要" — recording stays in app-local storage.
  }, []);

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      {/* ═══ Zone A · Header (title + two icon toggles) ═══ */}
      <header className="flex h-14 shrink-0 items-center justify-between border-b border-border px-5">
        <div className="flex items-center gap-2.5">
          <span className="flex size-8 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <FileAudio className="size-4" />
          </span>
          <h1 className="text-sm font-semibold">{t("transcript_detail.title")}</h1>
        </div>
        <div className="flex items-center gap-2">
          <IconToggle
            active={showSource}
            onClick={() => setShowSource((v) => !v)}
            label={t("transcript_detail.show_original")}
            title={t("transcript_detail.show_original")}
          >
            <Eye className="size-4" />
          </IconToggle>
          <IconToggle
            active={liveTranscribe}
            onClick={handleToggleLive}
            label={t("transcript_detail.live_transcribe")}
            title={t("transcript_detail.live_transcribe")}
          >
            <Captions className="size-4" />
          </IconToggle>
        </div>
      </header>

      {/* ═══ Zone B · Mode selector (纯录音 / 实时转写 / 同声翻译) ═══ */}
      <div className="flex shrink-0 items-center justify-center px-5 pt-3">
        <div className="flex items-center gap-1 rounded-full bg-muted p-1 text-xs font-medium">
          {MODE_OPTIONS.map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => session.selectMode(m)}
              disabled={session.busy && recording}
              className={cn(
                "rounded-full px-4 py-1.5 transition-colors",
                displayMode === m
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {m === "record"
                ? t("recording_mode.record")
                : m === "transcribe"
                  ? t("recording_mode.transcribe")
                  : t("recording_mode.translate")}
            </button>
          ))}
        </div>
      </div>

      {/* ═══ Zone C · Recording timestamp ═══ */}
      <div className="shrink-0 px-5 pt-3 text-xs text-muted-foreground">
        {timestamp}
      </div>

      {/* ═══ Zone D · Language + translation selectors ═══ */}
      <div className="flex shrink-0 gap-3 px-5 py-3">
        <label className="flex h-9 flex-1 items-center gap-2 rounded-md border border-input bg-background px-3 text-xs">
          <span className="text-muted-foreground">{t("transcript_detail.language")}</span>
          <select
            value={session.sourceLanguage}
            onChange={(e) => void session.setDirection(e.target.value, session.targetLanguage)}
            disabled={session.busy}
            className="flex-1 bg-transparent text-xs outline-none"
          >
            {SOURCE_LANGUAGE_OPTIONS.map((opt) => (
              <option key={opt.code} value={opt.code}>{opt.label}</option>
            ))}
          </select>
        </label>
        <label className="flex h-9 flex-1 items-center gap-2 rounded-md border border-input bg-background px-3 text-xs">
          <span className="text-muted-foreground">{t("transcript_detail.translation")}</span>
          <select
            value={session.targetLanguage}
            onChange={(e) => void session.setDirection(session.sourceLanguage, e.target.value)}
            disabled={session.busy}
            className="flex-1 bg-transparent text-xs outline-none"
          >
            {TARGET_LANGUAGE_OPTIONS.map((opt) => (
              <option key={opt.code} value={opt.code}>{opt.label}</option>
            ))}
          </select>
        </label>
      </div>

      {/* ═══ Zone E · Waveform band (ElevenLabs-style live visual) ═══ */}
      <div className="shrink-0 px-5 pt-1">
        <div className="w-full rounded-2xl border border-border/60 bg-muted/30 px-5 py-3">
          <AudioVisualizer
            level={session.micLevel}
            active={session.recording}
            className="h-24 w-full"
          />
        </div>
      </div>

      <div className="mx-5 border-t border-border" />

      {/* ═══ Zone F · Transcript content (flex-1) ═══ */}
      <div ref={transcriptRef} className="relative min-h-0 flex-1 overflow-y-auto px-5 py-4">
        {!liveTranscribe && (
          <div className="mb-3 flex items-center gap-2 rounded-md bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
            <Pause className="size-3.5" />
            {t("transcript_detail.transcribe_paused")}
          </div>
        )}
        {visibleSegments.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center text-center text-muted-foreground">
            <span className="mb-3 flex size-12 items-center justify-center rounded-full bg-muted">
              <Volume2 className="size-5" />
            </span>
            <p className="text-sm font-medium text-foreground">{t("transcript_detail.empty_title")}</p>
            <p className="mt-1 max-w-sm text-xs">{t("transcript_detail.empty_hint")}</p>
          </div>
        ) : (
          <div className="mx-auto max-w-3xl space-y-3">
            {visibleSegments.map((segment) => {
              const hasTranslation = segment.translatedText && segment.translatedText !== segment.recognizedText;
              return (
                <article key={segment.id} className="rounded-xl border border-border bg-background px-4 py-3 shadow-sm">
                  <div className="mb-1.5 flex items-center gap-2 text-[11px] text-muted-foreground">
                    <span className="tabular-nums">{formatTime(segment.startMs)}</span>
                    {!segment.isFinal && <span className="animate-pulse">{t("transcript_detail.recognizing")}</span>}
                  </div>
                  {showSource && (
                    <p className="text-base font-medium leading-relaxed text-foreground">
                      {segment.recognizedText}
                    </p>
                  )}
                  {hasTranslation && (
                    <div className={showSource ? "mt-1.5 border-l-2 border-border pl-2.5" : ""}>
                      <p className="text-sm leading-relaxed text-muted-foreground">
                        {segment.translatedText}
                      </p>
                    </div>
                  )}
                </article>
              );
            })}
          </div>
        )}
      </div>

      <div className="mx-5 border-t border-border" />

      {/* ═══ Zone G · Note input ═══ */}
      <div className="flex shrink-0 items-center gap-2 px-5 py-3">
        <Pencil className="size-4 shrink-0 text-muted-foreground" />
        <input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") saveNote();
          }}
          placeholder={t("transcript_detail.note_placeholder")}
          className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
        />
        <Button variant="ghost" size="icon" onClick={saveNote} aria-label={t("transcript_detail.save_note")}>
          <Save className="size-4" />
        </Button>
      </div>

      <div className="mx-5 border-t border-border" />

      {/* ═══ Zone H · Bottom control bar ═══ */}
      <footer className="flex shrink-0 items-center justify-between gap-3 border-t border-border bg-background/95 px-5 py-3 backdrop-blur">
        {/* ── Left: bookmark + action buttons ── */}
        <div className="flex items-center gap-2">
          {/* Bookmark */}
          <Button
            variant="ghost"
            size="icon"
            disabled={!recording}
            onClick={() => session.setBookmarked(!session.bookmarked)}
            title={t("recording_mode.bookmark")}
            aria-label={t("recording_mode.bookmark")}
            className={cn(session.bookmarked && "text-primary")}
          >
            <Bookmark className={cn("size-4", session.bookmarked && "fill-current")} />
          </Button>

          {recording ? (
            <>
              {session.paused ? (
                <Button onClick={session.togglePause} disabled={session.busy}>
                  <Play /> {t("transcript_detail.resume")}
                </Button>
              ) : (
                <Button variant="secondary" onClick={session.togglePause} disabled={session.busy}>
                  <Pause /> {t("transcript_detail.pause")}
                </Button>
              )}
              <Button variant="destructive" onClick={session.toggleRecording} disabled={session.busy}>
                <Square /> {t("transcript_detail.stop")}
              </Button>
            </>
          ) : (
            <Button onClick={session.toggleRecording} disabled={session.busy}>
              {session.busy ? <Loader2 className="animate-spin" /> : <Play />}
              {t("transcript_detail.start")}
            </Button>
          )}
        </div>

        {/* ── Right: live status group ── */}
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Volume2 className="size-4 text-primary" />
          <span>
            {recording
              ? (session.activeMode === "record"
                ? t("transcript_detail.recording_in_progress")
                : t("transcript_detail.transcribing_in_progress"))
              : paused
                ? t("transcript_detail.paused")
                : t("transcript_detail.idle")}
          </span>
          {session.elapsedMs > 0 && (
            <span className="tabular-nums text-foreground">{session.formattedTime}</span>
          )}
        </div>
      </footer>

      {/* ═══ Completion dialog (rendered outside flex layout) ═══ */}
      <RecordingCompleteDialog
        completedSession={session.completedSession}
        open={session.showCompleteDialog}
        onOpenChange={(open) => {
          if (!open) session.dismissCompleteDialog();
        }}
        onSave={handleSave}
        onDismiss={handleDismiss}
      />
    </div>
  );
}

// Icon toggle button. Active uses the shared restrained brand tint; inactive
// stays neutral. A small label sits beside the icon for clarity.
function IconToggle({
  active,
  onClick,
  label,
  title,
  children,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={title}
      aria-pressed={active}
      className={[
        "flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-xs font-medium transition-colors",
        active
          ? "border border-primary/25 bg-primary/10 text-accent-brand-text shadow-sm"
          : "border border-border bg-background text-muted-foreground hover:bg-muted hover:text-foreground",
      ].join(" ")}
    >
      {children}
      <span>{label}</span>
    </button>
  );
}
