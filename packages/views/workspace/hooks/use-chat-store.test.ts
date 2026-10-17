/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryObserver } from "@tanstack/react-query";

// The store is tested against a fake transport so its event contract
// (status/content/thinking/tool/done/confirm/error) can be driven directly;
// the real stream/poll HTTP behavior is covered in chat-transport.test.ts.
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
  return { ...actual, StreamChatTransport: fake.FakeTransport };
});

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

import { toast } from "sonner";
import type { useChatStore as ChatStore } from "./use-chat-store";
import type { ChatStreamEvent } from "../types";

let store: typeof ChatStore;
let queryClient: QueryClient;

type FakeRun = InstanceType<typeof fake.FakeTransport>;

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  window.localStorage.clear();
  fake.runs.length = 0;
  queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false, gcTime: Infinity } } });
  (await import("@lynse/core/query-client")).setActiveQueryClient(queryClient);
  store = (await import("./use-chat-store")).useChatStore;
});

afterEach(() => {
  queryClient.clear();
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
    expect(toast.success).toHaveBeenCalledWith("小灵助手已完成回复");
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
    expect(last.content).toBe("");
    expect(last.errorMessage).toBe("boom");
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
  it("blocks a confirmation from another file, a missing card, and an already answered card", async () => {
    store.getState().openFileChat("meeting-a");
    store.getState().sendMessage("Rename speaker", "meeting-a", true, undefined, { contextFileId: "meeting-a" });
    const prepare = fake.runs[0]!;
    emit(prepare, { type: "done", text: "Confirm meeting A" });
    emit(prepare, { type: "confirm", confirm: {
      question: "Rename A", options: [{ label: "Confirm", value: "confirm" }], confirmToken: "card-a",
    } });
    prepare.cancel();
    await vi.waitFor(() => expect(store.getState().workingConversationIds).toHaveLength(0));
    const card = store.getState().pendingConfirm!.messageId;
    store.getState().answerConfirm(card, "confirm", "meeting-b");
    store.getState().answerConfirm("missing-card", "confirm", "meeting-a");
    expect(fake.runs).toHaveLength(1);
    store.getState().answerConfirm(card, "confirm", "meeting-a");
    expect(fake.runs).toHaveLength(2);
    fake.runs[1]!.cancel();
    await vi.waitFor(() => expect(store.getState().workingConversationIds).toHaveLength(0));
    store.getState().answerConfirm(card, "confirm", "meeting-a");
    expect(fake.runs).toHaveLength(2);
  });

  it("keeps the original meeting on the confirmation turn", async () => {
    store.getState().sendMessage("Rename speaker 2", "meeting-1", true);
    const prepare = fake.runs[0]!;
    emit(prepare, { type: "done", text: "Please confirm" });
    emit(prepare, { type: "confirm", confirm: {
      question: "Rename speaker 2", options: [{ label: "Confirm", value: "confirm" }],
      kind: "speaker_patch_confirm", confirmToken: "rename-card",
    } });
    prepare.cancel();
    await vi.waitFor(() => expect(store.getState().workingConversationIds).toHaveLength(0));

    store.getState().answerConfirm(store.getState().pendingConfirm!.messageId, "confirm");
    expect(fake.runs[1]!.opts).toMatchObject({
      query: "confirm", fileIds: ["meeting-1"], userSpecifiedFile: true, confirmToken: "rename-card",
    });
  });

  it("does not borrow an earlier meeting for an unscoped confirmation", async () => {
    store.getState().sendMessage("Read meeting 1", "meeting-1", true);
    emit(fake.runs[0]!, { type: "done", text: "Read" });
    fake.runs[0]!.cancel();
    await vi.waitFor(() => expect(store.getState().workingConversationIds).toHaveLength(0));
    store.getState().sendMessage("Clear completed todos");
    const prepare = fake.runs[1]!;
    emit(prepare, { type: "done", text: "Please confirm" });
    emit(prepare, { type: "confirm", confirm: {
      question: "Clear todos", options: [{ label: "Confirm", value: "confirm" }], confirmToken: "todo-card",
    } });
    prepare.cancel();
    await vi.waitFor(() => expect(store.getState().workingConversationIds).toHaveLength(0));

    store.getState().answerConfirm(store.getState().pendingConfirm!.messageId, "confirm");
    expect(fake.runs[2]!.opts).toMatchObject({ fileIds: [], userSpecifiedFile: false, confirmToken: "todo-card" });
  });

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
    // The card stays on the message, collapsed with the chosen value marked.
    expect(store.getState().messages.find((m) => m.id === pending!.messageId)?.confirm).toMatchObject({
      resolvedChoice: "confirm",
    });
  });

  it("does not fabricate a card from an A/B/C menu in plain text", () => {
    const { sendMessage } = store.getState();
    sendMessage("给我列一下选项");
    emit(fake.runs[0]!, { type: "done", text: "怎么处理？\nA) 重启设备\nB) 暂不处理" });
    // Only the structured `confirm` event renders a card now; the text
    // heuristic that popped the dialog mis-triggered too often.
    expect(store.getState().pendingConfirm).toBeNull();
    expect(store.getState().messages.at(-1)?.confirm).toBeUndefined();
  });

  it("keeps a dismissed card collapsed and never re-pends it after switching", async () => {
    const { sendMessage, dismissConfirm, selectConversation } = store.getState();
    sendMessage("清理待办");
    const run = fake.runs[0]!;
    emit(run, { type: "confirm", confirm: { question: "清理待办", options: [{ label: "确认", value: "confirm" }, { label: "先不了", value: "cancel" }] } });
    run.cancel();
    await vi.waitFor(() => expect(store.getState().workingConversationIds).toHaveLength(0));

    const messageId = store.getState().pendingConfirm!.messageId;
    dismissConfirm(messageId);
    expect(store.getState().messages.find((m) => m.id === messageId)?.confirm).toMatchObject({ resolvedChoice: null });

    // Switching away and back must not resurrect the dismissed card.
    const conversationId = store.getState().activeConversationId!;
    store.getState().clearMessages();
    selectConversation(conversationId);
    expect(store.getState().pendingConfirm).toBeNull();
    expect(store.getState().messages.find((m) => m.id === messageId)?.confirm).toMatchObject({ resolvedChoice: null });
  });
});

describe("note sidebar conversations", () => {
  it("rejects a send whose file scope disagrees with the sidebar context", () => {
    store.getState().sendMessage("Rename speaker", "meeting-a", true, undefined, { contextFileId: "meeting-b" });
    expect(fake.runs).toHaveLength(0);
    expect(store.getState().conversations).toEqual([]);
  });

  it("starts a new server session after changing files and keeps the old history separate", async () => {
    store.getState().openFileChat("meeting-a");
    store.getState().sendMessage("Read A", "meeting-a", true, undefined, { contextFileId: "meeting-a" });
    const first = fake.runs[0]!;
    const firstId = first.opts!.sessionId;
    emit(first, { type: "done", text: "Answer A" });
    first.cancel();
    await vi.waitFor(() => expect(store.getState().workingConversationIds).toHaveLength(0));
    store.getState().openFileChat("meeting-a");
    expect(store.getState().activeConversationId).toBe(firstId);

    store.getState().openFileChat("meeting-b");
    expect(store.getState().messages).toEqual([]);
    expect(store.getState().pendingConfirm).toBeNull();
    store.getState().sendMessage("Read B", "meeting-b", true, undefined, { contextFileId: "meeting-b" });
    expect(fake.runs[1]!.opts!.sessionId).not.toBe(firstId);
    expect(fake.runs[1]!.opts).toMatchObject({ fileIds: ["meeting-b"], userSpecifiedFile: true });
    expect(store.getState().conversations.find((c) => c.id === firstId)).toMatchObject({ contextFileId: "meeting-a" });
    expect(store.getState().conversations.find((c) => c.id === fake.runs[1]!.opts!.sessionId)).toMatchObject({ contextFileId: "meeting-b" });
  });

  it("does not reuse the old file's active run or late confirmation", () => {
    store.getState().sendMessage("Read A", "meeting-a", true, undefined, { contextFileId: "meeting-a" });
    const old = fake.runs[0]!;
    store.getState().openFileChat("meeting-b");
    emit(old, { type: "confirm", confirm: {
      question: "Rename A", options: [{ label: "Confirm", value: "confirm" }], confirmToken: "card-a",
    } });
    expect(store.getState().messages).toEqual([]);
    expect(store.getState().pendingConfirm).toBeNull();
    store.getState().sendMessage("Read B", "meeting-b", true, undefined, { contextFileId: "meeting-b" });
    expect(fake.runs).toHaveLength(2);
    expect(fake.runs[1]!.opts!.sessionId).not.toBe(old.opts!.sessionId);
    expect(store.getState().messages.some((m) => m.confirm?.confirmToken === "card-a")).toBe(false);
  });

  it("enforces the requested file scope even if the caller missed the reset", async () => {
    store.getState().sendMessage("Read A", "meeting-a", true, undefined, { contextFileId: "meeting-a" });
    const first = fake.runs[0]!;
    emit(first, { type: "done", text: "A" });
    first.cancel();
    await vi.waitFor(() => expect(store.getState().workingConversationIds).toHaveLength(0));
    store.getState().sendMessage("Read B", "meeting-b", true, undefined, { contextFileId: "meeting-b" });
    expect(fake.runs[1]!.opts!.sessionId).not.toBe(first.opts!.sessionId);
    expect(store.getState().messages.map((m) => m.content)).not.toContain("Read A");
  });
});

describe("meeting transcription refresh", () => {
  it("refetches the displayed transcription once after completion and shows the saved speaker name", async () => {
    let savedName = "Speaker 2";
    const load = vi.fn(async () => [{ speakerName: savedName }]);
    const observer = new QueryObserver(queryClient, {
      queryKey: ["file-transcription", "meeting-1"], queryFn: load,
    });
    const unsubscribe = observer.subscribe(() => {});
    try {
      await vi.waitFor(() => expect(observer.getCurrentResult().data).toEqual([{ speakerName: "Speaker 2" }]));
      store.getState().sendMessage("Rename speaker 2", "meeting-1", true);
      const run = fake.runs[0]!;
      emit(run, { type: "content", delta: "Working" });
      expect(load).toHaveBeenCalledTimes(1);

      savedName = "Updated speaker";
      emit(run, { type: "done", text: "Done" });
      await vi.waitFor(() => expect(observer.getCurrentResult().data).toEqual([{ speakerName: "Updated speaker" }]));
      expect(load).toHaveBeenCalledTimes(2);
      emit(run, { type: "done", text: "Done" });
      await Promise.resolve();
      expect(load).toHaveBeenCalledTimes(2);
    } finally {
      unsubscribe();
    }
  });

  it("marks the original meeting stale when its conversation finishes in the background", () => {
    queryClient.setQueryData(["file-transcription", "meeting-1"], [{ speakerName: "Old" }]);
    queryClient.setQueryData(["file-transcription", "meeting-2"], [{ speakerName: "Other" }]);
    store.getState().sendMessage("Update meeting 1", "meeting-1", true);
    const original = fake.runs[0]!;
    store.getState().clearMessages();
    store.getState().sendMessage("Read meeting 2", "meeting-2", true);

    emit(original, { type: "done", text: "Done" });
    expect(queryClient.getQueryState(["file-transcription", "meeting-1"])?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(["file-transcription", "meeting-2"])?.isInvalidated).toBe(false);
  });

  it.each(["error", "account-switch"])("does not refresh a stale or failed turn (%s)", (outcome) => {
    queryClient.setQueryData(["file-transcription", "meeting-1"], [{ speakerName: "Current" }]);
    store.getState().sendMessage("Update meeting 1", "meeting-1", true);
    const run = fake.runs[0]!;
    if (outcome === "account-switch") {
      store.getState().switchUser("other-user");
      emit(run, { type: "done", text: "Late completion" });
    } else {
      emit(run, { type: "error", message: "Failed" });
    }
    expect(queryClient.getQueryState(["file-transcription", "meeting-1"])?.isInvalidated).toBe(false);
  });
});

describe("interrupted reply details", () => {
  it("keeps streamed content and the actual failure separate, including history", async () => {
    store.getState().setUserId("error-user");
    store.getState().sendMessage("做成图文纪要");
    const run = fake.runs[0]!;
    emit(run, { type: "content", delta: "**会议纪要**" });
    emit(run, { type: "tool", name: "render_preview", state: "running" });
    emit(run, { type: "error", message: "图文生成超时" });
    run.cancel();
    await vi.waitFor(() => expect(store.getState().isLoading).toBe(false));
    expect(store.getState().messages.at(-1)).toMatchObject({
      content: "**会议纪要**", error: true, errorMessage: "图文生成超时",
      toolUses: [{ id: "render_preview", name: "render_preview", state: "error" }],
    });
    await vi.waitFor(() => expect(window.localStorage.getItem("lynse_ai_chat_history_v1:error-user")).toContain("图文生成超时"));
  });
  it("removes a stale failure when an authoritative done result arrives", () => {
    store.getState().sendMessage("hello");
    const run = fake.runs[0]!;
    emit(run, { type: "error", message: "temporary" });
    emit(run, { type: "done", text: "完整答案" });
    const message = store.getState().messages.at(-1)!;
    expect(message.content).toBe("完整答案");
    expect(message.error).toBeUndefined();
    expect(message.errorMessage).toBeUndefined();
  });
  it("does not fabricate a generic tool row from an unclassified status", () => {
    store.getState().sendMessage("hello");
    emit(fake.runs[0]!, { type: "status", text: "调用工具: create_visual_card" });
    expect(store.getState().messages.at(-1)?.toolUses).toBeUndefined();
  });
});
