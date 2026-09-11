"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "@lynse/core/i18n/react";
import { useNavigation } from "../navigation";
import { toast } from "sonner";
import {
  ArrowLeft,
  Loader2,
  Pause,
  Play,
  Scissors,
  Combine,
  Sparkles,
  VolumeX,
  Wand2,
} from "../icons";
import { Button } from "@lynse/ui/components/ui/button";
import { getDesktopAudioEditorApi } from "./api";
import { useAudioEditorStore } from "./store";
import { EditorWaveform, type WaveformSelection } from "./editor-waveform";
import { useAudioAnalysis } from "./use-audio-analysis";

type EditorMode = "trim" | "merge" | "desilence" | "enhance";

function formatTime(seconds: number): string {
  if (!isFinite(seconds) || isNaN(seconds)) return "0:00";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export function AudioEditorPage() {
  const { t } = useTranslation();
  const { push } = useNavigation();
  const request = useAudioEditorStore((s) => s.request);
  const clearRequest = useAudioEditorStore((s) => s.clear);
  const api = useMemo(() => getDesktopAudioEditorApi(), []);

  const items = request?.items ?? [];
  const canMerge = items.length >= 2;

  const [mode, setMode] = useState<EditorMode>(canMerge ? "merge" : "trim");
  const [activeIndex, setActiveIndex] = useState(0);
  const activeItem = items[activeIndex] ?? null;

  // Audio URL per item, resolved from the local-transcription store.
  const [audioUrls, setAudioUrls] = useState<Record<string, string>>({});
  useEffect(() => {
    if (!api || items.length === 0) return;
    let cancelled = false;
    (async () => {
      const desktopWindow = window as Window & {
        desktopAPI?: { localTranscription?: { getAudioUrl: (id: string) => Promise<string | null> } };
      };
      const localApi = desktopWindow.desktopAPI?.localTranscription;
      if (!localApi) return;
      const entries = await Promise.all(
        items.map(async (item) => {
          const url = await localApi.getAudioUrl(item.id);
          return url ? ([item.id, url] as const) : null;
        }),
      );
      if (cancelled) return;
      setAudioUrls(Object.fromEntries(entries.filter((entry): entry is readonly [string, string] => entry != null)));
    })();
    return () => {
      cancelled = true;
    };
  }, [api, items]);

  const activeUrl = activeItem ? audioUrls[activeItem.id] ?? null : null;

  // FFmpeg runtime availability (downloaded on demand, shared with STT).
  const [runtimeReady, setRuntimeReady] = useState<boolean | null>(null);
  const [runtimeDownloading, setRuntimeDownloading] = useState(false);
  const [runtimePercent, setRuntimePercent] = useState<number | null>(null);

  useEffect(() => {
    if (!api) return;
    void api.status().then((status) => setRuntimeReady(status.ffmpegAvailable));
  }, [api]);

  // Runtime download progress arrives on the shared stt-download-progress
  // channel (provider "editor").
  useEffect(() => {
    if (!runtimeDownloading) return;
    const desktopWindow = window as Window & {
      desktopAPI?: {
        localTranscription?: { onSttDownloadProgress: (cb: (p: { provider: string; percent: number | null; phase: string }) => void) => Promise<() => void> };
      };
    };
    let unlisten: (() => void) | null = null;
    let disposed = false;
    void desktopWindow.desktopAPI?.localTranscription?.onSttDownloadProgress((progress) => {
      if (progress.provider !== "editor") return;
      setRuntimePercent(progress.percent);
    }).then((fn) => {
      if (disposed) fn();
      else unlisten = fn;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [runtimeDownloading]);

  const handleEnsureRuntime = useCallback(async () => {
    if (!api) return;
    setRuntimeDownloading(true);
    setRuntimePercent(null);
    try {
      const status = await api.ensureRuntime();
      setRuntimeReady(status.ffmpegAvailable);
      if (!status.ffmpegAvailable) {
        toast.error(t("audio_editor.runtime_failed"));
      }
    } catch (error) {
      toast.error(String(error));
    } finally {
      setRuntimeDownloading(false);
      setRuntimePercent(null);
    }
  }, [api, t]);

  // Analysis of the active file (peaks + silence segments). Desilence keeps
  // one-click defaults; the same numbers feed both the preview overlay and
  // the ffmpeg filter on the Rust side.
  const desilenceThresholdDb = -35;
  const desilenceMinSilenceSec = 0.6;
  const analysis = useAudioAnalysis(activeUrl, {
    thresholdDb: desilenceThresholdDb,
    minSilenceSec: desilenceMinSilenceSec,
  });

  // Playback.
  const audioRef = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [playheadSec, setPlayheadSec] = useState(0);
  useEffect(() => {
    if (!playing) return;
    const timer = setInterval(() => {
      if (audioRef.current) setPlayheadSec(audioRef.current.currentTime);
    }, 60);
    return () => clearInterval(timer);
  }, [playing]);

  // Reset transport state when switching files / modes.
  useEffect(() => {
    setPlayheadSec(0);
    setSelection(null);
  }, [activeItem?.id]);

  const togglePlay = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.paused) {
      void audio.play().catch(() => {});
    } else {
      audio.pause();
    }
  }, []);

  const seekTo = useCallback((sec: number) => {
    if (audioRef.current) audioRef.current.currentTime = sec;
    setPlayheadSec(sec);
  }, []);

  // Trim selection.
  const [selection, setSelection] = useState<WaveformSelection | null>(null);

  // Job state. Liveness/done/error arrive via `audio-editor-progress`; the
  // command promise itself carries success/failure for the toast.
  const [processing, setProcessing] = useState(false);

  const runExport = useCallback(
    async (action: () => Promise<unknown>) => {
      if (!api) return;
      setProcessing(true);
      try {
        await action();
        toast.success(t("audio_editor.export_done"));
        clearRequest();
        push("/notes");
      } catch (error) {
        toast.error(String(error));
      } finally {
        setProcessing(false);
      }
    },
    [api, clearRequest, push, t],
  );

  const handleTrim = useCallback(() => {
    if (!api || !activeItem || !selection) return;
    void runExport(() =>
      api.trim(activeItem.id, selection.startSec, selection.endSec, activeItem.title),
    );
  }, [api, activeItem, selection, runExport]);

  const handleMerge = useCallback(() => {
    if (!api || !canMerge) return;
    void runExport(() => api.merge(items.map((item) => item.id)));
  }, [api, canMerge, items, runExport]);

  const handleDesilence = useCallback(() => {
    if (!api || !activeItem) return;
    void runExport(() =>
      api.removeSilence(activeItem.id, {
        thresholdDb: desilenceThresholdDb,
        minSilenceSec: desilenceMinSilenceSec,
      }),
    );
  }, [api, activeItem, runExport]);

  const handleEnhance = useCallback(() => {
    if (!api || !activeItem) return;
    void runExport(() => api.enhanceVoice(activeItem.id, activeItem.title));
  }, [api, activeItem, runExport]);

  const handleCancel = useCallback(() => {
    void api?.cancel();
  }, [api]);

  if (!api || items.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 bg-background text-sm text-muted-foreground">
        <p>{t("audio_editor.empty")}</p>
        <Button variant="outline" size="sm" onClick={() => push("/notes")}>
          <ArrowLeft className="size-4" />
          {t("audio_editor.back_to_notes")}
        </Button>
      </div>
    );
  }

  const modes: { id: EditorMode; label: string; icon: React.ReactNode; disabled?: boolean }[] = [
    { id: "trim", label: t("audio_editor.trim"), icon: <Scissors className="size-4" /> },
    { id: "merge", label: t("audio_editor.merge"), icon: <Combine className="size-4" />, disabled: !canMerge },
    { id: "desilence", label: t("audio_editor.desilence"), icon: <VolumeX className="size-4" /> },
    { id: "enhance", label: t("audio_editor.enhance"), icon: <Wand2 className="size-4" /> },
  ];

  const totalSilenceSec = analysis.silenceSegments.reduce(
    (sum, s) => sum + (s.endSec - s.startSec),
    0,
  );

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      {/* Header */}
      <div className="flex shrink-0 items-center gap-3 border-b border-border/50 px-5 py-3">
        <Button variant="ghost" size="icon" className="size-8" onClick={() => push("/notes")}>
          <ArrowLeft className="size-4" />
        </Button>
        <h2 className="text-sm font-semibold text-foreground">{t("audio_editor.title")}</h2>
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
          {activeItem?.title ?? ""}
        </span>
        <div className="flex items-center gap-1 rounded-lg border border-border/60 bg-muted/20 p-0.5">
          {modes.map((entry) => (
            <button
              key={entry.id}
              type="button"
              disabled={entry.disabled || processing}
              title={entry.disabled ? t("audio_editor.merge_needs_two") : entry.label}
              onClick={() => setMode(entry.id)}
              className={
                "flex h-7 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium transition-colors disabled:opacity-40 " +
                (mode === entry.id
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground")
              }
            >
              {entry.icon}
              {entry.label}
            </button>
          ))}
        </div>
      </div>

      {/* Runtime banner */}
      {runtimeReady === false && (
        <div className="flex items-center gap-3 border-b border-border/50 bg-muted/30 px-5 py-2.5 text-xs text-muted-foreground">
          <span className="flex-1">{t("audio_editor.runtime_missing")}</span>
          <Button
            size="sm"
            disabled={runtimeDownloading}
            onClick={() => void handleEnsureRuntime()}
          >
            {runtimeDownloading ? (
              <>
                <Loader2 className="size-3.5 animate-spin" />
                {runtimePercent != null ? `${runtimePercent}%` : t("audio_editor.runtime_downloading")}
              </>
            ) : (
              t("audio_editor.runtime_download")
            )}
          </Button>
        </div>
      )}

      {/* Body */}
      <div className="flex min-h-0 flex-1">
        {/* Merge playlist */}
        {mode === "merge" && canMerge && (
          <div className="w-60 shrink-0 overflow-y-auto border-r border-border/50 px-3 py-3">
            <p className="px-1 pb-2 text-2xs font-medium text-muted-foreground">
              {t("audio_editor.merge_order")}
            </p>
            {items.map((item, index) => (
              <button
                key={item.id}
                type="button"
                onClick={() => setActiveIndex(index)}
                className={
                  "mb-1 flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-xs transition-colors " +
                  (index === activeIndex
                    ? "bg-accent text-foreground"
                    : "text-muted-foreground hover:bg-accent/50 hover:text-foreground")
                }
              >
                <span className="tabular-nums">{index + 1}.</span>
                <span className="min-w-0 flex-1 truncate">{item.title}</span>
              </button>
            ))}
          </div>
        )}

        {/* Waveform + transport */}
        <div className="flex min-w-0 flex-1 flex-col gap-4 px-5 py-4">
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={togglePlay}
              className="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground transition-colors hover:bg-primary/90"
            >
              {playing ? <Pause className="size-4" /> : <Play className="ml-0.5 size-4" />}
            </button>
            <div className="flex items-center gap-2 text-xs tabular-nums text-muted-foreground">
              <span>{formatTime(playheadSec)}</span>
              <span>/</span>
              <span>{analysis.loading ? "…" : formatTime(analysis.durationSec)}</span>
            </div>
            {mode === "trim" && selection && (
              <span className="rounded-md bg-muted px-2 py-0.5 text-2xs tabular-nums text-muted-foreground">
                {t("audio_editor.selection", {
                  start: formatTime(selection.startSec),
                  end: formatTime(selection.endSec),
                })}
              </span>
            )}
            {mode === "desilence" && !analysis.loading && analysis.silenceSegments.length > 0 && (
              <span className="rounded-md bg-muted px-2 py-0.5 text-2xs tabular-nums text-muted-foreground">
                {t("audio_editor.silence_found", { count: analysis.silenceSegments.length, seconds: formatTime(totalSilenceSec) })}
              </span>
            )}
          </div>

          <div className="min-h-0 flex-1 overflow-hidden rounded-xl border border-border/60 bg-muted/10">
            {analysis.loading ? (
              <div className="flex h-full items-center justify-center gap-2 text-xs text-muted-foreground">
                <Loader2 className="size-4 animate-spin" />
                {t("audio_editor.analyzing")}
              </div>
            ) : analysis.skipped || analysis.error || !activeUrl ? (
              <div className="flex h-full items-center justify-center px-6 text-center text-xs text-muted-foreground">
                {t("audio_editor.waveform_unavailable")}
              </div>
            ) : (
              <EditorWaveform
                className="h-full w-full"
                peaks={analysis.peaks}
                durationSec={analysis.durationSec}
                playheadSec={playheadSec}
                selection={mode === "trim" ? selection : null}
                silenceSegments={mode === "desilence" ? analysis.silenceSegments : undefined}
                onSeek={seekTo}
                onSelectionChange={setSelection}
              />
            )}
          </div>

          {/* Per-mode hint + export */}
          <div className="flex shrink-0 items-center gap-3">
            <p className="min-w-0 flex-1 text-2xs text-muted-foreground">
              {mode === "trim" && t("audio_editor.trim_hint")}
              {mode === "merge" && (canMerge ? t("audio_editor.merge_hint") : t("audio_editor.merge_needs_two"))}
              {mode === "desilence" && t("audio_editor.desilence_hint")}
              {mode === "enhance" && t("audio_editor.enhance_hint")}
            </p>
            {processing ? (
              <Button variant="outline" size="sm" onClick={handleCancel}>
                <Loader2 className="size-3.5 animate-spin" />
                {t("audio_editor.cancel")}
              </Button>
            ) : (
              <Button
                size="sm"
                disabled={
                  runtimeReady !== true ||
                  (mode === "trim" && !selection) ||
                  (mode === "merge" && !canMerge)
                }
                onClick={
                  mode === "trim"
                    ? handleTrim
                    : mode === "merge"
                      ? handleMerge
                      : mode === "desilence"
                        ? handleDesilence
                        : handleEnhance
                }
              >
                {mode === "trim" && <Scissors className="size-3.5" />}
                {mode === "merge" && <Combine className="size-3.5" />}
                {mode === "desilence" && <VolumeX className="size-3.5" />}
                {mode === "enhance" && <Sparkles className="size-3.5" />}
                {t("audio_editor.export")}
              </Button>
            )}
          </div>
        </div>
      </div>

      {activeUrl && (
        <audio
          ref={audioRef}
          src={activeUrl}
          preload="metadata"
          onPlaying={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onEnded={() => setPlaying(false)}
          className="hidden"
        />
      )}
    </div>
  );
}
