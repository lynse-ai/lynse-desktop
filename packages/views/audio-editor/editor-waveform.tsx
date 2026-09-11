"use client";

import { useCallback, useEffect, useRef } from "react";
import type { SilenceSegment } from "./use-audio-analysis";

// ───────────────────────────────────────────────────────────────
// Static editor waveform.
//
// Same visual language as the recording page's waveform (time ruler on top,
// pill bars beneath, theme CSS variables), but the whole file fits the canvas
// width and the bar heights come from pre-computed peaks. Adds the editing
// affordances the recorder doesn't have: a draggable selection region with
// edge handles, a playhead, and an overlay marking the silence spans that
// "remove silence" would cut.
// ───────────────────────────────────────────────────────────────

const RULER_HEIGHT = 34;
const MIN_BAR_HEIGHT = 3;
const BAR_GAP = 2;
const HANDLE_HIT_PX = 10;

export interface WaveformSelection {
  startSec: number;
  endSec: number;
}

interface EditorWaveformProps {
  peaks: number[];
  durationSec: number;
  playheadSec: number;
  selection: WaveformSelection | null;
  silenceSegments?: SilenceSegment[];
  onSeek: (sec: number) => void;
  onSelectionChange: (selection: WaveformSelection | null) => void;
  className?: string;
}

type DragState =
  | { kind: "start" }
  | { kind: "end" }
  | { kind: "new"; anchorSec: number; moved: boolean }
  | null;

export function EditorWaveform({
  peaks,
  durationSec,
  playheadSec,
  selection,
  silenceSegments,
  onSeek,
  onSelectionChange,
  className,
}: EditorWaveformProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dragRef = useRef<DragState>(null);
  // Latest props for the render loop, without re-subscribing the effect.
  const stateRef = useRef({ peaks, durationSec, playheadSec, selection, silenceSegments });
  stateRef.current = { peaks, durationSec, playheadSec, selection, silenceSegments };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let width = 0;
    let height = 0;
    const measure = () => {
      width = canvas.clientWidth;
      height = canvas.clientHeight;
    };
    measure();
    const resizeObserver = new ResizeObserver(measure);
    resizeObserver.observe(canvas);

    const theme = readTheme(ctx, canvas);
    const themeObserver = new MutationObserver(() => Object.assign(theme, readTheme(ctx, canvas)));
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "style", "data-theme"],
    });

    let raf = 0;
    const render = () => {
      raf = requestAnimationFrame(render);
      if (width === 0 || height === 0) return;
      const { peaks, durationSec, playheadSec, selection, silenceSegments } = stateRef.current;
      const dpr = window.devicePixelRatio || 1;
      const canvasW = Math.round(width * dpr);
      const canvasH = Math.round(height * dpr);
      if (canvas.width !== canvasW || canvas.height !== canvasH) {
        canvas.width = canvasW;
        canvas.height = canvasH;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);
      if (durationSec <= 0) return;

      const secToX = (sec: number) => (sec / durationSec) * width;
      const bandH = Math.max(1, height - RULER_HEIGHT - 6);
      const bandBottom = RULER_HEIGHT + bandH;
      const mid = RULER_HEIGHT + bandH / 2;
      const maxBarH = bandH * 0.46;

      // Band background.
      ctx.globalAlpha = theme.bandAlpha;
      ctx.fillStyle = theme.band;
      ctx.fillRect(0, RULER_HEIGHT, width, bandH);
      ctx.globalAlpha = 1;

      // Silence overlay (regions the desilence export would cut).
      if (silenceSegments && silenceSegments.length > 0) {
        ctx.fillStyle = theme.accent;
        ctx.globalAlpha = 0.08;
        for (const segment of silenceSegments) {
          ctx.fillRect(secToX(segment.startSec), RULER_HEIGHT, secToX(segment.endSec) - secToX(segment.startSec), bandH);
        }
        ctx.globalAlpha = 1;
      }

      // Bars.
      const barCount = peaks.length;
      if (barCount > 0) {
        const pitch = width / barCount;
        const barWidth = Math.max(1, Math.min(3, pitch - BAR_GAP));
        ctx.globalAlpha = 0.78;
        ctx.fillStyle = theme.bar;
        ctx.beginPath();
        for (let i = 0; i < barCount; i++) {
          const x = i * pitch + (pitch - barWidth) / 2;
          const bh = Math.max(MIN_BAR_HEIGHT, (peaks[i] ?? 0) * maxBarH * 2);
          addPillPath(ctx, x, mid - bh / 2, barWidth, bh);
        }
        ctx.fill();
        ctx.globalAlpha = 1;
      }

      // Dim everything outside the selection.
      if (selection && selection.endSec > selection.startSec) {
        ctx.fillStyle = theme.background;
        ctx.globalAlpha = 0.55;
        ctx.fillRect(0, RULER_HEIGHT, secToX(selection.startSec), bandH);
        ctx.fillRect(secToX(selection.endSec), RULER_HEIGHT, width - secToX(selection.endSec), bandH);
        ctx.globalAlpha = 1;
        // Selection edges.
        ctx.fillStyle = theme.accent;
        for (const sec of [selection.startSec, selection.endSec]) {
          const x = secToX(sec);
          ctx.fillRect(x - 1, RULER_HEIGHT, 2, bandH);
          // Grab handle.
          ctx.beginPath();
          addPillPath(ctx, x - 4, mid - 14, 8, 28);
          ctx.fill();
        }
      }

      // Playhead.
      const px = secToX(Math.min(playheadSec, durationSec));
      ctx.fillStyle = theme.accent;
      ctx.fillRect(px - 1, 12, 2, bandBottom - 12);
      ctx.beginPath();
      ctx.arc(px, bandBottom + 6, 5, 0, Math.PI * 2);
      ctx.fill();

      drawRuler(ctx, width, durationSec, theme.bar);
    };
    raf = requestAnimationFrame(render);

    return () => {
      cancelAnimationFrame(raf);
      resizeObserver.disconnect();
      themeObserver.disconnect();
    };
  }, []);

  const secFromEvent = useCallback(
    (event: React.PointerEvent<HTMLCanvasElement>): number => {
      const canvas = canvasRef.current;
      if (!canvas) return 0;
      const rect = canvas.getBoundingClientRect();
      const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
      return ratio * stateRef.current.durationSec;
    },
    [],
  );

  const onPointerDown = useCallback(
    (event: React.PointerEvent<HTMLCanvasElement>) => {
      if (stateRef.current.durationSec <= 0) return;
      event.currentTarget.setPointerCapture(event.pointerId);
      const sec = secFromEvent(event);
      const { selection, durationSec } = stateRef.current;
      const handlePx = (HANDLE_HIT_PX / (event.currentTarget.clientWidth || 1)) * durationSec;
      if (selection) {
        if (Math.abs(sec - selection.startSec) <= handlePx) {
          dragRef.current = { kind: "start" };
          return;
        }
        if (Math.abs(sec - selection.endSec) <= handlePx) {
          dragRef.current = { kind: "end" };
          return;
        }
      }
      dragRef.current = { kind: "new", anchorSec: sec, moved: false };
    },
    [secFromEvent],
  );

  const onPointerMove = useCallback(
    (event: React.PointerEvent<HTMLCanvasElement>) => {
      const drag = dragRef.current;
      if (!drag) return;
      const sec = secFromEvent(event);
      const { durationSec } = stateRef.current;
      if (drag.kind === "new") {
        if (Math.abs(sec - drag.anchorSec) > durationSec * 0.005) drag.moved = true;
        if (drag.moved) {
          const start = Math.min(drag.anchorSec, sec);
          const end = Math.max(drag.anchorSec, sec);
          onSelectionChange({ startSec: start, endSec: end });
        }
      } else if (drag.kind === "start" && stateRef.current.selection) {
        const end = stateRef.current.selection.endSec;
        onSelectionChange({ startSec: Math.min(sec, end - 0.05), endSec: end });
      } else if (drag.kind === "end" && stateRef.current.selection) {
        const start = stateRef.current.selection.startSec;
        onSelectionChange({ startSec: start, endSec: Math.max(sec, start + 0.05) });
      }
    },
    [onSelectionChange, secFromEvent],
  );

  const onPointerUp = useCallback(
    (event: React.PointerEvent<HTMLCanvasElement>) => {
      const drag = dragRef.current;
      dragRef.current = null;
      if (!drag) return;
      if (drag.kind === "new" && !drag.moved) {
        // Plain click — seek (and drop the selection).
        onSelectionChange(null);
        onSeek(secFromEvent(event));
      }
    },
    [onSelectionChange, onSeek, secFromEvent],
  );

  return (
    <canvas
      ref={canvasRef}
      className={className}
      style={{ touchAction: "none" }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      aria-label="audio editor waveform"
    />
  );
}

interface Theme {
  background: string;
  bar: string;
  accent: string;
  band: string;
  bandAlpha: number;
}

function readTheme(ctx: CanvasRenderingContext2D, canvas: HTMLCanvasElement): Theme {
  const style = getComputedStyle(canvas);
  const background = style.getPropertyValue("--background").trim() || "#ffffff";
  const bar = style.getPropertyValue("--muted-foreground").trim() || "#7b7b7e";
  const accent = style.getPropertyValue("--destructive").trim() || "#e23e33";
  const mixed = `color-mix(in srgb, ${bar} 10%, ${background})`;
  ctx.fillStyle = "#000000";
  ctx.fillStyle = mixed;
  const supportsColorMix = ctx.fillStyle !== "#000000";
  return {
    background,
    bar,
    accent,
    band: supportsColorMix ? mixed : bar,
    bandAlpha: supportsColorMix ? 1 : 0.1,
  };
}

// Ruler with adaptive tick stride: labels land on a "nice" second interval
// (1/2/5/10/30/60/…) so the axis stays readable from a 10 s clip to a 2 h
// meeting.
function drawRuler(ctx: CanvasRenderingContext2D, w: number, durationSec: number, color: string) {
  const strides = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1200];
  const minLabelPx = 64;
  const stride = strides.find((s) => (s / durationSec) * w >= minLabelPx) ?? 2400;
  const baseY = 16;
  ctx.fillStyle = color;

  // Minor ticks at stride/4.
  ctx.globalAlpha = 0.35;
  ctx.beginPath();
  const minor = stride / 4;
  for (let t = 0; t <= durationSec; t += minor) {
    const x = Math.round((t / durationSec) * w);
    ctx.rect(x, baseY, 1, 8);
  }
  ctx.fill();

  // Major labelled ticks.
  ctx.globalAlpha = 0.55;
  const labels: { x: number; text: string }[] = [];
  ctx.beginPath();
  for (let i = 0; i * stride <= durationSec; i++) {
    const t = i * stride;
    const x = Math.round((t / durationSec) * w);
    ctx.rect(x - 1, baseY, 2, 13);
    labels.push({ x, text: formatRulerTime(t) });
  }
  ctx.fill();

  ctx.globalAlpha = 1;
  ctx.font = "100 11px Inter, system-ui, sans-serif";
  ctx.textAlign = "center";
  for (const label of labels) ctx.fillText(label.text, label.x, 11);
  ctx.globalAlpha = 1;
}

function formatRulerTime(sec: number): string {
  const s = Math.round(sec);
  const mm = Math.floor(s / 60);
  const ss = s % 60;
  if (mm >= 60) {
    const hh = Math.floor(mm / 60);
    return `${hh}:${String(mm % 60).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
  }
  return `${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
}

function addPillPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number) {
  const r = w / 2;
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
