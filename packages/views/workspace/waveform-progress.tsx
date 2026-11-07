"use client";

import { cn } from "@lynse/ui/lib/utils";
import { Waveform } from "@lynse/ui/components/ui/waveform";
import "./waveform-loading.css";

const BAR_STYLE = { barWidth: 2, barGap: 2, barHeight: 3, barRadius: 1, fadeEdges: false };

// Fixed peaks keep the placeholder still during download and analysis.
const PLACEHOLDER_PEAKS = [
  0.13, 0.2, 0.42, 0.68, 0.4, 0.58, 0.35, 0.22, 0.34, 0.18, 0.11, 0.08,
  0.14, 0.31, 0.5, 0.71, 0.55, 0.32, 0.49, 0.28, 0.12, 0.16, 0.26, 0.11,
  0.09, 0.13, 0.35, 0.28, 0.62, 0.84, 0.48, 0.59, 0.39, 0.21, 0.15, 0.09,
  0.1, 0.19, 0.28, 0.49, 0.7, 0.58, 0.38, 0.44, 0.61, 0.27, 0.16, 0.11,
  0.1, 0.25, 0.15, 0.41, 0.56, 0.3, 0.74, 0.57, 0.42, 0.27, 0.36, 0.18,
  0.12, 0.09, 0.23, 0.33, 0.19, 0.54, 0.63, 0.47, 0.36, 0.2, 0.13, 0.1,
  0.08, 0.18, 0.37, 0.62, 0.41, 0.79, 0.56, 0.35, 0.24, 0.43, 0.22, 0.11,
  0.1, 0.16, 0.28, 0.45, 0.57, 0.31, 0.4, 0.25, 0.34, 0.19, 0.14, 0.1,
];

const REVEAL_SCALE = 1.08;
const REVEAL_TRACK_WIDTH = `${100 / REVEAL_SCALE}%`;
const REVEAL_MASK = `linear-gradient(to right, black ${REVEAL_TRACK_WIDTH}, transparent)`;

function DownloadWaveform({ percent, height, generating }: { percent: number; height: number; generating?: boolean }) {
  const remaining = 100 - percent;
  const transition = percent > 0 && "transition-[transform,opacity] duration-(--duration-quick) ease-linear motion-reduce:transition-none";
  return (
    <div data-slot="audio-download-waveform" aria-hidden="true" className="pointer-events-none absolute inset-0 overflow-hidden rounded-md bg-muted">
      <Waveform {...BAR_STYLE} data={PLACEHOLDER_PEAKS} height={height} barColor="var(--muted-foreground)" className="absolute inset-0 opacity-35" />
      {/* The mask travels past the right edge at 100%. The inverse translation keeps the bars in place. */}
      <div
        data-slot="audio-download-fill"
        className={cn("absolute inset-y-0 left-0", transition, generating && "opacity-0")}
        style={{
          width: `${REVEAL_SCALE * 100}%`,
          maskImage: REVEAL_MASK,
          WebkitMaskImage: REVEAL_MASK,
          transform: `translateX(${-remaining}%)`,
        }}
      >
        <div className={cn("absolute inset-0", transition)} style={{ transform: `translateX(${remaining}%)` }}>
          <div className="h-full bg-background/80 dark:bg-foreground/5" style={{ width: REVEAL_TRACK_WIDTH }}>
            <Waveform {...BAR_STYLE} data={PLACEHOLDER_PEAKS} height={height} barColor="var(--waveform-active)" className="opacity-80" />
          </div>
        </div>
      </div>
    </div>
  );
}

interface WaveformProgressProps {
  /** Peak amplitudes per bar, in [0, 1]. */
  peaks: readonly number[];
  /** Playback position, 0..1. */
  progress: number;
  /** Called with a 0..1 ratio when the user clicks / arrows the waveform. */
  onSeek?: (ratio: number) => void;
  /** Show the static download silhouette. Only a pending download has a label. */
  download?: { percent: number | null | undefined; label?: string };
  generating?: boolean;
  disabled?: boolean;
  className?: string;
  height?: number;
}

export function WaveformProgress({
  peaks,
  progress,
  onSeek,
  download,
  generating,
  disabled,
  className,
  height = 40,
}: WaveformProgressProps) {
  const ratio = Math.max(0, Math.min(1, progress));
  const role = onSeek ? "slider" : download?.label ? "progressbar" : undefined;
  const value = onSeek ? Math.round(ratio * 100) : download?.percent;

  function handleClick(event: React.MouseEvent<HTMLDivElement>) {
    if (disabled || !onSeek) return;
    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.width <= 0) return;
    onSeek(Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)));
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (disabled || !onSeek) return;
    if (event.key === "ArrowRight") onSeek(Math.min(1, ratio + 0.05));
    else if (event.key === "ArrowLeft") onSeek(Math.max(0, ratio - 0.05));
  }

  return (
    <div
      role={role}
      aria-label={download?.label}
      aria-valuemin={role ? 0 : undefined}
      aria-valuemax={role ? 100 : undefined}
      aria-valuenow={role ? value ?? undefined : undefined}
      aria-disabled={onSeek && disabled}
      tabIndex={onSeek ? 0 : undefined}
      onClick={onSeek ? handleClick : undefined}
      onKeyDown={onSeek ? handleKeyDown : undefined}
      className={cn(
        "relative w-full select-none",
        onSeek && "cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
        className,
      )}
      style={{ height }}
    >
      {download ? (
        <DownloadWaveform percent={download.percent ?? 0} height={height} generating={generating} />
      ) : (
        <Waveform
          {...BAR_STYLE}
          data={generating ? PLACEHOLDER_PEAKS : peaks as number[]}
          height={height}
          barColor="var(--muted-foreground)"
          className={cn("absolute inset-0", generating ? "opacity-25" : "opacity-45")}
        />
      )}
      {generating && (
        <div
          data-slot="waveform-loading"
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 overflow-hidden rounded-md motion-reduce:hidden"
        >
          {/* Counter-translate the waveform so only the highlight moves. */}
          <div className="waveform-loading-highlight absolute inset-0">
            <div className="waveform-loading-highlight-track absolute inset-0">
              <Waveform
                {...BAR_STYLE}
                data={PLACEHOLDER_PEAKS}
                height={height}
                barColor="var(--waveform-active)"
                className="absolute inset-0 scale-y-[1.16]"
              />
            </div>
          </div>
        </div>
      )}
      {onSeek && (
        <>
          {/* Played portion */}
          <div
            className="pointer-events-none absolute inset-y-0 left-0 rounded-[3px] bg-muted-foreground/50"
            style={{ width: `${ratio * 100}%` }}
          />
          {/* Playhead */}
          <div
            className="pointer-events-none absolute inset-y-0 w-[2px] rounded-full bg-destructive"
            style={{ left: `calc(${ratio * 100}% - 1px)` }}
          />
        </>
      )}
    </div>
  );
}
