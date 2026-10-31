import { cn } from "../../lib/utils";

// Visual reference: zai-org/ZCode's ChatLoadingPixels. This SVG and its
// opacity-only animation are implemented locally; see docs/assistant-activity-motion.md.
const PIXELS = [[0, 0], [5, 0], [10, 0], [10, 5], [10, 10], [5, 10], [0, 10], [0, 5]] as const;

/** A quiet, clockwise activity signal that does not move the surrounding text. */
export function ActivityIndicator({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 13 13"
      className={cn("size-3.5 shrink-0", className)}
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
      data-slot="activity-indicator"
    >
      {PIXELS.map(([x, y], phase) => (
        <rect
          key={phase}
          x={x}
          y={y}
          width="3"
          height="3"
          rx="0.6"
          className="activity-pixel"
          style={{ animationDelay: `${-960 + phase * 120}ms` }}
        />
      ))}
      <rect x="5" y="5" width="3" height="3" rx="0.6" opacity="0.12" />
    </svg>
  );
}

/** The highlight moves over stationary text; assistive technology reads it once. */
export function ActivityLabel({ text, className }: { text: string; className?: string }) {
  return (
    <span className={cn("activity-label", className)}>
      {text}
      <span className="activity-label-highlight" data-text={text} aria-hidden="true" />
    </span>
  );
}
