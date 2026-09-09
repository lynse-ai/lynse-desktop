"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "@lynse/core/i18n/react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@lynse/ui/components/ui/tooltip";
import { cn } from "@lynse/ui/lib/utils";
import { useNavigation } from "../navigation";
import { AudioVisualizer } from "./audio-visualizer";
import { Loader2, Maximize2, Mic, Pause, Play, Square } from "../icons";
import { formatTimer } from "./use-recording-session";
import { useLiveTranslation } from "./use-live-translation";
import { useQuickRecording } from "./quick-recording";

/** How long the circle → runway stretch plays before the app navigates to
    the recording page. Matches the width transition on the bar below. */
const STRETCH_NAVIGATE_DELAY_MS = 550;

/**
 * In-app floating recording dock, pinned above content pages.
 *
 * Idle it is a bare red circle in the bottom-right corner. Clicking it starts
 * a session, lets the circle stretch into a frosted-glass "runway" pill
 * (same width-transition choreography as the recording page's dock), then
 * lands on the recording page. The pill stays over any other page the user
 * browses to, offering pause/resume, stop (which hands the finished session
 * to the recording page's completion dialog) and an expand button back to
 * the full recording UI. Hidden over /recording itself — the page owns its
 * own transport controls — and on web (no desktop bridge).
 */
export function RecordingFloatDock() {
  const { t } = useTranslation();
  const { pathname, push } = useNavigation();
  const quick = useQuickRecording();
  const { view } = useLiveTranslation();

  // True from a successful start click until the page swap, so the runway
  // bar (not the bare circle) plays the stretch animation in place.
  const [stretching, setStretching] = useState(false);
  const [starting, setStarting] = useState(false);
  const navigateTimer = useRef<ReturnType<typeof globalThis.setTimeout> | undefined>(
    undefined,
  );
  useEffect(() => () => clearTimeout(navigateTimer.current), []);

  const start = useCallback(async () => {
    if (starting) return;
    setStarting(true);
    try {
      const ok = await quick.start();
      if (!ok) return;
      // Linger on the current page for a beat so the stretch reads, then
      // hand over to the recording page.
      setStretching(true);
      navigateTimer.current = setTimeout(() => {
        setStretching(false);
        push("/recording");
      }, STRETCH_NAVIGATE_DELAY_MS);
    } finally {
      setStarting(false);
    }
  }, [starting, quick, push]);

  const stop = useCallback(async () => {
    if (quick.stopping) return;
    // The command acks immediately; the finished session reaches the
    // completion dialog through the `completed` event (routed into the
    // recording-complete store by the tray agent), so land on the recording
    // page without waiting for the background persistence.
    await quick.stop();
    push("/recording");
  }, [quick, push]);

  const onRecordingPage = pathname.startsWith("/recording");
  // Desktop only, and never on top of the recording page.
  if (!quick.available || onRecordingPage) return null;

  const active = quick.recording || stretching;
  const paused = quick.paused && !stretching;
  const level = view.micSuppressed
    ? view.systemLevel
    : Math.max(view.micLevel, view.systemLevel);

  return (
    <div className="pointer-events-none fixed bottom-5 right-5 z-50 flex justify-end">
      <TooltipProvider delay={200}>
        {/* Right-anchored: the width transition grows the bar leftward from
            the circle, so the morph reads as an in-place stretch. */}
        <div
          className={cn(
            "pointer-events-auto relative flex items-center rounded-full transition-[width] duration-500 ease-[cubic-bezier(0.22,1,0.36,1)]",
            !active
              ? "h-11 w-11 justify-center"
              : "h-11 w-[min(64vw,272px)] justify-between border border-white/40 bg-background/20 px-2.5 shadow-[inset_0_1px_0_rgb(255_255_255/0.4),0_10px_34px_rgba(0,0,0,0.16)] backdrop-blur-3xl backdrop-saturate-150 dark:border-white/10 dark:bg-background/40 dark:shadow-[inset_0_1px_0_rgb(255_255_255/0.1),0_10px_34px_rgba(0,0,0,0.4)]",
          )}
        >
          {!active ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    onClick={() => void start()}
                    disabled={starting || quick.stopping}
                    aria-label={t("recording_mode.start_recording")}
                    className="flex size-11 items-center justify-center rounded-full bg-destructive text-white shadow-lg shadow-destructive/25 transition-all duration-200 hover:scale-105 hover:bg-destructive/90 active:scale-95 disabled:opacity-60 disabled:hover:scale-100"
                  >
                    {starting ? (
                      <Loader2 className="size-5 animate-spin" />
                    ) : (
                      <Mic className="size-5" />
                    )}
                  </button>
                }
              />
              <TooltipContent>{t("recording_mode.start_recording")}</TooltipContent>
            </Tooltip>
          ) : (
            <>
              {/* Left: REC indicator + elapsed timer */}
              <div className="flex shrink-0 items-center gap-2 pl-1">
                <span
                  className={cn(
                    "size-2.5 rounded-full",
                    paused ? "bg-warning" : "animate-pulse bg-destructive",
                  )}
                />
                <span className="font-mono text-sm font-semibold tabular-nums text-foreground">
                  {formatTimer(view.elapsedMs) || "00:00:00"}
                </span>
              </div>

              {/* Middle: live level animation (rAF-driven inside the canvas —
                  the 5 Hz level events never animate React) */}
              <div className="mx-1 h-7 min-w-0 flex-1">
                <AudioVisualizer
                  level={level}
                  active={quick.recording && !paused}
                  className="h-full w-full"
                />
              </div>

              {/* Right: pause/resume + stop + expand back to the full page */}
              <div className="flex shrink-0 items-center gap-0.5">
                <button
                  type="button"
                  onClick={() => void quick.togglePause()}
                  aria-label={paused ? t("recording_mode.resume") : t("recording_mode.pause")}
                  className="flex size-8 items-center justify-center rounded-full text-foreground/70 transition-colors hover:bg-foreground/10 hover:text-foreground"
                >
                  {paused ? <Play className="size-4" /> : <Pause className="size-4" />}
                </button>
                <button
                  type="button"
                  onClick={() => void stop()}
                  disabled={quick.stopping}
                  aria-label={t("recording_mode.stop_recording")}
                  className="flex size-8 items-center justify-center rounded-full text-destructive transition-colors hover:bg-destructive/10 disabled:opacity-60"
                >
                  {quick.stopping ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <Square className="size-4 fill-current" />
                  )}
                </button>
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <button
                        type="button"
                        onClick={() => push("/recording")}
                        aria-label={t("recording_mode.expand")}
                        className="flex size-8 items-center justify-center rounded-full text-foreground/70 transition-colors hover:bg-foreground/10 hover:text-foreground"
                      >
                        <Maximize2 className="size-4" />
                      </button>
                    }
                  />
                  <TooltipContent>{t("recording_mode.expand")}</TooltipContent>
                </Tooltip>
              </div>
            </>
          )}
        </div>
      </TooltipProvider>
    </div>
  );
}
