/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { NotesPage } from "./page";
import { getWorkspaceState } from "../workspace/store";

/**
 * The page mounts UploadDialog (whose hooks need the query context), so
 * render through the same provider stack the app shell supplies.
 */
function renderNotesPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <NotesPage />
    </QueryClientProvider>,
  );
}

const testData = vi.hoisted(() => ({
  files: [
    {
      id: "f1",
      title: "Note One",
      createdAt: "2026-09-01T10:00:00",
      updatedAt: "2026-09-01T10:00:00",
    },
    {
      id: "f2",
      title: "Note Two",
      createdAt: "2026-09-02T10:00:00",
      updatedAt: "2026-09-02T10:00:00",
    },
    {
      id: "f3",
      title: "Note Three",
      createdAt: "2026-09-03T10:00:00",
      updatedAt: "2026-09-03T10:00:00",
    },
  ],
  menuProps: [] as Array<{
    targetIds: string[];
    onDelete?: (ids: string[]) => void;
    onTranscribe?: (ids: string[]) => void;
  }>,
  deleteMutate: vi.fn(),
  rerunMutate: vi.fn(),
}));

vi.mock("@lynse/core/i18n/react", () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) =>
      params ? `${key}:${JSON.stringify(params)}` : key,
    i18n: { language: "en" },
  }),
}));

vi.mock("@lynse/core/auth", () => ({
  useAuthStore: (selector: (state: { isAuthenticated: boolean }) => unknown) =>
    selector({ isAuthenticated: true }),
}));

vi.mock("../workspace/hooks/use-files", () => ({
  useNotes: () => ({ data: testData.files }),
  useDeleteWorkspaceFiles: () => ({ mutate: testData.deleteMutate }),
  useTranscriptionStatus: () => ({ data: undefined }),
  useRerunSummary: () => ({ mutateAsync: testData.rerunMutate }),
  // Used by the header's UploadDialog; never triggered by these tests.
  useTransferFile: () => ({ mutate: vi.fn(), mutateAsync: vi.fn() }),
  waitForTranscriptionCompletion: vi.fn(),
  uploadFileToOSS: vi.fn(),
  // A default template so the batch-transcribe action is enabled.
  useTemplateCategories: () => ({
    data: [{ templates: [{ id: "tpl-1", isDefault: 1 }] }],
  }),
  isTranscriptionCompleted: () => false,
}));

vi.mock("../workspace/hooks/use-folder-mutations", () => ({
  useMoveFiles: () => ({ mutate: vi.fn() }),
}));

vi.mock("../workspace/hooks/use-folders", () => ({
  useFolders: () => ({ data: [] }),
}));

vi.mock("../workspace/local-transcription", () => ({
  LOCAL_TRANSCRIPTION_FOLDER_ID: "__local_transcriptions__",
  isLocalFileId: (id: string | null | undefined) =>
    typeof id === "string" && id.startsWith("local-"),
  // UploadDialog dependency; the dialog never opens in these tests.
  getDesktopLocalTranscriptionApi: () => null,
  OFFLINE_TRANSCRIPTION_ENABLED_KEY: "lynse_offline_transcription_enabled",
  resolveSttProvider: () => null,
  findModelStatus: () => undefined,
}));

vi.mock("../workspace/note-vault", () => ({
  getDesktopVaultApi: () => null,
  markVaultLastSync: () => {},
  syncAllNotesToVault: vi.fn(),
  useVaultConfig: () => ({ data: null }),
}));

vi.mock("../workspace/middle-panel/file-row-context-menu", () => ({
  FileRowContextMenu: (props: {
    targetIds: string[];
    onDelete?: (ids: string[]) => void;
    onTranscribe?: (ids: string[]) => void;
    children: React.ReactNode;
  }) => {
    testData.menuProps.push(props);
    return <>{props.children}</>;
  },
}));

vi.mock("../workspace/content-panel", () => ({ ContentPanel: () => <div /> }));
vi.mock("../workspace/right-panel/chat-panel", () => ({ ChatPanel: () => <div /> }));
vi.mock("../workspace/resizable-handle", () => ({ ResizableHandle: () => <div /> }));
vi.mock("../layout/title-bar", () => ({ TitleBar: () => <div /> }));
// The audio-editor entry navigates to /audio-editor; these tests never
// trigger it, so a stub navigation context is enough.
vi.mock("../navigation", () => ({
  useNavigation: () => ({ push: vi.fn(), pathname: "/notes" }),
}));

vi.mock("motion/react", async () => {
  const { createElement } = await import("react");
  return {
    motion: new Proxy(
      {},
      {
        get: (_target, tag: string) => (props: Record<string, unknown>) => {
          // Strip motion-only props so React doesn't warn about unknown DOM attributes.
          const { initial, animate, exit, transition, ...rest } = props;
          void initial;
          void animate;
          void exit;
          void transition;
          return createElement(tag, rest);
        },
      },
    ),
    AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    useReducedMotion: () => false,
  };
});

const SELECTED_COUNT = (count: number) =>
  `workspace.selected_count:${JSON.stringify({ count })}`;

/** Long-press the row for `title` to enter multi-select with that row checked. */
function longPressRow(title: string) {
  const row = screen.getByText(title).closest("button")!;
  fireEvent.pointerDown(row, { button: 0 });
  act(() => {
    vi.advanceTimersByTime(400);
  });
  fireEvent.pointerUp(row);
  // The click fired right after a long-press must be suppressed, not open the note.
  fireEvent.click(row);
}

beforeEach(() => {
  vi.useFakeTimers();
  getWorkspaceState().selectFolder("__all__");
  getWorkspaceState().clearFileSelection();
  testData.menuProps.length = 0;
  testData.deleteMutate.mockReset();
  testData.rerunMutate.mockReset();
  testData.rerunMutate.mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("NotesPage multi-select", () => {
  it("enters multi-select after a long-press and toggles rows on click", () => {
    renderNotesPage();

    longPressRow("Note One");

    expect(
      screen.getByText(SELECTED_COUNT(1), { exact: false }),
    ).toBeDefined();

    // A plain click on another row now toggles it instead of opening the note.
    fireEvent.click(screen.getByText("Note Two").closest("button")!);
    expect(screen.getByText(SELECTED_COUNT(2), { exact: false })).toBeDefined();

    // Clicking a selected row deselects it.
    fireEvent.click(screen.getByText("Note One").closest("button")!);
    expect(screen.getByText(SELECTED_COUNT(1), { exact: false })).toBeDefined();
  });

  it("selects all visible rows from the header checkbox", () => {
    renderNotesPage();

    longPressRow("Note One");

    const selectAll = screen.getByLabelText("workspace.select_all") as HTMLInputElement;
    fireEvent.click(selectAll);
    expect(selectAll.checked).toBe(true);
    expect(screen.getByText(SELECTED_COUNT(3), { exact: false })).toBeDefined();

    // Unchecking select-all clears the selection and exits multi-select.
    fireEvent.click(screen.getByLabelText("workspace.select_all"));
    expect(screen.queryByLabelText("workspace.select_all")).toBeNull();
  });

  it("targets the whole selection with the row context menu", () => {
    renderNotesPage();

    longPressRow("Note One");
    fireEvent.click(screen.getByText("Note Two").closest("button")!);

    const menu = testData.menuProps.find(
      (p) => p.targetIds.includes("f1") && p.targetIds.includes("f2"),
    );
    expect(menu).toBeDefined();
    expect(menu!.targetIds).toHaveLength(2);
    expect(menu!.onDelete).toBeDefined();
    expect(menu!.onTranscribe).toBeDefined();
  });

  it("batch-deletes the whole selection and exits multi-select on success", () => {
    window.confirm = vi.fn(() => true);
    renderNotesPage();

    longPressRow("Note One");
    fireEvent.click(screen.getByLabelText("workspace.select_all"));

    const menu = testData.menuProps.find((p) => p.targetIds.length === 3);
    expect(menu).toBeDefined();
    act(() => {
      menu!.onDelete!(menu!.targetIds);
    });

    expect(testData.deleteMutate).toHaveBeenCalledWith(
      ["f1", "f2", "f3"],
      expect.objectContaining({ onSuccess: expect.any(Function) }),
    );
    // The mutation's onSuccess drops the selection, leaving multi-select mode.
    const [, options] = testData.deleteMutate.mock.calls[0] as [
      string[],
      { onSuccess: () => void },
    ];
    act(() => {
      options.onSuccess();
    });
    expect(screen.queryByLabelText("workspace.select_all")).toBeNull();
  });

  it("shows the floating batch bar with move/transcribe/delete in multi-select", () => {
    renderNotesPage();

    expect(screen.queryByTitle("workspace.delete_selected")).toBeNull();

    longPressRow("Note One");

    expect(screen.getByTitle("workspace.move_to")).toBeDefined();
    expect(screen.getByTitle("workspace.transcribe_selected")).toBeDefined();
    expect(screen.getByTitle("workspace.delete_selected")).toBeDefined();
  });

  it("batch-deletes from the floating bar", () => {
    window.confirm = vi.fn(() => true);
    renderNotesPage();

    longPressRow("Note One");
    fireEvent.click(screen.getByLabelText("workspace.select_all"));
    fireEvent.click(screen.getByTitle("workspace.delete_selected"));

    expect(testData.deleteMutate).toHaveBeenCalledWith(
      ["f1", "f2", "f3"],
      expect.objectContaining({ onSuccess: expect.any(Function) }),
    );
  });

  it("batch-transcribes the selection from the floating bar and clears it", async () => {
    renderNotesPage();

    longPressRow("Note One");
    fireEvent.click(screen.getByLabelText("workspace.select_all"));
    await act(async () => {
      fireEvent.click(screen.getByTitle("workspace.transcribe_selected"));
    });

    // One pipeline run per selected file, with the account-default template.
    expect(testData.rerunMutate).toHaveBeenCalledTimes(3);
    expect(testData.rerunMutate).toHaveBeenNthCalledWith(1, {
      fileId: "f1",
      templateId: "tpl-1",
    });
    // The selection is dropped once every pipeline has been kicked off.
    expect(getWorkspaceState().selectedFileIds.size).toBe(0);
  });
});
