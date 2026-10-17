/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@lynse/core/api";
import { StreamChatTransport, chatPollTiming, type SendChatOptions } from "./chat-transport";
import type { ChatStreamEvent } from "./types";

const requests = vi.hoisted(() => ({
  stream: vi.fn(), post: vi.fn(), get: vi.fn(),
  getAgentBaseUrl: vi.fn((): string | null => null),
}));
vi.mock("@lynse/core/api", async (importOriginal) => ({
  ...await importOriginal<typeof import("@lynse/core/api")>(),
  api: () => requests,
}));

const defaultTiming = { ...chatPollTiming };
beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers();
  Object.assign(chatPollTiming, defaultTiming, { typewriterMaxMs: 1, typewriterTickMs: 1 });
  requests.getAgentBaseUrl.mockReturnValue(null);
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  Object.assign(chatPollTiming, defaultTiming);
});

function options(overrides: Partial<SendChatOptions> = {}): SendChatOptions {
  return {
    query: "hello", sessionId: "same-session", userId: "token-derived-user",
    fileIds: [], userSpecifiedFile: false, onEvent: vi.fn(), ...overrides,
  };
}

/** Drive callbacks independently of abort to test even misbehaving adapters. */
function queueStream(frames: unknown[] = [], outcome: Error | "complete" | "open" = "complete") {
  const controller = new AbortController();
  let chunk!: (payload: string) => void;
  let fail!: (error: Error) => void;
  let complete!: () => void;
  requests.stream.mockImplementationOnce((
    _path: string, _body: unknown, onChunk: typeof chunk, onError: typeof fail, onComplete: typeof complete,
  ) => {
    chunk = onChunk; fail = onError; complete = onComplete;
    for (const frame of frames) chunk(JSON.stringify(frame));
    if (outcome instanceof Error) fail(outcome);
    else if (outcome === "complete") complete();
    return controller;
  });
  return { controller, chunk: (frame: unknown) => chunk(JSON.stringify(frame)), fail: (error: Error) => fail(error), complete: () => complete() };
}

function events(onEvent: ReturnType<typeof vi.fn>): ChatStreamEvent[] {
  return onEvent.mock.calls.map(([event]) => event as ChatStreamEvent);
}

describe("StreamChatTransport resilience", () => {
  it.each([null, "https://agent.invalid"])("keeps the selected meeting explicit on the stream route (%s)", async (agentBase) => {
    requests.getAgentBaseUrl.mockReturnValue(agentBase);
    queueStream([{ type: "done", text: "ok" }]);
    await new StreamChatTransport().send(options({ fileIds: ["selected-meeting"], userSpecifiedFile: true }));

    expect(requests.stream.mock.calls[0]![0]).toBe(agentBase ? "/api/chat/stream" : "/api/business/ai/chat/stream");
    expect(requests.stream.mock.calls[0]![1]).toMatchObject({
      fileIds: ["selected-meeting"], userSpecifiedFile: true,
    });
  });

  it("backs off 503/429 by 2s then 4s, with an unchanged request body", async () => {
    queueStream([], new ApiError(503, "busy"));
    queueStream([], new ApiError(429, "busy"));
    queueStream([{ type: "content", content: "ok" }, { type: "done", text: "ok" }]);
    const onEvent = vi.fn();
    const sending = new StreamChatTransport().send(options({
      token: "jwt", fileIds: ["selected-meeting"], userSpecifiedFile: true, onEvent,
    }));

    await vi.advanceTimersByTimeAsync(1_999);
    expect(requests.stream).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(requests.stream).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(3_999);
    expect(requests.stream).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    await sending;
    expect(requests.stream).toHaveBeenCalledTimes(3);
    expect(requests.stream.mock.calls.map((call) => call[1])).toEqual(Array(3).fill({
      query: "hello", sessionId: "same-session", token: "jwt", requestId: expect.any(String),
      fileIds: ["selected-meeting"], userSpecifiedFile: true,
    }));
    expect(new Set(requests.stream.mock.calls.map((call) => call[1].requestId)).size).toBe(1);
    expect(events(onEvent).filter((event) => event.type === "status").map((event) => event.text)).toEqual([
      "submitting", "retrying", "submitting", "retrying", "submitting",
    ]);
    expect(events(onEvent).filter((event) => event.type === "error")).toEqual([]);
    expect(requests.post).not.toHaveBeenCalled();
  });

  it.each([503, 429, 200])("exhausts busy retries (%s) without amplifying load through polling", async (status) => {
    for (let i = 0; i < 3; i += 1) queueStream([], new ApiError(status, '{"msg":"system.error.busy"}'));
    const onEvent = vi.fn();
    const sending = new StreamChatTransport().send(options({ onEvent }));
    await vi.advanceTimersByTimeAsync(6_000);
    await sending;
    expect(requests.stream).toHaveBeenCalledTimes(3);
    expect(requests.post).not.toHaveBeenCalled();
    expect(events(onEvent).filter((event) => event.type === "error")).toEqual([{ type: "error", message: "当前使用人数较多，请稍后再试" }]);
  });

  it.each([400, 401, 403, 503])("preserves identity failures (%s) without retry or recovery", async (status) => {
    queueStream([], new ApiError(status, '{"detail":"身份校验失败"}'));
    const onEvent = vi.fn();
    await new StreamChatTransport().send(options({ onEvent }));
    expect(requests.stream).toHaveBeenCalledTimes(1);
    expect(requests.post).not.toHaveBeenCalled();
    expect(events(onEvent).filter((event) => event.type === "error")).toEqual([{
      type: "error", message: status === 503 ? "登录状态已失效，请重新登录后再试" : "身份校验失败",
    }]);
  });

  it("shows a missing CloudBase login-binding interface once without falling back to polling", async () => {
    queueStream([], new ApiError(412, "助手服务需要更新，请更新后重试"));
    const onEvent = vi.fn();
    await new StreamChatTransport().send(options({ token: "jwt", onEvent }));
    expect(events(onEvent).filter((event) => event.type === "error")).toEqual([
      { type: "error", message: "助手服务需要更新，请更新后重试" },
    ]);
    expect(requests.stream).toHaveBeenCalledOnce();
    expect(requests.post).not.toHaveBeenCalled();
  });

  it("treats explicit SSE errors as terminal even if the socket stays open", async () => {
    const attempt = queueStream([{ type: "content", content: "partial" }, { type: "error", error: "system.error.busy" }], "open");
    const onEvent = vi.fn();
    await new StreamChatTransport().send(options({ onEvent }));
    expect(attempt.controller.signal.aborted).toBe(true);
    expect(requests.post).not.toHaveBeenCalled();
    expect(events(onEvent).at(-1)).toEqual({ type: "error", message: "当前使用人数较多，请稍后再试" });
  });

  it.each(["complete", new TypeError("socket dropped")])("recovers a dropped stream (%s) in the same turn without appending duplicate text", async (outcome) => {
    queueStream([{ type: "thinking", content: "working" }, { type: "content", content: "partial" }], outcome as Error | "complete");
    requests.post.mockResolvedValue({ task_id: "recovery-task" });
    requests.get.mockResolvedValue({
      status: "done", text: "different final answer", sources: ["meeting"],
      attachments: [{ filename: "report.pdf", download_url: "https://files.invalid/report.pdf" }],
      human_support_link: { url: "https://support.invalid" },
      confirmation: { title: "Confirm", confirmToken: "new-card", actions: [{ label: "Yes", value: "yes" }] },
    });
    const onEvent = vi.fn();
    await new StreamChatTransport().send(options({
      token: "jwt", confirmToken: "answer-token", fileIds: ["f1"], userSpecifiedFile: true,
      modelOverride: { preset: "deepseek-official", model: "deepseek-flash" }, onEvent,
    }));
    expect(requests.post).toHaveBeenCalledTimes(1);
    expect(requests.post.mock.calls[0]![1]).toEqual(requests.stream.mock.calls[0]![1]);
    expect(requests.post.mock.calls[0]![1]).toMatchObject({ fileIds: ["f1"], userSpecifiedFile: true });
    expect(requests.post.mock.calls[0]![1]).not.toHaveProperty("userId");
    expect(events(onEvent).filter((event) => event.type === "content")).toEqual([{ type: "content", delta: "partial" }]);
    expect(events(onEvent).filter((event) => event.type === "done")).toEqual([expect.objectContaining({
      text: "different final answer", sources: ["meeting"],
      attachments: [expect.objectContaining({ name: "report.pdf" })],
      humanSupportLink: { url: "https://support.invalid" },
    })]);
    expect(events(onEvent).at(-1)).toMatchObject({ type: "confirm", confirm: { confirmToken: "new-card" } });
    expect(events(onEvent).filter((event) => event.type === "error")).toEqual([]);
  });

  it("resumes a pollable stream task without submitting again and ignores late stream callbacks", async () => {
    requests.getAgentBaseUrl.mockReturnValue("https://agent.invalid");
    const attempt = queueStream([{ type: "meta", taskId: "same/task" }, { type: "content", content: "part" }], new TypeError("dropped"));
    requests.get.mockResolvedValue({ status: "done", text: "partial final" });
    const onEvent = vi.fn();
    await new StreamChatTransport().send(options({ onEvent }));
    attempt.chunk({ type: "content", content: "stale" });
    attempt.fail(new Error("late error"));
    expect(requests.post).not.toHaveBeenCalled();
    expect(requests.get).toHaveBeenCalledWith("/api/chat/poll/same%2Ftask", { baseUrl: "https://agent.invalid", signal: expect.any(AbortSignal) });
    expect(events(onEvent).filter((event) => event.type === "content")).toEqual([{ type: "content", delta: "part" }]);
    expect(events(onEvent).at(-1)).toMatchObject({ type: "done", text: "partial final" });
  });

  it("falls back when the gateway has no SSE route and streams every pending poll delta", async () => {
    queueStream([], new ApiError(404, "Not Found"));
    requests.post.mockResolvedValue({ taskId: "poll-only" });
    requests.get.mockResolvedValueOnce({ status: "pending", text: "a" })
      .mockResolvedValueOnce({ status: "pending", text: "ab" })
      .mockResolvedValueOnce({ status: "done", text: "abc" });
    const onEvent = vi.fn();
    const sending = new StreamChatTransport().send(options({ onEvent }));
    await vi.advanceTimersByTimeAsync(1_000);
    await sending;
    expect(requests.post.mock.calls[0]![0]).toBe("/api/business/ai/chat/poll");
    expect(events(onEvent).filter((event) => event.type === "content").map((event) => event.delta)).toEqual(["a", "b", "c"]);
  });

  it("keeps done and trailing confirmation frames when the connection subsequently fails", async () => {
    queueStream([
      { type: "done", text: "Confirm please" },
      { type: "confirmation", title: "Choose", confirmToken: "late-card", actions: [{ label: "Yes", value: "yes" }] },
    ], new TypeError("closed after done"));
    const onEvent = vi.fn();
    await new StreamChatTransport().send(options({ onEvent }));
    expect(events(onEvent).map((event) => event.type)).toEqual(["status", "done", "confirm"]);
    expect(requests.post).not.toHaveBeenCalled();
  });

  it("bounds stalled streams and busy backoff with one 190-second deadline", async () => {
    queueStream([], new ApiError(503, "busy"));
    const stalled = queueStream([], "open");
    const onEvent = vi.fn();
    const sending = new StreamChatTransport().send(options({ onEvent }));
    await vi.advanceTimersByTimeAsync(189_999);
    expect(events(onEvent).filter((event) => event.type === "error")).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    await sending;
    expect(stalled.controller.signal.aborted).toBe(true);
    expect(events(onEvent).filter((event) => event.type === "error")).toEqual([{ type: "error", message: "回复生成超时，请重新发送" }]);
    expect(requests.post).not.toHaveBeenCalled();
  });

  it("gives polling only the time remaining in the original deadline", async () => {
    const attempt = queueStream([], "open");
    requests.post.mockResolvedValue({ task_id: "task" });
    // Even an adapter ignoring abort must not hold the outer turn open.
    requests.get.mockImplementation(() => new Promise(() => {}));
    const onEvent = vi.fn();
    const sending = new StreamChatTransport().send(options({ onEvent }));
    await vi.advanceTimersByTimeAsync(189_000);
    attempt.complete();
    await vi.advanceTimersByTimeAsync(0);
    expect(requests.get).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    await sending;
    expect(requests.get.mock.calls[0]![1].signal.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    expect(events(onEvent).filter((event) => event.type === "error")).toEqual([{ type: "error", message: "回复生成超时，请重新发送" }]);
  });

  it.each(["cancel", "signal"])("settles a stream quietly through %s without waiting for an adapter callback", async (method) => {
    const attempt = queueStream([{ type: "content", content: "partial" }], "open");
    const transport = new StreamChatTransport();
    const signal = new AbortController();
    const onEvent = vi.fn();
    const sending = transport.send(options({ signal: signal.signal, onEvent }));
    if (method === "cancel") transport.cancel();
    else signal.abort();
    await sending;
    attempt.chunk({ type: "done", text: "late answer" });
    attempt.complete();
    expect(attempt.controller.signal.aborted).toBe(true);
    expect(events(onEvent).map((event) => event.type)).toEqual(["status", "content"]);
    expect(requests.post).not.toHaveBeenCalled();
  });

  it("never starts an already cancelled turn", async () => {
    const controller = new AbortController();
    controller.abort();
    const onEvent = vi.fn();
    await new StreamChatTransport().send(options({ signal: controller.signal, onEvent }));
    expect(onEvent).not.toHaveBeenCalled();
    expect(requests.stream).not.toHaveBeenCalled();
    expect(requests.post).not.toHaveBeenCalled();
  });

  it("explicitly stops a known server task while stream-drop recovery leaves it running", async () => {
    const attempt = queueStream([{ type: "task", task_id: "same-task" }], "open");
    requests.post.mockResolvedValue({ status: "error" });
    const transport = new StreamChatTransport();
    const sending = transport.send(options({ token: "jwt", requestId: "fixed-turn" }));
    expect(requests.stream.mock.calls[0]![1].requestId).toBe("fixed-turn");
    transport.cancel();
    await sending;
    expect(attempt.controller.signal.aborted).toBe(true);
    expect(requests.post).toHaveBeenCalledWith("/api/business/ai/chat/poll/same-task/cancel", {}, {
      baseUrl: undefined, sessionToken: "jwt",
    });
    expect(requests.get).not.toHaveBeenCalled();
  });

  it("cancels busy backoff without retrying", async () => {
    queueStream([], new ApiError(503, "busy"));
    const transport = new StreamChatTransport();
    const onEvent = vi.fn();
    const sending = transport.send(options({ onEvent }));
    await vi.advanceTimersByTimeAsync(500);
    transport.cancel();
    await vi.advanceTimersByTimeAsync(50);
    await sending;
    expect(requests.stream).toHaveBeenCalledTimes(1);
    expect(requests.post).not.toHaveBeenCalled();
    expect(events(onEvent).filter((event) => event.type === "error")).toEqual([]);
  });

  it("cancels an in-flight poll recovery and ignores its late result", async () => {
    queueStream([], new TypeError("offline"));
    requests.post.mockResolvedValue({ task_id: "task" });
    let finish!: (result: unknown) => void;
    requests.get.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const transport = new StreamChatTransport();
    const onEvent = vi.fn();
    const sending = transport.send(options({ onEvent }));
    await vi.advanceTimersByTimeAsync(0);
    transport.cancel();
    await sending;
    expect(vi.getTimerCount()).toBe(0);
    finish({ status: "done", text: "too late" });
    await vi.advanceTimersByTimeAsync(0);
    expect(requests.get.mock.calls[0]![1].signal.aborted).toBe(true);
    expect(requests.post).toHaveBeenCalledWith("/api/business/ai/chat/poll/task/cancel", {}, expect.any(Object));
    expect(events(onEvent).filter((event) => ["content", "done", "error"].includes(event.type))).toEqual([]);
  });
});
