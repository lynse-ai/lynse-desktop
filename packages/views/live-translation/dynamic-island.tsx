"use client";

import { useEffect } from "react";
import { useTranslation } from "@lynse/core/i18n/react";
import { cn } from "@lynse/ui/lib/utils";
import { Maximize2, Pause, Play, Square, X } from "../icons";
import { useLiveTranslation } from "./use-live-translation";

interface DynamicIslandProps {
  /** Called when user taps the close/dismiss button. */
  onDismiss?: () => void;
  /** Called when user taps pause/resume. */
  onPause?: () => void;
  /** Called when user taps stop. */
  onStop?: () => void;
  /** Called when user taps expand (restore the full recording window). */
  onExpand?: () => void;
  className?: string;
}

/**
 * Dynamic Island — compact recording pill that mimics macOS menu-bar /
 * iOS Dynamic Island behavior.
 *
 * When recording is active this renders as an inline "live indicator" showing
 * elapsed time, a miniature mic-level bar, and one-tap pause/stop controls.
 * Rendered both inline (main window) and inside the always-on-top
 * "recording-island" Tauri window, where `onExpand` restores the full page
 * once the main window has been hidden.
 *
 * Auto-syncs the system tray tooltip via `live_translation_update_tray`.
 */
export function DynamicIsland({ onDismiss, onPause, onStop, onExpand, className }: DynamicIslandProps) {
  const { t } = useTranslation();
  const { api, view } = useLiveTranslation();
  const recording = view.state === "recording";
  const paused = view.state === "paused";

  // Format seconds into M:SS for the compact display.
  const fmt = (ms: number) => {
    const total = Math.floor(Math.max(0, ms) / 1000);
    const m = Math.floor(total / 60);
    const s = total % 60;
    return `${m}:${s.toString().padStart(2, "0")}`;
  };

  // Keep tray tooltip in sync with recording state.
  useEffect(() => {
    if (!api) return;
    // Debounce rapid updates — tray I/O is cheap but not free.
    let handle: ReturnType<typeof globalThis.setTimeout>;
    const sync = () => {
      handle = setTimeout(() => {
        void api.updateTray({
          recording: recording || paused,
          paused,
          elapsed_secs: Math.floor(view.elapsedMs / 1000),
        });
      }, 200);
    };
    sync();
    return () => clearTimeout(handle);
  }, [api, recording, paused, view.elapsedMs]);

  if (!recording && !paused) return null;

  return (
    <div
      className={cn(
        "group flex items-center gap-3 rounded-full border border-border/60 bg-background/95 px-3 py-1.5 shadow-lg backdrop-blur-md transition-all",
        className,
      )}
    >
      {/* Red pulse dot */}
      <span className={cn(
        "size-2 rounded-full",
        paused ? "bg-amber-500" : "bg-red-500 animate-pulse",
      )} />

      {/* Timer */}
      <span className="min-w-[3ch] text-center font-mono text-xs font-semibold tabular-nums">
        {fmt(view.elapsedMs)}
      </span>

      {/* Mini level bar */}
      <div className="h-1 w-12 overflow-hidden rounded-full bg-muted">
        <div
          className="h-full rounded-full bg-primary transition-[width] duration-100"
          style={{ width: `${Math.min(100, Math.max(4, view.micLevel * 100))}%` }}
        />
      </div>

      {/* Controls */}
      <div className="flex items-center gap-0.5">
        {onExpand && (
          <button
            type="button"
            onClick={onExpand}
            aria-label={t("recording_mode.expand")}
            title={t("recording_mode.expand")}
            className="flex size-6 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <Maximize2 className="size-3" />
          </button>
        )}
        <button
          type="button"
          onClick={onPause}
          aria-label={paused ? t("recording_mode.resume") : t("recording_mode.pause")}
          className="flex size-6 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          {paused ? <Play className="size-3" /> : <Pause className="size-3" />}
        </button>
        <button
          type="button"
          onClick={onStop}
          aria-label={t("recording_mode.stop_recording")}
          className="flex size-6 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
        >
          <Square className="size-3" />
        </button>
      </div>

      {/* Dismiss (only if handler provided — e.g. mini-player mode) */}
      {onDismiss && (
        <button
          type="button"
          onClick={onDismiss}
          aria-label={t("recording_mode.close")}
          className="ml-0.5 flex size-5 items-center justify-center rounded-full text-muted-foreground/50 opacity-0 transition-opacity group-hover:opacity-100 hover:text-foreground"
        >
          <X className="size-3" />
        </button>
      )}
    </div>
  );
}
