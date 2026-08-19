"use client";

import { useCallback, useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "@lynse/core/i18n/react";
import { Badge } from "@lynse/ui/components/ui/badge";
import { Button } from "@lynse/ui/components/ui/button";
import { ScrollArea } from "@lynse/ui/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@lynse/ui/components/ui/select";
import { Separator } from "@lynse/ui/components/ui/separator";
import { Tabs, TabsList, TabsTrigger } from "@lynse/ui/components/ui/tabs";
import { Toggle } from "@lynse/ui/components/ui/toggle";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@lynse/ui/components/ui/tooltip";
import { cn } from "@lynse/ui/lib/utils";
import { useRecordingSession } from "./use-recording-session";
import { useRecordingCloudSync } from "./use-recording-cloud-sync";
import { AudioVisualizer } from "./audio-visualizer";
import { RecordingCompleteDialog } from "./recording-complete-dialog";
import { getDesktopLiveTranslationApi } from "./desktop-api";
import {
  ArrowRight,
  Bookmark,
  Captions,
  Eye,
  EyeOff,
  FileAudio,
  Globe,
  Loader2,
  Pause,
  Play,
  Square,
  Volume2,
} from "../icons";
import {
  SOURCE_LANGUAGE_OPTIONS,
  TARGET_LANGUAGE_OPTIONS,
} from "./language-options";
import type { CompletedLiveSession, LiveTranslationSegment } from "./types";
import type { RecordMode } from "./use-recording-session";

function formatTime(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1_000));
  const hours = Math.floor(seconds / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  const rest = seconds % 60;
  return [hours, minutes, rest].map((value) => String(value).padStart(2, "0")).join(":");
}

type TranscriptTab = "transcript" | "timeline";

// ───────────────────────────────────────────────────────────────
// Unified recording page — one primary feature, three states.
//
// Recording ALWAYS starts offline (pure local capture). Live
// transcription and translation are mid-flight upgrades the user can
// attach at any moment via the two upgrade chips — the audio capture
// never restarts, the session is reconfigured on the fly (see
// `switchMode` / `live_translation_set_mode`). If no upgrade is ever
// selected, the audio file is simply saved locally.
//
// Layout (reference: detail-view recorder, ~40/60 split):
//   A. Header (title + timestamp + status chip + two icon toggles)
//   B. Main split:
//      · Left  (~40%) — transcript cards / compact timeline tabs
//      · Right (~60%) — dark recording card: REC + timer, horizontal
//        waveform, upgrade chips + language pair, transport toolbar
// ───────────────────────────────────────────────────────────────

export function TranscriptDetailPage() {
  const { t } = useTranslation();
  const session = useRecordingSession();
  const { syncCompletedSession } = useRecordingCloudSync();

  // ── icon toggle state ──
  const [showSource, setShowSource] = useState(true); // 显示原文
  const [liveTranscribe, setLiveTranscribe] = useState(true); // 实时转录
  const [frozenSegments, setFrozenSegments] = useState<readonly LiveTranslationSegment[]>([]);
  const [transcriptTab, setTranscriptTab] = useState<TranscriptTab>("transcript");

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
  const busy = session.busy;
  const displayMode = recording ? session.activeMode : session.mode;
  const timestamp = useMemo(() => {
    const d = session.sessionId ? new Date() : new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }, [session.sessionId]);

  // Completion dialog handlers (recording finished → save / dismiss).
  const handleSave = useCallback(
    (completed: CompletedLiveSession) => {
      // The recording is already persisted locally by the Rust sidecar;
      // "save" uploads it to the cloud and starts the transcription +
      // summarization pipeline (progress is reported via toasts).
      void syncCompletedSession(completed);
    },
    [syncCompletedSession],
  );
  const handleDismiss = useCallback(() => {
    // User chose "不需要" — recording stays in app-local storage.
  }, []);

  const statusLabel = recording
    ? (displayMode === "record"
      ? t("transcript_detail.recording_in_progress")
      : t("transcript_detail.transcribing_in_progress"))
    : paused
      ? t("transcript_detail.paused")
      : t("transcript_detail.idle");

  // Mode-aware status for the recording card (recording mode + privacy hint).
  const modeStatus = recording
    ? (displayMode === "record"
      ? t("recording_mode.status_recording")
      : displayMode === "transcribe"
        ? t("recording_mode.status_transcribing")
        : t("recording_mode.status_translating"))
    : statusLabel;

  // ── mid-flight mode upgrades (transcribe / translate) ──
  // Tapping an inactive chip attaches that stream on the fly; tapping the
  // active chip detaches it and falls back to pure local recording. The
  // audio capture keeps running throughout — only the session config changes.
  const [pendingUpgrade, setPendingUpgrade] = useState<RecordMode | null>(null);
  const handleUpgrade = async (next: RecordMode) => {
    if (busy) return;
    const target: RecordMode = next === displayMode ? "record" : next;
    setPendingUpgrade(next);
    try {
      await session.selectMode(target);
    } finally {
      setPendingUpgrade(null);
    }
  };

  return (
    <TooltipProvider delay={200}>
      <div className="flex h-full min-h-0 flex-col bg-background">
        {/* ═══ A · Header ═══ */}
        <header className="flex h-14 shrink-0 items-center justify-between border-b border-border px-5">
          <div className="flex items-center gap-2.5">
            <span className="flex size-8 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <FileAudio className="size-4" />
            </span>
            <div>
              <h1 className="text-sm font-semibold leading-tight">{t("transcript_detail.title")}</h1>
              <p className="text-[11px] leading-tight text-muted-foreground">{timestamp}</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Badge
              variant="outline"
              className="h-7 gap-1.5 rounded-full border-border/60 bg-background px-2.5 text-[11px] font-medium text-muted-foreground"
            >
              <span
                className={cn(
                  "size-1.5 rounded-full",
                  recording
                    ? "animate-pulse bg-red-500"
                    : paused
                      ? "bg-amber-500"
                      : "bg-muted-foreground/50",
                )}
              />
              {statusLabel}
            </Badge>
            <Separator orientation="vertical" className="data-[orientation=vertical]:h-5" />
            <Tooltip>
              <TooltipTrigger
                render={
                  <Toggle
                    variant="outline"
                    size="sm"
                    pressed={showSource}
                    onPressedChange={() => setShowSource((v) => !v)}
                    aria-label={t("transcript_detail.show_original")}
                  >
                    <Eye className="size-3.5" />
                  </Toggle>
                }
              />
              <TooltipContent>{t("transcript_detail.show_original")}</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Toggle
                    variant="outline"
                    size="sm"
                    pressed={liveTranscribe}
                    onPressedChange={handleToggleLive}
                    aria-label={t("transcript_detail.live_transcribe")}
                  >
                    <Captions className="size-3.5" />
                  </Toggle>
                }
              />
              <TooltipContent>{t("transcript_detail.live_transcribe")}</TooltipContent>
            </Tooltip>
          </div>
        </header>

        {/* ═══ B · Main split: transcript (~40%) · recording card (~60%) ═══
            Compact half-width panel, centered — the recorder reads as a
            focused floating card rather than a full-bleed page. */}
        <div className="mx-auto flex min-h-0 w-full max-w-[640px] flex-1 flex-col">
        <main className="grid min-h-0 flex-1 grid-cols-[2fr_3fr] gap-3 p-3">
          {/* ── Left: transcript cards / compact timeline ── */}
          <section className="flex min-h-0 flex-col overflow-hidden rounded-2xl border border-border bg-background">
            <div className="flex h-9 shrink-0 items-center justify-between border-b border-border px-2.5">
              <Tabs
                value={transcriptTab}
                onValueChange={(value) => setTranscriptTab(value as TranscriptTab)}
              >
                <TabsList className="h-7">
                  <TabsTrigger value="transcript" className="px-3 text-xs">
                    {t("transcript_detail.tab_transcript")}
                  </TabsTrigger>
                  <TabsTrigger value="timeline" className="px-3 text-xs">
                    {t("transcript_detail.tab_timeline")}
                  </TabsTrigger>
                </TabsList>
              </Tabs>
              <span className="shrink-0 pr-1 text-[11px] text-muted-foreground">
                {visibleSegments.length} {t("live_translation.segments")}
              </span>
            </div>
            <ScrollArea className="min-h-0 flex-1">
              <div ref={transcriptRef} className="px-3 py-3">
                {!liveTranscribe && (
                  <div className="mb-3 flex items-center gap-2 rounded-md bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
                    <Pause className="size-3.5" />
                    {t("transcript_detail.transcribe_paused")}
                  </div>
                )}
                {visibleSegments.length === 0 ? (
                  <div className="flex h-full flex-col items-center justify-center py-10 text-center text-muted-foreground">
                    <span className="mb-3 flex size-12 items-center justify-center rounded-full bg-muted">
                      <Volume2 className="size-5" />
                    </span>
                    <p className="text-sm font-medium text-foreground">{t("transcript_detail.empty_title")}</p>
                    <p className="mt-1 max-w-sm text-xs">{t("transcript_detail.empty_hint")}</p>
                  </div>
                ) : transcriptTab === "transcript" ? (
                  <div className="space-y-3">
                    {visibleSegments.map((segment) => {
                      const hasTranslation = segment.translatedText && segment.translatedText !== segment.recognizedText;
                      return (
                        <article key={segment.id} className="rounded-xl border border-border bg-background px-3 py-2.5 shadow-sm">
                          <div className="mb-1.5 flex items-center gap-2 text-[11px] text-muted-foreground">
                            <span className="tabular-nums">{formatTime(segment.startMs)}</span>
                            {!segment.isFinal && <span className="animate-pulse">{t("transcript_detail.recognizing")}</span>}
                          </div>
                          {showSource && (
                            <p className="text-sm font-medium leading-relaxed text-foreground">
                              {segment.recognizedText}
                            </p>
                          )}
                          {hasTranslation && (
                            <div className="mt-1.5 border-l-2 border-border pl-2.5">
                              <span className="mb-0.5 block text-[10px] font-medium uppercase tracking-wide text-muted-foreground/70">
                                {t("transcript_detail.translation")}
                              </span>
                              <p className="text-sm leading-relaxed text-muted-foreground">
                                {segment.translatedText}
                              </p>
                            </div>
                          )}
                        </article>
                      );
                    })}
                  </div>
                ) : (
                  <div className="space-y-2.5">
                    {visibleSegments.map((segment) => (
                      <div key={segment.id} className="flex items-start gap-3">
                        <span className="w-14 shrink-0 pt-0.5 font-mono text-[11px] tabular-nums text-muted-foreground">
                          {formatTime(segment.startMs).slice(3)}
                        </span>
                        <p className="min-w-0 flex-1 text-sm leading-relaxed text-foreground/90">
                          {segment.recognizedText || segment.translatedText}
                        </p>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </ScrollArea>
          </section>

          {/* ── Right: dark recording card ── */}
          <section className="flex min-h-0 flex-col rounded-2xl border border-zinc-800 bg-zinc-950 text-zinc-50 shadow-lg">
            {/* REC + elapsed timer · mode status */}
            <div className="flex shrink-0 items-center justify-between px-4 pt-3">
              <div className="flex items-center gap-2.5">
                <span
                  className={cn(
                    "size-2.5 rounded-full",
                    recording
                      ? "animate-pulse bg-red-500"
                      : paused
                        ? "bg-amber-500"
                        : "bg-zinc-600",
                  )}
                />
                <span className="text-[11px] font-semibold tracking-[0.25em] text-zinc-400">REC</span>
                <span className="font-mono text-lg font-semibold leading-none tabular-nums">
                  {session.formattedTime || "00:00:00"}
                </span>
              </div>
              <span className="text-xs text-zinc-400">{modeStatus}</span>
            </div>

            {/* horizontal live waveform strip */}
            <div className="shrink-0 px-4 pt-3 pb-1">
              <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 px-3 py-2">
                <AudioVisualizer
                  level={session.micLevel}
                  active={recording}
                  className="h-12 w-full"
                />
              </div>
            </div>

            {/* upgrade chips + language direction — transcription /
                translation attach on the fly by tapping a chip. */}
            <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 px-4 py-2">
              <div className="flex items-center gap-2">
                <ModeUpgradeChip
                  active={displayMode === "transcribe"}
                  pending={busy && pendingUpgrade === "transcribe"}
                  disabled={busy}
                  onClick={() => void handleUpgrade("transcribe")}
                  label={t("recording_mode.transcribe_short")}
                >
                  <Captions className="size-3.5" />
                </ModeUpgradeChip>
                <ModeUpgradeChip
                  active={displayMode === "translate"}
                  pending={busy && pendingUpgrade === "translate"}
                  disabled={busy}
                  onClick={() => void handleUpgrade("translate")}
                  label={t("recording_mode.translate_short")}
                >
                  <Globe className="size-3.5" />
                </ModeUpgradeChip>
              </div>
              <div
                className={cn(
                  "flex items-center gap-1.5 transition-opacity",
                  displayMode === "record" && "opacity-60",
                )}
              >
                <Select
                  items={Object.fromEntries(SOURCE_LANGUAGE_OPTIONS.map((o) => [o.code, o.label]))}
                  value={session.sourceLanguage}
                  onValueChange={(value) =>
                    void session.setDirection(String(value), session.targetLanguage)
                  }
                  disabled={busy}
                >
                  <SelectTrigger
                    size="sm"
                    className="w-28 border-zinc-700 bg-zinc-900 text-xs text-zinc-200"
                    aria-label={t("transcript_detail.language")}
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {SOURCE_LANGUAGE_OPTIONS.map((option) => (
                      <SelectItem key={option.code} value={option.code}>{option.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <ArrowRight className="size-3.5 shrink-0 text-zinc-500" />
                <Select
                  items={Object.fromEntries(TARGET_LANGUAGE_OPTIONS.map((o) => [o.code, o.label]))}
                  value={session.targetLanguage}
                  onValueChange={(value) =>
                    void session.setDirection(session.sourceLanguage, String(value))
                  }
                  disabled={busy}
                >
                  <SelectTrigger
                    size="sm"
                    className="w-28 border-zinc-700 bg-zinc-900 text-xs text-zinc-200"
                    aria-label={t("transcript_detail.translation")}
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {TARGET_LANGUAGE_OPTIONS.map((option) => (
                      <SelectItem key={option.code} value={option.code}>{option.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="flex-1" />

            {/* transport toolbar */}
            <div className="flex shrink-0 items-center justify-center gap-2.5 px-4 pb-3 pt-2">
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      variant="ghost"
                      disabled={!recording}
                      onClick={() => session.setBookmarked(!session.bookmarked)}
                      aria-label={t("recording_mode.bookmark")}
                      className={cn(
                        "size-10 rounded-full text-zinc-400 hover:bg-white/10 hover:text-zinc-50",
                        session.bookmarked && "text-primary",
                      )}
                    >
                      <Bookmark className={cn("size-4", session.bookmarked && "fill-current")} />
                    </Button>
                  }
                />
                <TooltipContent>{t("recording_mode.bookmark")}</TooltipContent>
              </Tooltip>

              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      variant="ghost"
                      disabled={!recording}
                      onClick={session.togglePause}
                      aria-label={paused ? t("recording_mode.resume") : t("recording_mode.pause")}
                      className="size-9 rounded-full text-zinc-400 hover:bg-white/10 hover:text-zinc-50"
                    >
                      {paused ? <Play className="size-4" /> : <Pause className="size-4" />}
                    </Button>
                  }
                />
                <TooltipContent>
                  {paused ? t("recording_mode.resume") : t("recording_mode.pause")}
                </TooltipContent>
              </Tooltip>

              {/* Center primary: stop while recording, start while idle */}
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      onClick={session.toggleRecording}
                      disabled={busy}
                      aria-label={
                        recording
                          ? t("recording_mode.stop_recording")
                          : t("recording_mode.start_recording")
                      }
                      className={cn(
                        "size-11 rounded-full shadow-lg transition-transform hover:scale-105",
                        recording
                          ? "bg-destructive text-white hover:bg-destructive/90"
                          : "bg-primary text-primary-foreground hover:bg-primary/90",
                      )}
                    >
                      {busy ? (
                        <Loader2 className="size-5 animate-spin" />
                      ) : recording ? (
                        <Square className="size-5" />
                      ) : (
                        <Play className="size-5" />
                      )}
                    </Button>
                  }
                />
                <TooltipContent>
                  {recording
                    ? t("recording_mode.stop_recording")
                    : t("recording_mode.start_recording")}
                </TooltipContent>
              </Tooltip>

              {/* Hide the main window — recording keeps running, the floating
                  recording island carries the progress bar and controls. */}
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      variant="ghost"
                      disabled={!recording}
                      onClick={() => void getDesktopLiveTranslationApi()?.minimizeToTray()}
                      aria-label={t("recording_mode.hide_to_island")}
                      className="size-9 rounded-full text-zinc-400 hover:bg-white/10 hover:text-zinc-50"
                    >
                      <EyeOff className="size-4" />
                    </Button>
                  }
                />
                <TooltipContent>{t("recording_mode.hide_to_island")}</TooltipContent>
              </Tooltip>
            </div>
          </section>
        </main>
        </div>

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
    </TooltipProvider>
  );
}

// Upgrade chip on the dark recording card — attaches / detaches live
// transcription or translation mid-recording. Active state uses the brand
// tint; pending shows an in-chip spinner while the session reconfigures.
function ModeUpgradeChip({
  active,
  pending,
  disabled,
  onClick,
  label,
  children,
}: {
  active: boolean;
  pending?: boolean;
  disabled?: boolean;
  onClick: () => void;
  label: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={active}
      className={cn(
        "flex h-7 items-center gap-1.5 rounded-full border px-3 text-[11px] font-medium transition-colors",
        active
          ? "border-primary/60 bg-primary/15 text-primary"
          : "border-zinc-700 bg-zinc-900 text-zinc-400 hover:border-zinc-500 hover:text-zinc-200",
        disabled && "pointer-events-none opacity-50",
      )}
    >
      {pending ? <Loader2 className="size-3.5 animate-spin" /> : children}
      {label}
    </button>
  );
}
