"use client";

import { useRef, useState, useEffect, useCallback, useImperativeHandle, forwardRef } from "react";
import { Play, Pause, SkipForward, Volume2, VolumeX } from "../icons";
import { useTranslation } from "@lynse/core/i18n/react";

const SPEEDS = [1, 1.5, 2];

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
  /** Highlight a specific time (ms) when clicked from transcript */
  highlightTimeMs?: number | null;
}

export const AudioPlayer = forwardRef<AudioPlayerHandle, AudioPlayerProps>(
  function AudioPlayer({ src, highlightTimeMs }, ref) {
    const audioRef = useRef<HTMLAudioElement>(null);
    const [playing, setPlaying] = useState(false);
    const [currentTime, setCurrentTime] = useState(0);
    const [duration, setDuration] = useState(0);
    const [speed, setSpeed] = useState(1);
    const [muted, setMuted] = useState(false);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(false);
    const { t } = useTranslation();

    // Expose seekTo to parent
    useImperativeHandle(ref, () => ({
      seekTo(seconds: number) {
        if (audioRef.current) {
          audioRef.current.currentTime = seconds;
          if (!playing) {
            audioRef.current.play().catch(() => {});
            setPlaying(true);
          }
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
    }, [speed]);

    // Mute
    useEffect(() => {
      if (audioRef.current) {
        audioRef.current.muted = muted;
      }
    }, [muted]);

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
      }
    }, []);

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

    const skipForward = useCallback(() => {
      if (audioRef.current) {
        audioRef.current.currentTime = Math.min(
          audioRef.current.currentTime + 15,
          duration,
        );
      }
    }, [duration]);

    if (!src) return null;

    if (error) {
      return (
        <div className="flex items-center gap-2 rounded-lg border border-border/60 bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
          {t("audio.error")}
        </div>
      );
    }

    const progress = duration > 0 ? (currentTime / duration) * 100 : 0;

    return (
      <div className="rounded-lg border border-border/60 bg-muted/20 px-3 py-2">
        {/* Hidden audio element */}
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

        {loading ? (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <div className="size-3 animate-spin rounded-full border-2 border-muted-foreground/30 border-t-muted-foreground" />
            {t("audio.loading")}
          </div>
        ) : (
          <div className="flex flex-col gap-1.5">
            {/* Progress bar */}
            <div
              className="group relative h-1.5 w-full cursor-pointer rounded-full bg-muted/60"
              onClick={handleSeek}
            >
              <div
                className="absolute inset-y-0 left-0 rounded-full bg-primary transition-[width] duration-100"
                style={{ width: `${progress}%` }}
              />
              {/* Thumb */}
              <div
                className="absolute top-1/2 size-3 -translate-y-1/2 rounded-full border-2 border-primary bg-background opacity-0 shadow-sm transition-opacity group-hover:opacity-100"
                style={{ left: `calc(${progress}% - 6px)` }}
              />
            </div>

            {/* Controls row */}
            <div className="flex items-center gap-2">
              {/* Play / Pause */}
              <button
                onClick={togglePlay}
                className="flex size-7 items-center justify-center rounded-full bg-primary text-primary-foreground transition-colors hover:bg-primary/90"
              >
                {playing ? (
                  <Pause className="size-3.5" />
                ) : (
                  <Play className="size-3.5 ml-0.5" />
                )}
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
              <span className="min-w-[80px] text-[11px] tabular-nums text-muted-foreground">
                {formatTime(currentTime)} / {formatTime(duration)}
              </span>

              <div className="flex-1" />

              {/* Speed */}
              <button
                onClick={cycleSpeed}
                className="flex h-5 items-center rounded px-1.5 text-[11px] font-medium tabular-nums text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                {speed}x
              </button>

              {/* Mute toggle */}
              <button
                onClick={() => setMuted(!muted)}
                className="flex size-6 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                {muted ? (
                  <VolumeX className="size-3.5" />
                ) : (
                  <Volume2 className="size-3.5" />
                )}
              </button>
            </div>
          </div>
        )}
      </div>
    );
  },
);
