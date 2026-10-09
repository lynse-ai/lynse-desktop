/* @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatStreamEvent, ChatConfirm } from "../types";
const fake = vi.hoisted(() => {
  const history = vi.fn(async (): Promise<{ messages: { role: "user" | "assistant"; content: string }[]; attachments: [] }> => ({ messages: [], attachments: [] }));
  class Transport {
    readonly provider = "workbuddy" as const;
    opts: { query: string; onEvent: (event: ChatStreamEvent) => void; workbuddySession?: { taskId?: string } } | null = null;
    private resolve: (() => void) | null = null;
    answerConfirmation = vi.fn(async (_confirm: ChatConfirm, _value: string | null) => {});
    send(opts: NonNullable<Transport["opts"]>): Promise<void> {
      this.opts = opts; fake.runs.push(this);
      return new Promise((resolve) => { this.resolve = resolve; });
    }
    loadHistory = history;
    finish(): void { this.resolve?.(); }
    cancel = vi.fn(() => { this.finish(); });
  }
  return { Transport, runs: [] as Transport[], history };
});
vi.mock("@lynse/core/workbuddy", () => ({ hasWorkBuddyAcpBridge: () => true }));
vi.mock("../workbuddy-cloud-chat-transport", () => ({ WorkBuddyCloudChatTransport: fake.Transport }));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
import type { useChatStore as Store } from "./use-chat-store";
let store: typeof Store;
beforeEach(async () => {
  vi.resetModules(); vi.clearAllMocks(); window.localStorage.clear(); fake.runs.length = 0;
  fake.history.mockResolvedValue({ messages: [], attachments: [] });
  store = (await import("./use-chat-store")).useChatStore;
  store.getState().setUserId("wb-user"); store.getState().setActiveAssistant("workbuddy");
});
afterEach(() => { store.getState().switchUser(null); });
function emit(index: number, event: ChatStreamEvent) { fake.runs[index]!.opts!.onEvent(event); }

describe("desktop WorkBuddy conversation store", () => {
  it("stops locally even if cancellation hangs and ignores the old turn after a follow-up starts", async () => {
    store.getState().sendMessage("first");
    emit(0, { type: "workbuddy_session", session: { mode: "cloud", taskId: "task-a" } });
    emit(0, { type: "content", delta: "partial reply" });
    emit(0, { type: "status", text: "thinking" });
    const conversationId = store.getState().activeConversationId!;
    const oldRun = fake.runs[0]!;
    oldRun.cancel.mockImplementationOnce(() => {});
    store.getState().stopStreaming();
    expect(store.getState().isLoading).toBe(false);
    expect(store.getState().workingConversationIds).not.toContain(conversationId);
    expect(store.getState().messages.at(-1)).toMatchObject({ content: "partial reply", thinkingActive: false });
    expect(store.getState().messages.at(-1)?.status).toBeUndefined();
    expect(store.getState().conversations.find((entry) => entry.id === conversationId)?.messages.at(-1)?.content).toBe("partial reply");
    store.getState().sendMessage("next");
    expect(fake.runs).toHaveLength(2);
    expect(fake.runs[1]!.opts?.workbuddySession?.taskId).toBe("task-a");
    emit(0, { type: "content", delta: "late text" });
    oldRun.finish(); await Promise.resolve();
    expect(store.getState().isLoading).toBe(true);
    expect(store.getState().messages.map((message) => message.content).join("")).not.toContain("late text");
  });
  it("keeps independent task mappings and background output when switching chats", async () => {
    store.getState().sendMessage("first");
    const firstId = store.getState().activeConversationId!;
    emit(0, { type: "workbuddy_session", session: { mode: "cloud", taskId: "task-a" } });
    store.getState().clearMessages(); store.getState().sendMessage("second");
    const secondId = store.getState().activeConversationId!;
    emit(1, { type: "workbuddy_session", session: { mode: "cloud", taskId: "task-b" } });
    emit(0, { type: "content", delta: "first background answer" });
    expect(store.getState().messages.map((message) => message.content).join("")).not.toContain("background");
    store.getState().selectConversation(firstId);
    expect(store.getState().messages.at(-1)?.content).toBe("first background answer");
    expect(store.getState().isLoading).toBe(true);
    emit(0, { type: "done", text: "first background answer" }); fake.runs[0]!.cancel(); await Promise.resolve();
    store.getState().sendMessage("follow up");
    expect(fake.runs[2]!.opts?.workbuddySession).toEqual({ mode: "cloud", taskId: "task-a" });
    expect(store.getState().conversations.find((entry) => entry.id === secondId)?.workbuddySession?.taskId).toBe("task-b");
  });
  it("routes permission selections and dismissal to the waiting RPC, without adding another turn", async () => {
    store.getState().sendMessage("ask");
    const confirm: ChatConfirm = { question: "Approve?", options: [{ label: "Allow", value: "allow" }], workbuddy: { requestId: "permission-1" } };
    emit(0, { type: "confirm", confirm });
    const messageId = store.getState().pendingConfirm!.messageId;
    store.getState().answerConfirm(messageId, "allow");
    expect(fake.runs[0]!.answerConfirmation).toHaveBeenCalledWith(confirm, "allow");
    expect(fake.runs).toHaveLength(1);
    emit(0, { type: "confirm_resolved", requestId: "permission-1" });
    expect(store.getState().pendingConfirm).toBeNull();
    emit(0, { type: "confirm", confirm: { ...confirm, workbuddy: { requestId: "permission-2" } } });
    store.getState().dismissConfirm(messageId);
    expect(fake.runs[0]!.answerConfirmation).toHaveBeenLastCalledWith(expect.objectContaining({ workbuddy: { requestId: "permission-2" } }), null);
  });
  it("refreshes only the selected idle cloud task and preserves its local message IDs", async () => {
    store.getState().sendMessage("question");
    emit(0, { type: "workbuddy_session", session: { mode: "cloud", taskId: "task-a" } });
    emit(0, { type: "content", delta: "partial" });
    const ids = store.getState().messages.map((message) => message.id);
    store.getState().stopStreaming(); await Promise.resolve();
    fake.history.mockResolvedValue({ messages: [{ role: "user", content: "question" }, { role: "assistant", content: "complete remote answer" }], attachments: [] });
    await store.getState().syncWorkBuddyThread();
    expect(fake.history).toHaveBeenCalledWith("task-a", expect.any(AbortSignal));
    expect(store.getState().messages.map((message) => message.content)).toEqual(["question", "complete remote answer"]);
    expect(store.getState().messages.map((message) => message.id)).toEqual(ids);
    expect(fake.runs).toHaveLength(1);
  });
  it("discards delayed history after account switching", async () => {
    store.getState().sendMessage("private");
    emit(0, { type: "workbuddy_session", session: { mode: "cloud", taskId: "task-a" } });
    store.getState().stopStreaming(); await Promise.resolve();
    let resolve!: (value: { messages: { role: "assistant"; content: string }[]; attachments: [] }) => void;
    fake.history.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    const pending = store.getState().syncWorkBuddyThread();
    store.getState().switchUser("other-user");
    resolve({ messages: [{ role: "assistant", content: "private late answer" }], attachments: [] }); await pending;
    expect(JSON.stringify(store.getState().conversations)).not.toContain("private");
  });
  it("keeps legacy local history readable and requires a new cloud conversation to send", () => {
    store.setState({ activeConversationId: "legacy", messages: [], conversations: [{ id: "legacy", title: "Local", provider: "workbuddy", messages: [], createdAt: 1, updatedAt: 1 }] });
    store.getState().sendMessage("must not attach"); expect(fake.runs).toHaveLength(0);
    store.getState().clearMessages(); store.getState().sendMessage("new cloud");
    expect(fake.runs).toHaveLength(1);
    expect(store.getState().conversations.find((entry) => entry.id === store.getState().activeConversationId)?.workbuddySession).toEqual({ mode: "cloud" });
  });
});
