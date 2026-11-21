"use client";

import { useEffect, useState } from "react";
import { cn } from "@lynse/ui/lib/utils";
import type { LoginCarouselSlide } from "./login-carousel-artwork";

/** Crossfade dwell time per slide. */
const SLIDE_INTERVAL_MS = 5000;
/** Crossfade duration; keep in sync with the transition class below. */
const SLIDE_FADE_MS = 700;

/**
 * Notta-login-style carousel for the web login page's right column: a
 * rounded illustration card with a live-text title/description underneath
 * and clickable dot indicators (active dot = wide pill), the whole block
 * centered. Slides are stacked in one grid cell so the column height stays
 * stable while they crossfade; images are pre-inlined data URIs
 * (login-carousel-artwork.ts) — no network, no layout shift.
 */
export function LoginCarousel({ slides }: { slides: LoginCarouselSlide[] }) {
  const [active, setActive] = useState(0);

  useEffect(() => {
    if (slides.length < 2) return;
    const timer = setInterval(
      () => setActive((i) => (i + 1) % slides.length),
      SLIDE_INTERVAL_MS,
    );
    return () => clearInterval(timer);
  }, [slides.length]);

  return (
    <div className="flex w-full flex-col items-center">
      <div className="grid w-[min(91%,720px)] max-w-full">
        {slides.map((slide, i) => (
          <div
            key={i}
            aria-hidden={i !== active}
            className={cn(
              "col-start-1 row-start-1 flex flex-col transition-opacity ease-in-out",
              i === active
                ? "opacity-100"
                : "pointer-events-none opacity-0",
            )}
            style={{ transitionDuration: `${SLIDE_FADE_MS}ms` }}
          >
            <img
              src={slide.src}
              alt=""
              className="w-full select-none rounded-2xl object-cover shadow-sm ring-1 ring-black/5"
            />
            <h2 className="mt-9 text-center text-xl font-semibold tracking-tight">
              {slide.title}
            </h2>
            <p className="mt-3 max-w-md text-center text-sm leading-relaxed text-muted-foreground">
              {slide.description}
            </p>
          </div>
        ))}
      </div>

      {/* Dot indicators: click to jump; the auto-advance keeps cycling
          from whichever slide is active. */}
      <div className="mt-7 flex items-center gap-2">
        {slides.map((_, i) => (
          <button
            key={i}
            type="button"
            aria-label={`${i + 1} / ${slides.length}`}
            onClick={() => setActive(i)}
            className={cn(
              "h-1.5 rounded-full transition-all",
              i === active
                ? "w-4 bg-primary"
                : "w-1.5 bg-muted-foreground/25 hover:bg-muted-foreground/40",
            )}
          />
        ))}
      </div>
    </div>
  );
}
