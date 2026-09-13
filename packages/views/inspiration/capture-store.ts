"use client";

import { create } from "zustand";

/** Input mode of the capture sheet: a plain flash note or a quick todo. */
export type CaptureMode = "note" | "todo";

/**
 * Open/close state (and input mode) of the inspiration capture sheet. Lives
 * in a store so the sidebar icon and the home quick-capture bar can pop the
 * sheet from any page — pre-set to note or todo — without prop drilling
 * through the layout.
 */
type InspirationCaptureState = {
  open: boolean;
  /** Mode the sheet was last opened in; reset to note on close. */
  mode: CaptureMode;
  /** When set, the sheet edits that record instead of composing a new one. */
  editId: string | null;
  openCapture: (mode?: CaptureMode) => void;
  /** Open the sheet as an editor for an existing record (same composer). */
  openEdit: (id: string) => void;
  closeCapture: () => void;
};

export const useInspirationCaptureStore = create<InspirationCaptureState>((set) => ({
  open: false,
  mode: "note",
  editId: null,
  openCapture: (mode = "note") => set({ open: true, mode, editId: null }),
  openEdit: (id) => set({ open: true, mode: "note", editId: id }),
  closeCapture: () => set({ open: false, mode: "note", editId: null }),
}));
