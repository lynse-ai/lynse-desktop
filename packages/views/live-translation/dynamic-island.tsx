"use client";

import { useEffect, type ReactNode } from "react";
import { useTranslation } from "@lynse/core/i18n/react";
import { cn } from "@lynse/ui/lib/utils";
import { ChevronDown, Maximize2, Pause, Play, Square, X } from "../icons";
import { IconSwap } from "../icon-swap";
import { AudioVisualizer } from "./audio-visualizer";
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
  /** Whether the live-transcript drawer beneath the pill is expanded. */
  drawerOpen?: boolean;
  /** Called when user taps the transcript toggle. Absent hides the toggle. */
  onToggleDrawer?: () => void;
  /** Live-transcript drawer content rendered beneath the pill row. */
  children?: ReactNode;
  className?: string;
}

/**
 * Dynamic Island — the always-on-top recording capsule, in the spirit of the
 * iOS Dynamic Island.
 *
 * The pill row shows elapsed time, a miniature live waveform and one-tap
 * pause/stop controls. When `onToggleDrawer` is provided a live-transcript
 * toggle appears; `RecordingIslandWindow` uses it to unfold a
 * live-transcript drawer beneath the pill. The frosted look comes from native vibrancy behind the
 * Tauri window (see `.island-surface` in the app's globals.css), so the pill
 * reads as translucent glass over whatever is on screen.
 *
 * Auto-syncs the system tray tooltip via `live_translation_update_tray`.
 */
export function DynamicIsland({
  onDismiss,
  onPause,
  onStop,
  onExpand,
  drawerOpen,
  onToggleDrawer,
  children,
  className,
}: DynamicIslandProps) {
  const { t } = useTranslation();
  const { api, view } = useLiveTranslation();
  const recording = view.state === "recording";
  const paused = view.state === "paused";
  // Pure-recording session (target == source): the transcript toggle doubles
  // as the "start live transcription" switch, so its label says so.
  const transcribing = view.targetLanguage !== view.sourceLanguage;
  const drawerLabel = drawerOpen
    ? t("recording_mode.hide_transcript")
    : transcribing
      ? t("recording_mode.view_transcribe")
      : t("recording_mode.start_transcribe");

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
        "island-surface flex h-full w-full flex-col overflow-hidden rounded-[22px] border border-border/50",
        className,
      )}
    >
      {/* Pill row — the entire collapsed island */}
      <div
        data-tauri-drag-region
        className="group flex h-11 shrink-0 items-center gap-2 px-3"
      >
        {/* Red pulse dot — turns warning while a stream error is up (e.g.
            the engine connection is down): the pill has no room for the
            message itself, the expanded drawer shows it. */}
        <span
          data-tauri-drag-region
          className={cn(
            "size-2 shrink-0 rounded-full",
            paused ? "bg-warning" : view.lastError ? "bg-warning animate-pulse" : "bg-destructive animate-pulse",
          )}
        />

        {/* Timer */}
        <span
          data-tauri-drag-region
          className="min-w-[3ch] text-center font-mono text-xs font-semibold tabular-nums"
        >
          {fmt(view.elapsedMs)}
        </span>

        {/* Mini live waveform — the same wave the expanded drawer shows in its
            footer, shrunk to a sliver: just enough to read "recording" at a
            glance. Flexes to absorb leftover pill width, so the row always
            fits the narrow capsule. */}
        <div data-tauri-drag-region className="h-3 min-w-8 flex-1">
          <AudioVisualizer
            level={view.micSuppressed ? view.systemLevel : Math.max(view.micLevel, view.systemLevel)}
            active={recording && !paused}
            className="h-full w-full"
          />
        </div>

        {/* Controls */}
        <div className="ml-auto flex items-center gap-0.5">
          {onToggleDrawer && (
            <button
              type="button"
              onClick={onToggleDrawer}
              aria-label={drawerLabel}
              title={drawerLabel}
              className={cn(
                "flex size-6 items-center justify-center rounded-full transition-[color,background-color,transform] duration-150 hover:bg-muted hover:text-foreground active:scale-[0.96]",
                drawerOpen ? "text-primary" : "text-muted-foreground",
              )}
            >
              {/* Disclosure arrow: points down while collapsed ("pull the
                  transcript open"), flips up once the drawer is expanded. */}
              <ChevronDown
                className={cn(
                  "size-4 transition-transform duration-200",
                  drawerOpen && "rotate-180",
                )}
              />
            </button>
          )}
          {onExpand && (
            <button
              type="button"
              onClick={onExpand}
              aria-label={t("recording_mode.expand")}
              title={t("recording_mode.expand")}
              className="flex size-6 items-center justify-center rounded-full text-muted-foreground transition-[color,background-color,transform] duration-150 hover:bg-muted hover:text-foreground active:scale-[0.96]"
            >
              <Maximize2 className="size-3" />
            </button>
          )}
          <button
            type="button"
            onClick={onPause}
            aria-label={paused ? t("recording_mode.resume") : t("recording_mode.pause")}
            className="flex size-6 items-center justify-center rounded-full text-muted-foreground transition-[color,background-color,transform] duration-150 hover:bg-muted hover:text-foreground active:scale-[0.96]"
          >
            <IconSwap stateKey={paused ? "play" : "pause"}>
              {paused ? <Play className="size-3" /> : <Pause className="size-3" />}
            </IconSwap>
          </button>
          <button
            type="button"
            onClick={onStop}
            aria-label={t("recording_mode.stop_recording")}
            className="flex size-6 items-center justify-center rounded-full text-muted-foreground transition-[color,background-color,transform] duration-150 hover:bg-destructive/10 hover:text-destructive active:scale-[0.96]"
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
            className="flex size-5 items-center justify-center rounded-full text-muted-foreground/50 opacity-0 transition-opacity group-hover:opacity-100 hover:text-foreground"
          >
            <X className="size-3" />
          </button>
        )}
      </div>

      {/* Live-transcript drawer (expanded state) */}
      {children}
    </div>
  );
}
