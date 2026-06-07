import { create } from "zustand";
import type { ChatMessage, EditorMode, ItemType } from "./types";

const CHAT_PANEL_WIDTH_KEY = "lynse_chat_panel_width";
const FILE_LIST_WIDTH_KEY = "lynse_file_list_width";
const FOLDER_TREE_WIDTH_KEY = "lynse_folder_tree_width";

const DEFAULT_CHAT_PANEL_WIDTH = 340;
const DEFAULT_FILE_LIST_WIDTH = 240;
const DEFAULT_FOLDER_TREE_WIDTH = 220;

const MIN_CHAT_PANEL_WIDTH = 260;
const MAX_CHAT_PANEL_WIDTH = 500;
const MIN_FILE_LIST_WIDTH = 180;
const MAX_FILE_LIST_WIDTH = 400;
const MIN_FOLDER_TREE_WIDTH = 180;
const MAX_FOLDER_TREE_WIDTH = 320;

function loadNumber(key: string, fallback: number): number {
  if (typeof window === "undefined") return fallback;
  const raw = localStorage.getItem(key);
  return raw ? Number(raw) || fallback : fallback;
}

function saveNumber(key: string, value: number): void {
  if (typeof window !== "undefined") localStorage.setItem(key, String(value));
}

interface WorkspaceState {
  selectedItemId: string | null;
  selectedItemType: ItemType | null;
  selectedFolderId: string | null;
  searchQuery: string;
  collapsedGroups: Set<string>;
  editorMode: EditorMode;
  chatMessages: ChatMessage[];
  chatPanelVisible: boolean;
  chatPanelWidth: number;
  fileListWidth: number;
  folderTreeWidth: number;
  contentTab: "outline" | "summary" | "transcription";
  outlineSidebarVisible: boolean;

  selectItem: (id: string | null, type: ItemType | null) => void;
  selectFolder: (id: string | null) => void;
  setSearchQuery: (query: string) => void;
  toggleGroup: (group: string) => void;
  setEditorMode: (mode: EditorMode) => void;
  addChatMessage: (message: ChatMessage) => void;
  clearChat: () => void;
  toggleChatPanel: () => void;
  setContentTab: (tab: "outline" | "summary" | "transcription") => void;
  toggleOutlineSidebar: () => void;
  setChatPanelWidth: (width: number) => void;
  handleChatPanelResize: (delta: number) => void;
  handleFileListResize: (delta: number) => void;
  handleFolderTreeResize: (delta: number) => void;
}

let workspaceStoreInstance: ReturnType<typeof createWorkspaceStore> | null = null;

function createWorkspaceStore() {
  return create<WorkspaceState>()((set, get) => ({
    selectedItemId: null,
    selectedItemType: null,
    selectedFolderId: null,
    searchQuery: "",
    collapsedGroups: new Set<string>(),
    editorMode: "edit",
    chatMessages: [],
    chatPanelVisible: false,
    contentTab: "outline",
    outlineSidebarVisible: false,
    chatPanelWidth: loadNumber(CHAT_PANEL_WIDTH_KEY, DEFAULT_CHAT_PANEL_WIDTH),
    fileListWidth: loadNumber(FILE_LIST_WIDTH_KEY, DEFAULT_FILE_LIST_WIDTH),
    folderTreeWidth: loadNumber(FOLDER_TREE_WIDTH_KEY, DEFAULT_FOLDER_TREE_WIDTH),

    selectItem: (id, type) =>
      set({ selectedItemId: id, selectedItemType: type }),

    selectFolder: (id) =>
      set({ selectedFolderId: id, selectedItemId: null, selectedItemType: null }),

    setSearchQuery: (query) => set({ searchQuery: query }),

    toggleGroup: (group) =>
      set((state) => {
        const next = new Set(state.collapsedGroups);
        if (next.has(group)) next.delete(group);
        else next.add(group);
        return { collapsedGroups: next };
      }),

    setEditorMode: (mode) => set({ editorMode: mode }),

    addChatMessage: (message) =>
      set((state) => ({ chatMessages: [...state.chatMessages, message] })),

    clearChat: () => set({ chatMessages: [] }),

    toggleChatPanel: () =>
      set((state) => ({ chatPanelVisible: !state.chatPanelVisible })),

    setContentTab: (tab) => set({ contentTab: tab }),

    toggleOutlineSidebar: () =>
      set((state) => ({ outlineSidebarVisible: !state.outlineSidebarVisible })),

    setChatPanelWidth: (width) => {
      const clamped = Math.max(MIN_CHAT_PANEL_WIDTH, Math.min(MAX_CHAT_PANEL_WIDTH, width));
      saveNumber(CHAT_PANEL_WIDTH_KEY, clamped);
      set({ chatPanelWidth: clamped });
    },

    handleChatPanelResize: (delta) => {
      get().setChatPanelWidth(get().chatPanelWidth + delta);
    },

    handleFileListResize: (delta) => {
      const next = Math.max(MIN_FILE_LIST_WIDTH, Math.min(MAX_FILE_LIST_WIDTH, get().fileListWidth + delta));
      saveNumber(FILE_LIST_WIDTH_KEY, next);
      set({ fileListWidth: next });
    },

    handleFolderTreeResize: (delta) => {
      const next = Math.max(MIN_FOLDER_TREE_WIDTH, Math.min(MAX_FOLDER_TREE_WIDTH, get().folderTreeWidth + delta));
      saveNumber(FOLDER_TREE_WIDTH_KEY, next);
      set({ folderTreeWidth: next });
    },
  }));
}

function getStore() {
  if (!workspaceStoreInstance) {
    workspaceStoreInstance = createWorkspaceStore();
  }
  return workspaceStoreInstance;
}

export function useWorkspaceStore<T>(selector: (s: WorkspaceState) => T): T {
  return getStore()(selector);
}
