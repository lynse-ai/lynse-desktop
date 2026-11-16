"use client";

import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { defaultStorage } from "@lynse/core/platform";
import { getDesktopLiveTranslationApi } from "../live-translation/desktop-api";

interface IslandPreferences {
  /** Notch-attached "Dynamic Island" style for the recording island (default
   * on; displays without a cutout always fall back to the floating pill). */
  notchIslandEnabled: boolean;
  setNotchIslandEnabled: (enabled: boolean) => void;
}

/** Applies the preference to the Rust executor. Rust never persists the flag
 * itself — this store is the source of truth, so every app launch (and every
 * toggle) re-applies it. No-op outside the desktop app. */
export function syncNotchIslandPreference(enabled: boolean): void {
  void getDesktopLiveTranslationApi()
    ?.setNotchIsland(enabled)
    .catch(() => {});
}

export const useIslandPreferences = create<IslandPreferences>()(
  persist(
    (set) => ({
      notchIslandEnabled: true,
      setNotchIslandEnabled: (enabled) => {
        set({ notchIslandEnabled: enabled });
        syncNotchIslandPreference(enabled);
      },
    }),
    {
      name: "lynse_island_preferences_v1",
      storage: createJSONStorage(() => defaultStorage),
      partialize: (state) => ({ notchIslandEnabled: state.notchIslandEnabled }),
    },
  ),
);
