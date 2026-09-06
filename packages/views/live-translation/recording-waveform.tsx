"use client";

import { useEffect, useRef } from "react";

// ───────────────────────────────────────────────────────────────
// Voice-Memos-style recording waveform.
//
// A time ruler sits on top (labels every 2 s, ticks at 0.5 s / 1 s / 2 s —
// the 2 s ticks reach down to just above the band), a full-width waveform
// band sits beneath it, and a destructive-coloured playhead runs from the
// ruler baseline down through the band, its dot detached and hanging below
// the band's bottom edge. Bookmark markers render as small red ticks on the
// band floor.
//
// Bars are appended from the capture sidecar's `levels` events: the buffer
// is keyed to `elapsedMs` (~7 bars / second), so pausing freezes the
// waveform, a restart truncates it, and the recorded history scrolls
// leftwards through the centre playhead at 62 px / second. All colours are
// read from the theme's CSS variables, so light / dark adapt automatically.
// ───────────────────────────────────────────────────────────────

const PX_PER_SEC = 62;
const BAR_PITCH = 9;
const BAR_WIDTH = 3.5;
const BARS_PER_SEC = PX_PER_SEC / BAR_PITCH; // ≈ 6.9
const RULER_HEIGHT = 46;
const MIN_BAR_HEIGHT = 3;
// Playhead geometry: the line starts just above the ruler baseline and the
// dot hangs attached to its lower end, flush with the band's bottom edge.
const PLAYHEAD_TOP = 26;
const DOT_RADIUS = 6;
const DOT_OVERHANG = 14;

interface RecordingWaveformProps {
  /** Authoritative elapsed time from the capture sidecar, in ms. */
  readonly elapsedMs: number;
  /** Latest microphone level in [0, 1]. */
  readonly micLevel: number;
  /** True while the session appends audio (recording and not paused). */
  readonly active: boolean;
  /** Bookmark marker positions in seconds, drawn on the band floor. */
  readonly markers?: readonly number[];
  className?: string;
}

export function RecordingWaveform({
  elapsedMs,
  micLevel,
  active,
  markers,
  className,
}: RecordingWaveformProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const elapsedRef = useRef(elapsedMs);
  const levelRef = useRef(micLevel);
  const activeRef = useRef(active);
  const markersRef = useRef(markers);
  elapsedRef.current = elapsedMs;
  levelRef.current = micLevel;
  activeRef.current = active;
  markersRef.current = markers;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // One level sample per BARS_PER_SEC slice of recorded audio.
    const history: number[] = [];

    let raf = 0;
    const render = () => {
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

      // Sync the bar buffer with the sidecar's clock: pausing freezes
      // elapsedMs so no bars grow, restarting truncates the buffer.
      const elapsedSec = Math.max(0, elapsedRef.current) / 1000;
      const targetBars = Math.floor(elapsedSec * BARS_PER_SEC);
      const level = activeRef.current ? Math.min(1, Math.max(0, levelRef.current)) : 0;
      while (history.length < targetBars) history.push(level);
      if (history.length > targetBars) history.length = targetBars;

      const style = getComputedStyle(canvas);
      const bgColor = style.getPropertyValue("--background").trim() || "#ffffff";
      const barColor = style.getPropertyValue("--muted-foreground").trim() || "#7b7b7e";
      const accentColor = style.getPropertyValue("--destructive").trim() || "#e23e33";
      // Band slightly deeper than the page, derived from tokens.
      const bandColor = `color-mix(in srgb, ${barColor} 10%, ${bgColor})`;

      const bandH = Math.max(1, h - RULER_HEIGHT - DOT_OVERHANG);
      const bandBottom = RULER_HEIGHT + bandH;
      const mid = RULER_HEIGHT + bandH / 2;
      const maxBarH = bandH * 0.37; // amplitude on one side of the mid line
      const viewT = elapsedSec; // playhead stays centred while recording

      // ── waveform band ──
      ctx.fillStyle = bandColor;
      ctx.fillRect(0, RULER_HEIGHT, w, bandH);

      ctx.fillStyle = barColor;
      ctx.globalAlpha = 0.78;
      const tLeft = viewT - w / 2 / PX_PER_SEC;
      const tRight = viewT + w / 2 / PX_PER_SEC;
      const iStart = Math.max(0, Math.floor(tLeft * BARS_PER_SEC) - 1);
      const iEnd = Math.min(history.length - 1, Math.ceil(tRight * BARS_PER_SEC) + 1);
      for (let i = iStart; i <= iEnd; i++) {
        const x = (i / BARS_PER_SEC - viewT) * PX_PER_SEC + w / 2;
        // Tiny samples render as the dotted baseline of the reference UI.
        const bh = Math.max(MIN_BAR_HEIGHT, (history[i] ?? 0) * maxBarH * 2);
        roundRectPath(ctx, x - BAR_WIDTH / 2, mid - bh / 2, BAR_WIDTH, bh);
        ctx.fill();
      }
      ctx.globalAlpha = 1;

      // ── bookmark markers on the band floor ──
      ctx.fillStyle = accentColor;
      for (const marker of markersRef.current ?? []) {
        const x = (marker - viewT) * PX_PER_SEC + w / 2;
        if (x < -4 || x > w + 4) continue;
        roundRectPath(ctx, x - 1.25, bandBottom - 15, 2.5, 15);
        ctx.fill();
      }

      // ── playhead: line from the ruler baseline + dot attached below ──
      const px = w / 2;
      ctx.fillStyle = accentColor;
      ctx.fillRect(px - 1, PLAYHEAD_TOP, 2, bandBottom - PLAYHEAD_TOP);
      ctx.beginPath();
      ctx.arc(px, bandBottom + DOT_RADIUS, DOT_RADIUS, 0, Math.PI * 2);
      ctx.fill();

      drawRuler(ctx, w, viewT, barColor, barColor);
    };
    raf = requestAnimationFrame(render);
    return () => cancelAnimationFrame(raf);
  }, []);

  return <canvas ref={canvasRef} className={className} aria-hidden="true" />;
}

// Ruler ticks only — no baseline. Labelled 2 s ticks are taller, thicker and
// darker; the three in-between ticks (0.5 s / 1 s / 1.5 s) share one height,
// thinner and lighter. Ticks continue left of 00:00; labels only for t ≥ 0.
function drawRuler(
  ctx: CanvasRenderingContext2D,
  w: number,
  viewT: number,
  tickColor: string,
  labelColor: string,
) {
  const baseY = 24;

  ctx.fillStyle = tickColor;
  ctx.font = "500 13px Inter, system-ui, sans-serif";
  ctx.textAlign = "center";

  const tLeft = viewT - w / 2 / PX_PER_SEC;
  const tRight = viewT + w / 2 / PX_PER_SEC;
  for (let s = Math.ceil(tLeft * 2) / 2; s <= tRight; s += 0.5) {
    const x = Math.round((s - viewT) * PX_PER_SEC + w / 2);
    const major = Math.abs(s / 2 - Math.round(s / 2)) < 1e-6;
    if (major) {
      ctx.globalAlpha = 0.55;
      ctx.fillRect(x - 1, baseY, 2, 20); // thicker + taller
    } else {
      ctx.globalAlpha = 0.35;
      ctx.fillRect(x, baseY, 1, 12); // uniform short ticks
    }
    if (major && s >= 0) {
      ctx.globalAlpha = 1;
      ctx.fillStyle = labelColor;
      const mm = Math.floor(s / 60);
      const ss = Math.round(s % 60);
      ctx.fillText(
        `${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}`,
        x,
        15,
      );
      ctx.fillStyle = tickColor;
    }
  }
  ctx.globalAlpha = 1;
}

function roundRectPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
) {
  const r = w / 2;
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
