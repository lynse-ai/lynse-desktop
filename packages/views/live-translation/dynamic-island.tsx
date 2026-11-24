"use client";

import { useEffect, type ReactNode } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useTranslation } from "@lynse/core/i18n/react";
import { cn } from "@lynse/ui/lib/utils";
import { Captions, ChevronDown, Maximize2, Pause, Play, Square, X } from "../icons";
import { IconSwap } from "../icon-swap";
import { AudioSourceControls } from "./audio-source-controls";
import { recordingLevel } from "./audio-sources";
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
  /** Called when user taps the subtitles overlay toggle. Absent hides the toggle. */
  onToggleSubtitles?: () => void;
  subtitlesVisible?: boolean;
  /** Docked island (macOS "Dynamic Island"): opaque black stadium capsule
   * hanging below the hardware cutout. Collapsed it shrinks to a mini pill
   * (dot + timer + waveform); hovering reveals the control bar. */
  notchStyle?: boolean;
  /** Whether the control bar (source icons + buttons + dismiss) is visible.
   * Outside notch style this is always true; the parent owns the phase. */
  controlsVisible?: boolean;
  /** Pointer entered/left the island — hover debounce lives in the parent so
   * a drawer closing while hovered keeps the control bar up. */
  onPointerEnter?: () => void;
  onPointerLeave?: () => void;
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
 * In notch style the window hangs just below the display's hardware cutout
 * and paints opaque black — dark tokens are forced for the window, so every
 * control keeps its contrast on the black surface.
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
  onToggleSubtitles,
  subtitlesVisible,
  notchStyle,
  controlsVisible,
  onPointerEnter,
  onPointerLeave,
  children,
  className,
}: DynamicIslandProps) {
  const { t } = useTranslation();
  const reduceMotion = useReducedMotion();
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

  // Floating islands always show every control; the docked island follows
  // the parent-controlled phase. During drawer fold-out (`drawerClosing`)
  // controls stay put so the pill doesn't flicker mid-transition.
  const showControls = !notchStyle || (controlsVisible ?? false);
  // Docked notch island is pinned flush under the hardware cutout; dragging
  // it would conflict with anchor re-centering, so drag region is disabled.
  const dragRegion = notchStyle ? undefined : true;
  // The capsule shape is driven by the window height (Rust sizes it), not by
  // the DOM: the pill row is always the full 44pt and the window crops it to
  // the 32pt mini capsule, so there is no internal height jump.
  const miniCapsule = notchStyle && !showControls;

  if (!recording && !paused) return null;

  return (
    <div
      className={cn(
        "island-surface flex h-full w-full flex-col overflow-hidden",
        notchStyle
          ? // Opaque black stadium capsule hanging below the hardware cutout —
            // rounded-[22px] matches both the 44pt controls bar and 36pt mini capsule.
            "bg-neutral-950 rounded-[22px]"
          : "rounded-[22px] border border-border/50",
        className,
      )}
      onMouseEnter={notchStyle ? onPointerEnter : undefined}
      onMouseLeave={notchStyle ? onPointerLeave : undefined}
    >
      {/* Pill row — fixed 44pt height; the native window crops it to the 32pt
          mini capsule, so growth/drop is one smooth window animation rather
          than a DOM height jump. Shifted up in mini state so the visible
          dot/timer/waveform sit centered in the 32pt window. */}
      <div
        data-tauri-drag-region={dragRegion}
        className={cn(
          "group flex h-11 shrink-0 items-center gap-2 px-3",
          "transition-transform duration-(--duration-quick)",
          miniCapsule && "-translate-y-1",
        )}
      >
        {/* Red pulse dot — turns warning while a stream error is up (e.g.
            the engine connection is down): the pill has no room for the
            message itself, the expanded drawer shows it. */}
        <span
          data-tauri-drag-region={dragRegion}
          className={cn(
            "size-2 shrink-0 rounded-full",
            paused ? "bg-warning" : view.lastError ? "bg-warning animate-pulse" : "bg-destructive animate-pulse",
          )}
        />

        {/* Timer */}
        <span
          data-tauri-drag-region={dragRegion}
          className="min-w-[3ch] text-center font-mono text-xs font-semibold tabular-nums"
        >
          {fmt(view.elapsedMs)}
        </span>

        <AnimatePresence initial={false}>
          {showControls && (
            <motion.div
              key="sources"
              className="flex shrink-0 items-center overflow-hidden"
              initial={reduceMotion ? false : { opacity: 0, width: 0, x: -6 }}
              animate={{ opacity: 1, width: "auto", x: 0 }}
              exit={reduceMotion ? { opacity: 0 } : { opacity: 0, width: 0, x: -6 }}
              transition={{ duration: reduceMotion ? 0 : 0.18, ease: [0.22, 1, 0.36, 1] }}
            >
              <AudioSourceControls compact />
            </motion.div>
          )}
        </AnimatePresence>

        {/* Mini live waveform — the same wave the expanded drawer shows in its
            footer, shrunk to a sliver: just enough to read "recording" at a
            glance. Flexes to absorb leftover pill width, so the row always
            fits the narrow capsule. Gain >1 because raw mic RMS levels sit
            low in normal speech — without it the wave reads as a flat line. */}
        <div data-tauri-drag-region={dragRegion} className="h-4 min-w-8 flex-1">
          <AudioVisualizer
            level={recordingLevel(view)}
            active={recording && !paused}
            gain={2.6}
            className="h-full w-full"
          />
        </div>

        {/* Controls — cross-fade in/out with the drawer-style motion; the
            window grows in sync underneath. */}
        <AnimatePresence initial={false}>
          {showControls && (
            <motion.div
              key="controls"
              className="ml-auto flex items-center gap-0.5 overflow-hidden"
              initial={reduceMotion ? false : { opacity: 0, width: 0, x: 8 }}
              animate={{ opacity: 1, width: "auto", x: 0 }}
              exit={reduceMotion ? { opacity: 0 } : { opacity: 0, width: 0, x: 8 }}
              transition={{ duration: reduceMotion ? 0 : 0.18, ease: [0.22, 1, 0.36, 1] }}
            >
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
            {onToggleSubtitles && (
              <button
                type="button"
                onClick={onToggleSubtitles}
                aria-label={t(subtitlesVisible ? "live_translation.hide_overlay" : "live_translation.show_overlay")}
                title={t(subtitlesVisible ? "live_translation.hide_overlay" : "live_translation.show_overlay")}
                className={cn(
                  "flex size-6 items-center justify-center rounded-full transition-[color,background-color,transform] duration-(--duration-quick) hover:bg-muted hover:text-foreground active:scale-[0.96]",
                  subtitlesVisible ? "text-primary" : "text-muted-foreground",
                )}
              >
                <Captions className="size-3.5" />
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
            </motion.div>
          )}
        </AnimatePresence>

        {/* Dismiss (only if handler provided — e.g. mini-player mode) */}
        <AnimatePresence initial={false}>
          {onDismiss && showControls && (
            <motion.button
              key="dismiss"
              type="button"
              onClick={onDismiss}
              aria-label={t("recording_mode.close")}
              initial={reduceMotion ? false : { opacity: 0, scale: 0.6 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.6 }}
              transition={{ duration: reduceMotion ? 0 : 0.18, ease: [0.22, 1, 0.36, 1] }}
              className="flex size-5 shrink-0 items-center justify-center rounded-full text-muted-foreground/60 transition-colors hover:text-foreground"
            >
              <X className="size-3" />
            </motion.button>
          )}
        </AnimatePresence>
      </div>

      {/* Live-transcript drawer (expanded state) */}
      {drawerOpen && <AudioSourceControls statusOnly />}
      {children}
    </div>
  );
}
