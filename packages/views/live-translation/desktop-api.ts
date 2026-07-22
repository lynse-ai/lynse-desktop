import type { DesktopLiveTranslationApi } from "./types";

export function getDesktopLiveTranslationApi(): DesktopLiveTranslationApi | null {
  if (typeof window === "undefined") return null;
  return (window as Window & {
    desktopAPI?: { liveTranslation?: DesktopLiveTranslationApi };
  }).desktopAPI?.liveTranslation ?? null;
}
