"use client";

import { useCallback, useEffect, useRef, useState } from "react";

interface ResizableHandleProps {
  onResize: (delta: number) => void;
  onResizeStart?: () => void;
  onResizeEnd?: () => void;
  side?: "left" | "right";
  label?: string;
}

export function ResizableHandle({
  onResize,
  onResizeStart,
  onResizeEnd,
  side = "right",
  label = "Resize panel",
}: ResizableHandleProps) {
  const dragging = useRef(false);
  const lastX = useRef(0);
  const pendingDelta = useRef(0);
  const animationFrame = useRef<number | null>(null);
  const previousCursor = useRef("");
  const previousUserSelect = useRef("");
  const [isDragging, setIsDragging] = useState(false);

  const flush = useCallback(() => {
    animationFrame.current = null;
    if (pendingDelta.current !== 0) {
      onResize(pendingDelta.current);
      pendingDelta.current = 0;
    }
  }, [onResize]);

  const scheduleFlush = useCallback(() => {
    if (animationFrame.current === null) {
      animationFrame.current = requestAnimationFrame(flush);
    }
  }, [flush]);

  const finishResize = useCallback(
    (element?: HTMLDivElement, pointerId?: number) => {
      if (!dragging.current) return;
      dragging.current = false;
      if (animationFrame.current !== null) {
        cancelAnimationFrame(animationFrame.current);
        animationFrame.current = null;
      }
      flush();
      if (element && pointerId !== undefined && element.hasPointerCapture(pointerId)) {
        element.releasePointerCapture(pointerId);
      }
      document.body.style.cursor = previousCursor.current;
      document.body.style.userSelect = previousUserSelect.current;
      setIsDragging(false);
      onResizeEnd?.();
    },
    [flush, onResizeEnd],
  );

  const handlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.currentTarget.setPointerCapture(e.pointerId);
      dragging.current = true;
      lastX.current = e.clientX;
      previousCursor.current = document.body.style.cursor;
      previousUserSelect.current = document.body.style.userSelect;
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
      setIsDragging(true);
      onResizeStart?.();
    },
    [onResizeStart],
  );

  const handlePointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!dragging.current) return;
      const delta = e.clientX - lastX.current;
      lastX.current = e.clientX;
      const effective = side === "right" ? delta : -delta;
      if (effective !== 0) {
        pendingDelta.current += effective;
        scheduleFlush();
      }
    },
    [scheduleFlush, side],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      e.preventDefault();
      const pointerDelta = e.key === "ArrowRight" ? 16 : -16;
      onResize(side === "right" ? pointerDelta : -pointerDelta);
    },
    [onResize, side],
  );

  useEffect(() => {
    return () => {
      if (animationFrame.current !== null) cancelAnimationFrame(animationFrame.current);
      if (dragging.current) {
        document.body.style.cursor = previousCursor.current;
        document.body.style.userSelect = previousUserSelect.current;
      }
    };
  }, []);

  return (
    <div
      role="separator"
      aria-label={label}
      aria-orientation="vertical"
      tabIndex={0}
      data-resizing={isDragging}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={(e) => finishResize(e.currentTarget, e.pointerId)}
      onPointerCancel={(e) => finishResize(e.currentTarget, e.pointerId)}
      onKeyDown={handleKeyDown}
      className="group relative z-30 w-px shrink-0 touch-none cursor-col-resize bg-border transition-colors before:absolute before:-inset-x-2 before:inset-y-0 before:cursor-col-resize before:content-[''] hover:bg-primary/50 focus-visible:bg-primary/60 focus-visible:outline-none data-[resizing=true]:bg-primary/60"
    />
  );
}
