"use client";

import { create } from "zustand";

interface NavigationState {
  lastPath: string | null;
  onPathChange: (path: string) => void;
}

export const useNavigationStore = create<NavigationState>()((set) => ({
  lastPath: null,
  onPathChange: (path: string) => {
    set({ lastPath: path });
  },
}));
