"use client";

import { useRef, useState, useEffect, useCallback, useImperativeHandle, forwardRef } from "react";
import { Play, Pause, SkipForward, Volume2, VolumeX, Crop, Download, Loader2, Mic, Monitor } from "../icons";
import { IconSwap } from "../icon-swap";
import { useTranslation } from "@lynse/core/i18n/react";
import { cn } from "@lynse/ui/lib/utils";
import { useWaveformPeaks } from "./use-waveform-peaks";
import type { RecordingAudioSourceInterval } from "./types";
import { WaveformProgress } from "./waveform-progress";

const SPEEDS = [1, 1.5, 2];
const PRIMARY_ACTION = "flex size-7 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground transition-[background-color,transform] duration-(--duration-quick) hover:bg-primary/90 active:scale-[0.96] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:opacity-60";

function formatTime(seconds: number): string {
  if (!isFinite(seconds) || isNaN(seconds)) return "0:00";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export interface AudioPlayerHandle {
  seekTo: (seconds: number) => void;
}

interface AudioPlayerProps {
  src: string | null | undefined;
  recordId?: string | null;
  sourceIntervals?: RecordingAudioSourceInterval[];
  /** Highlight a specific time (ms) when clicked from transcript */
  highlightTimeMs?: number | null;
  /** Open the audio editor for this recording. */
  onEdit?: () => void;
  animateWaveformLoading?: boolean;
  durationHint?: number;
  /** Local download controls for cloud audio. */
  download?: {
    start: () => void;
    disabled?: boolean;
    /** Undefined when idle, null when the transfer size is unknown. */
    progress?: number | null;
    failed?: boolean;
  };
}

export const AudioPlayer = forwardRef<AudioPlayerHandle, AudioPlayerProps>(
  function AudioPlayer({ src, recordId, sourceIntervals, highlightTimeMs, onEdit, animateWaveformLoading, durationHint, download }, ref) {
    const audioRef = useRef<HTMLAudioElement>(null);
    const pendingSeek = useRef<{ src: string; seconds: number } | null>(null);
    const [playing, setPlaying] = useState(false);
    const [currentTime, setCurrentTime] = useState(0);
    const [duration, setDuration] = useState(0);
    const [speed, setSpeed] = useState(1);
    const [muted, setMuted] = useState(false);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(false);
    // Keep the waveform mounted across download completion while resetting playback for a changed source.
    const [activeSrc, setActiveSrc] = useState(src);
    if (activeSrc !== src) {
      setActiveSrc(src);
      if (activeSrc) {
        setPlaying(false);
        setCurrentTime(0);
        setDuration(0);
        setLoading(true);
        setError(false);
      }
    }
    // Real waveform peaks for the scrubber; empty while decoding / on failure.
    const { peaks, loading: waveformLoading, error: waveformError, skipped: waveformSkipped, retry: retryWaveform } = useWaveformPeaks(src, recordId);
    const { t } = useTranslation();

    // Expose seekTo to parent
    useImperativeHandle(ref, () => ({
      seekTo(seconds: number) {
        if (!src || !Number.isFinite(seconds)) return;
        const target = Math.max(0, seconds);
        if (audioRef.current && audioRef.current.readyState >= 1) {
          audioRef.current.currentTime = target;
          pendingSeek.current = null;
          void audioRef.current.play().then(() => setPlaying(true)).catch(() => setPlaying(false));
        } else {
          pendingSeek.current = { src, seconds: target };
        }
      },
    }));

    // Track previous highlightTimeMs to avoid auto-play on mount/remount
    const prevHighlightRef = useRef<number | null | undefined>(undefined);

    // Seek when highlightTimeMs changes (from transcript click) — but NOT on initial mount
    useEffect(() => {
      if (
        highlightTimeMs != null &&
        highlightTimeMs !== prevHighlightRef.current &&
        prevHighlightRef.current !== undefined &&
        audioRef.current
      ) {
        audioRef.current.currentTime = highlightTimeMs / 1000;
        audioRef.current.play().catch(() => {});
        setPlaying(true);
      }
      prevHighlightRef.current = highlightTimeMs;
    }, [highlightTimeMs]);

    // Speed change
    useEffect(() => {
      if (audioRef.current) {
        audioRef.current.playbackRate = speed;
      }
    }, [speed, src]);

    // Mute
    useEffect(() => {
      if (audioRef.current) {
        audioRef.current.muted = muted;
      }
    }, [muted, src]);

    const togglePlay = useCallback(() => {
      const audio = audioRef.current;
      if (!audio) return;
      if (playing) {
        audio.pause();
      } else {
        audio.play().catch(() => {});
      }
      setPlaying(!playing);
    }, [playing]);

    const cycleSpeed = useCallback(() => {
      setSpeed((prev) => {
        const idx = SPEEDS.indexOf(prev);
        return SPEEDS[(idx + 1) % SPEEDS.length] ?? 1;
      });
    }, []);

    const handleTimeUpdate = useCallback(() => {
      if (audioRef.current) {
        setCurrentTime(audioRef.current.currentTime);
      }
    }, []);

    const handleLoadedMetadata = useCallback(() => {
      if (audioRef.current) {
        setDuration(audioRef.current.duration);
        setLoading(false);
        const pending = pendingSeek.current;
        pendingSeek.current = null;
        if (pending && pending.src === src) {
          audioRef.current.currentTime = pending.seconds;
          void audioRef.current.play().then(() => setPlaying(true)).catch(() => setPlaying(false));
        }
      }
    }, [src]);

    const handleError = useCallback(() => {
      setError(true);
      setLoading(false);
    }, []);

    const handleEnded = useCallback(() => {
      setPlaying(false);
    }, []);

    const handleSeek = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
      const audio = audioRef.current;
      if (!audio || !duration) return;
      const rect = e.currentTarget.getBoundingClientRect();
      const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      audio.currentTime = ratio * duration;
      setCurrentTime(ratio * duration);
    }, [duration]);

    // Seek by a 0..1 ratio (from the waveform scrubber).
    const seekToRatio = useCallback((ratio: number) => {
      const audio = audioRef.current;
      if (!audio || !duration) return;
      audio.currentTime = ratio * duration;
      setCurrentTime(ratio * duration);
    }, [duration]);

    const skipForward = useCallback(() => {
      if (audioRef.current) {
        audioRef.current.currentTime = Math.min(
          audioRef.current.currentTime + 15,
          duration,
        );
      }
    }, [duration]);

    if (!src && !download) return null;

    if (error) {
      return (
        <div className="flex items-center gap-2 rounded-lg border border-border/60 bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
          {t("audio.error")}
        </div>
      );
    }

    const progress = duration > 0 ? (currentTime / duration) * 100 : 0;
    const downloading = !src && download?.progress !== undefined;
    const downloadLabel = t(downloading ? "workspace.downloading_audio" : "workspace.download_audio");
    const showDownloadWaveform = !!download && (!src || waveformLoading || (loading && peaks.length === 0));
    const showWaveformLoading = animateWaveformLoading && waveformLoading;

    return (
      <div className="flex w-full flex-col gap-1.5 rounded-lg border border-border/60 bg-muted/20 px-3 py-2">
        {/* Hidden audio element */}
        {src && (
          <audio
            ref={audioRef}
            src={src}
            preload="metadata"
            onTimeUpdate={handleTimeUpdate}
            onLoadedMetadata={handleLoadedMetadata}
            onError={handleError}
            onEnded={handleEnded}
            onPlaying={() => setPlaying(true)}
            onPause={() => setPlaying(false)}
          />
        )}

        {showDownloadWaveform || showWaveformLoading || peaks.length > 0 ? (
          <WaveformProgress
            peaks={peaks}
            progress={progress / 100}
            onSeek={src && !loading ? seekToRatio : undefined}
            generating={showWaveformLoading}
            download={showDownloadWaveform ? {
              percent: src ? 100 : download?.progress,
              label: downloading ? downloadLabel : undefined,
            } : undefined}
            className="py-0.5"
          />
        ) : !loading && (
          <div className="group relative h-1.5 w-full cursor-pointer rounded-full bg-muted/60" onClick={handleSeek}>
            <div
              className="absolute inset-y-0 left-0 rounded-full bg-primary"
              style={{ width: `${progress}%` }}
            />
            {/* Thumb */}
            <div
              className="absolute top-1/2 size-3 -translate-y-1/2 rounded-full border-2 border-primary bg-background opacity-0 shadow-sm transition-opacity group-hover:opacity-100"
              style={{ left: `calc(${progress}% - 6px)` }}
            />
          </div>
        )}

        {!src && download ? (
          <div className="flex items-center gap-2">
            <button type="button" onClick={download.start} disabled={download.disabled} className={PRIMARY_ACTION} aria-label={downloadLabel} title={downloadLabel}>
              {downloading ? <Loader2 aria-hidden="true" className="size-3.5 animate-spin motion-reduce:animate-none" /> : <Download aria-hidden="true" className="size-3.5" />}
            </button>
            {download.failed ? (
              <span role="status" className="text-2xs text-destructive">{t("workspace.download_audio_failed")}</span>
            ) : (
              <span className="text-2xs tabular-nums text-muted-foreground">
                {downloadLabel}{download.progress != null ? ` ${download.progress}%` : ""}
              </span>
            )}
            {!!durationHint && <span className="ms-auto shrink-0 text-2xs tabular-nums text-muted-foreground">{formatTime(durationHint)}</span>}
          </div>
        ) : loading ? (
          <div role={showWaveformLoading ? "status" : undefined} className={cn("flex items-center gap-2 text-xs text-muted-foreground", (showDownloadWaveform || showWaveformLoading) && "min-h-7")}>
            {!showWaveformLoading && <div className="size-3 animate-spin rounded-full border-2 border-muted-foreground/30 border-t-muted-foreground motion-reduce:animate-none" />}
            {t(showWaveformLoading ? "recording_sources.waveform_loading" : "audio.loading")}
          </div>
        ) : (
          <div className="flex flex-col gap-1.5">
            {(waveformLoading || waveformError || waveformSkipped) && (
              <div role="status" className="flex items-center gap-2 text-2xs text-muted-foreground">
                <span>{t(waveformLoading ? "recording_sources.waveform_loading" : waveformSkipped ? "recording_sources.waveform_skipped" : "recording_sources.waveform_failed")}</span>
                {!waveformLoading && !waveformSkipped && <button type="button" onClick={retryWaveform} className="underline underline-offset-2 hover:text-foreground">{t("recording_sources.retry")}</button>}
              </div>
            )}

            {!!sourceIntervals?.length && (
              <div className="flex items-center gap-2 text-muted-foreground" role="img"
                aria-label={sourceIntervals.some((interval) => interval.sources.includes("mic"))
                  ? (sourceIntervals.some((interval) => interval.sources.includes("system")) ? `${t("recording_sources.system")} + ${t("recording_sources.mic")}` : t("recording_sources.mic"))
                  : t("recording_sources.system")}>
                {sourceIntervals.some((interval) => interval.sources.includes("system")) && <span title={t("recording_sources.system")}><Monitor aria-hidden="true" className="size-3.5" /></span>}
                {sourceIntervals.some((interval) => interval.sources.includes("mic")) && <span title={t("recording_sources.mic")}><Mic aria-hidden="true" className="size-3.5" /></span>}
              </div>
            )}

            {/* Controls row */}
            <div className="flex items-center gap-2">
              {/* Play / Pause */}
              <button
                type="button"
                onClick={togglePlay}
                className={PRIMARY_ACTION}
                aria-label={t(playing ? "audio_editor.pause" : "audio_editor.play")}
              >
                <IconSwap stateKey={playing ? "pause" : "play"}>
                  {playing ? (
                    <Pause className="size-3.5" />
                  ) : (
                    <Play className="size-3.5 ml-0.5" />
                  )}
                </IconSwap>
              </button>

              {/* Skip forward 15s */}
              <button
                onClick={skipForward}
                className="flex size-6 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                title="+15s"
              >
                <SkipForward className="size-3.5" />
              </button>

              {/* Time display */}
              <span className="min-w-[80px] text-2xs tabular-nums text-muted-foreground">
                {formatTime(currentTime)} / {formatTime(duration)}
              </span>

              <div className="flex-1" />

              {onEdit && (
                <button
                  type="button"
                  onClick={onEdit}
                  className="flex size-6 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
                  aria-label={t("audio_editor.edit")}
                  title={t("audio_editor.edit")}
                >
                  <Crop aria-hidden="true" className="size-3.5" />
                </button>
              )}

              {/* Speed */}
              <button
                onClick={cycleSpeed}
                className="flex h-5 items-center rounded px-1.5 text-2xs font-medium tabular-nums text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                {speed}x
              </button>

              {/* Mute toggle */}
              <button
                onClick={() => setMuted(!muted)}
                className="flex size-6 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                <IconSwap stateKey={muted ? "muted" : "unmuted"}>
                  {muted ? (
                    <VolumeX className="size-3.5" />
                  ) : (
                    <Volume2 className="size-3.5" />
                  )}
                </IconSwap>
              </button>
            </div>
          </div>
        )}
      </div>
    );
  },
);
