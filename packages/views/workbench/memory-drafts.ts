import { create } from "zustand";

export interface MemoryDraft {
  markdown: string;
  original: string;
  revision: string;
}

// Drafts survive navigation, but never leave this renderer's memory.
export const useMemoryDrafts = create<{
  drafts: Record<string, MemoryDraft>;
  set(key: string, draft: MemoryDraft): void;
  remove(key: string): void;
  clear(): void;
}>((set) => ({
  drafts: {},
  set: (key, draft) => set((state) => ({ drafts: { ...state.drafts, [key]: draft } })),
  remove: (key) => set((state) => {
    const drafts = { ...state.drafts };
    delete drafts[key];
    return { drafts };
  }),
  clear: () => set({ drafts: {} }),
}));
