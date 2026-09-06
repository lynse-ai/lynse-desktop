"use client";

import { create } from "zustand";

/**
 * Open/close state of the inspiration capture sheet. Lives in a store so the
 * sidebar icon can pop the sheet from any page, and the /inspiration page can
 * re-open it, without prop drilling through the layout.
 */
type InspirationCaptureState = {
  open: boolean;
  openCapture: () => void;
  closeCapture: () => void;
};

export const useInspirationCaptureStore = create<InspirationCaptureState>((set) => ({
  open: false,
  openCapture: () => set({ open: true }),
  closeCapture: () => set({ open: false }),
}));
