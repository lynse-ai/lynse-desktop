"use client";

import { useEffect, useRef } from "react";

interface AudioVisualizerProps {
  /** Real-time microphone level in [0, 1], sourced from the capture sidecar. */
  level: number;
  /** Whether a recording session is currently active. */
  active: boolean;
  className?: string;
}

/**
 * Canvas-based sound-wave visualizer in the style of the ElevenLabs UI
 * Waveform.
 *
 * Renders a dense row of thin, pill-shaped vertical bars mirrored around the
 * horizontal centre line. A travelling sine ripple modulated by the live
 * microphone level makes the bars breathe organically; a soft bell envelope
 * keeps the centre fuller so it reads as a single waveform rather than a flat
 * equaliser. The waveform uses the app's single restrained brand colour.
 *
 * When idle the whole row settles into a static low-amplitude wave. Active
 * animation runs via requestAnimationFrame with per-bar eased smoothing.
 *
 * PERFORMANCE — the sidecar publishes a level only every 200 ms, so the raw
 * value steps five times a second. Per-bar easing (frame-rate independent) and
 * the travelling ripple hide those steps, and the canvas is sized from a
 * ResizeObserver so no frame ever forces a layout read. All 64 bars are built
 * into a single path and filled once.
 */
export function AudioVisualizer({ level, active, className }: AudioVisualizerProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const levelRef = useRef(level);
  const activeRef = useRef(active);
  levelRef.current = level;
  activeRef.current = active;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const waveformColor = getComputedStyle(canvas).color;

    const BARS = 64;
    // Per-bar phase offset so neighbouring bars never move in lockstep.
    const bars = Array.from({ length: BARS }, (_, i) => ({
      phase: (i / BARS) * Math.PI * 4,
      value: 0,
    }));

    let width = 0;
    let height = 0;
    const measure = () => {
      width = canvas.clientWidth;
      height = canvas.clientHeight;
    };
    measure();
    const resizeObserver = new ResizeObserver(measure);
    resizeObserver.observe(canvas);

    let lastFrameAt = 0;
    let raf = 0;
    const render = (time: number) => {
      raf = requestAnimationFrame(render);
      if (width === 0 || height === 0) return;

      const dpr = window.devicePixelRatio || 1;
      const canvasW = Math.round(width * dpr);
      const canvasH = Math.round(height * dpr);
      if (canvas.width !== canvasW || canvas.height !== canvasH) {
        canvas.width = canvasW;
        canvas.height = canvasH;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);

      // Frame-rate independent easing so 60 Hz and 120 Hz look identical.
      const dt = lastFrameAt === 0 ? 1 / 60 : Math.min(0.1, (time - lastFrameAt) / 1000);
      lastFrameAt = time;

      const isActive = activeRef.current;
      const target = Math.min(1, Math.max(0, levelRef.current));
      const t = time / 1000;
      const mid = height / 2;

      const gap = Math.max(1.5, width * 0.004);
      const barW = (width - gap * (BARS - 1)) / BARS;
      const radius = Math.max(1, barW / 2); // fully rounded pill

      ctx.fillStyle = waveformColor;
      ctx.globalAlpha = isActive ? 0.9 : 0.3;
      ctx.beginPath();

      for (let i = 0; i < BARS; i++) {
        const bar = bars[i]!;
        const pos = i / (BARS - 1); // 0 … 1 left-to-right
        // Travelling ripple — neighbouring bars are slightly out of phase.
        const waveTime = isActive ? t : 0;
        const wave = 0.5 + 0.5 * Math.sin(pos * Math.PI * 7 - waveTime * 5 + bar.phase);
        // Soft bell envelope: centre bars fuller, edges taper off.
        const bell = 0.6 + 0.4 * (1 - Math.abs(pos - 0.5) * 2);
        const amp = isActive ? 0.14 + target * 0.86 : 0.06;
        const targetVal = amp * bell * (0.4 + 0.6 * wave);
        bar.value += (targetVal - bar.value) * (1 - Math.exp(-dt / 0.06));
        const barH = Math.max(3, bar.value * height);
        const x = i * (barW + gap);
        const y = mid - barH / 2;

        addPillPath(ctx, x, y, barW, barH, radius);
      }
      ctx.fill();
      ctx.globalAlpha = 1;
    };
    raf = requestAnimationFrame(render);

    return () => {
      cancelAnimationFrame(raf);
      resizeObserver.disconnect();
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      className={className}
      style={{ color: "var(--waveform-active)" }}
    />
  );
}

/** Append one rounded (pill) sub-path to the current path — no fill call. */
function addPillPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
) {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}
