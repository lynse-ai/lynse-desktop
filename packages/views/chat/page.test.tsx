/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ChatPage } from "./page";

const chat = vi.hoisted(() => ({
  messages: [],
  isLoading: false,
  sendMessage: vi.fn(),
  clearMessages: vi.fn(),
  stopStreaming: vi.fn(),
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
  chat.sendMessage.mockClear();
  chat.clearMessages.mockClear();
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
});
