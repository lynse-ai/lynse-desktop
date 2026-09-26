/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
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
  ChatHistorySidebar: () => null,
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
  });
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
  // Regression: the cloud-conversation selectors used to filter inside the
  // zustand hook, handing React a fresh array on every snapshot check. The
  // panel then re-rendered forever on mount — in production builds that is a
  // hard freeze the moment the panel opens.
  it("mounts and survives store updates with cloud + workbuddy conversations", async () => {
    const { getByText } = renderChatPanel();
    expect(getByText("chat.assistant_lynse")).toBeTruthy();

    await act(async () => {
      seedConversations([
        {
          id: "c1",
          title: "Cloud thread",
          provider: "cloud",
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
