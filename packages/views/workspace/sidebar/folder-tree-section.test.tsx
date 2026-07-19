/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { FolderTreeSection } from "./folder-tree-section";

const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  selectFolder: vi.fn(),
  state: {
    selectedFolderId: null,
    sidebarSectionsCollapsed: new Set<string>(),
    editingFolderId: null,
    selectFolder: vi.fn(),
    toggleSidebarSection: vi.fn(),
    setEditingFolderId: vi.fn(),
  },
}));

mocks.state.selectFolder = mocks.selectFolder;

vi.mock("../../navigation", () => ({
  useNavigation: () => ({ push: mocks.push }),
}));

vi.mock("@lynse/core/i18n/react", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("@dnd-kit/core", () => ({
  useDroppable: () => ({ setNodeRef: vi.fn(), isOver: false }),
}));

vi.mock("@lynse/ui/components/ui/sidebar", () => ({
  SidebarGroup: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SidebarGroupContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock("../hooks/use-folders", () => ({
  useFolders: () => ({ data: [] }),
}));

vi.mock("../hooks/use-folder-counts", () => ({
  useFolderCounts: () => ({ data: { all: 0, unclassified: 0, folderStats: [] } }),
}));

vi.mock("../hooks/use-files", () => ({
  useFiles: () => ({ data: [] }),
}));

vi.mock("../hooks/use-folder-mutations", () => ({
  useCreateFolder: () => ({ mutate: vi.fn() }),
  useEditFolder: () => ({ mutate: vi.fn() }),
}));

vi.mock("../store", () => ({
  useWorkspaceStore: (selector: (state: typeof mocks.state) => unknown) => selector(mocks.state),
  getWorkspaceState: () => mocks.state,
}));

vi.mock("./folder-context-menu", () => ({
  FolderContextMenu: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

afterEach(() => {
  cleanup();
  mocks.push.mockClear();
  mocks.selectFolder.mockClear();
});

describe("FolderTreeSection", () => {
  it("returns to the workspace when a persistent sidebar folder is selected", () => {
    render(<FolderTreeSection />);

    fireEvent.click(screen.getByText("layout.all_files"));

    expect(mocks.selectFolder).toHaveBeenCalledWith("__all__");
    expect(mocks.push).toHaveBeenCalledWith("/recordings");
  });
});
