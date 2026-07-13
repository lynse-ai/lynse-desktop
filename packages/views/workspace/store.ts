import { create } from "zustand";
import type { ChatMessage, EditorMode, ItemType } from "./types";

const CHAT_PANEL_WIDTH_KEY = "lynse_chat_panel_width";
const FILE_LIST_WIDTH_KEY = "lynse_file_list_width";
const FOLDER_TREE_WIDTH_KEY = "lynse_folder_tree_width";
const NOTE_TABS_KEY = "lynse_note_tabs";

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

export interface NoteTab {
  id: string;
  title: string;
}

function loadNoteTabs(): NoteTab[] {
  if (typeof window === "undefined") return [];
  const raw = localStorage.getItem(NOTE_TABS_KEY);
  if (!raw) return [];
  try { return JSON.parse(raw); } catch { return []; }
}

function saveNoteTabs(tabs: NoteTab[]) {
  if (typeof window !== "undefined") localStorage.setItem(NOTE_TABS_KEY, JSON.stringify(tabs));
}

type ContentTab = "outline" | "transcription" | `summary-${number}` | `note-${string}`;
type FileSortField = "updatedAt" | "createdAt";
type FileSortDir = "desc" | "asc";

interface WorkspaceState {
  selectedItemId: string | null;
  selectedItemType: ItemType | null;
  selectedItemTitle: string | null;
  selectedFolderId: string | null;
  searchQuery: string;
  collapsedGroups: Set<string>;
  editorMode: EditorMode;
  chatMessages: ChatMessage[];
  chatPanelVisible: boolean;
  chatPanelWidth: number;
  fileListWidth: number;
  folderTreeWidth: number;
  contentTab: ContentTab;
  outlineSidebarVisible: boolean;
  sourceViewVisible: boolean;
  noteTabs: NoteTab[];
  fileSortField: FileSortField;
  fileSortDir: FileSortDir;
  summarizingFileIds: Set<string>;

  // Sidebar directory state
  sidebarSectionsCollapsed: Set<string>;
  sidebarSearchQuery: string;
  editingFolderId: string | null;
  draggingFileIds: Set<string>;

  selectItem: (id: string | null, type: ItemType | null, title?: string | null) => void;
  selectFolder: (id: string | null) => void;
  setSearchQuery: (query: string) => void;
  toggleGroup: (group: string) => void;
  setEditorMode: (mode: EditorMode) => void;
  addChatMessage: (message: ChatMessage) => void;
  clearChat: () => void;
  toggleChatPanel: () => void;
  setContentTab: (tab: ContentTab) => void;
  toggleOutlineSidebar: () => void;
  toggleSourceView: () => void;
  toggleFileSortField: () => void;
  toggleFileSortDir: () => void;
  setChatPanelWidth: (width: number) => void;
  handleChatPanelResize: (delta: number) => void;
  handleFileListResize: (delta: number) => void;
  handleFolderTreeResize: (delta: number) => void;
  addNoteTab: () => void;
  removeNoteTab: (id: string) => void;
  setFileSummarizing: (fileId: string, summarizing: boolean) => void;

  // Sidebar directory actions
  toggleSidebarSection: (section: string) => void;
  setSidebarSearchQuery: (query: string) => void;
  setEditingFolderId: (id: string | null) => void;
  setDraggingFileIds: (ids: Set<string>) => void;
}

let workspaceStoreInstance: ReturnType<typeof createWorkspaceStore> | null = null;

function createWorkspaceStore() {
  return create<WorkspaceState>()((set, get) => ({
    selectedItemId: null,
    selectedItemType: null,
    selectedItemTitle: null,
    selectedFolderId: null,
    searchQuery: "",
    collapsedGroups: new Set<string>(),
    editorMode: "edit",
    chatMessages: [],
    chatPanelVisible: false,
    contentTab: "outline",
    outlineSidebarVisible: false,
    sourceViewVisible: false,
    noteTabs: loadNoteTabs(),
    fileSortField: "createdAt" as FileSortField,
    fileSortDir: "desc" as FileSortDir,
    summarizingFileIds: new Set<string>(),
    chatPanelWidth: loadNumber(CHAT_PANEL_WIDTH_KEY, DEFAULT_CHAT_PANEL_WIDTH),
    fileListWidth: loadNumber(FILE_LIST_WIDTH_KEY, DEFAULT_FILE_LIST_WIDTH),
    folderTreeWidth: loadNumber(FOLDER_TREE_WIDTH_KEY, DEFAULT_FOLDER_TREE_WIDTH),

    // Sidebar directory state
    sidebarSectionsCollapsed: new Set<string>(),
    sidebarSearchQuery: "",
    editingFolderId: null,
    draggingFileIds: new Set<string>(),

    selectItem: (id, type, title = null) =>
      set({ selectedItemId: id, selectedItemType: type, selectedItemTitle: id ? title : null }),

    selectFolder: (id) =>
      set({ selectedFolderId: id, selectedItemId: null, selectedItemType: null, selectedItemTitle: null }),

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

    toggleSourceView: () =>
      set((state) => ({ sourceViewVisible: !state.sourceViewVisible })),

    toggleFileSortField: () =>
      set((state) => ({
        fileSortField: state.fileSortField === "createdAt" ? "updatedAt" : "createdAt",
      })),

    toggleFileSortDir: () =>
      set((state) => ({
        fileSortDir: state.fileSortDir === "desc" ? "asc" : "desc",
      })),

    addNoteTab: () => {
      const id = Date.now().toString(36);
      const tabs = [...get().noteTabs, { id, title: `笔记 ${get().noteTabs.length + 1}` }];
      saveNoteTabs(tabs);
      set({ noteTabs: tabs, contentTab: `note-${id}` as ContentTab });
    },

    removeNoteTab: (id) => {
      const tabs = get().noteTabs.filter((t) => t.id !== id);
      saveNoteTabs(tabs);
      const current = get().contentTab;
      const updates: Partial<WorkspaceState> = { noteTabs: tabs };
      if (current === `note-${id}`) {
        updates.contentTab = tabs.length > 0 ? (`note-${tabs[0]!.id}` as ContentTab) : "outline";
      }
      set(updates);
    },

    setFileSummarizing: (fileId, summarizing) =>
      set((state) => {
        const next = new Set(state.summarizingFileIds);
        if (summarizing) next.add(fileId);
        else next.delete(fileId);
        return { summarizingFileIds: next };
      }),

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

    // Sidebar directory actions
    toggleSidebarSection: (section) =>
      set((state) => {
        const next = new Set(state.sidebarSectionsCollapsed);
        if (next.has(section)) next.delete(section);
        else next.add(section);
        return { sidebarSectionsCollapsed: next };
      }),

    setSidebarSearchQuery: (query) => set({ sidebarSearchQuery: query }),

    setEditingFolderId: (id) => set({ editingFolderId: id }),

    setDraggingFileIds: (ids) => set({ draggingFileIds: ids }),
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

/** Access workspace store state outside of React (e.g., in callbacks). */
export function getWorkspaceState(): WorkspaceState {
  return getStore().getState();
}
