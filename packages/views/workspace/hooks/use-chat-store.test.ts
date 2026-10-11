/* @vitest-environment jsdom */

import { beforeEach, describe, expect, it, vi } from "vitest";

// The store is tested against a fake transport so its event contract
// (status/content/thinking/tool/done/confirm/error) can be driven directly;
// the real poll transport's HTTP behavior is covered in chat-transport.test.ts.
const fake = vi.hoisted(() => {
  interface SendOptions {
    query: string;
    confirmToken?: string | null;
    onEvent: (event: unknown) => void;
    [key: string]: unknown;
  }
  class FakeTransport {
    readonly provider = "cloud" as const;
    opts: SendOptions | null = null;
    private resolve: (() => void) | null = null;
    send(opts: SendOptions): Promise<void> {
      this.opts = opts;
      fake.runs.push(this);
      return new Promise<void>((resolve) => {
        this.resolve = resolve;
      });
    }
    // Mirrors the real transports: cancelling settles the turn.
    cancel(): void {
      this.resolve?.();
    }
  }
  const fake = { FakeTransport, runs: [] as FakeTransport[] };
  return fake;
});

vi.mock("../chat-transport", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../chat-transport")>();
  return { ...actual, PollChatTransport: fake.FakeTransport };
});

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

import { toast } from "sonner";
import type { useChatStore as ChatStore } from "./use-chat-store";
import type { ChatStreamEvent } from "../types";

let store: typeof ChatStore;

type FakeRun = InstanceType<typeof fake.FakeTransport>;

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  window.localStorage.clear();
  fake.runs.length = 0;
  store = (await import("./use-chat-store")).useChatStore;
});

function emit(run: FakeRun, event: ChatStreamEvent): void {
  run.opts!.onEvent(event);
}

function conversationByUserText(text: string) {
  return store
    .getState()
    .conversations.find((conversation) =>
      conversation.messages.some((m) => m.role === "user" && m.content === text),
    )!;
}

describe("concurrent chat conversations", () => {
  it("keeps and persists connector-only replies without duplicated streaming cards", async () => {
    store.getState().setUserId("connector-user");
    store.getState().sendMessage("Read Notion");
    const run = fake.runs[0]!;
    const request = { request_id: "req-1", provider: "notion", provider_display_name: "Notion", status: "waiting_auth" as const, action_url: "https://auth.invalid/start" };
    emit(run, { type: "connection_request", request });
    emit(run, { type: "connection_request", request });
    emit(run, { type: "done", text: "" });
    run.cancel();
    await Promise.resolve();
    const assistant = store.getState().messages.find((message) => message.role === "assistant");
    expect(assistant?.connectionRequests).toEqual([request]);
    await vi.waitFor(() => expect(window.localStorage.getItem("lynse_ai_chat_history_v1:connector-user")).toContain("req-1"));
  });

  it("switches accounts without copying old history or accepting old stream events", async () => {
    store.getState().setUserId("u1");
    store.getState().sendMessage("Private u1 context");
    const oldRun = fake.runs[0]!;
    const cancel = vi.spyOn(oldRun, "cancel").mockImplementation(() => {});
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    emit(oldRun, { type: "content", delta: "Private u1 answer" });
    window.localStorage.setItem("lynse_ai_chat_history_v1:u2", JSON.stringify({ activeConversationId: "u2-history", conversations: [{
      id: "u2-history", title: "Own u2 history", provider: "cloud", createdAt: 1, updatedAt: 1,
      messages: [{ id: "u2-message", role: "user", content: "Own u2 history", timestamp: 1 }],
    }] }));
    store.getState().switchUser("u2");
    expect(cancel).toHaveBeenCalled();
    expect(store.getState().conversations.map((conversation) => conversation.id)).toEqual(["u2-history"]);
    expect(store.getState().workingConversationIds).toEqual([]);
    emit(oldRun, { type: "done", text: "Late private u1 answer" });
    await Promise.resolve();
    store.getState().clearMessages();
    store.getState().sendMessage("Open u2 context suggestion");
    expect(window.localStorage.getItem("lynse_ai_chat_history_v1:u1")).toContain("Private u1 answer");
    expect(window.localStorage.getItem("lynse_ai_chat_history_v1:u2")).not.toContain("Private u1");
    expect(JSON.stringify(store.getState().conversations)).not.toContain("Private u1");
    store.getState().switchUser(null);
    expect(store.getState().messages).toEqual([]);
    expect(store.getState().conversations).toEqual([]);
    store.getState().switchUser("u1");
    expect(JSON.stringify(store.getState().conversations)).toContain("Private u1 answer");
    expect(JSON.stringify(store.getState().conversations)).not.toContain("Open u2 context suggestion");
    cancel.mockRestore();
    oldRun.cancel();
    await Promise.resolve();
    expect(info).not.toHaveBeenCalled();
    info.mockRestore();
  });
  it("runs up to three conversations at once and blocks the fourth", () => {
    const { sendMessage, clearMessages } = store.getState();
    sendMessage("one");
    clearMessages();
    sendMessage("two");
    clearMessages();
    sendMessage("three");

    expect(fake.runs).toHaveLength(3);
    expect(store.getState().workingConversationIds).toHaveLength(3);
    expect(store.getState().isLoading).toBe(true);

    clearMessages();
    sendMessage("four");

    expect(fake.runs).toHaveLength(3);
    expect(toast.error).toHaveBeenCalled();
    expect(store.getState().workingConversationIds).toHaveLength(3);
  });

  it("keeps background turns running when a new chat is started", () => {
    const { sendMessage, clearMessages } = store.getState();
    sendMessage("one");
    clearMessages();

    // Starting a new chat resets the view but never aborts the running turn.
    expect(store.getState().messages).toEqual([]);
    expect(store.getState().workingConversationIds).toHaveLength(1);
    expect(fake.runs[0]!.opts!.query).toBe("one");
  });

  it("marks a completed background reply unread and stores it in its conversation", async () => {
    const { sendMessage, clearMessages } = store.getState();
    sendMessage("one");
    clearMessages();
    sendMessage("two");

    emit(fake.runs[0]!, { type: "content", delta: "answer A" });
    emit(fake.runs[0]!, { type: "done", text: "answer A" });
    fake.runs[0]!.cancel();
    await vi.waitFor(() =>
      expect(store.getState().workingConversationIds).toHaveLength(1),
    );

    const state = store.getState();
    expect(Object.keys(state.unreadCounts)).toHaveLength(1);
    const conversationA = conversationByUserText("one");
    expect(state.unreadCounts[conversationA.id]).toBe(1);

    const backgroundMessage = conversationA.messages.at(-1)!;
    expect(backgroundMessage.role).toBe("assistant");
    expect(backgroundMessage.content).toBe("answer A");
    expect(backgroundMessage.status).toBeUndefined();

    // The active conversation (two) is untouched by the background reply.
    expect(conversationByUserText("two").messages.at(-1)!.content).toBe("");
    expect(toast.success).toHaveBeenCalledWith("小玲同学已完成回复");
  });

  it("stores the human-support link from the done payload", () => {
    const { sendMessage } = store.getState();
    sendMessage("help me");
    emit(fake.runs[0]!, {
      type: "done",
      text: "已转接人工",
      humanSupportLink: { url: "https://help.example.test", label: "联系人工" },
    });

    const message = store.getState().messages.at(-1)!;
    expect(message.humanSupportLink).toEqual({
      url: "https://help.example.test",
      label: "联系人工",
    });
  });

  it("clears a conversation's unread count when it is opened", async () => {
    const { sendMessage, clearMessages, selectConversation } = store.getState();
    sendMessage("one");
    clearMessages();
    sendMessage("two");

    emit(fake.runs[0]!, { type: "done", text: "answer A" });
    fake.runs[0]!.cancel();
    // The unread mark lands with the done event; the run unregisters one
    // promise hop later — wait for both before switching.
    await vi.waitFor(() => {
      expect(Object.keys(store.getState().unreadCounts)).toHaveLength(1);
      expect(store.getState().workingConversationIds).toHaveLength(1);
    });

    selectConversation(conversationByUserText("one").id);
    const state = store.getState();
    expect(state.unreadCounts).toEqual({});
    // Switching to the just-finished conversation is not a loading state.
    expect(state.isLoading).toBe(false);
  });

  it("routes events to the right conversation when switching mid-turn", async () => {
    const { sendMessage, clearMessages, selectConversation } = store.getState();
    sendMessage("one");
    clearMessages();
    sendMessage("two");

    const conversationA = conversationByUserText("one");
    selectConversation(conversationA.id);
    // Conversation A is running and now on screen.
    expect(store.getState().isLoading).toBe(true);

    // A delta for the background conversation B lands in its stored copy only.
    emit(fake.runs[1]!, { type: "content", delta: "B delta" });
    expect(conversationByUserText("two").messages.at(-1)!.content).toBe("B delta");
    expect(store.getState().messages.at(-1)!.content).toBe("");

    // A delta for the viewed conversation A renders into the messages buffer.
    emit(fake.runs[0]!, { type: "content", delta: "A delta" });
    expect(store.getState().messages.at(-1)!.content).toBe("A delta");
  });

  it("stops only the active conversation's turn", async () => {
    const { sendMessage, clearMessages, stopStreaming } = store.getState();
    sendMessage("one");
    clearMessages();
    sendMessage("two");

    stopStreaming();
    // Cancelling the transport settles the promise and unregisters the run.
    await vi.waitFor(() =>
      expect(store.getState().workingConversationIds).toHaveLength(1),
    );
    const remaining = conversationByUserText("one").id;
    expect(store.getState().workingConversationIds).toEqual([remaining]);
    expect(store.getState().isLoading).toBe(false);
  });
});

describe("reasoning and tool activity", () => {
  it("accumulates thinking deltas and closes the trace when content starts", () => {
    const { sendMessage } = store.getState();
    sendMessage("hello");
    const run = fake.runs[0]!;

    emit(run, { type: "thinking", delta: "先想想" });
    emit(run, { type: "thinking", delta: "再想想" });
    let message = store.getState().messages.at(-1)!;
    expect(message.thinking).toBe("先想想再想想");
    expect(message.thinkingActive).toBe(true);

    emit(run, { type: "thinking", delta: "" });
    message = store.getState().messages.at(-1)!;
    expect(message.thinkingActive).toBe(false);

    emit(run, { type: "content", delta: "答案" });
    message = store.getState().messages.at(-1)!;
    expect(message.content).toBe("答案");
    expect(message.thinking).toBe("先想想再想想");
    expect(message.thinkingActive).toBe(false);
  });

  it("tracks tool calls from tool events and status ticks", () => {
    const { sendMessage } = store.getState();
    sendMessage("hello");
    const run = fake.runs[0]!;

    emit(run, { type: "tool", name: "search_meetings", id: "t1" });
    let message = store.getState().messages.at(-1)!;
    expect(message.toolUses).toEqual([
      { id: "t1", name: "search_meetings", state: "running" },
    ]);

    // A status tick announcing the next tool closes the previous one.
    emit(run, { type: "status", text: "调用工具: get_meeting" });
    message = store.getState().messages.at(-1)!;
    expect(message.toolUses).toEqual([
      { id: "t1", name: "search_meetings", state: "done" },
      { id: "get_meeting", name: "get_meeting", state: "running" },
    ]);

    emit(run, { type: "tool", name: "get_meeting", state: "done" });
    message = store.getState().messages.at(-1)!;
    expect(message.toolUses?.every((t) => t.state === "done")).toBe(true);
  });

  it("closes running tools when the turn completes", () => {
    const { sendMessage } = store.getState();
    sendMessage("hello");
    const run = fake.runs[0]!;

    emit(run, { type: "status", text: "调用工具: search_notes" });
    emit(run, { type: "content", delta: "partial" });
    emit(run, { type: "done", text: "partial" });

    const message = store.getState().messages.at(-1)!;
    expect(message.content).toBe("partial");
    expect(message.status).toBeUndefined();
    expect(message.toolUses?.every((t) => t.state === "done")).toBe(true);
    expect(message.thinkingActive).toBeFalsy();
  });
});

describe("stopping a pending poll turn", () => {
  it("drops the empty assistant bubble when stopped before the answer lands", async () => {
    const { sendMessage, stopStreaming } = store.getState();
    sendMessage("hello");

    // Poll has no partial content — stopping mid-turn leaves the placeholder
    // empty, and an empty bubble would render a "thinking" spinner forever.
    stopStreaming();
    await vi.waitFor(() => expect(store.getState().workingConversationIds).toHaveLength(0));

    const messages = store.getState().messages;
    expect(messages.map((m) => m.role)).toEqual(["user"]);
    expect(messages[0]!.content).toBe("hello");
    expect(store.getState().isLoading).toBe(false);

    // The conversation's stored copy is cleaned up too.
    expect(conversationByUserText("hello").messages.map((m) => m.role)).toEqual(["user"]);
  });

  it("keeps the bubble when the turn wrote something before ending", async () => {
    const { sendMessage, stopStreaming } = store.getState();
    sendMessage("hello");
    const run = fake.runs[0]!;
    emit(run, { type: "error", message: "boom" });

    stopStreaming();
    await vi.waitFor(() => expect(store.getState().workingConversationIds).toHaveLength(0));

    const last = store.getState().messages.at(-1)!;
    expect(last.role).toBe("assistant");
    expect(last.error).toBe(true);
    expect(last.content).toContain("boom");
  });

  it("stamps revealedAt when the finished answer lands", () => {
    const { sendMessage } = store.getState();
    sendMessage("hello");
    emit(fake.runs[0]!, { type: "done", text: "full answer" });

    const message = store.getState().messages.at(-1)!;
    expect(message.content).toBe("full answer");
    expect(message.revealedAt).toBeGreaterThan(0);
  });
});

describe("confirmation cards", () => {
  it("pops the card from the confirm event and answers with its confirmToken", async () => {
    const { sendMessage, answerConfirm } = store.getState();
    sendMessage("清理待办");
    const run = fake.runs[0]!;

    emit(run, { type: "done", text: "请确认清理待办" });
    emit(run, {
      type: "confirm",
      confirm: {
        question: "清理待办",
        options: [
          { label: "确认清理", value: "confirm" },
          { label: "先不了", value: "cancel" },
        ],
        confirmToken: "card-token-1",
      },
    });

    const pending = store.getState().pendingConfirm;
    expect(pending).not.toBeNull();
    expect(pending!.confirm.options).toHaveLength(2);

    // The transport settles right after emitting done/confirm; the user can
    // only tap the card once the dialog renders, i.e. after that microtask.
    run.cancel();
    await vi.waitFor(() => expect(store.getState().workingConversationIds).toHaveLength(0));

    answerConfirm(pending!.messageId, "confirm");
    await vi.waitFor(() => expect(fake.runs).toHaveLength(2));

    // The follow-up turn must carry the card's token as confirm_token.
    expect(fake.runs[1]!.opts!.query).toBe("confirm");
    expect(fake.runs[1]!.opts!.confirmToken).toBe("card-token-1");
    // The card is cleared from the answered message.
    expect(store.getState().messages.find((m) => m.id === pending!.messageId)?.confirm).toBeUndefined();
  });
});
