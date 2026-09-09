"use client";

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AnimatePresence,
  motion,
  useReducedMotion,
  type Transition,
  type Variants,
} from "motion/react";
import { useTranslation } from "@lynse/core/i18n/react";
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
import { Switch } from "@lynse/ui/components/ui/switch";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@lynse/ui/components/ui/tooltip";
import { cn } from "@lynse/ui/lib/utils";
import { useRecordingSession } from "./use-recording-session";
import { useRecordingCloudSync } from "./use-recording-cloud-sync";
import { useRecordingCompleteStore } from "./recording-complete-store";
import { RecordingWaveform } from "./recording-waveform";
import { SmoothTimer } from "./smooth-timer";
import { RecordingDock } from "./recording-dock";
import { RecordingCompleteDialog } from "./recording-complete-dialog";
import { getDesktopLiveTranslationApi } from "./desktop-api";
import {
  ArrowRight,
  Bookmark,
  Captions,
  Eye,
  EyeOff,
  Loader2,
  Mic,
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

type TranscriptTab = "transcript" | "timeline";

function formatTime(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1_000));
  const hours = Math.floor(seconds / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  const rest = seconds % 60;
  return [hours, minutes, rest].map((value) => String(value).padStart(2, "0")).join(":");
}

/** Format elapsed ms as `MM:SS.cs` for the large stage timer. */
function formatTimerCentis(ms: number): string {
  const total = Math.max(0, ms);
  const cs = Math.floor((total % 1000) / 10);
  const ss = Math.floor(total / 1000) % 60;
  const mm = Math.floor(total / 60_000);
  return `${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}.${String(cs).padStart(2, "0")}`;
}

// ───────────────────────────────────────────────────────────────
// Unified recording page — the full page surface is the live output.
//
// Recording ALWAYS starts offline (pure local capture); live mode
// (realtime transcription ± translation) is a mid-flight upgrade the
// user can attach at any moment via a translation switch. The audio
// file is persisted locally by the Rust sidecar, so "本地录音保存在本机"
// holds regardless of whether cloud sync is later chosen in the dialog.
//
// Layout:
//   · Header — title, mode switch (录音 / 实时), translation switch,
//     language pair, status chip, and the two view toggles.
//   · Main   — the whole area shows the live transcript when a text stream is
//              active; in pure-recording mode (or with live transcription
//              paused) it shows only the recording activity (timer + animation).
//   · Dock   — a floating glassmorphism bar at the bottom holds Start / Pause /
//              Stop and animates while recording.
// ───────────────────────────────────────────────────────────────

// Stage swap choreography: the incoming pane slides in from the side of its
// header-toggle position (录音 left / 实时 right) while the outgoing pane
// leaves through the opposite side, so everything drifts one way.
const stageVariants: Variants = {
  enter: (direction: number) => ({
    opacity: 0,
    transform: `translateX(${24 * direction}px)`,
  }),
  center: { opacity: 1, transform: "translateX(0px)" },
  exit: (direction: number) => ({
    opacity: 0,
    transform: `translateX(${-24 * direction}px)`,
  }),
};

const stageSpringTransition: Transition = { type: "spring", bounce: 0, duration: 0.25 };

export function TranscriptDetailPage() {
  const { t, i18n } = useTranslation();
  const session = useRecordingSession();
  const { syncCompletedSession } = useRecordingCloudSync();
  const reduceMotion = useReducedMotion();
  // Sessions stopped outside this page (float dock / tray / island) hand
  // their result over via the store; this page then shows the same
  // completion dialog for them.
  const pendingComplete = useRecordingCompleteStore((s) => s.session);
  const clearPendingComplete = useRecordingCompleteStore((s) => s.clear);

  // Recording date under the page title: the session's own start date once
  // one exists, today otherwise. Long-form year/month/day per locale.
  const recordingDate = useMemo(() => {
    const d = session.startedAt ? new Date(session.startedAt) : new Date();
    return new Intl.DateTimeFormat(i18n.language, {
      year: "numeric",
      month: "long",
      day: "numeric",
    }).format(d);
  }, [session.startedAt, i18n.language]);

  // ── view toggles ──
  const [showSource, setShowSource] = useState(true); // 显示原文
  const [liveTranscribe, setLiveTranscribe] = useState(true); // 实时转录
  const [frozenSegments, setFrozenSegments] = useState<readonly LiveTranslationSegment[]>([]);
  const [transcriptTab, setTranscriptTab] = useState<TranscriptTab>("transcript");

  const recording = session.recording;
  const paused = session.paused;
  const busy = session.busy;
  // True from the stop click until the background finalization (sidecar
  // drain + persistence) lands — the UI stays responsive throughout.
  const stopping = session.stopping;
  const displayMode: RecordMode = recording ? session.activeMode : session.mode;
  const transcribing = displayMode !== "record";

  // Panes enter from the side of their toggle position (录音 left / 实时 right).
  const stageDirection = displayMode === "record" ? -1 : 1;
  const stageTransition: Transition = reduceMotion
    ? { duration: 0 }
    : { duration: 0.2, ease: [0.23, 1, 0.32, 1] };

  // Freeze the transcript snapshot when live transcription is toggled off.
  const visibleSegments = useMemo(() => {
    if (liveTranscribe) return session.segments;
    return frozenSegments.length ? frozenSegments : session.segments;
  }, [liveTranscribe, frozenSegments, session.segments]);

  // Stable (reads through refs) so the memoized transcript feed does not
  // re-render on the 5 Hz level/elapsed updates from the capture sidecar.
  const liveTranscribeRef = useRef(liveTranscribe);
  liveTranscribeRef.current = liveTranscribe;
  const segmentsRef = useRef(session.segments);
  segmentsRef.current = session.segments;
  const handleToggleLive = useCallback(() => {
    if (liveTranscribeRef.current) setFrozenSegments(segmentsRef.current);
    setLiveTranscribe((v) => !v);
  }, []);

  // The whole page shows the transcript only while a text stream is active;
  // otherwise it shows just the recording activity (timer + animation).
  const showTranscript = transcribing;

  // Status text for the recording-activity stage.
  const stageStatus = stopping
    ? t("recording_mode.status_stopping")
    : recording
      ? paused
        ? t("transcript_detail.paused")
        : transcribing
          ? t("recording_mode.status_transcribing")
          : t("recording_mode.status_recording")
      : t("recording_mode.idle_status");

  // Completion dialog handlers. The recording is always persisted locally by
  // the Rust sidecar; `onSave` fires only when the user ticks "保存到云" in the
  // dialog, uploading it to the cloud and starting the transcription +
  // summarization pipeline (progress is reported via toasts).
  const handleSave = useCallback(
    (completed: CompletedLiveSession) => {
      void syncCompletedSession(completed);
    },
    [syncCompletedSession],
  );

  return (
    <TooltipProvider delay={200}>
      <div className="flex h-full min-h-0 flex-col bg-background text-foreground">
        {/* ═══ Header ═══ */}
        <header
          className="flex h-14 shrink-0 items-center justify-between gap-3 border-b border-border px-5 select-none"
          data-tauri-drag-region
        >
          <div className="min-w-0">
            <h1 className="truncate text-sm font-semibold leading-tight">
              {t("transcript_detail.title")}
            </h1>
            <p className="truncate text-2xs leading-tight text-muted-foreground/60">
              {recordingDate}
            </p>
          </div>

          <div className="flex shrink-0 items-center gap-2">
            {/* mode switch — pure recording vs live (transcription ± translation) */}
            <div className="flex items-center gap-0.5 rounded-full border border-border/60 bg-background/40 p-0.5">
              {(["record", "live"] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => void session.selectMode(m)}
                  className={cn(
                    "relative rounded-full px-2.5 py-1 text-2xs font-medium transition-colors",
                    displayMode === m
                      ? "text-primary"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {displayMode === m && (
                    <motion.span
                      layoutId="recording-mode-thumb"
                      className="absolute inset-0 rounded-full bg-primary/15"
                      transition={reduceMotion ? { duration: 0 } : stageSpringTransition}
                    />
                  )}
                  <span className="relative">
                    {m === "record"
                      ? t("recording_mode.record")
                      : t("recording_mode.live_short")}
                  </span>
                </button>
              ))}
            </div>

            {/* live mode controls — translation switch + language pair */}
            {transcribing && (
              <motion.div
                initial={reduceMotion ? false : { opacity: 0, transform: "translateX(8px)" }}
                animate={{ opacity: 1, transform: "translateX(0px)" }}
                transition={{ duration: 0.15, ease: [0.23, 1, 0.32, 1] }}
                className="flex items-center gap-2"
              >
                <label
                  className={cn(
                    "flex items-center gap-1.5 rounded-full border px-2.5 py-1",
                    session.translationEnabled
                      ? "border-primary/30 bg-primary/10"
                      : "border-border/60 bg-background/40",
                  )}
                >
                  <Switch
                    checked={session.translationEnabled}
                    onCheckedChange={(checked) => void session.setTranslationEnabled(checked)}
                    disabled={busy}
                    aria-label={t("recording_mode.translation")}
                    className="scale-90"
                  />
                  <span className="text-2xs font-medium leading-none">
                    {t("recording_mode.translation")}
                  </span>
                </label>

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
                    className="h-7 w-24 border-border/60 bg-background/60 text-2xs"
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

                {session.translationEnabled && (
                  <>
                    <ArrowRight className="size-3.5 shrink-0 text-muted-foreground" />
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
                        className="h-7 w-24 border-border/60 bg-background/60 text-2xs"
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
                  </>
                )}
              </motion.div>
            )}

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

        {/* ═══ Main — full-page live output ═══ */}
        <main className="relative min-h-0 flex-1 overflow-hidden">
          <AnimatePresence initial={false} custom={stageDirection}>
            {showTranscript ? (
              <motion.div
                key="live"
                custom={stageDirection}
                variants={stageVariants}
                initial="enter"
                animate="center"
                exit="exit"
                transition={stageTransition}
                className="absolute inset-0"
              >
                <TranscriptFeed
                  segments={visibleSegments}
                  showSource={showSource}
                  liveTranscribe={liveTranscribe}
                  translationEnabled={session.translationEnabled}
                  tab={transcriptTab}
                  onTabChange={setTranscriptTab}
                  onToggleLive={handleToggleLive}
                  t={t}
                />

                {/* Floating glassmorphism dock (live-transcript view only — the
                    recording stage owns its own transport bar) */}
                <div className="pointer-events-none absolute inset-x-0 bottom-5 flex justify-center px-4">
                  <RecordingDock
                    recording={recording}
                    paused={paused}
                    busy={busy}
                    stopping={stopping}
                    formattedTime={session.formattedTime}
                    micLevel={session.micLevel}
                    bookmarked={session.bookmarked}
                    onStart={() => void session.toggleRecording()}
                    onTogglePause={() => void session.togglePause()}
                    onStop={() => void session.toggleRecording()}
                    onToggleBookmark={() => session.setBookmarked(!session.bookmarked)}
                    onHide={() => void getDesktopLiveTranslationApi()?.hideMainWindow()}
                  />
                </div>
              </motion.div>
            ) : (
              <motion.div
                key="record"
                custom={stageDirection}
                variants={stageVariants}
                initial="enter"
                animate="center"
                exit="exit"
                transition={stageTransition}
                className="absolute inset-0"
              >
                <RecordingStage
                  recording={recording}
                  paused={paused}
                  busy={busy}
                  stopping={stopping}
                  elapsedMs={session.elapsedMs}
                  micLevel={session.micLevel}
                  statusLabel={stageStatus}
                  onStart={() => void session.toggleRecording()}
                  onTogglePause={() => void session.togglePause()}
                  onStop={() => void session.toggleRecording()}
                  onHide={() => void getDesktopLiveTranslationApi()?.hideMainWindow()}
                  t={t}
                />
              </motion.div>
            )}
          </AnimatePresence>
        </main>

        {/* ═══ Completion dialog ═══ */}
        <RecordingCompleteDialog
          completedSession={pendingComplete}
          open={!recording && !!pendingComplete}
          onOpenChange={(open) => {
            if (!open) clearPendingComplete();
          }}
          onSave={handleSave}
          onDismiss={() => undefined}
        />
      </div>
    </TooltipProvider>
  );
}

// Full-page live transcript. Auto-scrolls to the newest line as segments arrive.
//
// Memoized: the recording session pushes a level/elapsed update five times a
// second, and re-reconciling a long transcript that often is pure waste — the
// feed only changes when the segments (or a view toggle) actually change.
const TranscriptFeed = memo(function TranscriptFeed({
  segments,
  showSource,
  liveTranscribe,
  translationEnabled,
  tab,
  onTabChange,
  onToggleLive,
  t,
}: {
  segments: readonly LiveTranslationSegment[];
  showSource: boolean;
  liveTranscribe: boolean;
  /** Whether live translation (target-language output) is currently active. */
  translationEnabled: boolean;
  tab: TranscriptTab;
  onTabChange: (tab: TranscriptTab) => void;
  onToggleLive: () => void;
  t: (key: string) => string;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [segments.length]);

  return (
    <div className="mx-auto flex h-full max-w-3xl flex-col px-6">
      <div className="flex h-11 shrink-0 items-center justify-between border-b border-border/60">
        <Tabs value={tab} onValueChange={(value) => onTabChange(value as TranscriptTab)}>
          <TabsList className="h-7">
            <TabsTrigger value="transcript" className="px-3 text-xs">
              {t("transcript_detail.tab_transcript")}
            </TabsTrigger>
            <TabsTrigger value="timeline" className="px-3 text-xs">
              {t("transcript_detail.tab_timeline")}
            </TabsTrigger>
          </TabsList>
        </Tabs>
        <span className="text-2xs text-muted-foreground">
          {segments.length} {t("live_translation.segments")}
        </span>
      </div>

      <div ref={ref} className="min-h-0 flex-1 overflow-y-auto py-5 pb-28">
        {!liveTranscribe && (
          <button
            type="button"
            onClick={onToggleLive}
            className="mb-3 flex w-full items-center gap-2 rounded-md bg-warning/10 px-3 py-2 text-left text-xs text-warning-text transition-colors hover:bg-warning/15"
          >
            <Pause className="size-3.5" />
            {t("transcript_detail.transcribe_paused")}
          </button>
        )}

        {segments.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center text-center text-muted-foreground">
            <span className="mb-3 flex size-12 items-center justify-center rounded-full bg-muted">
              <Volume2 className="size-5" />
            </span>
            <p className="text-sm font-medium text-foreground">{t("transcript_detail.empty_title")}</p>
            <p className="mt-1 max-w-sm text-xs">{t("transcript_detail.empty_hint")}</p>
          </div>
        ) : tab === "transcript" ? (
          <div className="pb-2">
            {segments.map((segment, index) => {
              // Only render the translation line when translation is actually
              // enabled. Segments may retain a stale `translatedText` from
              // before the switch was turned off, so we must gate on the flag
              // rather than on the segment data alone.
              const hasTranslation =
                translationEnabled &&
                segment.translatedText &&
                segment.translatedText !== segment.recognizedText;
              // Label the speaker on the first utterance of each speaker run
              // instead of repeating it on every line.
              const prev = index > 0 ? segments[index - 1] : undefined;
              const showSpeaker = segment.speaker != null && segment.speaker !== prev?.speaker;
              return (
                <div key={segment.id} className="flex items-start gap-4 py-2">
                  <span className="w-14 shrink-0 pt-0.5 font-mono text-2xs tabular-nums text-muted-foreground/60">
                    {formatTime(segment.startMs)}
                  </span>
                  <div className="min-w-0 flex-1">
                    {showSpeaker && (
                      <div className="mb-0.5 text-2xs font-medium text-primary/80">
                        {t("live_translation.speaker")} {segment.speaker}
                      </div>
                    )}
                    {showSource && (
                      <p className="text-sm leading-relaxed text-foreground">
                        {segment.recognizedText}
                        {!segment.isFinal && (
                          <span className="ml-0.5 inline-block h-3.5 w-0.5 animate-pulse rounded-full bg-primary align-[-2px]" />
                        )}
                      </p>
                    )}
                    {hasTranslation && (
                      <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
                        {segment.translatedText}
                      </p>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="space-y-2.5">
            {segments.map((segment) => (
              <div key={segment.id} className="flex items-start gap-3">
                <span className="w-14 shrink-0 pt-0.5 font-mono text-2xs tabular-nums text-muted-foreground">
                  {formatTime(segment.startMs).slice(3)}
                </span>
                <p className="min-w-0 flex-1 text-sm leading-relaxed text-foreground/90">
                  {segment.recognizedText || (translationEnabled ? segment.translatedText : "")}
                </p>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
});

// Recording-only stage, styled after the Voice-Memos / Huawei recorder UI:
// a time ruler over a full-width waveform band with a red centre playhead,
// a large `MM:SS.cs` timer beneath it, and a transport bar at the bottom
// (bookmark · pause · stop) while recording. When idle only the big red
// start button shows.
function RecordingStage({
  recording,
  paused,
  busy,
  stopping,
  elapsedMs,
  micLevel,
  statusLabel,
  onStart,
  onTogglePause,
  onStop,
  onHide,
  t,
}: {
  recording: boolean;
  paused: boolean;
  busy: boolean;
  stopping: boolean;
  elapsedMs: number;
  micLevel: number;
  statusLabel: string;
  onStart: () => void;
  onTogglePause: () => void;
  onStop: () => void;
  onHide: () => void;
  t: (key: string) => string;
}) {
  const [markers, setMarkers] = useState<number[]>([]);
  const reduceMotion = useReducedMotion();

  // Markers belong to the running session; clear them once it stops.
  useEffect(() => {
    if (!recording) setMarkers([]);
  }, [recording]);

  const addMarker = () => {
    setMarkers((prev) => [...prev, Math.max(0, elapsedMs) / 1000]);
  };

  // Landing choreography: the stage settles in as three staggered layers —
  // waveform, timer, then the transport bar rising from the bottom edge —
  // so landing here from the float dock (or the sidebar) reads as one
  // continuous motion instead of a hard content swap. Mount-only.
  const enter = (delay: number, y: number, duration = 0.32) => ({
    initial: reduceMotion
      ? false
      : { opacity: 0, transform: `translateY(${y}px)` },
    animate: { opacity: 1, transform: "translateY(0px)" },
    transition: { duration, delay, ease: [0.22, 1, 0.36, 1] } as Transition,
  });

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Time ruler + waveform band + centre playhead.
          flex-[2] vs the spacer's flex-1 gives the band ~50% more height. */}
      <motion.div className="flex min-h-0 w-full flex-[2]" {...enter(0, 14)}>
        <RecordingWaveform
          elapsedMs={elapsedMs}
          micLevel={micLevel}
          active={recording && !paused}
          markers={markers}
          className="min-h-0 w-full flex-1"
        />
      </motion.div>

      {/* Large centisecond timer + status */}
      <motion.div className="mt-6 shrink-0 text-center" {...enter(0.06, 10)}>
        <SmoothTimer
          elapsedMs={elapsedMs}
          running={recording && !paused}
          format={formatTimerCentis}
          className="block text-6xl font-medium tracking-tight tabular-nums text-foreground"
        />
        <div className="mt-1.5 flex items-center justify-center gap-2 text-sm text-muted-foreground">
          <span
            className={cn(
              "size-2 rounded-full",
              paused
                ? "bg-warning"
                : recording
                  ? "animate-pulse bg-destructive"
                  : "bg-muted-foreground/40",
            )}
          />
          <span>{statusLabel}</span>
        </div>
      </motion.div>

      <div className="min-h-8 flex-1" />

      {/* Transport bar — start (idle) / bookmark · stop · pause (recording):
          the centre button owns the lifecycle (mic → stop square), pause /
          resume lives on the black circle at the right. */}
      <motion.div
        className="relative mx-auto mb-9 grid w-full max-w-[1100px] grid-cols-[1fr_auto_1fr] items-center px-10"
        {...enter(0.12, 18, 0.38)}
      >
        {recording ? (
          <>
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    onClick={addMarker}
                    aria-label={t("recording_mode.bookmark")}
                    className="mx-auto flex flex-col items-center gap-1.5 rounded-xl px-3 py-1.5 text-2xs text-muted-foreground transition-colors hover:text-foreground"
                  >
                    <Bookmark className="size-5 text-foreground/80" />
                    <span>{t("recording_mode.bookmark")}</span>
                  </button>
                }
              />
              <TooltipContent>{t("recording_mode.bookmark")}</TooltipContent>
            </Tooltip>

            {/* Stop — the record button turns into stop while recording */}
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    onClick={onStop}
                    disabled={busy}
                    aria-label={t("recording_mode.stop_recording")}
                    className="mx-auto flex size-16 items-center justify-center rounded-full bg-destructive text-white shadow-lg shadow-destructive/25 transition-all duration-200 hover:scale-105 hover:bg-destructive/90 active:scale-95 disabled:opacity-60 disabled:hover:scale-100"
                  >
                    {busy ? (
                      <Loader2 className="size-6 animate-spin" />
                    ) : (
                      <Square className="size-5 fill-current" />
                    )}
                  </button>
                }
              />
              <TooltipContent>{t("recording_mode.stop_recording")}</TooltipContent>
            </Tooltip>

            {/* Pause / resume — bare icon + label, mirroring the bookmark
                button's style so the two side controls read as one row */}
            <div className="relative flex items-center justify-center">
              <Tooltip>
                <TooltipTrigger
                  render={
                    <button
                      type="button"
                      onClick={onTogglePause}
                      aria-label={paused ? t("recording_mode.resume") : t("recording_mode.pause")}
                      className="mx-auto flex flex-col items-center gap-2 rounded-xl px-4 py-2 text-xs text-muted-foreground transition-colors hover:text-foreground"
                    >
                      {paused ? (
                        <Play className="size-6 fill-current text-foreground/80" />
                      ) : (
                        <Pause className="size-6 text-foreground/80" />
                      )}
                      <span>{paused ? t("recording_mode.resume") : t("recording_mode.pause")}</span>
                    </button>
                  }
                />
                <TooltipContent>
                  {paused ? t("recording_mode.resume") : t("recording_mode.pause")}
                </TooltipContent>
              </Tooltip>

              {/* Hide main window — recording keeps running via the island */}
              <Tooltip>
                <TooltipTrigger
                  render={
                    <button
                      type="button"
                      onClick={onHide}
                      aria-label={t("recording_mode.hide_to_island")}
                      className="absolute right-2 flex size-9 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground"
                    >
                      <EyeOff className="size-4.5" />
                    </button>
                  }
                />
                <TooltipContent>{t("recording_mode.hide_to_island")}</TooltipContent>
              </Tooltip>
            </div>
          </>
        ) : (
          <>
            <span />
            {/* Idle — the big red record button (locked while a stop is being
                finalized in the background) */}
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    onClick={onStart}
                    disabled={busy || stopping}
                    aria-label={t("recording_mode.start_recording")}
                    className="mx-auto flex size-16 items-center justify-center rounded-full bg-destructive text-white shadow-lg shadow-destructive/25 transition-all duration-200 hover:scale-105 hover:bg-destructive/90 active:scale-95 disabled:opacity-60 disabled:hover:scale-100"
                  >
                    {busy ? <Loader2 className="size-6 animate-spin" /> : <Mic className="size-6" />}
                  </button>
                }
              />
              <TooltipContent>{t("recording_mode.start_recording")}</TooltipContent>
            </Tooltip>
            <span />
          </>
        )}
      </motion.div>
    </div>
  );
}
