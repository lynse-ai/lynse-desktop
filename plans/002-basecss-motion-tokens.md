# 002 — Consolidate base.css keyframe easings onto motion tokens

- **Status**: TODO
- **Commit**: 2880b1d2 (refs are against the current working tree)
- **Severity**: LOW
- **Category**: Cohesion & tokens (AUDIT §7) / Easing (AUDIT §2)
- **Estimated scope**: 1 file (`packages/ui/styles/base.css`), 6 easing values changed

## Problem

The bespoke keyframes in `packages/ui/styles/base.css` use six distinct hand-typed easing curves; `cubic-bezier(0.4, 0, 0.2, 1)` is typed verbatim at both `:59` and `:149`, and entrances use weak CSS keywords (`ease-out`, `ease`). Motion tokens now exist (`--ease-out`, `--ease-in-out` in `packages/ui/styles/tokens.css` `@theme`), and `floating-toolbar-enter` (`:232`) already proves the pattern. AUDIT §7: "Five hand-typed cubic-beziers that almost match is a consolidation finding." AUDIT §2: "Built-in CSS easings are too weak for deliberate motion."

Current (verbatim):

```css
/* packages/ui/styles/base.css:25  */ .animate-entrance-spin     { animation: entrance-spin 0.6s ease-out forwards; }
/* packages/ui/styles/base.css:45  */ .animate-onboarding-enter  { animation: onboarding-enter 0.4s ease both; }
/* packages/ui/styles/base.css:59  */ .animate-welcome-emoji-pop { animation: welcome-emoji-pop 0.7s cubic-bezier(0.4, 0, 0.2, 1) both; }
/* packages/ui/styles/base.css:86  */ .animate-completion-check  { animation: completion-check 400ms ease-out 350ms both; }
/* packages/ui/styles/base.css:104 */ .animate-chat-impulse      { animation: chat-impulse 1.6s ease-in-out infinite; }
/* packages/ui/styles/base.css:149 */ .animate-nav-progress-sweep{ animation: nav-progress-sweep 1.4s cubic-bezier(0.4, 0, 0.2, 1) infinite; }
```

## Target

```css
.animate-entrance-spin      { animation: entrance-spin 0.6s var(--ease-out) forwards; }
.animate-onboarding-enter   { animation: onboarding-enter 0.4s var(--ease-out) both; }
.animate-welcome-emoji-pop  { animation: welcome-emoji-pop 0.7s var(--ease-out) both; }
.animate-completion-check   { animation: completion-check 400ms var(--ease-out) 350ms both; }
.animate-chat-impulse       { animation: chat-impulse 1.6s var(--ease-in-out) infinite; }
.animate-nav-progress-sweep { animation: nav-progress-sweep 1.4s linear infinite; }
```

Keep unchanged:
- `.animate-completion-badge` (`:73`, `cubic-bezier(0.5, 1.5, 0.4, 1)`) — a deliberately unique overshoot for a rare celebration; do not collapse.
- `.animate-chat-text-shimmer` (`:135`, `linear`) and `.border-beam-rotate` (`:197`, `linear`) — correct for constant motion (AUDIT §2 decision table).
- `.floating-toolbar` (`:232`) — already tokenized.

Note: `--ease-out` is a stronger curve than CSS `ease-out`, so entrances become slightly snappier. This is the intended AUDIT §2 improvement — feel-check each.

## Repo conventions to follow

- Tokens: `--ease-out: cubic-bezier(0.23, 1, 0.32, 1)`, `--ease-in-out: cubic-bezier(0.77, 0, 0.175, 1)` in `packages/ui/styles/tokens.css` `@theme` (imported before `base.css` in `apps/web/app/globals.css:4-5`).
- Exemplar: `.floating-toolbar` at `packages/ui/styles/base.css:232` — `animation: floating-toolbar-enter var(--duration-quick) var(--ease-out);`.

## Steps

1. In `packages/ui/styles/base.css`, replace only the easing token on lines 25, 45, 59, 86, 104, 149 as shown. Leave every duration and the `350ms` delay on `:86` untouched. Change `:149`'s curve to `linear`.

## Boundaries

- Do NOT change any duration or the `animation-delay` on `completion-check`.
- Do NOT touch `completion-badge`, `chat-text-shimmer`, `border-beam`, `floating-toolbar`.
- Do NOT edit `tokens.css`.
- If a line doesn't match its excerpt (drift), STOP and report.

## Verification

- **Mechanical**: `pnpm --dir /Users/lynse/Documents/lynse-app/lynse-desktop typecheck`.
- **Feel check**: `pnpm dev:web`; DevTools → Animations panel at 10%:
  - Onboarding step entry, completion checkmark draw, welcome emoji — confirm they ease out (fast start, gentle settle), not the old weak curve.
  - Chat FAB impulse while a task runs — confirm an ease-in-out pulse.
  - Nav progress sweep — confirm it is now linear (constant).
- **Done when**: all six keyframes reference the token/`linear`; this grep returns nothing except the kept `completion-badge` literal:
  `grep -nE 'ease-out|ease-in-out|cubic-bezier\(0\.4, 0, 0\.2, 1\)| ease ' packages/ui/styles/base.css`
