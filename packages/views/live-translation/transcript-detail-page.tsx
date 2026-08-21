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
import { AudioVisualizer } from "./audio-visualizer";
import { RecordingDock } from "./recording-dock";
import { RecordingCompleteDialog } from "./recording-complete-dialog";
import { getDesktopLiveTranslationApi } from "./desktop-api";
import { ArrowRight, Captions, Eye, FileAudio, Pause, Volume2 } from "../icons";
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

  const timestamp = useMemo(() => {
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }, []);

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
        <header className="flex h-14 shrink-0 items-center justify-between gap-3 border-b border-border px-5">
          <div className="flex min-w-0 items-center gap-2.5">
            <span className="flex size-8 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <FileAudio className="size-4" />
            </span>
            <div className="min-w-0">
              <h1 className="truncate text-sm font-semibold leading-tight">
                {t("transcript_detail.title")}
              </h1>
              <p className="truncate text-[11px] leading-tight text-muted-foreground">{timestamp}</p>
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
                    "rounded-full px-2.5 py-1 text-[11px] font-medium transition-colors",
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
                  <span className="text-[11px] font-medium leading-none">
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
                    className="h-7 w-24 border-border/60 bg-background/60 text-[11px]"
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
                        className="h-7 w-24 border-border/60 bg-background/60 text-[11px]"
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
            <TranscriptFeed
              segments={visibleSegments}
              showSource={showSource}
              liveTranscribe={liveTranscribe}
              tab={transcriptTab}
              onTabChange={setTranscriptTab}
              onToggleLive={handleToggleLive}
              t={t}
            />
          ) : (
            <RecordingStage
              recording={recording}
              paused={paused}
              formattedTime={session.formattedTime}
              micLevel={session.micLevel}
              statusLabel={stageStatus}
              t={t}
            />
          )}

          {/* Floating glassmorphism dock */}
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
  tab,
  onTabChange,
  onToggleLive,
  t,
}: {
  segments: readonly LiveTranslationSegment[];
  showSource: boolean;
  liveTranscribe: boolean;
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
        <span className="text-[11px] text-muted-foreground">
          {segments.length} {t("live_translation.segments")}
        </span>
      </div>

      <div ref={ref} className="min-h-0 flex-1 overflow-y-auto py-5 pb-28">
        {!liveTranscribe && (
          <button
            type="button"
            onClick={onToggleLive}
            className="mb-3 flex w-full items-center gap-2 rounded-md bg-amber-500/10 px-3 py-2 text-left text-xs text-amber-700 transition-colors hover:bg-amber-500/15 dark:text-amber-300"
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
            {segments.map((segment) => {
              const hasTranslation =
                segment.translatedText && segment.translatedText !== segment.recognizedText;
              return (
                <article
                  key={segment.id}
                  className="rounded-xl border border-border bg-card px-4 py-3 shadow-sm"
                >
                  <div className="mb-1.5 flex items-center gap-2 text-[11px] text-muted-foreground">
                    <span className="tabular-nums">{formatTime(segment.startMs)}</span>
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
            {segments.map((segment) => (
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
    </div>
  );
}

// Recording-only stage: when no text stream is active the page shows just the
// recording activity — a large timer plus a live waveform animation.
function RecordingStage({
  recording,
  paused,
  formattedTime,
  micLevel,
  statusLabel,
  t,
}: {
  recording: boolean;
  paused: boolean;
  formattedTime: string;
  micLevel: number;
  statusLabel: string;
  t: (key: string) => string;
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-7 px-6 text-center">
      <div className="flex items-center gap-2.5">
        <span
          className={cn(
            "size-3 rounded-full",
            paused
              ? "bg-amber-500"
              : recording
                ? "animate-pulse bg-red-500"
                : "bg-muted-foreground/40",
          )}
        />
        <span className="text-sm font-medium text-muted-foreground">{statusLabel}</span>
      </div>

      <div className="font-mono text-6xl font-semibold tracking-tight tabular-nums text-foreground">
        {formattedTime || "00:00:00"}
      </div>

      <div className="h-32 w-full max-w-xl">
        <AudioVisualizer level={micLevel} active={recording && !paused} className="h-full w-full" />
      </div>

      <p className="max-w-sm text-xs leading-relaxed text-muted-foreground">
        {t("recording_mode.status_recording")}
      </p>
    </div>
  );
}
