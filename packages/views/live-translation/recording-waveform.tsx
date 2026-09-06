"use client";

import { useEffect, useRef } from "react";
import { createElapsedClock } from "./elapsed-clock";

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
//
// PERFORMANCE — the sidecar only publishes `elapsedMs` every 200 ms, so the
// raw value moves in ~12 px steps five times a second. Three things keep the
// band scrolling at a continuous 60 fps:
//   · a local clock extrapolates between sidecar ticks (see elapsed-clock.ts),
//   · the microphone level is smoothed frame-rate independently with a fast
//     attack / slow release plus a peak-hold, so bars never pop,
//   · canvas size, theme colours and the bar path are cached — every frame
//     builds one path per colour and fills once instead of reading layout
//     (clientWidth) or computed styles 60 times a second.
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

// Level smoothing time constants, in seconds.
const ATTACK_TAU = 0.025;
const RELEASE_TAU = 0.14;

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

interface Theme {
  bar: string;
  accent: string;
  /** Fill style for the band behind the bars. */
  band: string;
  /** Alpha used together with `band` (1 when `color-mix` produced the tint). */
  bandAlpha: number;
}

const THEME_FALLBACK = {
  background: "#ffffff",
  bar: "#7b7b7e",
  accent: "#e23e33",
};

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
    const clock = createElapsedClock();
    let smoothedLevel = 0;
    let pendingPeak = 0;
    let lastFrameAt = 0;

    // ── cached size: read layout only when the element actually resizes ──
    let width = 0;
    let height = 0;
    const measure = () => {
      width = canvas.clientWidth;
      height = canvas.clientHeight;
    };
    measure();
    const resizeObserver = new ResizeObserver(measure);
    resizeObserver.observe(canvas);

    // ── cached theme: getComputedStyle is a forced style recalculation ──
    let theme = readTheme(canvas, ctx);
    const refreshTheme = () => {
      theme = readTheme(canvas, ctx);
    };
    const themeObserver = new MutationObserver(refreshTheme);
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "style", "data-theme"],
    });
    const colorScheme = window.matchMedia("(prefers-color-scheme: dark)");
    colorScheme.addEventListener("change", refreshTheme);

    let raf = 0;
    const render = (now: number) => {
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

      // Frame-rate independent smoothing: fast attack, slow release, plus a
      // peak-hold so a transient between two bars is never swallowed.
      const dt = lastFrameAt === 0 ? 1 / 60 : Math.min(0.1, (now - lastFrameAt) / 1000);
      lastFrameAt = now;
      const raw = activeRef.current ? Math.min(1, Math.max(0, levelRef.current)) : 0;
      const tau = raw > smoothedLevel ? ATTACK_TAU : RELEASE_TAU;
      smoothedLevel += (raw - smoothedLevel) * (1 - Math.exp(-dt / tau));
      pendingPeak = Math.max(pendingPeak, raw);

      // Sync the bar buffer with the (interpolated) sidecar clock: pausing
      // freezes it, restarting truncates it.
      clock.push(elapsedRef.current, activeRef.current);
      const elapsedSec = Math.max(0, clock.read(now)) / 1000;
      const targetBars = Math.floor(elapsedSec * BARS_PER_SEC);
      while (history.length < targetBars) {
        history.push(Math.max(smoothedLevel, pendingPeak));
        pendingPeak = 0;
      }
      if (history.length > targetBars) history.length = targetBars;

      const bandH = Math.max(1, height - RULER_HEIGHT - DOT_OVERHANG);
      const bandBottom = RULER_HEIGHT + bandH;
      const mid = RULER_HEIGHT + bandH / 2;
      const maxBarH = bandH * 0.37; // amplitude on one side of the mid line
      const viewT = elapsedSec; // playhead stays centred while recording

      // ── waveform band ──
      ctx.globalAlpha = theme.bandAlpha;
      ctx.fillStyle = theme.band;
      ctx.fillRect(0, RULER_HEIGHT, width, bandH);

      // ── bars: one batched path, one fill ──
      const tLeft = viewT - width / 2 / PX_PER_SEC;
      const tRight = viewT + width / 2 / PX_PER_SEC;
      const iStart = Math.max(0, Math.floor(tLeft * BARS_PER_SEC) - 1);
      const iEnd = Math.min(history.length - 1, Math.ceil(tRight * BARS_PER_SEC) + 1);
      ctx.globalAlpha = 0.78;
      ctx.fillStyle = theme.bar;
      ctx.beginPath();
      for (let i = iStart; i <= iEnd; i++) {
        const x = (i / BARS_PER_SEC - viewT) * PX_PER_SEC + width / 2;
        // Tiny samples render as the dotted baseline of the reference UI.
        const bh = Math.max(MIN_BAR_HEIGHT, (history[i] ?? 0) * maxBarH * 2);
        addPillPath(ctx, x - BAR_WIDTH / 2, mid - bh / 2, BAR_WIDTH, bh);
      }
      ctx.fill();
      ctx.globalAlpha = 1;

      // ── bookmark markers on the band floor ──
      ctx.fillStyle = theme.accent;
      ctx.beginPath();
      let hasMarkers = false;
      for (const marker of markersRef.current ?? []) {
        const x = (marker - viewT) * PX_PER_SEC + width / 2;
        if (x < -4 || x > width + 4) continue;
        addPillPath(ctx, x - 1.25, bandBottom - 15, 2.5, 15);
        hasMarkers = true;
      }
      if (hasMarkers) ctx.fill();

      // ── playhead: line from the ruler baseline + dot attached below ──
      const px = width / 2;
      ctx.fillStyle = theme.accent;
      ctx.fillRect(px - 1, PLAYHEAD_TOP, 2, bandBottom - PLAYHEAD_TOP);
      ctx.beginPath();
      ctx.arc(px, bandBottom + DOT_RADIUS, DOT_RADIUS, 0, Math.PI * 2);
      ctx.fill();

      drawRuler(ctx, width, viewT, theme.bar);
    };
    raf = requestAnimationFrame(render);

    return () => {
      cancelAnimationFrame(raf);
      resizeObserver.disconnect();
      themeObserver.disconnect();
      colorScheme.removeEventListener("change", refreshTheme);
    };
  }, []);

  return <canvas ref={canvasRef} className={className} aria-hidden="true" />;
}

/**
 * Read the theme tokens once per theme change. `color-mix` keeps the band
 * derived from the palette; engines that reject it fall back to plain alpha
 * compositing so the band never silently inherits the previous fill colour.
 */
function readTheme(canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D): Theme {
  const style = getComputedStyle(canvas);
  const background = style.getPropertyValue("--background").trim() || THEME_FALLBACK.background;
  const bar = style.getPropertyValue("--muted-foreground").trim() || THEME_FALLBACK.bar;
  const accent = style.getPropertyValue("--destructive").trim() || THEME_FALLBACK.accent;
  const mixed = `color-mix(in srgb, ${bar} 10%, ${background})`;

  ctx.fillStyle = "#000000";
  ctx.fillStyle = mixed;
  const supportsColorMix = ctx.fillStyle !== "#000000";
  return {
    bar,
    accent,
    band: supportsColorMix ? mixed : bar,
    bandAlpha: supportsColorMix ? 1 : 0.1,
  };
}

// Ruler ticks only — no baseline. Labelled 2 s ticks are taller, thicker and
// darker; the three in-between ticks (0.5 s / 1 s / 1.5 s) share one height,
// thinner and lighter. Ticks continue left of 00:00; labels only for t ≥ 0.
//
// Ticks are batched into two paths (minor / major) so a full ruler costs two
// fills instead of one per tick; labels are the only per-item draw calls.
function drawRuler(ctx: CanvasRenderingContext2D, w: number, viewT: number, color: string) {
  const baseY = 24;
  const halfSecondsLeft = Math.ceil((viewT - w / 2 / PX_PER_SEC) * 2);
  const halfSecondsRight = Math.floor((viewT + w / 2 / PX_PER_SEC) * 2);
  const labels: { x: number; text: string }[] = [];

  ctx.fillStyle = color;

  // Minor ticks (0.5 s / 1 s / 1.5 s between labels).
  ctx.globalAlpha = 0.35;
  ctx.beginPath();
  for (let i = halfSecondsLeft; i <= halfSecondsRight; i++) {
    if (i % 4 === 0) continue;
    const x = Math.round((i / 2 - viewT) * PX_PER_SEC + w / 2);
    ctx.rect(x, baseY, 1, 12);
  }
  ctx.fill();

  // Major ticks (every 2 s) — thicker and taller.
  ctx.globalAlpha = 0.55;
  ctx.beginPath();
  for (let i = halfSecondsLeft; i <= halfSecondsRight; i++) {
    if (i % 4 !== 0) continue;
    const s = i / 2;
    const x = Math.round((s - viewT) * PX_PER_SEC + w / 2);
    ctx.rect(x - 1, baseY, 2, 20);
    if (s >= 0) {
      const mm = Math.floor(s / 60);
      const ss = Math.round(s % 60);
      labels.push({
        x,
        text: `${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}`,
      });
    }
  }
  ctx.fill();

  if (labels.length > 0) {
    ctx.globalAlpha = 1;
    ctx.font = "500 13px Inter, system-ui, sans-serif";
    ctx.textAlign = "center";
    for (const label of labels) ctx.fillText(label.text, label.x, 15);
  }
  ctx.globalAlpha = 1;
}

/** Append one rounded (pill) sub-path to the current path — no fill call. */
function addPillPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
) {
  const r = w / 2;
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
