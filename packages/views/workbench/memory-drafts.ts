import { create } from "zustand";

export interface MemoryDraft {
  markdown: string;
  original: string;
  revision: string;
}

// Drafts survive navigation, but never leave this renderer's memory.
export const useMemoryDrafts = create<{
  drafts: Record<string, MemoryDraft>;
  selectedPaths: Record<string, string>;
  select(scope: string, path: string): void;
  set(key: string, draft: MemoryDraft): void;
  remove(key: string): void;
  clear(): void;
}>((set) => ({
  drafts: {},
  selectedPaths: {},
  select: (scope, path) => set((state) => ({ selectedPaths: { ...state.selectedPaths, [scope]: path } })),
  set: (key, draft) => set((state) => ({ drafts: { ...state.drafts, [key]: draft } })),
  remove: (key) => set((state) => {
    const drafts = { ...state.drafts };
    delete drafts[key];
    return { drafts };
  }),
  clear: () => set({ drafts: {}, selectedPaths: {} }),
}));
