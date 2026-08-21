"use client";

import { useEffect, useRef } from "react";

export interface WaveformProps {
  /** Array of values between 0 and 1 for each bar. */
  data?: number[];
  /** Width of each bar in pixels. */
  barWidth?: number;
  /** Height of each bar in pixels (used as a minimum). */
  barHeight?: number;
  /** Gap between bars in pixels. */
  barGap?: number;
  /** Border radius of bars in pixels. */
  barRadius?: number;
  /** Bar color. Accepts any CSS color or a `var(--token)`. */
  barColor?: string;
  /** Apply a fade effect on the left/right edges. */
  fadeEdges?: boolean;
  /** Width of the fade effect in pixels. */
  fadeWidth?: number;
  /** Height of the waveform. */
  height?: string | number;
  className?: string;
  onClick?: (index: number, value: number) => void;
}

export interface ScrollingWaveformProps
  extends Omit<WaveformProps, "data" | "onClick"> {
  /** Scroll speed in pixels per second. */
  speed?: number;
  /** Number of bars kept in the scrolling buffer. */
  barCount?: number;
}

/** Resolve a CSS color, expanding `var(--token)` to its computed value. */
function resolveColor(color?: string): string {
  if (!color) return "#9ca3af";
  if (typeof document === "undefined") return color;

  const pure = color.match(/^var\(\s*(--[\w-]+)\s*\)$/);
  if (pure) {
    const val = getComputedStyle(document.documentElement)
      .getPropertyValue(pure[1] ?? "")
      .trim();
    return val || "#6366f1";
  }

  // hsl(var(--x)) / rgb(var(--x)) — drop the wrapper, use the raw token value.
  const wrapped = color.match(
    /^(?:hsl|rgb|rgba|hsla)\(\s*var\(\s*(--[\w-]+)\s*\)\s*\)$/,
  );
  if (wrapped) {
    const val = getComputedStyle(document.documentElement)
      .getPropertyValue(wrapped[1] ?? "")
      .trim();
    return val || "#6366f1";
  }

  const inner = color.match(/var\(\s*(--[\w-]+)\s*\)/);
  if (inner) {
    const val = getComputedStyle(document.documentElement)
      .getPropertyValue(inner[1] ?? "")
      .trim();
    return val ? color.replace(inner[0], val) : "#6366f1";
  }

  return color;
}

function roundRectPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
) {
  const radius = Math.max(0, Math.min(r, w / 2, h / 2));
  if (radius <= 0) {
    ctx.rect(x, y, w, h);
    return;
  }
  if (typeof ctx.roundRect === "function") {
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, radius);
    return;
  }
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

function setupCanvas(
  canvas: HTMLCanvasElement,
  cssWidth: number,
  cssHeight: number,
): CanvasRenderingContext2D | null {
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, Math.floor(cssWidth * dpr));
  canvas.height = Math.max(1, Math.floor(cssHeight * dpr));
  canvas.style.width = `${cssWidth}px`;
  canvas.style.height = `${cssHeight}px`;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return ctx;
}

/** Base waveform: renders `data` as bars on a canvas, edges faded by default. */
export function Waveform({
  data = [],
  barWidth = 4,
  barHeight = 4,
  barGap = 2,
  barRadius = 2,
  barColor = "var(--primary)",
  fadeEdges = true,
  fadeWidth = 24,
  height = 128,
  className,
  onClick,
}: WaveformProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;

    const draw = () => {
      const cssWidth = container.clientWidth;
      const cssHeight =
        typeof height === "number" ? height : parseInt(height, 10) || 128;
      const ctx = setupCanvas(canvas, cssWidth, cssHeight);
      if (!ctx) return;
      ctx.clearRect(0, 0, cssWidth, cssHeight);

      const color = resolveColor(barColor);
      const step = barWidth + barGap;
      const count = Math.max(0, Math.floor(cssWidth / step));
      const centerY = cssHeight / 2;
      const pad = 4;

      for (let i = 0; i < count; i++) {
        const value = data[i] ?? 0;
        const h = Math.max(barHeight, value * (cssHeight - pad * 2));
        let alpha = 1;
        if (fadeEdges) {
          const edgeDist = Math.min(i, count - 1 - i) * step;
          alpha = Math.min(1, edgeDist / Math.max(1, fadeWidth));
        }
        ctx.globalAlpha = alpha;
        ctx.fillStyle = color;
        roundRectPath(ctx, i * step, centerY - h / 2, barWidth, h, barRadius);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    };

    draw();
    const ro = new ResizeObserver(draw);
    ro.observe(container);
    return () => ro.disconnect();
  }, [data, barWidth, barGap, barHeight, barRadius, barColor, fadeEdges, fadeWidth, height]);

  useEffect(() => {
    if (!onClick) return;
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;
    const handler = (e: MouseEvent) => {
      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const idx = Math.floor(x / (barWidth + barGap));
      onClick(idx, data[idx] ?? 0);
    };
    canvas.addEventListener("click", handler);
    return () => canvas.removeEventListener("click", handler);
  }, [onClick, data, barWidth, barGap]);

  const cssHeight = typeof height === "number" ? height : undefined;

  return (
    <div
      ref={containerRef}
      className={className}
      style={{ width: "100%", height: cssHeight }}
    >
      <canvas ref={canvasRef} style={{ display: "block" }} />
    </div>
  );
}

/** Continuously scrolling waveform with auto-generated bars. */
export function ScrollingWaveform({
  speed = 50,
  barCount = 60,
  barWidth = 4,
  barGap = 2,
  barRadius = 2,
  barColor = "var(--primary)",
  fadeEdges = true,
  fadeWidth = 24,
  height = 80,
  className,
}: ScrollingWaveformProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const step = barWidth + barGap;
    const buffer: number[] = [];
    let target = Math.random();
    const nextBar = () => {
      const last = buffer.length > 0 ? (buffer[buffer.length - 1] as number) : target;
      if (Math.abs(target - last) < 0.08) {
        target = 0.12 + Math.random() * 0.88;
      }
      const next = last + (target - last) * 0.35 + (Math.random() - 0.5) * 0.12;
      return Math.max(0.05, Math.min(1, next));
    };
    for (let i = 0; i < barCount + 4; i++) buffer.push(nextBar());

    const cssHeightNum = () =>
      typeof height === "number" ? height : parseInt(height, 10) || 80;

    let lastW = -1;
    const resizeIfNeeded = () => {
      const cssWidth = container.clientWidth;
      if (cssWidth === lastW) return;
      lastW = cssWidth;
      setupCanvas(canvas, cssWidth, cssHeightNum());
    };

    let raf = 0;
    let lastTs = performance.now();
    let scrollAcc = 0;

    const render = (ts: number) => {
      const dt = Math.min(0.05, (ts - lastTs) / 1000);
      lastTs = ts;
      const cssWidth = container.clientWidth;
      const cssHeight = cssHeightNum();
      resizeIfNeeded();

      scrollAcc += (speed * dt) / step;
      while (scrollAcc >= 1) {
        scrollAcc -= 1;
        buffer.shift();
        buffer.push(nextBar());
      }

      ctx.clearRect(0, 0, cssWidth, cssHeight);
      const color = resolveColor(barColor);
      const centerY = cssHeight / 2;
      const pad = 6;
      const offset = scrollAcc * step;
      const count = buffer.length;

      for (let i = 0; i < count; i++) {
        const h = Math.max(barWidth, (buffer[i] ?? 0) * (cssHeight - pad * 2));
        let alpha = 1;
        if (fadeEdges) {
          const edgeDist = Math.min(i, count - 1 - i) * step;
          alpha = Math.min(1, edgeDist / Math.max(1, fadeWidth));
        }
        const x = i * step - offset;
        if (x + barWidth < 0 || x > cssWidth) continue;
        ctx.globalAlpha = alpha;
        ctx.fillStyle = color;
        roundRectPath(ctx, x, centerY - h / 2, barWidth, h, barRadius);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
      raf = requestAnimationFrame(render);
    };

    resizeIfNeeded();
    raf = requestAnimationFrame(render);
    const ro = new ResizeObserver(resizeIfNeeded);
    ro.observe(container);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [speed, barCount, barWidth, barGap, barRadius, barColor, fadeEdges, fadeWidth, height]);

  const cssHeight = typeof height === "number" ? height : undefined;

  return (
    <div
      ref={containerRef}
      className={className}
      style={{ width: "100%", height: cssHeight }}
    >
      <canvas ref={canvasRef} style={{ display: "block" }} />
    </div>
  );
}
