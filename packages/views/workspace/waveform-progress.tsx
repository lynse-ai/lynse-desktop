"use client";

import { cn } from "@lynse/ui/lib/utils";
import { Waveform } from "@lynse/ui/components/ui/waveform";

// ───────────────────────────────────────────────────────────────
// Waveform progress scrubber (ElevenLabs UI "waveform" style).
//
// Presentational: renders the waveform bars with a "played" tint and a
// playhead, and maps clicks / arrow keys to a 0..1 seek ratio. The audio
// element and its state live in the caller so this stays reusable both in
// the workspace player and the recording-complete preview.
// ───────────────────────────────────────────────────────────────

interface WaveformProgressProps {
  /** Peak amplitudes per bar, in [0, 1]. */
  peaks: readonly number[];
  /** Playback position, 0..1. */
  progress: number;
  /** Called with a 0..1 ratio when the user clicks / arrows the waveform. */
  onSeek: (ratio: number) => void;
  disabled?: boolean;
  className?: string;
  height?: number;
}

export function WaveformProgress({
  peaks,
  progress,
  onSeek,
  disabled,
  className,
  height = 40,
}: WaveformProgressProps) {
  const ratio = Math.max(0, Math.min(1, progress));

  function handleClick(event: React.MouseEvent<HTMLDivElement>) {
    if (disabled) return;
    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.width <= 0) return;
    onSeek(Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)));
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (disabled) return;
    if (event.key === "ArrowRight") onSeek(Math.min(1, ratio + 0.05));
    else if (event.key === "ArrowLeft") onSeek(Math.max(0, ratio - 0.05));
  }

  return (
    <div
      role="slider"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(ratio * 100)}
      tabIndex={0}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      className={cn(
        "group relative w-full cursor-pointer select-none outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
        className,
      )}
      style={{ height }}
    >
      <Waveform
        data={peaks as number[]}
        height={height}
        barWidth={3}
        barGap={1.5}
        barRadius={1.5}
        barColor="var(--primary)"
        fadeEdges={false}
        className="absolute inset-0 opacity-35"
      />

      {/* Played portion tint */}
      <div
        className="pointer-events-none absolute inset-y-0 left-0 rounded-[3px]"
        style={{ width: `${ratio * 100}%`, background: "var(--primary)", opacity: 0.16 }}
      />

      {/* Playhead */}
      <div
        className="pointer-events-none absolute inset-y-0 w-[2px] rounded-full bg-foreground/70"
        style={{ left: `calc(${ratio * 100}% - 1px)` }}
      />
    </div>
  );
}
