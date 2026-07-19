"use client";

import { useCallback, useRef } from "react";

interface ResizableHandleProps {
  onResize: (delta: number) => void;
  onResizeStart?: () => void;
  onResizeEnd?: () => void;
  side?: "left" | "right";
}

export function ResizableHandle({ onResize, onResizeStart, onResizeEnd, side = "right" }: ResizableHandleProps) {
  const dragging = useRef(false);
  const lastX = useRef(0);
  const pendingDelta = useRef(0);

  const flush = useCallback(() => {
    if (pendingDelta.current !== 0) {
      onResize(pendingDelta.current);
      pendingDelta.current = 0;
    }
  }, [onResize]);

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      dragging.current = true;
      lastX.current = e.clientX;
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
      onResizeStart?.();

      const onMouseMove = (ev: MouseEvent) => {
        if (!dragging.current) return;
        const delta = ev.clientX - lastX.current;
        lastX.current = ev.clientX;
        const effective = side === "right" ? delta : -delta;
        if (effective !== 0) {
          pendingDelta.current += effective;
          requestAnimationFrame(flush);
        }
      };

      const onMouseUp = () => {
        dragging.current = false;
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        flush();
        onResizeEnd?.();
        document.removeEventListener("mousemove", onMouseMove);
        document.removeEventListener("mouseup", onMouseUp);
      };

      document.addEventListener("mousemove", onMouseMove);
      document.addEventListener("mouseup", onMouseUp);
    },
    [side, flush, onResizeStart, onResizeEnd],
  );

  return (
    <div
      onMouseDown={handleMouseDown}
      className="group relative z-30 w-px shrink-0 cursor-col-resize bg-border transition-colors hover:bg-primary/40 before:absolute before:-inset-x-1.5 before:inset-y-0 before:cursor-col-resize before:content-['']"
    />
  );
}
