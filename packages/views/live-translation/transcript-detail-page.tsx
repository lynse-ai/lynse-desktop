"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { RecordingWaveform } from "./recording-waveform";
import { RecordingDock } from "./recording-dock";
import { RecordingCompleteDialog } from "./recording-complete-dialog";
import { getDesktopLiveTranslationApi } from "./desktop-api";
import {
  ArrowRight,
  Bookmark,
  Captions,
  Eye,
  EyeOff,
  FileAudio,
  Loader2,
  Mic,
  Pause,
  Play,
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
//   · Header — title, mode switch (纯录音 / 实时), translation switch,
//     language pair, status chip, and the two view toggles.
//   · Main   — the whole area shows the live transcript when a text stream is
//              active; in pure-recording mode (or with live transcription
//              paused) it shows only the recording activity (timer + animation).
//   · Dock   — a floating glassmorphism bar at the bottom holds Start / Pause /
//              Stop and animates while recording.
// ───────────────────────────────────────────────────────────────

export function TranscriptDetailPage() {
  const { t } = useTranslation();
  const session = useRecordingSession();
  const { syncCompletedSession } = useRecordingCloudSync();

  // ── view toggles ──
  const [showSource, setShowSource] = useState(true); // 显示原文
  const [liveTranscribe, setLiveTranscribe] = useState(true); // 实时转录
  const [frozenSegments, setFrozenSegments] = useState<readonly LiveTranslationSegment[]>([]);
  const [transcriptTab, setTranscriptTab] = useState<TranscriptTab>("transcript");

  const recording = session.recording;
  const paused = session.paused;
  const busy = session.busy;
  const displayMode: RecordMode = recording ? session.activeMode : session.mode;
  const transcribing = displayMode !== "record";

  // Freeze the transcript snapshot when live transcription is toggled off.
  const visibleSegments = useMemo(() => {
    if (liveTranscribe) return session.segments;
    return frozenSegments.length ? frozenSegments : session.segments;
  }, [liveTranscribe, frozenSegments, session.segments]);

  function handleToggleLive() {
    if (liveTranscribe) setFrozenSegments(session.segments);
    setLiveTranscribe((v) => !v);
  }

  // The whole page shows the transcript only while a text stream is active;
  // otherwise it shows just the recording activity (timer + animation).
  const showTranscript = transcribing;

  // Status text for the recording-activity stage.
  const stageStatus = recording
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
          <div className="flex min-w-0 items-center gap-2.5">
            <span className="flex size-8 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <FileAudio className="size-4" />
            </span>
            <div className="min-w-0">
              <h1 className="truncate text-sm font-semibold leading-tight">
                {t("transcript_detail.title")}
              </h1>
              <p className="truncate text-2xs leading-tight tabular-nums text-muted-foreground">
                {session.formattedTime}
              </p>
            </div>
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
                    "rounded-full px-2.5 py-1 text-2xs font-medium transition-colors",
                    displayMode === m
                      ? "bg-primary/15 text-primary"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {m === "record"
                    ? t("recording_mode.record")
                    : t("recording_mode.live_short")}
                </button>
              ))}
            </div>

            {/* live mode controls — translation switch + language pair */}
            {transcribing && (
              <div className="flex items-center gap-2">
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
              </div>
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
          {showTranscript ? (
            <>
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
                  pure-recording stage owns its own transport bar) */}
              <div className="pointer-events-none absolute inset-x-0 bottom-5 flex justify-center px-4">
                <RecordingDock
                  recording={recording}
                  paused={paused}
                  busy={busy}
                  formattedTime={session.formattedTime}
                  micLevel={session.micLevel}
                  bookmarked={session.bookmarked}
                  onStart={() => void session.toggleRecording()}
                  onTogglePause={() => void session.togglePause()}
                  onStop={() => void session.toggleRecording()}
                  onToggleBookmark={() => session.setBookmarked(!session.bookmarked)}
                  onHide={() => void getDesktopLiveTranslationApi()?.minimizeToTray()}
                />
              </div>
            </>
          ) : (
            <RecordingStage
              recording={recording}
              paused={paused}
              busy={busy}
              elapsedMs={session.elapsedMs}
              micLevel={session.micLevel}
              statusLabel={stageStatus}
              onStart={() => void session.toggleRecording()}
              onTogglePause={() => void session.togglePause()}
              onStop={() => void session.toggleRecording()}
              onHide={() => void getDesktopLiveTranslationApi()?.minimizeToTray()}
              t={t}
            />
          )}
        </main>

        {/* ═══ Completion dialog ═══ */}
        <RecordingCompleteDialog
          completedSession={session.completedSession}
          open={session.showCompleteDialog}
          onOpenChange={(open) => {
            if (!open) session.dismissCompleteDialog();
          }}
          onSave={handleSave}
          onDismiss={() => undefined}
        />
      </div>
    </TooltipProvider>
  );
}

// Full-page live transcript. Auto-scrolls to the newest line as segments arrive.
function TranscriptFeed({
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
          <div className="space-y-3">
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
              const prevSpeaker = index > 0 ? segments[index - 1]?.speaker : undefined;
              const showSpeaker = segment.speaker != null && segment.speaker !== prevSpeaker;
              return (
                <article
                  key={segment.id}
                  className="rounded-xl border border-border bg-card px-4 py-3 shadow-sm"
                >
                  <div className="mb-1.5 flex items-center gap-2 text-2xs text-muted-foreground">
                    <span className="tabular-nums">{formatTime(segment.startMs)}</span>
                    {showSpeaker && (
                      <span className="rounded bg-primary/10 px-1.5 py-0.5 text-3xs font-medium text-primary">
                        {t("live_translation.speaker")} {segment.speaker}
                      </span>
                    )}
                    {!segment.isFinal && (
                      <span className="animate-pulse">{t("transcript_detail.recognizing")}</span>
                    )}
                  </div>
                  {showSource && (
                    <p className="text-base font-medium leading-relaxed text-foreground">
                      {segment.recognizedText}
                    </p>
                  )}
                  {hasTranslation && (
                    <div className="mt-1.5 border-l-2 border-border pl-2.5">
                      <span className="mb-0.5 block text-3xs font-medium uppercase tracking-wide text-muted-foreground/70">
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
}

// Recording-only stage, styled after the Voice-Memos / Huawei recorder UI:
// a time ruler over a full-width waveform band with a red centre playhead,
// a large `MM:SS.cs` timer beneath it, and a transport bar at the bottom
// (bookmark · stop · pause) while recording. When idle only the big red
// start button shows.
function RecordingStage({
  recording,
  paused,
  busy,
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

  // Markers belong to the running session; clear them once it stops.
  useEffect(() => {
    if (!recording) setMarkers([]);
  }, [recording]);

  const addMarker = () => {
    setMarkers((prev) => [...prev, Math.max(0, elapsedMs) / 1000]);
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Time ruler + waveform band + centre playhead.
          flex-[2] vs the spacer's flex-1 gives the band ~50% more height. */}
      <RecordingWaveform
        elapsedMs={elapsedMs}
        micLevel={micLevel}
        active={recording && !paused}
        markers={markers}
        className="min-h-0 w-full flex-[2]"
      />

      {/* Large centisecond timer + status */}
      <div className="mt-6 shrink-0 text-center">
        <div className="text-6xl font-medium tracking-tight tabular-nums text-foreground">
          {formatTimerCentis(elapsedMs)}
        </div>
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
      </div>

      <div className="min-h-8 flex-1" />

      {/* Transport bar — start (idle) / bookmark · stop · pause (recording) */}
      <div className="relative mx-auto mb-9 grid w-full max-w-[1100px] grid-cols-[1fr_auto_1fr] items-center px-10">
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

            {/* Stop — white circle with a red rounded square */}
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    onClick={onStop}
                    disabled={busy}
                    aria-label={t("recording_mode.stop_recording")}
                    className="flex size-[78px] items-center justify-center rounded-full bg-background shadow-[0_6px_18px_rgba(0,0,0,0.12)] transition-transform duration-200 hover:scale-[1.03] active:scale-95 disabled:opacity-60 disabled:hover:scale-100 dark:shadow-[0_6px_18px_rgba(0,0,0,0.55)]"
                  >
                    {busy ? (
                      <Loader2 className="size-6 animate-spin text-muted-foreground" />
                    ) : (
                      <span className="size-[30px] rounded-lg bg-destructive" />
                    )}
                  </button>
                }
              />
              <TooltipContent>{t("recording_mode.stop_recording")}</TooltipContent>
            </Tooltip>

            <div className="relative flex items-center justify-center">
              <Tooltip>
                <TooltipTrigger
                  render={
                    <button
                      type="button"
                      onClick={onTogglePause}
                      aria-label={paused ? t("recording_mode.resume") : t("recording_mode.pause")}
                      className="flex flex-col items-center gap-1.5 rounded-xl px-3 py-1.5 text-2xs text-muted-foreground transition-colors hover:text-foreground"
                    >
                      {paused ? (
                        <Play className="size-5 text-foreground/80" />
                      ) : (
                        <Pause className="size-5 text-foreground/80" />
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
            {/* Idle — the big red record button */}
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    onClick={onStart}
                    disabled={busy}
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
      </div>
    </div>
  );
}
