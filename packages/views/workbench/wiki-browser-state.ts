import { create } from "zustand";
import type { GraphCamera } from "./graph-scene-layout";

interface BrowseState {
  camera?: GraphCamera;
  selectedId: string | null;
  search: string;
}
interface WikiBrowserState {
  scope?: string;
  browse: BrowseState;
  setScope: (scope: string | undefined) => void;
  update: (patch: Partial<BrowseState>) => void;
}
export const useWikiBrowser = create<WikiBrowserState>((set, get) => ({
  browse: { selectedId: null, search: "" },
  setScope: scope => { if (get().scope !== scope) set({ scope, browse: { selectedId: null, search: "" } }); },
  update: patch => set(state => ({ browse: { ...state.browse, ...patch } })),
}));
