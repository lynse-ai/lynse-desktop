/* @vitest-environment jsdom */

import { beforeEach, describe, expect, it, vi } from "vitest";

const apiMocks = vi.hoisted(() => ({
  stream: vi.fn(),
}));

vi.mock("@lynse/core/api", () => ({
  api: () => ({ stream: apiMocks.stream }),
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

import { toast } from "sonner";
import type { useChatStore as ChatStore } from "./use-chat-store";

interface CapturedStream {
  body: Record<string, unknown>;
  onChunk: (data: string) => void;
  onError: (error: Error) => void;
  onComplete: () => void;
}

let streams: CapturedStream[];
let store: typeof ChatStore;

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  window.localStorage.clear();
  streams = [];
  apiMocks.stream.mockImplementation(
    (
      _path: string,
      body: Record<string, unknown>,
      onChunk: (data: string) => void,
      onError: (error: Error) => void,
      onComplete: () => void,
    ) => {
      const controller = new AbortController();
      // Mirror the real client: aborting the stream resolves the turn.
      controller.signal.addEventListener("abort", () => onComplete());
      streams.push({ body, onChunk, onError, onComplete });
      return controller;
    },
  );
  store = (await import("./use-chat-store")).useChatStore;
});

function emit(stream: CapturedStream, event: Record<string, unknown>): void {
  stream.onChunk(JSON.stringify(event));
}

function conversationByUserText(text: string) {
  return store
    .getState()
    .conversations.find((conversation) =>
      conversation.messages.some((m) => m.role === "user" && m.content === text),
    )!;
}

describe("concurrent chat conversations", () => {
  it("runs up to three conversations at once and blocks the fourth", () => {
    const { sendMessage, clearMessages } = store.getState();
    sendMessage("one");
    clearMessages();
    sendMessage("two");
    clearMessages();
    sendMessage("three");

    expect(streams).toHaveLength(3);
    expect(store.getState().workingConversationIds).toHaveLength(3);
    expect(store.getState().isLoading).toBe(true);

    clearMessages();
    sendMessage("four");

    expect(streams).toHaveLength(3);
    expect(toast.error).toHaveBeenCalled();
    expect(store.getState().workingConversationIds).toHaveLength(3);
  });

  it("keeps background streams running when a new chat is started", () => {
    const { sendMessage, clearMessages } = store.getState();
    sendMessage("one");
    clearMessages();

    // Starting a new chat resets the view but never aborts the running turn.
    expect(store.getState().messages).toEqual([]);
    expect(store.getState().workingConversationIds).toHaveLength(1);
    expect(streams[0]!.body.query).toBe("one");
  });

  it("marks a completed background reply unread and stores it in its conversation", async () => {
    const { sendMessage, clearMessages } = store.getState();
    sendMessage("one");
    clearMessages();
    sendMessage("two");

    emit(streams[0]!, { type: "content", delta: "answer A" });
    emit(streams[0]!, { type: "done", text: "answer A" });
    streams[0]!.onComplete();
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
    expect(toast.success).toHaveBeenCalledWith("AI 助手已完成回复");
  });

  it("clears a conversation's unread count when it is opened", async () => {
    const { sendMessage, clearMessages, selectConversation } = store.getState();
    sendMessage("one");
    clearMessages();
    sendMessage("two");

    emit(streams[0]!, { type: "done", text: "answer A" });
    streams[0]!.onComplete();
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

  it("routes events to the right conversation when switching mid-stream", async () => {
    const { sendMessage, clearMessages, selectConversation } = store.getState();
    sendMessage("one");
    clearMessages();
    sendMessage("two");

    const conversationA = conversationByUserText("one");
    selectConversation(conversationA.id);
    // Conversation A is streaming and now on screen.
    expect(store.getState().isLoading).toBe(true);

    // A delta for the background conversation B lands in its stored copy only.
    emit(streams[1]!, { type: "content", delta: "B delta" });
    expect(conversationByUserText("two").messages.at(-1)!.content).toBe("B delta");
    expect(store.getState().messages.at(-1)!.content).toBe("");

    // A delta for the viewed conversation A renders into the messages buffer.
    emit(streams[0]!, { type: "content", delta: "A delta" });
    expect(store.getState().messages.at(-1)!.content).toBe("A delta");
  });

  it("stops only the active conversation's stream", async () => {
    const { sendMessage, clearMessages, stopStreaming } = store.getState();
    sendMessage("one");
    clearMessages();
    sendMessage("two");

    stopStreaming();
    // The abort resolves the transport promise and unregisters the run.
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
    const stream = streams[0]!;

    emit(stream, { type: "thinking", content: "先想想" });
    emit(stream, { type: "thinking", content: "再想想" });
    let message = store.getState().messages.at(-1)!;
    expect(message.thinking).toBe("先想想再想想");
    expect(message.thinkingActive).toBe(true);

    emit(stream, { type: "thinking_end" });
    message = store.getState().messages.at(-1)!;
    expect(message.thinkingActive).toBe(false);

    emit(stream, { type: "content", delta: "答案" });
    message = store.getState().messages.at(-1)!;
    expect(message.content).toBe("答案");
    expect(message.thinking).toBe("先想想再想想");
    expect(message.thinkingActive).toBe(false);
  });

  it("tracks tool calls from tool events and status ticks", () => {
    const { sendMessage } = store.getState();
    sendMessage("hello");
    const stream = streams[0]!;

    emit(stream, { type: "tool_use", name: "search_meetings", id: "t1" });
    let message = store.getState().messages.at(-1)!;
    expect(message.toolUses).toEqual([
      { id: "t1", name: "search_meetings", state: "running" },
    ]);

    // A status tick announcing the next tool closes the previous one.
    emit(stream, { type: "status", text: "调用工具: get_meeting" });
    message = store.getState().messages.at(-1)!;
    expect(message.toolUses).toEqual([
      { id: "t1", name: "search_meetings", state: "done" },
      { id: "get_meeting", name: "get_meeting", state: "running" },
    ]);

    emit(stream, { type: "tool_result", name: "get_meeting" });
    message = store.getState().messages.at(-1)!;
    expect(message.toolUses?.every((t) => t.state === "done")).toBe(true);
  });

  it("closes running tools when the turn completes", () => {
    const { sendMessage } = store.getState();
    sendMessage("hello");
    const stream = streams[0]!;

    emit(stream, { type: "status", text: "调用工具: search_notes" });
    emit(stream, { type: "content", delta: "partial" });
    emit(stream, { type: "done", text: "partial" });

    const message = store.getState().messages.at(-1)!;
    expect(message.content).toBe("partial");
    expect(message.status).toBeUndefined();
    expect(message.toolUses?.every((t) => t.state === "done")).toBe(true);
    expect(message.thinkingActive).toBeFalsy();
  });
});
