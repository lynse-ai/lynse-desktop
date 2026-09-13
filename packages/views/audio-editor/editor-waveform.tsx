"use client";

import { useCallback, useEffect, useRef } from "react";
import type { SilenceSegment } from "./use-audio-analysis";

// ───────────────────────────────────────────────────────────────
// Voice-Memos trim waveform (zoomed main view) — 1:1 with macOS.
//
// The reference (macOS Voice Memos → select a recording → 编辑 → 修剪):
//   · a light-grey band filled with dense HAIRLINE vertical bars drawn in
//     (near-)foreground colour — straight lines, no rounding;
//   · a BLUE playhead: a thin vertical line carrying a small filled dot at
//     the band's top and bottom edge;
//   · in trim state the kept span is tinted soft YELLOW, bounded by thin
//     yellow edge lines that carry the same style of dots at both ends;
//   · a time ruler runs along the BOTTOM edge, labels under the band.
//
// Interactions: drag an edge handle to resize the selection, drag inside it
// to move the whole selection, drag on empty space to draw a new one, and a
// plain click seeks the playhead. All colours come from theme CSS variables,
// so light / dark adapt automatically.
// ───────────────────────────────────────────────────────────────

const TOP_PAD = 10;
const RULER_HEIGHT = 24;
const MIN_BAR_HEIGHT = 2;
// Zoomed-out display pitch: bars never get closer than this (1px line +
// 2px gap), so long recordings keep the hairline texture instead of
// collapsing into a solid block.
const MIN_PITCH = 3;
const EDGE_HIT_PX = 12;
/** Radius of the little dots sitting on the playhead / selection edges. */
const EDGE_DOT_RADIUS = 4;

export interface WaveformSelection {
  startSec: number;
  endSec: number;
}

interface EditorWaveformProps {
  peaks: number[];
  durationSec: number;
  /** Live playhead position, read every frame (kept out of React state so
   *  playback never re-renders the page at 60 fps). */
  getPlayheadSec: () => number;
  /** Visible window (zoom span) — only this time range is rendered. */
  viewStartSec: number;
  viewEndSec: number;
  selection: WaveformSelection | null;
  silenceSegments?: SilenceSegment[];
  onSeek: (sec: number) => void;
  onSelectionChange: (selection: WaveformSelection | null) => void;
  className?: string;
}

type DragState =
  | { kind: "start" }
  | { kind: "end" }
  | { kind: "move"; anchorSec: number; startSec: number; endSec: number }
  | { kind: "new"; anchorSec: number; moved: boolean }
  | null;

export function EditorWaveform({
  peaks,
  durationSec,
  getPlayheadSec,
  viewStartSec,
  viewEndSec,
  selection,
  silenceSegments,
  onSeek,
  onSelectionChange,
  className,
}: EditorWaveformProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dragRef = useRef<DragState>(null);
  // Latest props for the render loop, without re-subscribing the effect.
  const stateRef = useRef({ peaks, durationSec, getPlayheadSec, viewStartSec, viewEndSec, selection, silenceSegments });
  stateRef.current = { peaks, durationSec, getPlayheadSec, viewStartSec, viewEndSec, selection, silenceSegments };

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
    let themeVersion = 0;
    const themeObserver = new MutationObserver(() => {
      Object.assign(theme, readTheme(ctx, canvas));
      themeVersion += 1;
    });
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "style", "data-theme"],
    });

    // The loop runs every frame but repaints only when something actually
    // changed — a static editor costs zero drawing, playback costs one
    // repaint per playhead pixel step instead of 60 full redraws a second.
    let lastSignature = "";
    let lastPeaks: number[] | null = null;
    let lastSelection: WaveformSelection | null | undefined = null;
    let lastSilence: SilenceSegment[] | null | undefined = undefined;

    let raf = 0;
    const render = () => {
      raf = requestAnimationFrame(render);
      if (width === 0 || height === 0) return;
      const { peaks, durationSec, getPlayheadSec, viewStartSec, viewEndSec, selection, silenceSegments } = stateRef.current;
      const playheadSec = getPlayheadSec();
      const windowSec = Math.max(0.001, viewEndSec - viewStartSec);
      const playheadPx = Math.round(((playheadSec - viewStartSec) / windowSec) * width);
      const signature = `${width}x${height}|${playheadPx}|${viewStartSec.toFixed(3)}|${viewEndSec.toFixed(3)}|${selection?.startSec ?? -1}:${selection?.endSec ?? -1}|${themeVersion}`;
      if (
        signature === lastSignature &&
        peaks === lastPeaks &&
        selection === lastSelection &&
        silenceSegments === lastSilence
      ) {
        return;
      }
      lastSignature = signature;
      lastPeaks = peaks;
      lastSelection = selection;
      lastSilence = silenceSegments;

      const dpr = window.devicePixelRatio || 1;
      const canvasW = Math.round(width * dpr);
      const canvasH = Math.round(height * dpr);
      if (canvas.width !== canvasW || canvas.height !== canvasH) {
        canvas.width = canvasW;
        canvas.height = canvasH;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);

      const secToX = (sec: number) => ((sec - viewStartSec) / windowSec) * width;
      const bandTop = TOP_PAD;
      const bandH = Math.max(1, height - RULER_HEIGHT - TOP_PAD);
      const bandBottom = bandTop + bandH;
      const mid = bandTop + bandH / 2;
      const maxBarH = bandH * 0.42;

      // Band background.
      ctx.globalAlpha = theme.bandAlpha;
      ctx.fillStyle = theme.band;
      ctx.fillRect(0, bandTop, width, bandH);
      ctx.globalAlpha = 1;

      // Silence overlay (regions the desilence export would cut).
      if (silenceSegments && silenceSegments.length > 0) {
        ctx.fillStyle = theme.accent;
        ctx.globalAlpha = 0.08;
        for (const segment of silenceSegments) {
          const x0 = Math.max(0, secToX(segment.startSec));
          const x1 = Math.min(width, secToX(segment.endSec));
          if (x1 > 0 && x0 < width) ctx.fillRect(x0, bandTop, x1 - x0, bandH);
        }
        ctx.globalAlpha = 1;
      }

      // Bars — hairline vertical strokes in the near-foreground colour, the
      // Voice-Memos look. Bars never get closer than MIN_PITCH px: once the
      // zoom level would crowd them together, peaks collapse into buckets of
      // one bar per MIN_PITCH (max peak of the covered span), so the
      // hairline + gap texture stays legible at any duration.
      const barRate = durationSec > 0 ? peaks.length / durationSec : 0;
      if (barRate > 0) {
        const pitch = width / (windowSec * barRate);
        const iStart = Math.max(0, Math.floor(viewStartSec * barRate) - 1);
        const iEnd = Math.min(peaks.length - 1, Math.ceil(viewEndSec * barRate) + 1);
        ctx.globalAlpha = 0.88;
        ctx.fillStyle = theme.bar;
        if (pitch >= MIN_PITCH) {
          // One hairline per bar, centred on its timestamp.
          const barW = Math.min(2, Math.max(1, pitch * 0.3));
          ctx.beginPath();
          for (let i = iStart; i <= iEnd; i++) {
            const t = (i + 0.5) / barRate;
            const x = secToX(t);
            if (x < -2 || x > width + 2) continue;
            const bh = Math.max(MIN_BAR_HEIGHT, (peaks[i] ?? 0) * maxBarH * 2);
            ctx.rect(x - barW / 2, mid - bh / 2, barW, bh);
          }
          ctx.fill();
        } else {
          // Bucketed downsample: one 1px bar per MIN_PITCH px, holding the
          // max peak of the time span it covers. Near-silent buckets still
          // draw the min-height stub, forming the reference's dotted baseline.
          const buckets = Math.ceil(width / MIN_PITCH);
          const bucketPeak = new Float32Array(buckets);
          for (let i = iStart; i <= iEnd; i++) {
            const b = Math.floor(secToX((i + 0.5) / barRate) / MIN_PITCH);
            if (b < 0 || b >= buckets) continue;
            const value = peaks[i] ?? 0;
            if (value > bucketPeak[b]!) bucketPeak[b] = value;
          }
          ctx.beginPath();
          for (let b = 0; b < buckets; b++) {
            const value = bucketPeak[b]!;
            if (value <= 0) continue;
            const bh = Math.max(MIN_BAR_HEIGHT, value * maxBarH * 2);
            ctx.rect(b * MIN_PITCH + 1, mid - bh / 2, 1, bh);
          }
          ctx.fill();
        }
        ctx.globalAlpha = 1;
      }

      // Selection — the Voice-Memos trim look: soft yellow tint over the kept
      // span, thin yellow edge lines carrying dots at the band's top and
      // bottom edge (exactly like the playhead's dots).
      if (selection && selection.endSec > selection.startSec) {
        const x0 = secToX(selection.startSec);
        const x1 = secToX(selection.endSec);
        ctx.fillStyle = theme.warning;
        ctx.globalAlpha = 0.16;
        ctx.fillRect(Math.max(0, x0), bandTop, Math.min(width, x1) - Math.max(0, x0), bandH);
        ctx.globalAlpha = 1;
        for (const [edge, inside] of [
          [x0, x0 >= -2 && x0 <= width + 2],
          [x1, x1 >= -2 && x1 <= width + 2],
        ] as const) {
          if (!inside) continue;
          ctx.fillStyle = theme.warning;
          ctx.fillRect(edge - 1, bandTop, 2, bandH);
          ctx.beginPath();
          ctx.arc(edge, bandTop, EDGE_DOT_RADIUS, 0, Math.PI * 2);
          ctx.arc(edge, bandBottom, EDGE_DOT_RADIUS, 0, Math.PI * 2);
          ctx.fill();
        }
      }

      // Playhead — a thin BLUE line with a dot at the band's top and bottom
      // edge, matching the reference's blue needle.
      if (playheadSec >= viewStartSec && playheadSec <= viewEndSec) {
        const px = secToX(playheadSec);
        ctx.fillStyle = theme.playhead;
        ctx.fillRect(px - 0.75, bandTop, 1.5, bandH);
        ctx.beginPath();
        ctx.arc(px, bandTop, EDGE_DOT_RADIUS, 0, Math.PI * 2);
        ctx.arc(px, bandBottom, EDGE_DOT_RADIUS, 0, Math.PI * 2);
        ctx.fill();
      }

      drawRuler(ctx, width, height, viewStartSec, viewEndSec, theme.bar);
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
      const { viewStartSec, viewEndSec } = stateRef.current;
      const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
      return viewStartSec + ratio * (viewEndSec - viewStartSec);
    },
    [],
  );

  const onPointerDown = useCallback(
    (event: React.PointerEvent<HTMLCanvasElement>) => {
      const { durationSec, viewStartSec, viewEndSec, selection } = stateRef.current;
      if (durationSec <= 0 || viewEndSec <= viewStartSec) return;
      // A stale/invalid pointer id must not break the interaction.
      try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* ignore */ }
      const sec = Math.max(0, Math.min(durationSec, secFromEvent(event)));
      const rect = event.currentTarget.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const secToX = (t: number) => ((t - viewStartSec) / (viewEndSec - viewStartSec)) * rect.width;
      if (selection) {
        if (Math.abs(x - secToX(selection.startSec)) <= EDGE_HIT_PX) {
          dragRef.current = { kind: "start" };
          return;
        }
        if (Math.abs(x - secToX(selection.endSec)) <= EDGE_HIT_PX) {
          dragRef.current = { kind: "end" };
          return;
        }
        if (sec > selection.startSec && sec < selection.endSec) {
          dragRef.current = { kind: "move", anchorSec: sec, startSec: selection.startSec, endSec: selection.endSec };
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
      const { durationSec, selection } = stateRef.current;
      if (drag.kind === "new") {
        if (Math.abs(sec - drag.anchorSec) > durationSec * 0.005) drag.moved = true;
        if (drag.moved) {
          onSelectionChange({
            startSec: Math.max(0, Math.min(drag.anchorSec, sec)),
            endSec: Math.min(durationSec, Math.max(drag.anchorSec, sec)),
          });
        }
      } else if (drag.kind === "start" && selection) {
        onSelectionChange({ startSec: Math.min(sec, selection.endSec - 0.05), endSec: selection.endSec });
      } else if (drag.kind === "end" && selection) {
        onSelectionChange({ startSec: selection.startSec, endSec: Math.max(sec, selection.startSec + 0.05) });
      } else if (drag.kind === "move" && selection) {
        // Drag inside the selection shifts the whole span, clamped to the file.
        const length = drag.endSec - drag.startSec;
        const delta = sec - drag.anchorSec;
        const start = Math.max(0, Math.min(drag.startSec + delta, durationSec - length));
        onSelectionChange({ startSec: start, endSec: start + length });
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
        // Plain click — seek; an existing selection stays (clear it via trash).
        onSeek(Math.max(0, Math.min(stateRef.current.durationSec, secFromEvent(event))));
      }
    },
    [onSeek, secFromEvent],
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
  bar: string;
  accent: string;
  warning: string;
  playhead: string;
  band: string;
  bandAlpha: number;
}

function readTheme(ctx: CanvasRenderingContext2D, canvas: HTMLCanvasElement): Theme {
  const style = getComputedStyle(canvas);
  const background = style.getPropertyValue("--background").trim() || "#ffffff";
  const bar = style.getPropertyValue("--foreground").trim() || "#1a1a1a";
  const accent = style.getPropertyValue("--destructive").trim() || "#e23e33";
  const warning = style.getPropertyValue("--warning").trim() || "#eab308";
  // The blue needle — macOS uses the system accent blue for the playhead;
  // here --info carries that role (indigo blue in both themes).
  const playhead = style.getPropertyValue("--info").trim() || "#5f67d8";
  const mixed = `color-mix(in srgb, ${bar} 7%, ${background})`;

  ctx.fillStyle = "#000000";
  ctx.fillStyle = mixed;
  const supportsColorMix = ctx.fillStyle !== "#000000";
  return {
    bar,
    accent,
    warning,
    playhead,
    band: supportsColorMix ? mixed : bar,
    bandAlpha: supportsColorMix ? 1 : 0.08,
  };
}

// Ruler along the BOTTOM edge, labels under the band — the reference trim UI
// puts the time axis below the waveform. Adaptive tick stride keeps labels
// readable from a 10 s window to a 2 h meeting.
function drawRuler(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  viewStartSec: number,
  viewEndSec: number,
  color: string,
) {
  const windowSec = Math.max(0.001, viewEndSec - viewStartSec);
  const strides = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1200];
  const minLabelPx = 64;
  const stride = strides.find((s) => (s / windowSec) * w >= minLabelPx) ?? 2400;
  const tickTop = h - RULER_HEIGHT + 4;

  ctx.fillStyle = color;
  // Minor ticks at stride/4.
  ctx.globalAlpha = 0.35;
  ctx.beginPath();
  const minor = stride / 4;
  for (let t = Math.ceil(viewStartSec / minor) * minor; t <= viewEndSec; t += minor) {
    const x = Math.round(((t - viewStartSec) / windowSec) * w);
    ctx.rect(x, tickTop, 1, 5);
  }
  ctx.fill();

  // Major labelled ticks.
  ctx.globalAlpha = 0.55;
  const labels: { x: number; text: string }[] = [];
  ctx.beginPath();
  for (let t = Math.ceil(viewStartSec / stride) * stride; t <= viewEndSec; t += stride) {
    const x = Math.round(((t - viewStartSec) / windowSec) * w);
    ctx.rect(x - 1, tickTop, 2, 7);
    labels.push({ x, text: formatRulerTime(t) });
  }
  ctx.fill();

  ctx.globalAlpha = 1;
  ctx.font = "100 11px Inter, system-ui, sans-serif";
  ctx.textAlign = "center";
  for (const label of labels) ctx.fillText(label.text, label.x, h - 5);
  ctx.globalAlpha = 1;
}

function formatRulerTime(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  if (hh > 0) return `${hh}:${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
  return `${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
}
