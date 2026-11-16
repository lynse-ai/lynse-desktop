"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { useTranslation } from "@lynse/core/i18n/react";
import { cn } from "@lynse/ui/lib/utils";
import { ChevronDown, Maximize2, Pause, Play, Square, X } from "../icons";
import { IconSwap } from "../icon-swap";
import { AudioSourceControls } from "./audio-source-controls";
import { recordingLevel } from "./audio-sources";
import { AudioVisualizer } from "./audio-visualizer";
import { useLiveTranslation } from "./use-live-translation";

/** Hover debounce in notch mode: how long the pointer must rest on the
 * island before it grows to the control bar — and how long it must stay off
 * before shrinking back to the mini pill. Mirrors the MacIsland timing. */
const HOVER_DELAY_MS = 150;

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
  /** Notch-attached island (macOS "Dynamic Island"): opaque black surface
   * merging with the hardware cutout — square top corners, rounded bottom.
   * Collapsed it shrinks to a mini pill (dot + timer + waveform); hovering
   * reveals the control bar via `hoverControls`. */
  notchStyle?: boolean;
  /** Notch mode: the pointer is on the island, so the full control bar
   * shows. Ignored outside notch style (floating islands always show it). */
  hoverControls?: boolean;
  /** Notch mode: hover settled on the island — grow to the control bar. */
  onHoverExpand?: () => void;
  /** Notch mode: hover left the island — shrink back to the mini pill. */
  onHoverCollapse?: () => void;
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
 * In notch style the window is pinned to the display's hardware cutout and
 * paints opaque black instead — dark tokens are forced for the window, so
 * every control keeps its contrast on the black surface.
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
  notchStyle,
  hoverControls,
  onHoverExpand,
  onHoverCollapse,
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

  // Notch hover state machine: enter arms the grow timer, leaving arms the
  // shrink timer; the shared handle means re-entering cancels a pending
  // collapse (and vice versa), so quick pointer crossings never flicker.
  const hoverTimer = useRef<ReturnType<typeof globalThis.setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(hoverTimer.current), []);
  const clearHoverTimer = () => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
    hoverTimer.current = undefined;
  };
  const handleHoverStart = () => {
    if (!notchStyle || drawerOpen || hoverControls) return;
    clearHoverTimer();
    hoverTimer.current = setTimeout(() => onHoverExpand?.(), HOVER_DELAY_MS);
  };
  const handleHoverEnd = () => {
    if (!notchStyle || !hoverControls || drawerOpen) return;
    clearHoverTimer();
    hoverTimer.current = setTimeout(() => onHoverCollapse?.(), HOVER_DELAY_MS);
  };

  // Floating islands always show every control; the notch island collapses
  // to the mini pill until the pointer (or an open drawer) summons them.
  const showAllControls = !notchStyle || hoverControls || drawerOpen;

  if (!recording && !paused) return null;

  return (
    <div
      className={cn(
        "island-surface flex h-full w-full flex-col overflow-hidden",
        notchStyle
          ? // Opaque black merging with the hardware cutout: square top corners
            // (the notch itself is square), full-round bottom capsule.
            "rounded-b-[22px] rounded-t-none bg-neutral-950"
          : "rounded-[22px] border border-border/50",
        className,
      )}
      onMouseEnter={notchStyle ? handleHoverStart : undefined}
      onMouseLeave={notchStyle ? handleHoverEnd : undefined}
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

        {showAllControls && <AudioSourceControls compact />}

        {/* Mini live waveform — the same wave the expanded drawer shows in its
            footer, shrunk to a sliver: just enough to read "recording" at a
            glance. Flexes to absorb leftover pill width, so the row always
            fits the narrow capsule. */}
        <div data-tauri-drag-region className="h-3 min-w-8 flex-1">
          <AudioVisualizer
            level={recordingLevel(view)}
            active={recording && !paused}
            className="h-full w-full"
          />
        </div>

        {/* Controls (hidden on the notch mini pill until hover) */}
        {showAllControls && (
          <div className="ml-auto flex items-center gap-0.5">
            {onToggleDrawer && (
              <button
                type="button"
                onClick={onToggleDrawer}
                aria-label={drawerLabel}
                title={drawerLabel}
                className={cn(
                  "flex size-6 items-center justify-center rounded-full transition-[color,background-color,transform] duration-(--duration-quick) hover:bg-muted hover:text-foreground active:scale-[0.96]",
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
                className="flex size-6 items-center justify-center rounded-full text-muted-foreground transition-[color,background-color,transform] duration-(--duration-quick) hover:bg-muted hover:text-foreground active:scale-[0.96]"
              >
                <Maximize2 className="size-3" />
              </button>
            )}
            <button
              type="button"
              onClick={onPause}
              aria-label={paused ? t("recording_mode.resume") : t("recording_mode.pause")}
              className="flex size-6 items-center justify-center rounded-full text-muted-foreground transition-[color,background-color,transform] duration-(--duration-quick) hover:bg-muted hover:text-foreground active:scale-[0.96]"
            >
              <IconSwap stateKey={paused ? "play" : "pause"}>
                {paused ? <Play className="size-3" /> : <Pause className="size-3" />}
              </IconSwap>
            </button>
            <button
              type="button"
              onClick={onStop}
              aria-label={t("recording_mode.stop_recording")}
              className="flex size-6 items-center justify-center rounded-full text-muted-foreground transition-[color,background-color,transform] duration-(--duration-quick) hover:bg-destructive/10 hover:text-destructive active:scale-[0.96]"
            >
              <Square className="size-3" />
            </button>
          </div>
        )}

        {/* Dismiss (only if handler provided — e.g. mini-player mode) */}
        {onDismiss && showAllControls && (
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
      {drawerOpen && <AudioSourceControls statusOnly />}
      {children}
    </div>
  );
}
