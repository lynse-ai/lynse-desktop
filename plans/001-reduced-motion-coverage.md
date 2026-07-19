# 001 — Reduced-motion coverage for bespoke keyframes + overlay utilities

- **Status**: TODO
- **Commit**: 2880b1d2 (refs are against the current working tree, which has uncommitted changes)
- **Severity**: MEDIUM
- **Category**: Accessibility (AUDIT §6)
- **Estimated scope**: 1 file (`packages/ui/styles/base.css`), one appended block

## Problem

Only `.border-beam::before` honors `prefers-reduced-motion` (`packages/ui/styles/base.css:201-213`). The other 10 bespoke keyframes, every tw-animate-css overlay (`animate-in`/`animate-out`), and the Tailwind `animate-spin`/`animate-ping`/`animate-bounce`/`animate-pulse` utilities run unconditionally. Per AUDIT §6, reduced motion means *fewer and gentler, not zero* — drop movement, keep opacity/color feedback.

Keyframe classes all live in `packages/ui/styles/base.css` (`:25, :45, :59, :73, :86, :104, :121, :149, :232`); the inline `ai-file-text-shimmer` keyframe is at `packages/views/workspace/middle-panel/file-list.tsx:225`.

## Target

Append one block at the end of `packages/ui/styles/base.css` (after the final `@layer base { … }`):

```css
/* target — append to packages/ui/styles/base.css */
@media (prefers-reduced-motion: reduce) {
  /* Positional/movement keyframes: snap to end state so the element is visible, no movement */
  .animate-entrance-spin,
  .animate-welcome-emoji-pop,
  .animate-completion-badge,
  .animate-floating-toolbar {
    animation-duration: 0.01ms;
    animation-iteration-count: 1;
  }
  /* Continuous/ambient loops: stop them; element rests in its natural (non-animated) state */
  .animate-chat-impulse,
  .animate-nav-progress-sweep,
  .animate-chat-text-shimmer {
    animation: none;
  }
  /* tw-animate-css overlays + Tailwind animate-* utilities: appear without movement.
     Content still resolves to final opacity, so feedback is preserved. */
  .animate-in,
  .animate-out,
  .animate-spin,
  .animate-ping,
  .animate-bounce,
  .animate-pulse {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
  }
}
```

`completion-check` (SVG stroke draw) and `onboarding-enter` (opacity-only) are non-positional and stay as-is. `base.css` is imported last in `apps/web/app/globals.css:5`, after `tw-animate-css` (`:2`), so it wins the cascade without `!important` for `.animate-in/.animate-out`; `!important` is kept as a safety net for the Tailwind utilities.

## Repo conventions to follow

- Imitate the existing reduced-motion block at `packages/ui/styles/base.css:201-213` (same media-query syntax, same file).
- Global block goes at the end of `base.css`, after all keyframe definitions.

## Steps

1. Open `packages/ui/styles/base.css`. After the closing `}` of the final `@layer base { … }` block (~line 280), append the target `@media (prefers-reduced-motion: reduce)` block above.

## Boundaries

- Do NOT modify any keyframe definition — only append the media-query block.
- Do NOT touch the existing `.border-beam::before` reduced-motion rule.
- No JS / no `useReducedMotion` — CSS only.
- If a class in the block doesn't exist (drift since `2880b1d2`), STOP and report.

## Verification

- **Mechanical**: `pnpm --dir /Users/lynse/Documents/lynse-app/lynse-desktop typecheck` (CSS-only; expect no change).
- **Feel check**: `pnpm dev:web`; DevTools → Rendering → emulate `prefers-reduced-motion: reduce`:
  - Open a popover/dialog/dropdown/tooltip → content appears instantly, no zoom/slide.
  - Trigger onboarding completion badge / welcome emoji → no scale/rotate; element just appears.
  - A loader spinner and the chat typing dots stop moving; the summarizing shimmer stops.
  - Toggle reduce OFF → all motion returns unchanged.
- **Done when**: with reduce ON, no element moves and all content is visible; with reduce OFF, behavior is identical to before.
