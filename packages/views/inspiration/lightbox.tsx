"use client";

import { useCallback, useEffect } from "react";
import { AnimatePresence, motion } from "motion/react";
import { cn } from "@lynse/ui/lib/utils";
import { ChevronLeft, ChevronRight, X } from "../icons";

/** One entry in the lightbox: a saved record image or a staged preview URL. */
export type LightboxSlide = {
  /** `local-media://` URL of the image. */
  url: string;
  label?: string;
};

/**
 * Fullscreen image viewer: dark backdrop, centered picture, arrow/dot
 * navigation for multiple images, keyboard ←/→/Esc, click-outside to close.
 */
export function InspirationLightbox({
  slides,
  index,
  onIndexChange,
  onClose,
}: {
  slides: LightboxSlide[];
  index: number | null;
  onIndexChange: (index: number) => void;
  onClose: () => void;
}) {
  const open = index !== null && slides.length > 0;
  const current = open ? slides[Math.min(index, slides.length - 1)] : null;

  const step = useCallback(
    (delta: number) => {
      if (!open || slides.length < 2) return;
      onIndexChange(((index ?? 0) + delta + slides.length) % slides.length);
    },
    [index, onIndexChange, open, slides.length],
  );

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
      else if (event.key === "ArrowLeft") step(-1);
      else if (event.key === "ArrowRight") step(1);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose, open, step]);

  return (
    <AnimatePresence>
      {open && current && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.16 }}
          className="fixed inset-0 z-[90] flex items-center justify-center bg-black/80 backdrop-blur-sm"
          onClick={onClose}
        >
          <button
            type="button"
            title="Close"
            onClick={onClose}
            className="absolute right-4 top-4 rounded-full bg-white/10 p-2 text-white/90 transition-colors hover:bg-white/20"
          >
            <X className="size-4" />
          </button>

          {slides.length > 1 && (
            <>
              <button
                type="button"
                title="Previous"
                onClick={(event) => {
                  event.stopPropagation();
                  step(-1);
                }}
                className="absolute left-4 top-1/2 -translate-y-1/2 rounded-full bg-white/10 p-2 text-white/90 transition-colors hover:bg-white/20"
              >
                <ChevronLeft className="size-5" />
              </button>
              <button
                type="button"
                title="Next"
                onClick={(event) => {
                  event.stopPropagation();
                  step(1);
                }}
                className="absolute right-4 top-1/2 -translate-y-1/2 rounded-full bg-white/10 p-2 text-white/90 transition-colors hover:bg-white/20"
              >
                <ChevronRight className="size-5" />
              </button>
            </>
          )}

          <motion.img
            key={current.url}
            initial={{ opacity: 0, scale: 0.97 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ duration: 0.16 }}
            src={current.url}
            alt={current.label ?? ""}
            onClick={(event) => event.stopPropagation()}
            className="max-h-[88vh] max-w-[88vw] rounded-lg object-contain shadow-2xl outline outline-1 -outline-offset-1 outline-white/10"
          />

          {slides.length > 1 && (
            <div className="absolute bottom-5 left-1/2 flex -translate-x-1/2 gap-1.5">
              {slides.map((slide, slideIndex) => (
                <button
                  key={slide.url}
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation();
                    onIndexChange(slideIndex);
                  }}
                  className={cn(
                    "h-1.5 rounded-full transition-[width,background-color]",
                    slideIndex === index ? "w-4 bg-white" : "w-1.5 bg-white/40 hover:bg-white/70",
                  )}
                />
              ))}
            </div>
          )}
        </motion.div>
      )}
    </AnimatePresence>
  );
}
