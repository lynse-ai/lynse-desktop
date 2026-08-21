"use client";

import { useTranslation } from "@lynse/core/i18n/react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  TooltipProvider,
} from "@lynse/ui/components/ui/tooltip";
import { cn } from "@lynse/ui/lib/utils";
import { AudioVisualizer } from "./audio-visualizer";
import { Bookmark, EyeOff, Loader2, Mic, Pause, Play, Square } from "../icons";

interface RecordingDockProps {
  /** Whether a recording session is active. */
  recording: boolean;
  /** Whether the active session is paused (controls show resume). */
  paused: boolean;
  /** A transient action is in flight (disables the start button). */
  busy: boolean;
  /** Elapsed time formatted as HH:MM:SS. */
  formattedTime: string;
  /** Live microphone level in [0, 1] for the in-dock animation. */
  micLevel: number;
  /** Whether the current position is bookmarked. */
  bookmarked: boolean;
  onStart: () => void;
  onTogglePause: () => void;
  onStop: () => void;
  onToggleBookmark: () => void;
  /** Hide the main window — recording keeps running via the floating island. */
  onHide: () => void;
}

/**
 * Floating glassmorphism recording dock.
 *
 * Lives at the bottom-center of the recording page and owns the primary
 * transport controls. It animates through three states:
 *
 *  1. idle        — the big red record circle floats standalone, no glass shell.
 *  2. start click — the glass dock *stretches* out to a wide rounded bar (width
 *                  transition) as the session begins.
 *  3. recording   — a live waveform animation fills the middle of the dock,
 *                  flanked by the timer (left) and transport controls (right).
 */
export function RecordingDock({
  recording,
  paused,
  busy,
  formattedTime,
  micLevel,
  bookmarked,
  onStart,
  onTogglePause,
  onStop,
  onToggleBookmark,
  onHide,
}: RecordingDockProps) {
  const { t } = useTranslation();
  const idle = !recording;

  return (
    <TooltipProvider delay={200}>
      <div
        className={cn(
          "pointer-events-auto flex items-center rounded-full transition-[width] duration-500 ease-[cubic-bezier(0.22,1,0.36,1)]",
          idle
            ? "h-16 w-16 justify-center"
            : "w-[min(92vw,580px)] justify-between border border-border/50 bg-background/55 px-3 py-2.5 shadow-[0_10px_34px_rgba(0,0,0,0.14)] backdrop-blur-2xl",
        )}
      >
        {idle ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  onClick={onStart}
                  disabled={busy}
                  aria-label={t("recording_mode.start_recording")}
                  className="flex size-16 items-center justify-center rounded-full bg-red-500 text-white shadow-lg shadow-red-500/25 transition-all duration-200 hover:scale-105 hover:bg-red-400 active:scale-95 disabled:opacity-60 disabled:hover:scale-100"
                >
                  {busy ? (
                    <Loader2 className="size-6 animate-spin" />
                  ) : (
                    <Mic className="size-6" />
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
                  paused ? "bg-amber-500" : "animate-pulse bg-red-500",
                )}
              />
              <span className="font-mono text-sm font-semibold tabular-nums text-foreground">
                {formattedTime || "00:00:00"}
              </span>
            </div>

            {/* Middle: live recording animation */}
            <div className="mx-1 h-9 min-w-0 flex-1">
              <AudioVisualizer
                level={micLevel}
                active={recording && !paused}
                className="h-full w-full"
              />
            </div>

            {/* Right: transport controls */}
            <div className="flex shrink-0 items-center gap-0.5">
              <DockButton
                label={paused ? t("recording_mode.resume") : t("recording_mode.pause")}
                onClick={onTogglePause}
              >
                {paused ? <Play className="size-4" /> : <Pause className="size-4" />}
              </DockButton>
              <DockButton
                label={t("recording_mode.stop_recording")}
                onClick={onStop}
                destructive
              >
                <Square className="size-4" />
              </DockButton>
              <DockButton
                label={t("recording_mode.bookmark")}
                onClick={onToggleBookmark}
              >
                <Bookmark className={cn("size-4", bookmarked && "fill-current text-primary")} />
              </DockButton>
              <DockButton label={t("recording_mode.hide_to_island")} onClick={onHide}>
                <EyeOff className="size-4" />
              </DockButton>
            </div>
          </>
        )}
      </div>
    </TooltipProvider>
  );
}

function DockButton({
  label,
  onClick,
  destructive,
  children,
}: {
  label: string;
  onClick: () => void;
  destructive?: boolean;
  children: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            onClick={onClick}
            aria-label={label}
            className={cn(
              "flex size-9 items-center justify-center rounded-full transition-colors",
              destructive
                ? "text-destructive hover:bg-destructive/10"
                : "text-foreground/70 hover:bg-foreground/10 hover:text-foreground",
            )}
          >
            {children}
          </button>
        }
      />
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}
