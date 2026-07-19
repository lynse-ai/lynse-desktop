# 004 — Chat panel slides in from its trigger (first `motion` use)

- **Status**: TODO
- **Commit**: 2880b1d2 (refs are against the current working tree)
- **Severity**: MEDIUM
- **Category**: Missed opportunities (AUDIT §8) / Interruptibility (AUDIT §4)
- **Estimated scope**: 2 files — `packages/views/workspace/workspace-layout.tsx`, `packages/views/workspace/resizable-handle.tsx`

## Problem

The chat panel teleports open/closed, shoving the editor in a single frame. The inline comment even claims it "slides in from right when 'Ask AI' is clicked" — but it does not.

```tsx
// packages/views/workspace/workspace-layout.tsx:67-75 — current
{/* Chat panel: slides in from right when "Ask AI" is clicked */}
{chatPanelVisible && (
  <>
    <ResizableHandle onResize={handleChatPanelResize} side="left" />
    <div className="shrink-0 overflow-hidden" style={{ width: chatPanelWidth }}>
      <ChatPanel />
    </div>
  </>
)}
```

`chatPanelVisible` is a plain boolean (`store.ts:129`, toggled by `toggleChatPanel` `:194`); `chatPanelWidth` is a persisted, resizable width (default 340, clamp 260–500). Trigger is the "Ask AI" button at `packages/views/layout/title-bar.tsx:127-139`.

## Target

Wrap the panel in `motion`'s `AnimatePresence` and animate `width` + `opacity` so the editor collapses smoothly and the panel reveals. Because `chatPanelWidth` is also driven by live drag, gate the animation off during an active resize so dragging stays 1:1.

```tsx
// target — packages/views/workspace/workspace-layout.tsx
import { useState } from "react";            // add if not already imported
import { AnimatePresence, motion } from "motion/react";
// …existing imports…

// inside the component, before return:
const [isChatResizing, setIsChatResizing] = useState(false);

// replace lines 67-75 with:
<AnimatePresence initial={false}>
  {chatPanelVisible && (
    <motion.div
      key="chat-panel"
      className="flex shrink-0"
      initial={{ width: 0, opacity: 0 }}
      animate={{ width: chatPanelWidth, opacity: 1 }}
      exit={{ width: 0, opacity: 0 }}
      transition={
        isChatResizing
          ? { duration: 0 }
          : { duration: 0.24, ease: [0.23, 1, 0.32, 1] }
      }
    >
      <ResizableHandle
        onResize={handleChatPanelResize}
        onResizeStart={() => setIsChatResizing(true)}
        onResizeEnd={() => setIsChatResizing(false)}
        side="left"
      />
      <div className="overflow-hidden" style={{ width: chatPanelWidth }}>
        <ChatPanel />
      </div>
    </motion.div>
  )}
</AnimatePresence>
```

`ResizableHandle` must gain optional start/end callbacks:

```tsx
// target — packages/views/workspace/resizable-handle.tsx
interface ResizableHandleProps {
  onResize: (delta: number) => void;
  onResizeStart?: () => void;   // ADD
  onResizeEnd?: () => void;     // ADD
  side?: "left" | "right";
}

export function ResizableHandle({ onResize, onResizeStart, onResizeEnd, side = "right" }: ResizableHandleProps) {
  // …refs unchanged…
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    dragging.current = true;
    lastX.current = e.clientX;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    onResizeStart?.();                          // ADD
    const onMouseMove = (ev: MouseEvent) => { /* unchanged */ };
    const onMouseUp = () => {
      dragging.current = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      flush();
      onResizeEnd?.();                          // ADD
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
    };
    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
  }, [side, flush, onResizeStart, onResizeEnd]);
  // …return unchanged…
}
```

Animating `width` triggers layout (AUDIT §5), but a panel toggle is occasional (not high-frequency), and transform-only motion cannot push siblings — this is the standard collapsible-panel pattern. Inner content is fixed at `chatPanelWidth` inside `overflow-hidden`, so it does not reflow during the width animation.

## Repo conventions to follow

- Easing: the literal `[0.23, 1, 0.32, 1]` equals the `--ease-out` token; inline it because `motion`'s `ease` takes numbers, not a CSS var.
- `motion` import path is `"motion/react"` (`motion@12.42.2`, installed in Phase 0; peer-linked to React 19).
- `workspace-layout.tsx` is a client component (uses hooks + the Zustand store) — confirm `"use client"` is present at the top before adding `motion`.

## Steps

1. `resizable-handle.tsx`: add `onResizeStart?` / `onResizeEnd?` props; call `onResizeStart?.()` at the start of `handleMouseDown` and `onResizeEnd?.()` at the end of `onMouseUp`; add both to the `useCallback` dep array.
2. `workspace-layout.tsx`: add the `useState` + `motion` imports; add `isChatResizing` state; replace lines 67-75 with the `AnimatePresence` block above (wire the new handle callbacks only on the chat handle — the file-list handle at `:56` is unchanged).

## Boundaries

- Do NOT alter `chatPanelWidth` math, min/max clamps, or persistence in `store.ts`.
- Do NOT touch `ChatPanel` internals, `ContentPanel`, or the file-list `ResizableHandle`.
- Do NOT change `toggleChatPanel` semantics.
- Keep `"use client"` valid; do not introduce server-only APIs.
- If the code at the cited lines doesn't match (drift), STOP and report.

## Verification

- **Mechanical**: `pnpm --dir /Users/lynse/Documents/lynse-app/lynse-desktop typecheck` + `pnpm lint`.
- **Feel check**: `pnpm dev:web` (and `pnpm dev:desktop`):
  - Click "Ask AI" → chat panel slides in from the right over ~240ms; the editor collapses smoothly, no jump. Click again → panel collapses out.
  - Drag the panel's left handle → width tracks the pointer 1:1 with no lag/elasticity (the `isChatResizing` bypass works).
  - Spam the toggle rapidly → never jumps or restarts from a stale state (AnimatePresence handles interruptible exit/enter).
  - DevTools → Rendering → `prefers-reduced-motion: reduce` → panel appears/disappears instantly (plan 001 covers the broader reduced-motion story; confirm this panel doesn't move).
- **Done when**: toggle animates a smooth width slide; drag is 1:1; spam is stable; reduced-motion is instant.
