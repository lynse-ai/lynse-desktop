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
 * equaliser. A left-to-right indigo→violet gradient (matching the app's
 * primary) gives it the ElevenLabs glow.
 *
 * When idle the whole row settles into a gentle low-amplitude wave. Animation
 * runs at 60fps via requestAnimationFrame with per-bar eased smoothing.
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

    const BARS = 64;
    // Per-bar phase offset so neighbouring bars never move in lockstep.
    const bars = Array.from({ length: BARS }, (_, i) => ({
      phase: (i / BARS) * Math.PI * 4,
      value: 0,
    }));

    let raf = 0;
    const render = (time: number) => {
      raf = requestAnimationFrame(render);
      const dpr = window.devicePixelRatio || 1;
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      if (w === 0 || h === 0) return;
      if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
        canvas.width = Math.round(w * dpr);
        canvas.height = Math.round(h * dpr);
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);

      const isActive = activeRef.current;
      const target = Math.min(1, Math.max(0, levelRef.current));
      const t = time / 1000;
      const mid = h / 2;

      const gap = Math.max(1.5, w * 0.004);
      const barW = (w - gap * (BARS - 1)) / BARS;
      const radius = Math.max(1, barW / 2); // fully rounded pill

      const gradient = ctx.createLinearGradient(0, 0, w, 0);
      gradient.addColorStop(0, "rgba(99, 102, 241, 0.95)");
      gradient.addColorStop(1, "rgba(168, 85, 247, 0.9)");
      ctx.fillStyle = gradient;

      bars.forEach((bar, i) => {
        const pos = i / (BARS - 1); // 0 … 1 left-to-right
        // Travelling ripple — neighbouring bars are slightly out of phase.
        const wave = 0.5 + 0.5 * Math.sin(pos * Math.PI * 7 - t * 5 + bar.phase);
        // Soft bell envelope: centre bars fuller, edges taper off.
        const bell = 0.6 + 0.4 * (1 - Math.abs(pos - 0.5) * 2);
        const amp = isActive ? 0.14 + target * 0.86 : 0.05 + 0.03 * (0.5 + 0.5 * Math.sin(t * 1.4));
        const targetVal = amp * bell * (0.4 + 0.6 * wave);
        bar.value += (targetVal - bar.value) * 0.25;
        const barH = Math.max(3, bar.value * h);
        const x = i * (barW + gap);
        const y = mid - barH / 2;

        roundRect(ctx, x, y, barW, barH, radius);
        ctx.fill();
      });
    };
    raf = requestAnimationFrame(render);
    return () => cancelAnimationFrame(raf);
  }, []);

  return <canvas ref={canvasRef} className={className} />;
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
) {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}
