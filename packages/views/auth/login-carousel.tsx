"use client";

import { useEffect, useState } from "react";
import { cn } from "@lynse/ui/lib/utils";

/** Crossfade dwell time per slide. */
const SLIDE_INTERVAL_MS = 5000;
/** Crossfade duration; keep in sync with the transition class below. */
const SLIDE_FADE_MS = 1000;

/**
 * Auto-advancing crossfade carousel for the web login page's right column.
 * Images are pre-inlined data URIs (login-carousel-artwork.ts), so every
 * slide is already in memory — no network, no layout shift; slides are
 * stacked full-bleed and faded via opacity.
 */
export function LoginCarousel({ images }: { images: string[] }) {
  const [active, setActive] = useState(0);

  useEffect(() => {
    if (images.length < 2) return;
    const timer = setInterval(
      () => setActive((i) => (i + 1) % images.length),
      SLIDE_INTERVAL_MS,
    );
    return () => clearInterval(timer);
  }, [images.length]);

  return (
    <div className="absolute inset-0 overflow-hidden">
      {images.map((src, i) => (
        <img
          key={i}
          src={src}
          alt=""
          className={cn(
            "absolute inset-0 h-full w-full select-none object-cover transition-opacity ease-in-out",
            i === active ? "opacity-100" : "opacity-0",
          )}
          style={{ transitionDuration: `${SLIDE_FADE_MS}ms` }}
        />
      ))}
    </div>
  );
}
