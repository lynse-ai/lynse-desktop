/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ChatPage } from "./page";

const chat = vi.hoisted(() => ({
  messages: [],
  isLoading: false,
  conversations: [] as Array<Record<string, unknown>>,
  activeConversationId: null as string | null,
  workingConversationIds: [] as string[],
  unreadCount: 0,
  sendMessage: vi.fn(),
  clearMessages: vi.fn(),
  selectConversation: vi.fn(),
  stopStreaming: vi.fn(),
  pendingConfirm: null,
  answerConfirm: vi.fn(),
  dismissConfirm: vi.fn(),
}));

const mentionData = vi.hoisted(() => ({
  notes: [] as Array<Record<string, unknown>>,
  folders: [] as Array<Record<string, unknown>>,
}));

const uploadMock = vi.hoisted(() => ({
  uploadFileToOSS: vi.fn(),
}));

vi.mock("../workspace/hooks/use-chat", () => ({
  useChat: () => chat,
}));

vi.mock("../workspace/hooks/use-files", () => ({
  useNotes: () => ({ data: mentionData.notes }),
  uploadFileToOSS: uploadMock.uploadFileToOSS,
}));

vi.mock("../workspace/hooks/use-folders", () => ({
  useFolders: () => ({ data: mentionData.folders }),
}));

vi.mock("@lynse/core/i18n/react", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("@lynse/ui/markdown", () => ({
  StreamingMarkdown: ({ content }: { content: string }) => <div>{content}</div>,
}));

afterEach(() => {
  cleanup();
  chat.isLoading = false;
  chat.conversations = [];
  chat.activeConversationId = null;
  chat.sendMessage.mockClear();
  chat.clearMessages.mockClear();
  chat.selectConversation.mockClear();
  chat.stopStreaming.mockClear();
  mentionData.notes = [];
  mentionData.folders = [];
  uploadMock.uploadFileToOSS.mockReset();
});

describe("ChatPage", () => {
  it("sends the message through the shared AI chat hook", () => {
    render(<ChatPage />);

    const input = screen.getByPlaceholderText("chat.page_placeholder");
    fireEvent.change(input, { target: { value: "  summarize my meetings  " } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(chat.sendMessage).toHaveBeenCalledWith("summarize my meetings");
    expect((input as HTMLInputElement).value).toBe("");
  });

  it("starts a chat from a suggested prompt", () => {
    render(<ChatPage />);

    fireEvent.click(screen.getByText("chat.suggestion_summary"));

    expect(chat.sendMessage).toHaveBeenCalledWith("chat.suggestion_summary");
  });

  it("does not send when Shift+Enter is pressed", () => {
    render(<ChatPage />);

    const input = screen.getByPlaceholderText("chat.page_placeholder");
    fireEvent.change(input, { target: { value: "first line" } });
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });

    expect(chat.sendMessage).not.toHaveBeenCalled();
    expect((input as HTMLTextAreaElement).value).toBe("first line");
  });

  it("keeps history hidden until its icon is clicked, then opens a saved conversation", () => {
    chat.conversations = [
      {
        id: "conversation-1",
        title: "8 月会议",
        messages: [],
        provider: "cloud",
        createdAt: 1,
        updatedAt: 2,
      },
    ];
    render(<ChatPage />);

    expect(screen.queryByText("8 月会议")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "chat.history" }));
    fireEvent.click(screen.getByText("8 月会议"));

    expect(chat.selectConversation).toHaveBeenCalledWith("conversation-1");
    chat.conversations = [];
  });

  it("references a note via @ and sends its id as fileIds", () => {
    mentionData.notes = [
      { id: "note-1", type: "file", title: "产品评审", createdAt: "2026-01-02", updatedAt: "" },
      { id: "note-2", type: "file", title: "周会纪要", createdAt: "2026-01-01", updatedAt: "" },
    ];
    render(<ChatPage />);

    const input = screen.getByPlaceholderText("chat.page_placeholder");
    fireEvent.change(input, { target: { value: "总结 @产" } });

    const option = screen.getByRole("option", { name: /产品评审/ });
    fireEvent.click(option);

    expect((input as HTMLTextAreaElement).value).toBe("总结 @产品评审 ");
    fireEvent.keyDown(input, { key: "Enter" });

    expect(chat.sendMessage).toHaveBeenCalledWith("总结 @产品评审", ["note-1"], true, undefined);
    expect((input as HTMLTextAreaElement).value).toBe("");
  });

  it("references a group via # and sends the group's member note ids", () => {
    mentionData.notes = [
      { id: "n1", type: "file", title: "A", createdAt: "", folderId: "f1" },
      { id: "n2", type: "file", title: "B", createdAt: "", folderId: "f1" },
      { id: "n3", type: "file", title: "C", createdAt: "", folderId: "f2" },
    ];
    mentionData.folders = [{ id: "f1", folderName: "工作" }, { id: "f2", folderName: "生活" }];
    render(<ChatPage />);

    const input = screen.getByPlaceholderText("chat.page_placeholder");
    fireEvent.change(input, { target: { value: "梳理 #工" } });

    fireEvent.click(screen.getByRole("option", { name: /工作/ }));
    fireEvent.keyDown(input, { key: "Enter" });

    expect(chat.sendMessage).toHaveBeenCalledWith("梳理 #工作", ["n1", "n2"], true, undefined);
  });

  it("keyboard-navigates the @ list with arrow keys and picks with Enter", () => {
    mentionData.notes = [
      { id: "note-1", type: "file", title: "Alpha", createdAt: "", updatedAt: "" },
      { id: "note-2", type: "file", title: "Beta", createdAt: "", updatedAt: "" },
    ];
    render(<ChatPage />);

    const input = screen.getByPlaceholderText("chat.page_placeholder");
    fireEvent.change(input, { target: { value: "@" } });

    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });

    expect((input as HTMLTextAreaElement).value).toBe("@Beta ");
    expect(chat.sendMessage).not.toHaveBeenCalled();
  });

  it("closes the @ picker with Escape and sends normally", () => {
    mentionData.notes = [
      { id: "note-1", type: "file", title: "Alpha", createdAt: "", updatedAt: "" },
    ];
    render(<ChatPage />);

    const input = screen.getByPlaceholderText("chat.page_placeholder");
    fireEvent.change(input, { target: { value: "@" } });
    fireEvent.keyDown(input, { key: "Escape" });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(screen.queryByRole("option")).toBeNull();
    expect(chat.sendMessage).toHaveBeenCalledWith("@");
  });

  it("hides the attachment entry (upload not implemented yet) and offers the mic placeholder", () => {
    render(<ChatPage />);

    // The "+" upload button is deliberately hidden until upload ships; the
    // composer shows only the mic placeholder next to it.
    expect(screen.queryByRole("button", { name: "chat.attach_files" })).toBeNull();
    expect(screen.getByRole("button", { name: "chat.microphone" })).toBeTruthy();
  });
});
