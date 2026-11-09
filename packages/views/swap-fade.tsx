import { motion, useReducedMotion } from "motion/react";
import type { ReactNode } from "react";

/** The token curve (--ease-out), as motion's cubic-bezier array. */
const EASE_OUT: [number, number, number, number] = [0.23, 1, 0.32, 1];

interface SwapFadeProps {
  /**
   * Entry bridge for view/tab swaps that would otherwise teleport: content
   * fades (and rises 4px) over 150ms whenever it mounts or `viewKey` changes.
   * Entry-only — no exit animation, so the swap underneath stays instant.
   * Under reduced motion the rise drops and it is a pure cross-fade.
   */
  viewKey?: string;
  className?: string;
  children?: ReactNode;
}

export function SwapFade({ viewKey, className, children }: SwapFadeProps) {
  const reduceMotion = useReducedMotion();
  return (
    <motion.div
      key={viewKey}
      className={className}
      initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 4 }}
      animate={reduceMotion ? { opacity: 1 } : { opacity: 1, y: 0 }}
      transition={{ duration: 0.15, ease: EASE_OUT }}
    >
      {children}
    </motion.div>
  );
}
