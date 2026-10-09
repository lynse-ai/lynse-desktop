import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ token: vi.fn(), create: vi.fn(), get: vi.fn(), artifacts: vi.fn() }));
vi.mock("@lynse/core/auth/workbuddy", async (original) => ({ ...await original<typeof import("@lynse/core/auth/workbuddy")>(), getWorkBuddyToken: mocks.token }));
vi.mock("@lynse/core/workbuddy", async (original) => ({
  ...await original<typeof import("@lynse/core/workbuddy")>(),
  createWorkBuddyTask: mocks.create, getWorkBuddyTask: mocks.get, listWorkBuddyArtifacts: mocks.artifacts,
}));
import { setWorkBuddyAcpBridge, WorkBuddyAcpHttpError, type RpcMessage, type WorkBuddyAcpEvent } from "@lynse/core/workbuddy";
import { WorkBuddyCloudChatTransport, workBuddyPermission, workbuddyCloudTiming } from "./workbuddy-cloud-chat-transport";
import type { ChatConfirm, ChatStreamEvent } from "./types";

const task = { task_id: "task-1", status: "idle", link: "https://acp.workbuddy.cn/sessions/task-1", token: "ticket-1" };
let receive: (event: WorkBuddyAcpEvent) => void;
let posts: RpcMessage[];
let onPrompt: (message: RpcMessage) => void | Promise<void>;
let onLoad: () => void;
let close = vi.fn(async () => {});
function push(message: Partial<RpcMessage>) { receive({ type: "data", data: `data: ${JSON.stringify({ jsonrpc: "2.0", ...message })}\n\n` }); }
function update(text: string, sessionUpdate = "agent_message_chunk") {
  push({ method: "session/update", params: { sessionId: task.task_id, update: { sessionUpdate, content: { type: "text", text } } } });
}
function setupBridge() {
  const open = vi.fn(async (_url: string, _token: string, listener: (event: WorkBuddyAcpEvent) => void) => {
    receive = listener;
    return { close, post: async (message: RpcMessage) => {
      posts.push(message);
      if (message.method === "initialize") push({ id: message.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } });
      else if (message.method === "session/load") { onLoad(); push({ id: message.id, result: {} }); }
      else if (message.method === "session/prompt") await onPrompt(message);
    } };
  });
  setWorkBuddyAcpBridge({ open }); return open;
}
function send(transport: WorkBuddyCloudChatTransport, events: ChatStreamEvent[], taskId?: string) {
  return transport.send({ query: "hello", sessionId: "local-chat", userId: "u1", fileIds: [], userSpecifiedFile: false,
    workbuddySession: { mode: "cloud", taskId }, onEvent: (event) => events.push(event) });
}
beforeEach(() => {
  vi.resetAllMocks(); posts = []; close = vi.fn(async () => {});
  mocks.token.mockResolvedValue({ authorized: true, scope: "user.task.readable user.task.invokable" });
  mocks.create.mockResolvedValue(task); mocks.get.mockResolvedValue(task); mocks.artifacts.mockResolvedValue([]);
  onLoad = () => { update("old question", "user_message_chunk"); update("old answer"); };
  onPrompt = (message) => { update("你"); update("好"); push({ id: message.id, result: { stopReason: "end_turn" } }); };
  setupBridge();
});
afterEach(() => { setWorkBuddyAcpBridge(null); vi.useRealTimers(); });

describe("WorkBuddy cloud chat", () => {
  it("saves the new task and streams only this turn, waiting for its RPC result", async () => {
    const events: ChatStreamEvent[] = [];
    await send(new WorkBuddyCloudChatTransport(), events);
    expect(mocks.create).toHaveBeenCalledExactlyOnceWith("hello");
    expect(posts.filter((message) => message.method).map((message) => message.method)).toEqual(["initialize", "session/load", "session/prompt"]);
    expect(posts[0]).toEqual({ jsonrpc: "2.0", id: 1, method: "initialize", params: {
      protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
    } });
    expect(posts.slice(0, 3).map((message) => message.id)).toEqual([1, 2, 3]);
    expect(events.find((event) => event.type === "workbuddy_session")).toEqual({ type: "workbuddy_session", session: { mode: "cloud", taskId: task.task_id } });
    expect(events.filter((event) => event.type === "content")).toEqual([{ type: "content", delta: "你" }, { type: "content", delta: "好" }]);
    expect(events.at(-1)).toMatchObject({ type: "done", text: "你好", workbuddyStopReason: "end_turn" });
    expect(close).toHaveBeenCalledOnce();
  });
  it("loads an existing task for follow-up without creating another task", async () => {
    await send(new WorkBuddyCloudChatTransport(), [], task.task_id);
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.get).toHaveBeenCalledWith(task.task_id);
    expect(posts.find((message) => message.method === "session/prompt")?.params?.sessionId).toBe(task.task_id);
  });
  it("restores the replay without prompting or approving historical requests", async () => {
    onLoad = () => {
      update("old question", "user_message_chunk"); update("old "); update("answer");
      push({ id: "old-approval", method: "session/request_permission", params: { sessionId: task.task_id, options: [{ optionId: "allow", name: "Allow" }] } });
    };
    const history = await new WorkBuddyCloudChatTransport().loadHistory(task.task_id);
    expect(history.messages).toEqual([{ role: "user", content: "old question" }, { role: "assistant", content: "old answer" }]);
    expect(posts.some((message) => message.method === "session/prompt")).toBe(false);
    expect(posts.find((message) => message.id === "old-approval")?.result).toEqual({ outcome: { outcome: "cancelled" } });
  });
  it("does not create a task for a grant missing cloud scopes", async () => {
    mocks.token.mockResolvedValue({ authorized: true, scope: "user.profile.readable" });
    const events: ChatStreamEvent[] = [];
    await send(new WorkBuddyCloudChatTransport(), events);
    expect(mocks.create).not.toHaveBeenCalled();
    expect(events).toEqual([expect.objectContaining({ type: "error", workbuddyAuthRequired: true })]);
  });
  it("renews a rejected connection ticket before submitting exactly one prompt", async () => {
    const open = setupBridge();
    open.mockRejectedValueOnce(new WorkBuddyAcpHttpError(401));
    mocks.get.mockResolvedValue({ ...task, token: "renewed" });
    const events: ChatStreamEvent[] = [];
    await send(new WorkBuddyCloudChatTransport(), events);
    expect(open).toHaveBeenCalledTimes(2);
    expect(open.mock.calls[1]?.[1]).toBe("renewed");
    expect(posts.filter((message) => message.method === "session/prompt")).toHaveLength(1);
    expect(events.at(-1)?.type).toBe("done");
  });
  it("never retries a prompt whose POST outcome is uncertain", async () => {
    onPrompt = () => { update("partial"); throw new WorkBuddyAcpHttpError(401); };
    const events: ChatStreamEvent[] = [];
    await send(new WorkBuddyCloudChatTransport(), events);
    expect(posts.filter((message) => message.method === "session/prompt")).toHaveLength(1);
    expect(mocks.get).not.toHaveBeenCalled();
    expect(events.at(-1)?.type).toBe("error");
  });
  it("answers approvals on the same RPC ID without sending a new prompt", async () => {
    let prompt!: RpcMessage;
    onPrompt = (message) => { prompt = message; push({ id: "approve-7", method: "session/request_permission", params: {
      sessionId: task.task_id, toolCall: { title: "Read a file", rawInput: { path: "/workspace/a" } },
      options: [{ name: "Allow once", optionId: "allow", kind: "allow_once" }, { name: "Reject", optionId: "reject", kind: "reject_once" }],
    } }); };
    const transport = new WorkBuddyCloudChatTransport(); const events: ChatStreamEvent[] = [];
    const pending = send(transport, events);
    await vi.waitFor(() => expect(events.some((event) => event.type === "confirm")).toBe(true));
    expect(events.some((event) => event.type === "done")).toBe(false);
    const confirm = (events.find((event) => event.type === "confirm") as { confirm: ChatConfirm }).confirm;
    await transport.answerConfirmation(confirm, "allow");
    expect(posts.find((message) => message.id === "approve-7")?.result).toEqual({ outcome: { outcome: "selected", optionId: "allow" } });
    update("Approved"); push({ id: prompt.id, result: { stopReason: "end_turn" } }); await pending;
    expect(posts.filter((message) => message.method === "session/prompt")).toHaveLength(1);
    expect(events).toContainEqual({ type: "confirm_resolved", requestId: "approve-7" });
  });
  it("cancels pending permissions and the upstream turn before closing", async () => {
    onPrompt = () => { push({ id: 99, method: "session/request_permission", params: { sessionId: task.task_id, options: [{ name: "Allow", optionId: "allow" }] } }); };
    const transport = new WorkBuddyCloudChatTransport(); const events: ChatStreamEvent[] = [];
    const pending = send(transport, events);
    await vi.waitFor(() => expect(events.some((event) => event.type === "confirm")).toBe(true));
    transport.cancel(); await pending;
    expect(posts.find((message) => message.id === 99)?.result).toEqual({ outcome: { outcome: "cancelled" } });
    expect(posts.at(-1)).toMatchObject({ method: "session/cancel", params: { sessionId: task.task_id } });
    expect(close).toHaveBeenCalledOnce();
    expect(events.some((event) => event.type === "error")).toBe(false);
  });
  it("keeps artifact-only replies and does not resurrect deleted SSE artifacts from older REST snapshots", async () => {
    let restore!: (artifacts: unknown[]) => void;
    mocks.artifacts.mockImplementationOnce(() => new Promise((resolve) => { restore = resolve; }));
    onPrompt = async (message) => {
      const artifact = { type: "plan", uri: "agent:///artifacts/plan.md", text: "# Plan" };
      push({ method: "_codebuddy.ai/artifact", params: { sessionId: task.task_id, event: "created", artifact } });
      push({ method: "_codebuddy.ai/artifact", params: { sessionId: task.task_id, event: "deleted", artifact } });
      restore([{ artifact }]); await Promise.resolve();
      push({ method: "_codebuddy.ai/artifact", params: { sessionId: task.task_id, event: "created", artifact: { ...artifact, uri: "agent:///artifacts/final.md", text: "# Final" } } });
      push({ id: message.id, result: { stopReason: "end_turn" } });
    };
    const events: ChatStreamEvent[] = []; await send(new WorkBuddyCloudChatTransport(), events);
    const done = events.find((event) => event.type === "done");
    expect(done).toMatchObject({ type: "done", text: "", attachments: [expect.objectContaining({ text: "# Final" })] });
  });
  it("preserves a non-success stopReason even when the turn has no text", async () => {
    onPrompt = (message) => { push({ id: message.id, result: { stopReason: "refusal" } }); };
    const events: ChatStreamEvent[] = []; await send(new WorkBuddyCloudChatTransport(), events);
    expect(events.at(-1)).toMatchObject({ type: "done", text: "", workbuddyStopReason: "refusal" });
  });
  it("normalizes multi-question forms and returns the selected answers on the originating request", async () => {
    let prompt!: RpcMessage;
    const request = { jsonrpc: "2.0" as const, id: "questions-1", method: "session/request_permission", params: {
      sessionId: task.task_id, toolCall: { title: "Choose", rawInput: { questions: [
        { question: "Pick one", options: [{ label: "A" }, { label: "B" }] },
        { question: "Pick many", multiSelect: true, options: ["X", "Y"] },
      ] } }, options: [{ name: "Answer", optionId: "answer" }],
    } };
    const confirm = workBuddyPermission(request)!;
    expect(confirm.workbuddy?.questions?.map((question) => question.id)).toEqual(["q_0", "q_1"]);
    onPrompt = (message) => { prompt = message; push(request); };
    const transport = new WorkBuddyCloudChatTransport(); const events: ChatStreamEvent[] = []; const pending = send(transport, events);
    await vi.waitFor(() => expect(events.some((event) => event.type === "confirm")).toBe(true));
    await transport.answerConfirmation(confirm, JSON.stringify({ q_0: "A", q_1: ["X", "Y"] }));
    expect(posts.find((message) => message.id === request.id)?.result).toEqual({ outcome: { outcome: "selected", optionId: "answer", answers: { q_0: "A", q_1: ["X", "Y"] } } });
    update("thanks"); push({ id: prompt.id, result: { stopReason: "end_turn" } }); await pending;
  });
  it("bounds task startup and retains the task ID for a manual reconnect", async () => {
    vi.useFakeTimers(); const previous = workbuddyCloudTiming.taskReadyMs;
    workbuddyCloudTiming.taskReadyMs = 1_000;
    mocks.create.mockResolvedValue({ task_id: task.task_id, status: "CREATING" });
    mocks.get.mockResolvedValue({ task_id: task.task_id, status: "CREATING" });
    try {
      const events: ChatStreamEvent[] = []; const pending = send(new WorkBuddyCloudChatTransport(), events);
      await vi.advanceTimersByTimeAsync(1_000); await pending;
      expect(events).toContainEqual({ type: "workbuddy_session", session: { mode: "cloud", taskId: task.task_id } });
      expect(events.at(-1)?.type).toBe("error");
      expect(posts).toEqual([]);
    } finally { workbuddyCloudTiming.taskReadyMs = previous; }
  });
});
