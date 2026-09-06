"use client";

import type { DesktopInspirationApi } from "./types";

/** Desktop bridge accessor; returns null on web where the feature degrades. */
export function getDesktopInspirationApi(): DesktopInspirationApi | null {
  if (typeof window === "undefined") return null;
  return (
    (window as Window & {
      desktopAPI?: { inspiration?: DesktopInspirationApi };
    }).desktopAPI?.inspiration ?? null
  );
}
