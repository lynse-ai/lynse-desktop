"use client";

import { useEffect, useRef } from "react";
import { createElapsedClock } from "./elapsed-clock";
import type { ElapsedClock } from "./elapsed-clock";

interface SmoothTimerProps {
  /** Authoritative elapsed time from the capture sidecar, in ms. */
  readonly elapsedMs: number;
  /** False while paused — the displayed value freezes. */
  readonly running: boolean;
  /** Formats the interpolated value. Must be a stable (module-level) function. */
  readonly format: (ms: number) => string;
  className?: string;
}

/**
 * Elapsed-time readout that ticks at display refresh rate.
 *
 * The sidecar only reports elapsed time every 200 ms, which makes a
 * centisecond clock stutter badly. This component interpolates between updates
 * and writes straight to the DOM node, so the numbers advance smoothly without
 * re-rendering the page 60 times a second.
 */
export function SmoothTimer({ elapsedMs, running, format, className }: SmoothTimerProps) {
  const ref = useRef<HTMLSpanElement>(null);
  const clockRef = useRef<ElapsedClock | null>(null);
  clockRef.current ??= createElapsedClock();
  const clock = clockRef.current;
  clock.push(elapsedMs, running);

  const formatRef = useRef(format);
  formatRef.current = format;

  // A snapshot captured on the first render: React keeps rendering the very
  // same string, so it never touches the node again and the rAF loop below
  // owns the text from mount onwards (no fight over textContent).
  const initialText = useRef(format(elapsedMs));

  useEffect(() => {
    let raf = 0;
    const tick = (now: number) => {
      raf = requestAnimationFrame(tick);
      const el = ref.current;
      if (!el) return;
      const text = formatRef.current(clock.read(now));
      if (el.textContent !== text) el.textContent = text;
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [clock]);

  return (
    <span ref={ref} className={className}>
      {initialText.current}
    </span>
  );
}
