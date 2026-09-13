"use client";

import { useCallback, useEffect, useRef } from "react";
import type { WaveformSelection } from "./editor-waveform";

// ───────────────────────────────────────────────────────────────
// Trim overview strip — the whole file as a mini waveform, 1:1 with the
// macOS Voice Memos reference:
//
//   · a rounded rectangle with a thin grey border around the strip;
//   · dense hairline bars for the whole file;
//   · a BLUE tick tracking the playhead;
//   · in trim state the border turns YELLOW, the kept span is tinted, and
//     the selection edges carry yellow handle bars with black chevrons
//     (‹ ›) — dragging a handle trims the selection.
//
// The strip body still pans the main view (our zoom affordance): drag the
// body to pan, tap outside the view window to jump there. Out-of-view spans
// are dimmed so the zoom position stays legible without cluttering the
// macOS look.
// ───────────────────────────────────────────────────────────────

const HANDLE_HIT_PX = 14;
const HANDLE_WIDTH = 10;
const CORNER_RADIUS = 6;
// Fixed display pitch: 1px bar + 2px gap, whatever the duration — the
// whole-file texture stays one-bar-at-a-time legible instead of collapsing
// into a solid block on long recordings.
const MIN_PITCH = 3;

interface EditorOverviewProps {
  peaks: number[];
  durationSec: number;
  /** Live playhead position, read every frame (kept out of React state). */
  getPlayheadSec: () => number;
  viewStartSec: number;
  viewEndSec: number;
  /** Trim selection; its edges render as chevron handles when present. */
  selection: WaveformSelection | null;
  onSelectionChange: (selection: WaveformSelection | null) => void;
  onViewChange: (startSec: number, endSec: number) => void;
  className?: string;
}

type Drag =
  | { kind: "sel-start" }
  | { kind: "sel-end" }
  | { kind: "pan"; anchorSec: number; startSec: number; endSec: number }
  | null;

export function EditorOverview({
  peaks,
  durationSec,
  getPlayheadSec,
  viewStartSec,
  viewEndSec,
  selection,
  onSelectionChange,
  onViewChange,
  className,
}: EditorOverviewProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dragRef = useRef<Drag>(null);
  const stateRef = useRef({ peaks, durationSec, getPlayheadSec, viewStartSec, viewEndSec, selection });
  stateRef.current = { peaks, durationSec, getPlayheadSec, viewStartSec, viewEndSec, selection };

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

    const theme = readTheme(canvas);
    let themeVersion = 0;
    const themeObserver = new MutationObserver(() => {
      Object.assign(theme, readTheme(canvas));
      themeVersion += 1;
    });
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "style", "data-theme"],
    });

    // Repaint only on actual change — idle CPU stays at zero.
    let lastSignature = "";
    let lastPeaks: number[] | null = null;
    let lastSelection: WaveformSelection | null | undefined = null;

    let raf = 0;
    const render = () => {
      raf = requestAnimationFrame(render);
      if (width === 0 || height === 0) return;
      const { peaks, durationSec, getPlayheadSec, viewStartSec, viewEndSec, selection } = stateRef.current;
      const playheadPx = Math.round((getPlayheadSec() / Math.max(0.001, durationSec)) * width);
      const signature = `${width}x${height}|${playheadPx}|${viewStartSec.toFixed(3)}|${viewEndSec.toFixed(3)}|${selection?.startSec ?? -1}:${selection?.endSec ?? -1}|${themeVersion}`;
      if (signature === lastSignature && peaks === lastPeaks && selection === lastSelection) return;
      lastSignature = signature;
      lastPeaks = peaks;
      lastSelection = selection;

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
      const mid = height / 2;
      const maxBarH = height * 0.52;
      const hasSelection = !!(selection && selection.endSec > selection.startSec);
      const stroke = hasSelection ? theme.warning : theme.border;

      // Bars — the whole file as hairline strokes at the fixed MIN_PITCH
      // spacing; each bar holds the max peak of the time span it covers.
      if (peaks.length > 0) {
        const buckets = Math.ceil(width / MIN_PITCH);
        const bucketPeak = new Float32Array(buckets);
        for (let i = 0; i < peaks.length; i++) {
          const b = Math.floor((((i + 0.5) / peaks.length) * width) / MIN_PITCH);
          if (b < 0 || b >= buckets) continue;
          const value = peaks[i] ?? 0;
          if (value > bucketPeak[b]!) bucketPeak[b] = value;
        }
        ctx.globalAlpha = 0.85;
        ctx.fillStyle = theme.bar;
        ctx.beginPath();
        for (let b = 0; b < buckets; b++) {
          const value = bucketPeak[b]!;
          if (value <= 0) continue;
          const bh = Math.max(2, value * maxBarH * 2);
          ctx.rect(b * MIN_PITCH + 1, mid - bh / 2, 1, bh);
        }
        ctx.fill();
        ctx.globalAlpha = 1;
      }

      // Selection — tinted kept span + yellow handle bars with chevrons.
      if (hasSelection) {
        const x0 = secToX(selection!.startSec);
        const x1 = secToX(selection!.endSec);
        ctx.fillStyle = theme.warning;
        ctx.globalAlpha = 0.18;
        ctx.fillRect(x0, 1, Math.max(2, x1 - x0), height - 2);
        ctx.globalAlpha = 1;
        for (const edge of [x0, x1] as const) {
          // Handle bar: rounded yellow pill spanning the strip height.
          ctx.fillStyle = theme.warning;
          roundRect(ctx, edge - HANDLE_WIDTH / 2, 1, HANDLE_WIDTH, height - 2, HANDLE_WIDTH / 2);
          ctx.fill();
          // Black chevron pointing outward (‹ on the left handle, › right).
          ctx.strokeStyle = theme.handleGlyph;
          ctx.lineWidth = 1.5;
          ctx.lineCap = "round";
          const cx = edge;
          const cy = height / 2;
          const dir = edge === x0 ? -1 : 1;
          ctx.beginPath();
          ctx.moveTo(cx + dir * 2.5, cy - 3.5);
          ctx.lineTo(cx - dir * 1.5, cy);
          ctx.lineTo(cx + dir * 2.5, cy + 3.5);
          ctx.stroke();
        }
      }

      // Zoom position — dim whatever lies outside the visible window so the
      // pan/zoom state stays legible without introducing a second coloured
      // box the reference does not have.
      const vx0 = secToX(viewStartSec);
      const vx1 = secToX(viewEndSec);
      ctx.fillStyle = theme.bar;
      ctx.globalAlpha = 0.07;
      if (vx0 > 0) ctx.fillRect(0, 0, vx0, height);
      if (vx1 < width) ctx.fillRect(vx1, 0, width - vx1, height);
      ctx.globalAlpha = 1;

      // Playhead tick — blue, like the reference.
      if (durationSec > 0) {
        const px = secToX(getPlayheadSec());
        ctx.fillStyle = theme.playhead;
        ctx.fillRect(px - 1, 0, 2, height);
      }

      // Rounded border around the strip — grey normally, yellow in trim.
      ctx.strokeStyle = stroke;
      ctx.lineWidth = hasSelection ? 2 : 1;
      roundRect(ctx, 0.75, 0.75, width - 1.5, height - 1.5, CORNER_RADIUS);
      ctx.stroke();
    };
    raf = requestAnimationFrame(render);

    return () => {
      cancelAnimationFrame(raf);
      resizeObserver.disconnect();
      themeObserver.disconnect();
    };
  }, []);

  const secFromEvent = useCallback((event: React.PointerEvent<HTMLCanvasElement>): number => {
    const canvas = canvasRef.current;
    if (!canvas) return 0;
    const rect = canvas.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
    return ratio * stateRef.current.durationSec;
  }, []);

  const onPointerDown = useCallback(
    (event: React.PointerEvent<HTMLCanvasElement>) => {
      const { durationSec, viewStartSec, viewEndSec, selection } = stateRef.current;
      if (durationSec <= 0) return;
      // A stale/invalid pointer id must not break the interaction.
      try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* ignore */ }
      const rect = event.currentTarget.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const secToX = (t: number) => (t / durationSec) * rect.width;
      // Selection handles own their edges when a trim selection exists.
      if (selection && selection.endSec > selection.startSec) {
        if (Math.abs(x - secToX(selection.startSec)) <= HANDLE_HIT_PX) {
          dragRef.current = { kind: "sel-start" };
          return;
        }
        if (Math.abs(x - secToX(selection.endSec)) <= HANDLE_HIT_PX) {
          dragRef.current = { kind: "sel-end" };
          return;
        }
      }
      if (x > secToX(viewStartSec) && x < secToX(viewEndSec)) {
        dragRef.current = { kind: "pan", anchorSec: secFromEvent(event), startSec: viewStartSec, endSec: viewEndSec };
        return;
      }
      // Outside the window — jump the window there, then keep panning.
      const span = viewEndSec - viewStartSec;
      const start = Math.max(0, Math.min(secFromEvent(event) - span / 2, durationSec - span));
      onViewChange(start, start + span);
      dragRef.current = { kind: "pan", anchorSec: secFromEvent(event), startSec: start, endSec: start + span };
    },
    [onViewChange, secFromEvent],
  );

  const onPointerMove = useCallback(
    (event: React.PointerEvent<HTMLCanvasElement>) => {
      const drag = dragRef.current;
      if (!drag) return;
      const { durationSec, selection } = stateRef.current;
      const sec = secFromEvent(event);
      if (drag.kind === "pan") {
        const span = drag.endSec - drag.startSec;
        const delta = sec - drag.anchorSec;
        const start = Math.max(0, Math.min(drag.startSec + delta, durationSec - span));
        onViewChange(start, start + span);
      } else if (drag.kind === "sel-start" && selection) {
        onSelectionChange({ startSec: Math.max(0, Math.min(sec, selection.endSec - 0.05)), endSec: selection.endSec });
      } else if (drag.kind === "sel-end" && selection) {
        onSelectionChange({ startSec: selection.startSec, endSec: Math.min(durationSec, Math.max(sec, selection.startSec + 0.05)) });
      }
    },
    [onSelectionChange, onViewChange, secFromEvent],
  );

  const onPointerUp = useCallback(() => {
    dragRef.current = null;
  }, []);

  return (
    <canvas
      ref={canvasRef}
      className={className}
      style={{ touchAction: "none" }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      aria-label="audio editor overview"
    />
  );
}

interface Theme {
  bar: string;
  border: string;
  warning: string;
  playhead: string;
  handleGlyph: string;
}

function readTheme(canvas: HTMLCanvasElement): Theme {
  const style = getComputedStyle(canvas);
  return {
    bar: style.getPropertyValue("--foreground").trim() || "#1a1a1a",
    border: style.getPropertyValue("--border").trim() || "#d9d9de",
    warning: style.getPropertyValue("--warning").trim() || "#eab308",
    playhead: style.getPropertyValue("--info").trim() || "#5f67d8",
    handleGlyph: style.getPropertyValue("--foreground").trim() || "#1a1a1a",
  };
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
