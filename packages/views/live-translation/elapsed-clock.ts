/**
 * Smoothing clock for the recording elapsed time.
 *
 * The capture sidecar publishes its `levels` event (and with it `elapsedMs`)
 * only every 200 ms. Feeding that raw value straight into the waveform makes
 * the band jump ~12 px five times per second instead of scrolling at a
 * continuous 62 px/s — the single biggest source of visible stutter while
 * recording.
 *
 * The clock treats the sidecar value as the authority but extrapolates locally
 * between two updates. Extrapolation is clamped, so a delayed or dropped event
 * can never make the waveform run away, and while the session is paused the
 * value simply freezes.
 */

/** Hard cap on local extrapolation — 2× the sidecar's 200 ms cadence. */
const MAX_EXTRAPOLATION_MS = 400;

export interface ElapsedClock {
  /**
   * Feed the authoritative value from the sidecar. Safe to call as often as
   * React re-renders; only a real change re-anchors the clock.
   */
  push(elapsedMs: number, running: boolean): void;
  /** Read the smoothed value for a `performance.now()`-based timestamp. */
  read(now: number): number;
}

export function createElapsedClock(): ElapsedClock {
  let anchorValue = 0;
  let anchorAt = 0;
  let running = false;
  let initialised = false;

  return {
    push(elapsedMs, nextRunning) {
      if (!Number.isFinite(elapsedMs)) return;
      const now = performance.now();
      if (!initialised) {
        initialised = true;
        anchorValue = elapsedMs;
        anchorAt = now;
        running = nextRunning;
        return;
      }
      // A new session (or a backwards jump) resets the clock outright.
      if (elapsedMs < anchorValue) {
        anchorValue = elapsedMs;
        anchorAt = now;
        running = nextRunning;
        return;
      }
      if (elapsedMs > anchorValue) {
        anchorValue = elapsedMs;
        anchorAt = now;
      }
      running = nextRunning;
    },
    read(now) {
      if (!running) return anchorValue;
      const ahead = now - anchorAt;
      if (ahead <= 0) return anchorValue;
      return anchorValue + Math.min(ahead, MAX_EXTRAPOLATION_MS);
    },
  };
}
