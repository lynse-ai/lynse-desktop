/* @vitest-environment jsdom */

import { afterEach, describe, expect, it } from "vitest";
import { conversationTitle, loadChatHistory, saveChatHistory } from "./chat-history";

afterEach(() => window.localStorage.clear());

describe("AI chat history", () => {
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
            expect.not.objectContaining({ status: expect.anything() }),
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
});
