// A 1px stroke with a 2px gap. Full-scale bars leave room above and below.
export const EDITOR_BAR_PITCH = 3;
export const EDITOR_BAR_HEIGHT_RATIO = 0.84;

/** Reduce peak windows to screen columns using the RMS of the peaks. */
export function editorWaveformBars(
  peaks: readonly number[],
  durationSec: number,
  viewStartSec: number,
  viewEndSec: number,
  width: number,
): Float32Array {
  if (!peaks.length || durationSec <= 0 || viewEndSec <= viewStartSec || width <= 0) return new Float32Array();

  const bars = new Float32Array(Math.ceil(width / EDITOR_BAR_PITCH));
  const peakRate = peaks.length / durationSec;
  const firstPeak = viewStartSec * peakRate;
  const lastPeak = viewEndSec * peakRate;
  const peaksPerBar = (lastPeak - firstPeak) * EDITOR_BAR_PITCH / width;

  // Peaks are placed at the centers of their time windows.
  let start = Math.min(peaks.length, Math.max(0, Math.ceil(firstPeak - 0.5)));
  for (let bar = 0; bar < bars.length; bar++) {
    const boundary = Math.min(lastPeak, firstPeak + (bar + 1) * peaksPerBar);
    const end = Math.max(start, Math.min(peaks.length, Math.ceil(boundary - 0.5)));
    if (end === start) continue;
    let energy = 0;
    for (let i = start; i < end; i++) {
      const peak = peaks[i]!;
      energy += peak * peak;
    }
    bars[bar] = Math.sqrt(energy / (end - start));
    start = end;
  }
  return bars;
}
