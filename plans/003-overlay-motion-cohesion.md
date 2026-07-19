# 003 — Easing token + budget durations for overlay primitives

- **Status**: TODO
- **Commit**: 2880b1d2 (refs are against the current working tree)
- **Severity**: MEDIUM
- **Category**: Easing & duration (AUDIT §2) / Cohesion (AUDIT §7)
- **Estimated scope**: 1 CSS rule added (`base.css`) + ~10 class-string duration edits across `packages/ui/components/ui/`

## Problem

Every overlay primitive opens/closes with `duration-100` and no easing token, so all inherit tw-animate-css's weak default easing. AUDIT §2 budget: tooltips/small popovers 125–200ms, dropdowns/selects 150–250ms, modals 200–500ms — `duration-100` is below the floor everywhere. The strong `--ease-out` token exists but is applied to no overlay animation.

Representative current code (verbatim):

```tsx
// packages/ui/components/ui/popover.tsx:40
"... origin-(--transform-origin) ... duration-100 ... data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95"
// packages/ui/components/ui/dialog.tsx:56
"... duration-100 ... data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95"
```

## Target

**Part A — one global easing rule** (covers all overlays at once). Add to `packages/ui/styles/base.css` (imported *after* `tw-animate-css` in `apps/web/app/globals.css:2` vs `:5`, so this wins the cascade):

```css
/* target — add near the other overlay-related rules in packages/ui/styles/base.css */
.animate-in,
.animate-out {
  animation-timing-function: var(--ease-out);
}
```

**Part B — bring durations onto the AUDIT §2 budget** (per file). Change `duration-100` to:

- `duration-150` (popovers / tooltips / dropdowns / selects budget 125–250ms): `popover.tsx:40`, `tooltip.tsx:53`, `hover-card.tsx:67`, `dropdown-menu.tsx:54`, `dropdown-menu.tsx:148` (if it carries its own), `context-menu.tsx:55`, `menubar.tsx:83`, `menubar.tsx:257`, `select.tsx:86`, `combobox.tsx:113`
- `duration-200` (modals budget 200–500ms): `dialog.tsx:34` (overlay) + `:56` (content), `alert-dialog.tsx:33` (overlay) + `:55` (content)

## Repo conventions to follow

- `--ease-out` in `packages/ui/styles/tokens.css` `@theme` (global CSS var).
- tw-animate-css `animate-in`/`animate-out` already drive these overlays — keep them; only add timing + adjust duration.
- Global rule placement: `base.css` is the last CSS import, so a same-specificity rule here overrides tw-animate-css.

## Steps

1. In `packages/ui/styles/base.css`, add the Part A `.animate-in, .animate-out { animation-timing-function: var(--ease-out); }` rule (e.g. just before the final `@layer base`).
2. For each of the 8 popover-family files, change `duration-100` → `duration-150` on the content class line listed above.
3. In `dialog.tsx` and `alert-dialog.tsx`, change `duration-100` → `duration-200` on both the overlay and content class lines.

## Boundaries

- Do NOT change `origin-(--transform-origin)` (correct per AUDIT §3) or the `zoom-in-95`/`slide-in-from-*`/`fade-in-0` utilities.
- Do NOT touch `navigation-menu.tsx` (350ms — separate), `sheet.tsx`, `drawer.tsx`.
- Motion properties only — no structural/markup changes.
- If a listed file's class string doesn't contain `duration-100` + `animate-in` (drift), STOP and report.

## Verification

- **Mechanical**: `pnpm --dir /Users/lynse/Documents/lynse-app/lynse-desktop typecheck` + `pnpm lint`.
- **Feel check**: `pnpm dev:web`; DevTools → Animations panel at ~25%:
  - Open a popover, dropdown, tooltip, and a dialog — each should ease out (snappy start, gentle settle) at ~150ms (overlays) / ~200ms (dialog), not the old weak/100ms feel.
  - Inspect an open popover → computed `animation-timing-function` must resolve to `cubic-bezier(0.23, 1, 0.32, 1)` (proves Part A reached the animation through the cascade).
  - `transform-origin` still anchors to the trigger (unchanged).
- **Done when**: the global rule is in `base.css`; all listed class strings carry the new duration; computed `animation-timing-function` on an open popover equals the `--ease-out` curve.
