/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// Heavy leaf components are stubbed; the store, useChat and the panel itself
// stay real — the point is exercising ChatPanel's actual render cycle.
vi.mock("../../assistant", () => ({
  AssistantAvatar: () => <div data-testid="avatar" />,
}));
vi.mock("@lynse/ui/markdown", () => ({
  StreamingMarkdown: ({ content }: { content: string }) => <div>{content}</div>,
}));
vi.mock("../../chat/chat-attachments", () => ({
  ChatAttachments: () => null,
}));
vi.mock("../../chat/chat-history-sidebar", () => ({
  ChatHistorySidebar: ({ conversations, onSelect }: {
    conversations: { id: string; title: string }[]; onSelect: (id: string) => void;
  }) => <div>{conversations.map((c) => <button key={c.id} onClick={() => onSelect(c.id)}>{c.title}</button>)}</div>,
}));
vi.mock("@lynse/core/i18n/react", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: "en" },
  }),
}));
vi.mock("@lynse/core/auth", () => ({
  useAuthStore: (selector: (state: { user: { id: string } | null }) => unknown) =>
    selector({ user: { id: "user" } }),
}));
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));
vi.mock("../hooks/use-files", () => ({
  useFiles: () => ({ data: [] }),
}));

import { ChatPanel } from "./chat-panel";
import { useChatStore } from "../hooks/use-chat-store";
import { getWorkspaceState } from "../store";
import type { ChatConversation } from "../types";

function seedConversations(conversations: ChatConversation[]) {
  const active = conversations[0];
  useChatStore.setState({
    conversations,
    activeConversationId: active?.id ?? null,
    messages: active?.messages ?? [],
  });
}

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  useChatStore.setState({
    conversations: [],
    activeConversationId: null,
    messages: [],
    unreadCounts: {},
    pendingConfirm: null,
    isLoading: false,
    activeAssistant: "lynse",
  });
  getWorkspaceState().selectItem(null, null);
});

function renderChatPanel() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <ChatPanel />
    </QueryClientProvider>,
  );
}

describe("ChatPanel", () => {
  it("clears the previous note's dialog and draft when another note is selected", async () => {
    getWorkspaceState().selectItem("meeting-a", "note", "Meeting A");
    seedConversations([{ id: "a", title: "Thread A", provider: "cloud", contextFileId: "meeting-a", createdAt: 1, updatedAt: 1,
      messages: [{ id: "answer-a", role: "assistant", content: "Old note answer", timestamp: 1 }] }]);
    const view = renderChatPanel();
    expect(view.getByText("Old note answer")).toBeTruthy();
    fireEvent.change(view.getByPlaceholderText("workspace.chat_placeholder"), { target: { value: "Old draft" } });
    await act(async () => getWorkspaceState().selectItem("meeting-b", "note", "Meeting B"));
    expect(view.queryByText("Old note answer")).toBeNull();
    expect((view.getByPlaceholderText("workspace.chat_placeholder") as HTMLInputElement).value).toBe("");
    expect(useChatStore.getState().activeConversationId).toBeNull();
    expect(useChatStore.getState().conversations.find((c) => c.id === "a")).toBeTruthy();
  });

  it.each(["meeting-a", undefined])("clears an old dialog when the sidebar is opened on a different note (%s)", (contextFileId) => {
    getWorkspaceState().selectItem("meeting-b", "note", "Meeting B");
    seedConversations([{ id: "a", title: "Thread A", provider: "cloud", contextFileId, createdAt: 1, updatedAt: 1,
      messages: [{ id: "answer-a", role: "assistant", content: "Old note answer", timestamp: 1 }] }]);
    const view = renderChatPanel();
    expect(view.queryByText("Old note answer")).toBeNull();
    expect(useChatStore.getState().messages).toEqual([]);
  });

  it("keeps the same note's dialog on reopen and only lists that note's history", () => {
    getWorkspaceState().selectItem("meeting-a", "note", "Meeting A");
    seedConversations([
      { id: "a", title: "Thread A", provider: "cloud", contextFileId: "meeting-a", createdAt: 1, updatedAt: 1,
        messages: [{ id: "answer-a", role: "assistant", content: "Answer A", timestamp: 1 }] },
      { id: "b", title: "Thread B", provider: "cloud", contextFileId: "meeting-b", createdAt: 1, updatedAt: 2, messages: [] },
    ]);
    const first = renderChatPanel();
    first.unmount();
    const reopened = renderChatPanel();
    expect(reopened.getByText("Answer A")).toBeTruthy();
    fireEvent.click(reopened.getByTitle("chat.history"));
    expect(reopened.getByText("Thread A")).toBeTruthy();
    expect(reopened.queryByText("Thread B")).toBeNull();
  });

  it("starts empty when the sidebar is closed on A and reopened after switching to B", () => {
    getWorkspaceState().selectItem("meeting-a", "note", "Meeting A");
    seedConversations([{ id: "a", title: "Thread A", provider: "cloud", contextFileId: "meeting-a", createdAt: 1, updatedAt: 1,
      messages: [{ id: "answer-a", role: "assistant", content: "Old note answer", timestamp: 1 }] }]);
    const first = renderChatPanel();
    fireEvent.change(first.getByPlaceholderText("workspace.chat_placeholder"), { target: { value: "Old draft" } });
    first.unmount();
    useChatStore.setState({ pendingConfirm: {
      messageId: "old-card", confirm: { question: "Old operation", options: [{ label: "Confirm", value: "confirm" }] },
    } });
    expect(useChatStore.getState().pendingConfirm).not.toBeNull();
    getWorkspaceState().selectItem("meeting-b", "note", "Meeting B");
    const reopened = renderChatPanel();
    expect(reopened.queryByText("Old note answer")).toBeNull();
    expect((reopened.getByPlaceholderText("workspace.chat_placeholder") as HTMLInputElement).value).toBe("");
    expect(useChatStore.getState().activeConversationId).toBeNull();
    expect(useChatStore.getState().pendingConfirm).toBeNull();
    expect(reopened.getByText("Meeting B")).toBeTruthy();
  });

  it("sends a new sidebar conversation with the currently selected note as its scope", () => {
    getWorkspaceState().selectItem("meeting-b", "note", "Meeting B");
    const send = vi.spyOn(useChatStore.getState(), "sendMessage").mockImplementation(() => {});
    try {
      const view = renderChatPanel();
      const input = view.getByPlaceholderText("workspace.chat_placeholder");
      fireEvent.change(input, { target: { value: "What are the risks?" } });
      fireEvent.keyDown(input, { key: "Enter" });
      expect(send).toHaveBeenCalledExactlyOnceWith("What are the risks?", "meeting-b", true, undefined, {
        assistant: "lynse", contextFileId: "meeting-b",
      });
    } finally {
      send.mockRestore();
    }
  });

  it("does not show or send a general chat when no note is selected", () => {
    seedConversations([{ id: "global", title: "General chat", provider: "cloud", createdAt: 1, updatedAt: 1,
      messages: [{ id: "global-answer", role: "assistant", content: "General answer", timestamp: 1 }] }]);
    const send = vi.spyOn(useChatStore.getState(), "sendMessage");
    try {
      const view = renderChatPanel();
      expect(view.queryByText("General answer")).toBeNull();
      expect(view.getByText("workspace.select_file_hint")).toBeTruthy();
      const input = view.getByPlaceholderText("workspace.chat_placeholder") as HTMLInputElement;
      expect(input.disabled).toBe(true);
      fireEvent.change(input, { target: { value: "An unscoped message" } });
      fireEvent.keyDown(input, { key: "Enter" });
      expect(send).not.toHaveBeenCalled();
      expect(useChatStore.getState().activeConversationId).toBeNull();
    } finally {
      send.mockRestore();
    }
  });

  it("does not show another note's latest cloud dialog when WorkBuddy is selected", () => {
    getWorkspaceState().selectItem("meeting-b", "note", "Meeting B");
    seedConversations([
      { id: "wb", title: "WorkBuddy", provider: "workbuddy", createdAt: 1, updatedAt: 2, messages: [] },
      { id: "a", title: "Thread A", provider: "cloud", contextFileId: "meeting-a", createdAt: 1, updatedAt: 3,
        messages: [{ id: "answer-a", role: "assistant", content: "Old note answer", timestamp: 1 }] },
    ]);
    useChatStore.setState({ activeAssistant: "workbuddy" });
    const view = renderChatPanel();
    expect(view.queryByText("Old note answer")).toBeNull();
    expect(useChatStore.getState().activeAssistant).toBe("workbuddy");
  });

  // Regression: the cloud-conversation selectors used to filter inside the
  // zustand hook, handing React a fresh array on every snapshot check. The
  // panel then re-rendered forever on mount — in production builds that is a
  // hard freeze the moment the panel opens.
  it("mounts and survives store updates with cloud + workbuddy conversations", async () => {
    getWorkspaceState().selectItem("meeting-a", "note", "Meeting A");
    const { getByText } = renderChatPanel();
    expect(getByText("chat.assistant_lynse")).toBeTruthy();

    await act(async () => {
      seedConversations([
        {
          id: "c1",
          title: "Cloud thread",
          provider: "cloud",
          contextFileId: "meeting-a",
          createdAt: 1,
          updatedAt: 10,
          messages: [
            { id: "m1", role: "user", content: "hi", timestamp: 1 },
            { id: "m2", role: "assistant", content: "hello", timestamp: 2 },
          ],
        },
        {
          id: "c2",
          title: "WorkBuddy thread",
          provider: "workbuddy",
          createdAt: 2,
          updatedAt: 20,
          messages: [],
        },
      ]);
    });

    expect(getByText("hello")).toBeTruthy();
  });
});
