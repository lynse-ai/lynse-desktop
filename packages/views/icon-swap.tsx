import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import type { ReactNode } from "react";

import { cn } from "@lynse/ui/lib/utils";

/**
 * Cross-fades an icon when its state changes (play/pause, busy spinner
 * swaps, copy/check). Keeps the exiting icon in the DOM until the enter
 * finishes, so both directions animate. Wrap only state-change icons —
 * static or decorative icons stay unmounted normally.
 */
export function IconSwap({
  stateKey,
  children,
  className,
}: {
  /** Identity of the current state; changing it triggers the swap. */
  stateKey: string;
  children: ReactNode;
  className?: string;
}) {
  const reduceMotion = useReducedMotion();

  return (
    <span
      className={cn(
        "relative inline-flex items-center justify-center",
        className,
      )}
    >
      <AnimatePresence initial={false} mode="popLayout">
        <motion.span
          key={stateKey}
          className="inline-flex items-center justify-center"
          initial={
            reduceMotion
              ? false
              : { opacity: 0, scale: 0.25, filter: "blur(4px)" }
          }
          animate={{ opacity: 1, scale: 1, filter: "blur(0px)" }}
          exit={
            reduceMotion
              ? { opacity: 0 }
              : { opacity: 0, scale: 0.25, filter: "blur(4px)" }
          }
          transition={
            reduceMotion
              ? { duration: 0 }
              : { type: "spring", duration: 0.3, bounce: 0 }
          }
        >
          {children}
        </motion.span>
      </AnimatePresence>
    </span>
  );
}
