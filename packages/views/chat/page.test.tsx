/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ChatPage } from "./page";

const chat = vi.hoisted(() => ({
  messages: [],
  isLoading: false,
  conversations: [] as Array<Record<string, unknown>>,
  activeConversationId: null as string | null,
  sendMessage: vi.fn(),
  clearMessages: vi.fn(),
  selectConversation: vi.fn(),
  stopStreaming: vi.fn(),
  pendingConfirm: null,
  answerConfirm: vi.fn(),
  dismissConfirm: vi.fn(),
}));

vi.mock("../workspace/hooks/use-chat", () => ({
  useChat: () => chat,
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
        provider: "qoder",
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
});
