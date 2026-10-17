/* @vitest-environment jsdom */

import { afterEach, describe, expect, it } from "vitest";
import { conversationTitle, loadChatHistory, saveChatHistory } from "./chat-history";

afterEach(() => window.localStorage.clear());

describe("AI chat history", () => {
  it("persists a note's conversation scope and rejects malformed scopes", () => {
    const conversation = { id: "a", title: "A", provider: "cloud" as const, contextFileId: "meeting-a", createdAt: 1, updatedAt: 1, messages: [] };
    saveChatHistory("user", { activeConversationId: "a", conversations: [conversation] });
    expect(loadChatHistory("user").conversations[0]?.contextFileId).toBe("meeting-a");
    window.localStorage.setItem("lynse_ai_chat_history_v1:user", JSON.stringify({ conversations: [
      conversation, { ...conversation, id: "bad", contextFileId: 42 },
    ] }));
    expect(loadChatHistory("user").conversations.map((c) => c.id)).toEqual(["a"]);
  });

  it("keeps cloud task mappings and artifact-only replies, stripping tickets and stale approvals", () => {
    const session = { mode: "cloud" as const, taskId: "remote-task", token: "never-persist", link: "never-persist" };
    saveChatHistory("wb", { activeConversationId: "cloud-task", conversations: [{
      id: "cloud-task", title: "WorkBuddy", provider: "workbuddy", createdAt: 1, updatedAt: 2, workbuddySession: session,
      messages: [
        { id: "files", role: "assistant", content: "", timestamp: 1, attachments: [{ name: "plan.md", type: "markdown", text: "# Plan" }],
          confirm: { question: "Approve", options: [], workbuddy: { requestId: "expired-request" } } },
        { id: "refusal", role: "assistant", content: "", timestamp: 2, workbuddyStopReason: "refusal" },
      ],
    }] });
    const loaded = loadChatHistory("wb").conversations[0]!;
    expect(loaded.workbuddySession).toEqual({ mode: "cloud", taskId: "remote-task" });
    expect(loaded.messages.map((message) => message.id)).toEqual(["files", "refusal"]);
    expect(loaded.messages[0]?.confirm).toBeUndefined();
    expect(window.localStorage.getItem("lynse_ai_chat_history_v1:wb")).not.toContain("never-persist");
    expect(window.localStorage.getItem("lynse_ai_chat_history_v1:wb")).not.toContain("expired-request");
  });
  it("keeps legacy WorkBuddy history distinct and rejects malformed cloud mappings", () => {
    const legacy = { id: "legacy", title: "Old", provider: "workbuddy", createdAt: 1, updatedAt: 2, messages: [] };
    window.localStorage.setItem("lynse_ai_chat_history_v1:wb", JSON.stringify({ conversations: [legacy,
      { ...legacy, id: "invalid", workbuddySession: { mode: "cloud", taskId: 42 } },
    ] }));
    expect(loadChatHistory("wb").conversations.map((conversation) => conversation.id)).toEqual(["legacy"]);
    expect(loadChatHistory("wb").conversations[0]?.workbuddySession).toBeUndefined();
  });
  it("retains resolved WorkBuddy approval choices as disabled history cards", () => {
    saveChatHistory("wb", { activeConversationId: "resolved", conversations: [{
      id: "resolved", title: "WorkBuddy", provider: "workbuddy", createdAt: 1, updatedAt: 2,
      messages: [{ id: "answer", role: "assistant", content: "", timestamp: 2,
        confirm: { question: "Read cloud file", options: [{ label: "Allow once", value: "allow" }],
          resolvedChoice: "allow", workbuddy: { requestId: "answered-request" } } }],
    }] });
    expect(loadChatHistory("wb").conversations[0]?.messages[0]?.confirm).toMatchObject({
      question: "Read cloud file", resolvedChoice: "allow",
    });
  });
  it("keeps cloud confirmation-only messages when restoring a conversation", () => {
    saveChatHistory("u", { activeConversationId: "confirmation", conversations: [{
      id: "confirmation", title: "Choose a meeting", provider: "cloud", createdAt: 1, updatedAt: 2,
      messages: [{ id: "card", role: "assistant", content: "", timestamp: 2,
        confirm: { question: "Which meeting?", options: [{ label: "Review", value: "review" }], resolvedChoice: "review" } }],
    }] });
    expect(loadChatHistory("u").conversations[0]?.messages[0]?.confirm?.resolvedChoice).toBe("review");
  });
  it("persists conversations per user and removes transient progress", () => {
    saveChatHistory("user-1", {
      activeConversationId: "conversation-1",
      conversations: [
        {
          id: "conversation-1",
          title: "8 月会议",
          provider: "qoder",
          createdAt: 1,
          updatedAt: 2,
          qoderSession: {
            sessionId: "sess_1",
            afterEventId: "evt_2",
            sessionOptionsKey: "options",
          },
          messages: [
            { id: "user-1", role: "user", content: "查看 8 月会议", timestamp: 1 },
            {
              id: "assistant-1",
              role: "assistant",
              content: "共 14 条",
              timestamp: 2,
              status: "正在运行",
              revealedAt: 999,
            },
            { id: "assistant-2", role: "assistant", content: "", timestamp: 3, status: "处理中" },
          ],
        },
      ],
    });

    expect(loadChatHistory("user-1")).toEqual({
      activeConversationId: "conversation-1",
      conversations: [
        expect.objectContaining({
          id: "conversation-1",
          qoderSession: expect.objectContaining({ sessionId: "sess_1", afterEventId: "evt_2" }),
          messages: [
            expect.objectContaining({ role: "user", content: "查看 8 月会议" }),
            expect.not.objectContaining({
              status: expect.anything(),
              revealedAt: expect.anything(),
            }),
          ],
        }),
      ],
    });
    expect(loadChatHistory("user-2").conversations).toEqual([]);
  });

  it("derives a compact title from the first user message", () => {
    expect(conversationTitle("  生成   某场会议的图文总结  ")).toBe("生成 某场会议的图文总结");
    expect(conversationTitle("这是一条很长的会话标题，用于验证会话历史列表不会被无限撑宽并保持可读性和布局稳定性"))
      .toMatch(/…$/);
  });

  it("returns an empty history for junk or missing storage", () => {
    // No entry at all.
    expect(loadChatHistory("nobody")).toEqual({ activeConversationId: null, conversations: [] });
    // Unparsable JSON.
    window.localStorage.setItem("lynse_ai_chat_history_v1:u", "{not json");
    expect(loadChatHistory("u")).toEqual({ activeConversationId: null, conversations: [] });
    // Parsed but wrong shape.
    window.localStorage.setItem("lynse_ai_chat_history_v1:u", JSON.stringify({ conversations: "nope" }));
    expect(loadChatHistory("u")).toEqual({ activeConversationId: null, conversations: [] });
  });

  it("drops malformed conversations and invalidates dangling active ids", () => {
    const validConversation = {
      id: "keep-1",
      title: "有效会话",
      provider: "cloud",
      createdAt: 1,
      updatedAt: 2,
      messages: [{ id: "m1", role: "user", content: "你好", timestamp: 1 }],
    };
    window.localStorage.setItem(
      "lynse_ai_chat_history_v1:u",
      JSON.stringify({
        activeConversationId: "broken-1",
        conversations: [
          validConversation,
          { id: "broken-1", title: 42, provider: "cloud", createdAt: 1, updatedAt: 2, messages: [] },
          { id: "broken-2", title: "坏消息体", provider: "cloud", createdAt: 1, updatedAt: 2,
            messages: [{ id: "m2", role: "system", content: "x", timestamp: 1 }] },
          { id: "broken-3", title: "坏 provider", provider: "gemini", createdAt: 1, updatedAt: 2, messages: [] },
          null,
        ],
      }),
    );

    const loaded = loadChatHistory("u");
    expect(loaded.conversations.map((c) => c.id)).toEqual(["keep-1"]);
    // The stored active id pointed at a dropped conversation — it must not surface.
    expect(loaded.activeConversationId).toBeNull();
  });

  it("keeps errored empty assistant bubbles but drops plain empty ones", () => {
    saveChatHistory("u", {
      activeConversationId: "c1",
      conversations: [
        {
          id: "c1",
          title: "错误保留",
          provider: "cloud",
          createdAt: 1,
          updatedAt: 2,
          messages: [
            { id: "m1", role: "user", content: "问题", timestamp: 1 },
            // Empty AND errored — must survive the round trip.
            { id: "m2", role: "assistant", content: "", timestamp: 2, error: true },
            // Empty without error — transient placeholder, dropped.
            { id: "m3", role: "assistant", content: "", timestamp: 3 },
          ],
        },
      ],
    });

    const messages = loadChatHistory("u").conversations[0]!.messages;
    expect(messages.map((m) => m.id)).toEqual(["m1", "m2"]);
    expect(messages[1]).toMatchObject({ error: true, content: "" });
  });

  it("never throws when the storage quota is exhausted", () => {
    const block = window.localStorage.setItem;
    window.localStorage.setItem = () => {
      throw new DOMException("quota exceeded", "QuotaExceededError");
    };
    try {
      expect(() =>
        saveChatHistory("u", { activeConversationId: null, conversations: [] }),
      ).not.toThrow();
    } finally {
      window.localStorage.setItem = block;
    }
  });
});
