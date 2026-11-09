import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import type { ReactNode } from "react";
import type { Transition } from "motion/react";

/**
 * The one panel-squeeze recipe shared by every side panel that squeezes the
 * content beside it (workspace/notes/todo chat and edit panels,
 * live-translation rails): width and opacity ride the same 300ms zero-bounce
 * spring; while resizing or under reduced motion it snaps (duration 0). The
 * panel clips a fixed-width child via overflow-hidden so its content never
 * reflows mid-animation.
 */
export const PANEL_SQUEEZE_SPRING: Transition = {
  type: "spring",
  bounce: 0,
  duration: 0.3,
};

interface SqueezePanelProps {
  open: boolean;
  /** Panel width in px once fully open. */
  width: number;
  /** True while the user drags the panel's resize handle — motion snaps. */
  resizing?: boolean;
  /** Host element; "aside" for rails that are landmark content. */
  element?: "div" | "aside";
  className?: string;
  children?: ReactNode;
}

export function SqueezePanel({
  open,
  width,
  resizing = false,
  element = "div",
  className,
  children,
}: SqueezePanelProps) {
  const reduceMotion = useReducedMotion();
  const Panel = element === "aside" ? motion.aside : motion.div;
  return (
    <AnimatePresence initial={false}>
      {open && (
        <Panel
          initial={{ width: 0, opacity: 0 }}
          animate={{ width, opacity: 1 }}
          exit={{ width: 0, opacity: 0 }}
          transition={
            resizing || reduceMotion ? { duration: 0 } : PANEL_SQUEEZE_SPRING
          }
          className={`flex shrink-0 overflow-hidden${className ? ` ${className}` : ""}`}
        >
          {children}
        </Panel>
      )}
    </AnimatePresence>
  );
}
