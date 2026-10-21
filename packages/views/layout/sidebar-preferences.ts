"use client";

import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { defaultStorage } from "@lynse/core/platform";

interface SidebarPreferences {
  pinnedItems: string[];
  togglePin: (key: string) => void;
}

export const useSidebarPreferences = create<SidebarPreferences>()(
  persist(
    (set) => ({
      pinnedItems: [],
      togglePin: (key) => set((state) => ({
        pinnedItems: state.pinnedItems.includes(key)
          ? state.pinnedItems.filter((item) => item !== key)
          : [...state.pinnedItems, key],
      })),
    }),
    {
      name: "lynse_sidebar_preferences_v1",
      storage: createJSONStorage(() => defaultStorage),
      partialize: (state) => ({ pinnedItems: state.pinnedItems }),
      skipHydration: true,
      merge: (persisted, current) => {
        const saved = (persisted as Partial<SidebarPreferences> | undefined)?.pinnedItems;
        return {
          ...current,
          pinnedItems: Array.isArray(saved)
            ? [...new Set(saved.filter((key): key is string => typeof key === "string"))]
            : [],
        };
      },
    },
  ),
);
