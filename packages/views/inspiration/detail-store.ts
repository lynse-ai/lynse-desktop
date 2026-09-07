"use client";

import { create } from "zustand";

/**
 * Which inspiration the detail dialog is showing (null = closed). Lives in a
 * store so any card — masonry or list — can open the dialog without lifting
 * state through the page.
 */
type InspirationDetailState = {
  activeId: string | null;
  openDetail: (id: string) => void;
  closeDetail: () => void;
};

export const useInspirationDetailStore = create<InspirationDetailState>((set) => ({
  activeId: null,
  openDetail: (id) => set({ activeId: id }),
  closeDetail: () => set({ activeId: null }),
}));
