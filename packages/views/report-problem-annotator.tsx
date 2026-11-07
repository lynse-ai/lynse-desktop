"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "@lynse/ui/lib/utils";
import { useTranslation } from "@lynse/core/i18n/react";
import { ArrowUpRight, Copy, Eraser, Loader2, Minus, Pencil, Plus, Type, Undo, X } from "./icons";
import type { StagedScreenshot } from "./diagnostics";

type Tool = "pen" | "arrow" | "text" | "eraser";
type Point = { x: number; y: number };
type Size = { w: number; h: number };

/** One mark, in the screenshot's natural pixel space. */
type Stroke =
  | { kind: "pen"; color: string; width: number; points: Point[] }
  | { kind: "arrow"; color: string; width: number; from: Point; to: Point }
  | { kind: "text"; color: string; size: number; x: number; y: number; text: string; w: number };

type TextDraft = { x: number; y: number; value: string; color: string };

/**
 * Annotation ink. These are fixed, high-contrast marks that must read the
 * same on every theme and inside the uploaded JPEG, so deliberately not
 * theme tokens.
 */
const INK = [
  { id: "red", value: "#ef4444", labelKey: "settings.report_color_red" },
  { id: "amber", value: "#f59e0b", labelKey: "settings.report_color_amber" },
  { id: "blue", value: "#3b82f6", labelKey: "settings.report_color_blue" },
] as const;

const ZOOM_MAX = 8;
const TEXT_FONT =
  '600 ui-sans-serif, system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif';

/** Clamp to [1, ZOOM_MAX], snapping off float drift from ×1.25/×0.8 chains. */
function clampZoom(value: number): number {
  const snapped = Math.round(value * 10000) / 10000;
  return Math.min(ZOOM_MAX, Math.max(1, snapped));
}

/** Stroke width that stays legible whether the capture is 1× or Retina. */
function strokeWidthFor(natural: Size): number {
  return Math.max(3, Math.round(Math.min(natural.w, natural.h) / 300));
}

/**
 * Annotation text size in natural pixels for the current display scale, so
 * it reads at ~16 CSS px on screen while staying proportional in the saved
 * JPEG.
 */
function textNaturalSize(totalScale: number): number {
  return Math.max(18, Math.round(16 / Math.max(totalScale, 0.05)));
}

function drawStroke(ctx: CanvasRenderingContext2D, stroke: Stroke): void {
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.strokeStyle = stroke.color;
  ctx.fillStyle = stroke.color;

  if (stroke.kind === "text") {
    ctx.font = `600 ${stroke.size}px ${TEXT_FONT}`;
    ctx.textBaseline = "top";
    ctx.fillText(stroke.text, stroke.x, stroke.y);
    return;
  }

  ctx.lineWidth = stroke.width;

  if (stroke.kind === "pen") {
    const points = stroke.points;
    const first = points[0];
    if (!first) return;
    ctx.beginPath();
    if (points.length === 1) {
      // A tap leaves a dot rather than nothing.
      ctx.arc(first.x, first.y, stroke.width / 2, 0, Math.PI * 2);
      ctx.fill();
      return;
    }
    ctx.moveTo(first.x, first.y);
    // Quadratic segments through the midpoints smooth the pointer samples.
    for (let index = 1; index < points.length - 1; index += 1) {
      const control = points[index];
      const next = points[index + 1];
      if (!control || !next) break;
      ctx.quadraticCurveTo(control.x, control.y, (control.x + next.x) / 2, (control.y + next.y) / 2);
    }
    const last = points[points.length - 1];
    if (last) ctx.lineTo(last.x, last.y);
    ctx.stroke();
    return;
  }

  const { from, to } = stroke;
  ctx.beginPath();
  ctx.moveTo(from.x, from.y);
  ctx.lineTo(to.x, to.y);
  ctx.stroke();
  // Two barbs trailing back from the tip.
  const angle = Math.atan2(to.y - from.y, to.x - from.x);
  const barb = stroke.width * 4;
  for (const spread of [0.5, -0.5]) {
    const direction = angle + Math.PI + spread;
    ctx.beginPath();
    ctx.moveTo(to.x, to.y);
    ctx.lineTo(to.x + Math.cos(direction) * barb, to.y + Math.sin(direction) * barb);
    ctx.stroke();
  }
}

function redraw(canvas: HTMLCanvasElement, strokes: readonly Stroke[], draft: Stroke | null): void {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  for (const stroke of strokes) drawStroke(ctx, stroke);
  if (draft) drawStroke(ctx, draft);
}

function measureText(canvas: HTMLCanvasElement | null, text: string, size: number): number {
  const ctx = canvas?.getContext("2d");
  if (!ctx) return 0;
  ctx.font = `600 ${size}px ${TEXT_FONT}`;
  return ctx.measureText(text).width;
}

function distanceToSegment(point: Point, from: Point, to: Point): number {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const lengthSq = dx * dx + dy * dy;
  const t = lengthSq === 0 ? 0 : ((point.x - from.x) * dx + (point.y - from.y) * dy) / lengthSq;
  const clamped = Math.max(0, Math.min(1, t));
  return Math.hypot(from.x + clamped * dx - point.x, from.y + clamped * dy - point.y);
}

/** Whether the eraser at `point` (with a stroke-width-wide reach) touches a mark. */
function strokeHit(stroke: Stroke, point: Point, tolerance: number): boolean {
  if (stroke.kind === "text") {
    return (
      point.x >= stroke.x - tolerance &&
      point.x <= stroke.x + stroke.w + tolerance &&
      point.y >= stroke.y - tolerance &&
      point.y <= stroke.y + stroke.size * 1.3 + tolerance
    );
  }
  if (stroke.kind === "arrow") {
    return distanceToSegment(point, stroke.from, stroke.to) <= stroke.width / 2 + tolerance;
  }
  const points = stroke.points;
  if (points.length === 1) {
    const only = points[0];
    return Boolean(only && Math.hypot(only.x - point.x, only.y - point.y) <= stroke.width / 2 + tolerance);
  }
  for (let index = 1; index < points.length; index += 1) {
    const from = points[index - 1];
    const to = points[index];
    if (from && to && distanceToSegment(point, from, to) <= stroke.width / 2 + tolerance) {
      return true;
    }
  }
  return false;
}

function ToolButton({
  active,
  title,
  testId,
  onClick,
  children,
}: {
  active: boolean;
  title: string;
  testId: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      title={title}
      aria-label={title}
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        "rounded-full p-2 text-white transition-colors hover:bg-white/15",
        active && "bg-white/20",
      )}
    >
      {children}
    </button>
  );
}

/**
 * Enlarged view of the report screenshot with pen, arrow, text and eraser
 * tools, so the user can point at the problem instead of describing where
 * it is. Trackpad/mouse scroll pans, ⌘/Ctrl+wheel (pinch) zooms around the
 * cursor, and the bottom pill steps zoom; 100% is the fit-to-window scale.
 *
 * The capture is shown as a plain `<img>`; only the marks live on a canvas
 * stacked over it. Reading a `local-media://` image into a canvas would
 * taint it, so the overlay goes to the host as a transparent PNG and the
 * compositing happens there (see report_screenshot.rs). The canvas works in
 * the capture's natural pixels (crisp on Retina) and is scaled by CSS, so
 * every tool maps pointer input through the live scale and stays correct at
 * any zoom. The eraser removes whole marks — the overlay is transparent, so
 * pixel-erasing could only reveal the original capture anyway.
 */
export function ReportProblemAnnotator({
  screenshot,
  onClose,
  onSave,
}: {
  screenshot: StagedScreenshot;
  onClose: () => void;
  /** Receives the overlay as a PNG data URL; a rejection keeps the editor open. */
  onSave: (overlayDataUrl: string) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [tool, setTool] = useState<Tool>("pen");
  const [ink, setInk] = useState<string>(INK[0].value);
  const [strokes, setStrokes] = useState<Stroke[]>([]);
  const [natural, setNatural] = useState<Size | null>(null);
  const [stage, setStage] = useState<Size | null>(null);
  const [zoom, setZoom] = useState(1);
  const [textDraft, setTextDraft] = useState<TextDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const draftRef = useRef<Stroke | null>(null);
  const erasingRef = useRef(false);
  const textDraftRef = useRef<TextDraft | null>(null);
  const zoomAnchorRef = useRef<{ cx: number; cy: number; ratio: number } | null>(null);

  // Keyboard focus lives inside the editor so Escape closes it rather than
  // the dialog hosting it.
  useEffect(() => {
    rootRef.current?.focus();
  }, []);

  // Fit the capture to whatever space the stage has, window resizes included.
  useLayoutEffect(() => {
    const node = stageRef.current;
    if (!node) return;
    const measure = () => setStage({ w: node.clientWidth, h: node.clientHeight });
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !natural) return;
    if (canvas.width !== natural.w) canvas.width = natural.w;
    if (canvas.height !== natural.h) canvas.height = natural.h;
    redraw(canvas, strokes, draftRef.current);
  }, [natural, strokes]);

  const fitScale =
    natural && stage && natural.w > 0 && natural.h > 0
      ? Math.min((stage.w - 88) / natural.w, (stage.h - 64) / natural.h, 1)
      : 0;
  const totalScale = Math.max(fitScale * zoom, 0);
  const fitted =
    natural && totalScale > 0
      ? { w: Math.floor(natural.w * totalScale), h: Math.floor(natural.h * totalScale) }
      : null;

  // Wheel/pinch zoom around the cursor: plain wheel stays native (pans the
  // overflow area), ⌘/Ctrl+wheel zooms. The scroll offset is corrected after
  // the resize lands so the point under the cursor stays put.
  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      const next = clampZoom(zoom * (event.deltaY < 0 ? 1.25 : 0.8));
      if (next === zoom) return;
      const rect = element.getBoundingClientRect();
      zoomAnchorRef.current = {
        cx: event.clientX - rect.left,
        cy: event.clientY - rect.top,
        ratio: next / zoom,
      };
      setZoom(next);
    };
    element.addEventListener("wheel", onWheel, { passive: false });
    return () => element.removeEventListener("wheel", onWheel);
  }, [zoom]);

  useLayoutEffect(() => {
    const anchor = zoomAnchorRef.current;
    const element = scrollRef.current;
    zoomAnchorRef.current = null;
    if (!anchor || !element) return;
    element.scrollTop = (element.scrollTop + anchor.cy) * anchor.ratio - anchor.cy;
    element.scrollLeft = (element.scrollLeft + anchor.cx) * anchor.ratio - anchor.cx;
  }, [zoom]);

  function zoomBy(factor: number) {
    const element = scrollRef.current;
    if (element) {
      zoomAnchorRef.current = {
        cx: element.clientWidth / 2,
        cy: element.clientHeight / 2,
        ratio: factor,
      };
    }
    setZoom((previous) => clampZoom(previous * factor));
  }

  function selectTool(next: Tool) {
    commitTextDraft();
    setTool(next);
  }

  function updateTextDraft(draft: TextDraft | null) {
    textDraftRef.current = draft;
    setTextDraft(draft);
  }

  /** Commit the open text draft as a stroke (no-op when empty or absent). */
  function commitTextDraft() {
    const draft = textDraftRef.current;
    if (!draft) return;
    updateTextDraft(null);
    const value = draft.value.trim();
    if (!value || !natural) return;
    const size = textNaturalSize(totalScale);
    setStrokes((previous) => [
      ...previous,
      {
        kind: "text",
        color: draft.color,
        size,
        x: draft.x,
        y: draft.y,
        text: value,
        w: measureText(canvasRef.current, value, size),
      },
    ]);
  }

  /** Pointer position mapped into the canvas's natural pixel space. */
  const toNatural = useCallback((event: React.PointerEvent<HTMLCanvasElement>): Point | null => {
    const canvas = event.currentTarget;
    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;
    const x = ((event.clientX - rect.left) / rect.width) * canvas.width;
    const y = ((event.clientY - rect.top) / rect.height) * canvas.height;
    return {
      x: Math.min(Math.max(x, 0), canvas.width),
      y: Math.min(Math.max(y, 0), canvas.height),
    };
  }, []);

  function eraseAt(point: Point) {
    if (!natural) return;
    const tolerance = strokeWidthFor(natural);
    setStrokes((previous) => previous.filter((stroke) => !strokeHit(stroke, point, tolerance)));
  }

  function beginStroke(event: React.PointerEvent<HTMLCanvasElement>) {
    if (event.button !== 0 || saving || !natural) return;
    const point = toNatural(event);
    if (!point) return;
    event.preventDefault();
    if (tool === "text") {
      commitTextDraft();
      updateTextDraft({ x: point.x, y: point.y, value: "", color: ink });
      return;
    }
    if (tool === "eraser") {
      event.currentTarget.setPointerCapture(event.pointerId);
      erasingRef.current = true;
      eraseAt(point);
      return;
    }
    event.currentTarget.setPointerCapture(event.pointerId);
    const width = strokeWidthFor(natural);
    draftRef.current =
      tool === "pen"
        ? { kind: "pen", color: ink, width, points: [point] }
        : { kind: "arrow", color: ink, width, from: point, to: point };
    redraw(event.currentTarget, strokes, draftRef.current);
  }

  function extendStroke(event: React.PointerEvent<HTMLCanvasElement>) {
    const point = toNatural(event);
    if (!point) return;
    if (tool === "eraser") {
      if (erasingRef.current) eraseAt(point);
      return;
    }
    const draft = draftRef.current;
    if (!draft) return;
    if (draft.kind === "pen") draft.points.push(point);
    else if (draft.kind === "arrow") draft.to = point;
    redraw(event.currentTarget, strokes, draft);
  }

  function endStroke(event: React.PointerEvent<HTMLCanvasElement>) {
    if (tool === "eraser") {
      erasingRef.current = false;
      return;
    }
    const draft = draftRef.current;
    draftRef.current = null;
    if (!draft) return;
    // An arrow that was never dragged has no direction to point in.
    if (draft.kind === "arrow" && draft.from.x === draft.to.x && draft.from.y === draft.to.y) {
      redraw(event.currentTarget, strokes, null);
      return;
    }
    setStrokes((previous) => [...previous, draft]);
  }

  function undo() {
    setStrokes((previous) => previous.slice(0, -1));
  }

  async function save() {
    const canvas = canvasRef.current;
    if (!canvas || !natural || saving) return;
    if (strokes.length === 0) {
      // Nothing to burn in — the capture stays as it is.
      onClose();
      return;
    }
    setSaving(true);
    try {
      await onSave(canvas.toDataURL("image/png"));
    } catch {
      // The host already surfaced the error; keep the marks for a retry.
    } finally {
      setSaving(false);
    }
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (event.key !== "Escape" || saving) return;
    // The dialog hosting the editor also closes on Escape (document-level
    // listener) — stop the event here so only the editor goes away.
    event.stopPropagation();
    onClose();
  }

  return (
    <div
      ref={rootRef}
      tabIndex={-1}
      data-testid="report-annotator"
      onKeyDown={handleKeyDown}
      className="relative flex min-h-0 flex-1 select-none flex-col bg-black/90 text-white outline-none"
    >
      <div ref={stageRef} className="relative min-h-0 w-full flex-1">
        <div
          ref={scrollRef}
          data-testid="report-annotator-stage"
          className="absolute inset-0 overflow-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        >
          <div className="flex min-h-full min-w-full items-center justify-center py-4 pl-4 pr-20">
            <div
              className={cn("relative shadow-2xl ring-1 ring-white/10", !fitted && "invisible")}
              style={fitted ? { width: fitted.w, height: fitted.h } : undefined}
            >
              <img
                src={screenshot.url}
                alt={t("settings.report_screenshot_label")}
                draggable={false}
                onLoad={(event) =>
                  setNatural({
                    w: event.currentTarget.naturalWidth,
                    h: event.currentTarget.naturalHeight,
                  })
                }
                className="block h-full w-full"
              />
              <canvas
                ref={canvasRef}
                data-testid="report-annotator-canvas"
                onPointerDown={beginStroke}
                onPointerMove={extendStroke}
                onPointerUp={endStroke}
                onPointerCancel={endStroke}
                className={cn(
                  "absolute inset-0 h-full w-full touch-none",
                  tool === "eraser" ? "cursor-pointer" : "cursor-crosshair",
                )}
              />
              {textDraft && (
                <input
                  value={textDraft.value}
                  onChange={(event) => updateTextDraft({ ...textDraft, value: event.target.value })}
                  onKeyDown={(event) => {
                    // Keep typing events (Enter/Escape) out of the editor
                    // root and the hosting dialog.
                    event.stopPropagation();
                    if (event.key === "Enter") {
                      event.preventDefault();
                      commitTextDraft();
                    } else if (event.key === "Escape") {
                      event.preventDefault();
                      updateTextDraft(null);
                    }
                  }}
                  onBlur={() => commitTextDraft()}
                  autoFocus
                  spellCheck={false}
                  aria-label={t("settings.report_annotate_text_placeholder")}
                  placeholder={t("settings.report_annotate_text_placeholder")}
                  style={{
                    position: "absolute",
                    left: textDraft.x * totalScale,
                    top: textDraft.y * totalScale,
                    color: textDraft.color,
                    font: `600 16px ${TEXT_FONT}`,
                    width: Math.max(measureText(canvasRef.current, `${textDraft.value} `, 16) + 8, 64),
                  }}
                  className="border-b border-white/40 bg-transparent p-0 outline-none placeholder:text-white/40"
                />
              )}
            </div>
          </div>
        </div>
      </div>

      <p className="pointer-events-none absolute left-5 top-4 max-w-72 text-2xs leading-relaxed text-white/50">
        {t("settings.report_annotate_stage_hint")}
      </p>

      <div className="absolute right-4 top-4 z-10 flex items-center gap-2">
        <button
          type="button"
          data-testid="report-annotator-done"
          title={t("settings.report_annotate_done")}
          aria-label={t("settings.report_annotate_done")}
          disabled={saving || !natural}
          onClick={() => void save()}
          className="rounded-full bg-neutral-900/90 p-2 text-white ring-1 ring-white/15 transition-colors hover:bg-neutral-800 disabled:opacity-50"
        >
          {saving ? <Loader2 className="size-4 animate-spin" /> : <Copy className="size-4" />}
        </button>
        <button
          type="button"
          data-testid="report-annotator-close"
          title={t("settings.report_annotate_close")}
          aria-label={t("settings.report_annotate_close")}
          disabled={saving}
          onClick={onClose}
          className="rounded-full bg-neutral-900/90 p-2 text-white ring-1 ring-white/15 transition-colors hover:bg-neutral-800 disabled:opacity-50"
        >
          <X className="size-4" />
        </button>
      </div>

      <div className="absolute right-4 top-1/2 z-10 flex -translate-y-1/2 flex-col items-center gap-1 rounded-[1.375rem] bg-neutral-900/90 p-1.5 shadow-2xl ring-1 ring-white/15 backdrop-blur">
        <ToolButton
          active={tool === "pen"}
          title={t("settings.report_tool_pen")}
          testId="report-annotator-pen"
          onClick={() => selectTool("pen")}
        >
          <Pencil className="size-4" />
        </ToolButton>
        <ToolButton
          active={tool === "arrow"}
          title={t("settings.report_tool_arrow")}
          testId="report-annotator-arrow"
          onClick={() => selectTool("arrow")}
        >
          <ArrowUpRight className="size-4" />
        </ToolButton>
        <ToolButton
          active={tool === "text"}
          title={t("settings.report_tool_text")}
          testId="report-annotator-text"
          onClick={() => selectTool("text")}
        >
          <Type className="size-4" />
        </ToolButton>
        <ToolButton
          active={tool === "eraser"}
          title={t("settings.report_tool_eraser")}
          testId="report-annotator-eraser"
          onClick={() => selectTool("eraser")}
        >
          <Eraser className="size-4" />
        </ToolButton>
        <span className="my-1 h-px w-5 bg-white/20" />
        {INK.map((swatch) => (
          <button
            key={swatch.id}
            type="button"
            data-testid={`report-annotator-ink-${swatch.id}`}
            title={t(swatch.labelKey)}
            aria-label={t(swatch.labelKey)}
            aria-pressed={ink === swatch.value}
            onClick={() => setInk(swatch.value)}
            className={cn(
              "flex size-8 items-center justify-center rounded-full transition-colors hover:bg-white/15",
              ink === swatch.value && "bg-white/20",
            )}
          >
            <span
              className={cn(
                "block size-4 rounded-full ring-2",
                ink === swatch.value ? "ring-white" : "ring-transparent",
              )}
              style={{ backgroundColor: swatch.value }}
            />
          </button>
        ))}
        <span className="my-1 h-px w-5 bg-white/20" />
        <button
          type="button"
          data-testid="report-annotator-undo"
          title={t("settings.report_annotate_undo")}
          aria-label={t("settings.report_annotate_undo")}
          disabled={strokes.length === 0 || saving}
          onClick={undo}
          className="rounded-full p-2 text-white transition-colors hover:bg-white/15 disabled:opacity-40 disabled:hover:bg-transparent"
        >
          <Undo className="size-4" />
        </button>
      </div>

      <div className="absolute bottom-5 left-1/2 z-10 flex -translate-x-1/2 items-center gap-1 rounded-full bg-neutral-900/90 p-1.5 shadow-2xl ring-1 ring-white/15 backdrop-blur">
        <button
          type="button"
          data-testid="report-annotator-zoom-out"
          title={t("settings.report_zoom_out")}
          aria-label={t("settings.report_zoom_out")}
          disabled={zoom <= 1}
          onClick={() => zoomBy(0.8)}
          className="rounded-full p-2 text-white transition-colors hover:bg-white/15 disabled:opacity-40 disabled:hover:bg-transparent"
        >
          <Minus className="size-4" />
        </button>
        <button
          type="button"
          data-testid="report-annotator-zoom-reset"
          title={t("settings.report_zoom_reset")}
          aria-label={t("settings.report_zoom_reset")}
          onClick={() => zoomBy(1 / zoom)}
          className="min-w-14 text-center text-sm tabular-nums text-white transition-colors hover:text-white/80"
        >
          {Math.round(zoom * 100)}%
        </button>
        <button
          type="button"
          data-testid="report-annotator-zoom-in"
          title={t("settings.report_zoom_in")}
          aria-label={t("settings.report_zoom_in")}
          disabled={zoom >= ZOOM_MAX}
          onClick={() => zoomBy(1.25)}
          className="rounded-full p-2 text-white transition-colors hover:bg-white/15 disabled:opacity-40 disabled:hover:bg-transparent"
        >
          <Plus className="size-4" />
        </button>
      </div>
    </div>
  );
}
