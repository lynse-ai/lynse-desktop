"use client";

import { useEffect } from "react";
import { create } from "zustand";
import { useTranslation } from "@lynse/core/i18n/react";
import { cn } from "@lynse/ui/lib/utils";
import { Pause, Play, Square } from "../icons";
import { IconSwap } from "../icon-swap";
import { SmoothTimer } from "../live-translation/smooth-timer";
import { useQuickRecording } from "../live-translation/quick-recording";
import { useNavigation } from "../navigation";

/* ── Pill lane store ───────────────────────────────────────────────────────
 * The pill floats absolutely at the right end of the title zone, so it never
 * displaces the bar's flex layout. Pages with a start-aligned title
 * (breadcrumbs) still need to keep their text clear of it: they read this
 * boolean and pad the title zone while the pill is on screen. The pill —
 * which already tracks the live session — is the single writer.
 * ------------------------------------------------------------------------- */

const useRecordingPillStore = create<{
  visible: boolean;
  setVisible: (visible: boolean) => void;
}>((set) => ({
  visible: false,
  setVisible: (visible) => set({ visible }),
}));

/** True while the recording pill occupies the title bar's right lane. */
export function useRecordingPillVisible(): boolean {
  return useRecordingPillStore((s) => s.visible);
}

/** `MM:SS`, zero-padded like the reference design; minutes keep growing
 *  past an hour (`125:30`) so the capsule never changes format mid-session.
 *  Module-level: SmoothTimer requires a stable format reference. */
function formatPillTimer(ms: number): string {
  const total = Math.floor(Math.max(0, ms) / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

/**
 * Recording status pill for the unified title bar — the in-window answer to
 * the floating recording island (which Rust only shows while the main window
 * is hidden). Shows a pulsing dot, the smooth elapsed timer and one-tap
 * pause/resume + stop for the live session, on every page, without touching
 * any existing title-bar element (absolutely positioned; breadcrumb pages
 * make room via {@link useRecordingPillVisible}).
 *
 * Hidden on the recording page itself, whose dock already owns the controls,
 * and on non-desktop shells (no bridge → `available` is false).
 */
export function RecordingTitleBarPill() {
  const { t } = useTranslation();
  const { pathname } = useNavigation();
  const {
    available,
    recording,
    paused,
    stopping,
    elapsedMs,
    lastError,
    togglePause,
    stop,
  } = useQuickRecording();
  const setVisible = useRecordingPillStore((s) => s.setVisible);

  // The recording page's dock owns the controls — no duplicate pill there.
  const visible =
    available && (recording || paused || stopping) && pathname !== "/recording";

  useEffect(() => {
    setVisible(visible);
  }, [visible, setVisible]);
  useEffect(() => () => setVisible(false), [setVisible]);

  if (!visible) return null;

  return (
    <div
      data-tauri-drag-region
      className="absolute right-2 top-1/2 flex h-[26px] -translate-y-1/2 items-center gap-2 rounded-full bg-foreground pl-2.5 pr-1.5 text-background shadow-sm"
    >
      {/* Session indicator — red pulsing while recording, warning amber when
          paused or while a stream error is up (island parity); a tiny spinner
          stands in while the stop finalizes in the background. */}
      {stopping ? (
        <span
          className="size-3 shrink-0 animate-spin rounded-full border-2 border-background/25 border-t-background"
          aria-hidden="true"
        />
      ) : (
        <span
          className={cn(
            "size-2 shrink-0 rounded-full",
            paused || lastError
              ? "bg-warning animate-pulse"
              : "bg-destructive animate-pulse",
          )}
          aria-hidden="true"
        />
      )}

      {/* Elapsed time — freezes while paused / saving. */}
      <SmoothTimer
        elapsedMs={elapsedMs}
        running={!paused && !stopping}
        format={formatPillTimer}
        className="min-w-[3ch] text-center font-mono text-xs font-semibold tabular-nums"
      />

      <button
        type="button"
        onClick={togglePause}
        aria-label={paused ? t("recording_mode.resume") : t("recording_mode.pause")}
        title={paused ? t("recording_mode.resume") : t("recording_mode.pause")}
        className="flex size-5 items-center justify-center rounded-full text-background/70 transition-[color,background-color,transform] duration-150 hover:bg-background/15 hover:text-background active:scale-[0.96]"
      >
        <IconSwap stateKey={paused ? "play" : "pause"}>
          {paused ? <Play className="size-3" /> : <Pause className="size-3" />}
        </IconSwap>
      </button>
      <button
        type="button"
        onClick={stop}
        aria-label={t("recording_mode.stop_recording")}
        title={t("recording_mode.stop_recording")}
        className="flex size-5 items-center justify-center rounded-full text-background/70 transition-[color,background-color,transform] duration-150 hover:bg-destructive/25 hover:text-destructive active:scale-[0.96]"
      >
        <Square className="size-3" />
      </button>
    </div>
  );
}
