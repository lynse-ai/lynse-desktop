"use client";

import { create } from "zustand";

/** Where the edited audio goes on export. */
export type AudioEditorSaveMode = "overwrite" | "new";

/** A local audio handed to the editor from the notes page. */
export interface AudioEditorItem {
  /** `local:<uuid>` record id. */
  id: string;
  title: string;
  /** Recording start time — shown under the title in the trim header. */
  createdAt?: string;
}

interface AudioEditorState {
  /** Pending edit request; null until the user opens the editor. */
  request: { items: AudioEditorItem[]; defaultSaveMode?: AudioEditorSaveMode } | null;
  openEditor: (items: AudioEditorItem[], defaultSaveMode?: AudioEditorSaveMode) => void;
  clear: () => void;
}

export const useAudioEditorStore = create<AudioEditorState>((set) => ({
  request: null,
  openEditor: (items, defaultSaveMode) =>
    set({ request: { items, defaultSaveMode } }),
  clear: () => set({ request: null }),
}));
