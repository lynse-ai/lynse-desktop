"use client";

import { create } from "zustand";

/** A local audio handed to the editor from the notes page. */
export interface AudioEditorItem {
  /** `local:<uuid>` record id. */
  id: string;
  title: string;
}

interface AudioEditorState {
  /** Pending edit request; null until the user opens the editor. */
  request: { items: AudioEditorItem[] } | null;
  openEditor: (items: AudioEditorItem[]) => void;
  clear: () => void;
}

export const useAudioEditorStore = create<AudioEditorState>((set) => ({
  request: null,
  openEditor: (items) => set({ request: { items } }),
  clear: () => set({ request: null }),
}));
