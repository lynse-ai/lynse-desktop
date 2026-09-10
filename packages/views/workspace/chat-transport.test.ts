/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PollChatTransport,
  chatPollTiming,
  extractConfirmFromText,
  normalizeHumanSupportLink,
  normalizePollAttachment,
  normalizePollConfirmation,
  setChatDirectBaseUrl,
  type SendChatOptions,
} from "./chat-transport";
import { ApiError } from "@lynse/core/api";

const apiMocks = vi.hoisted(() => ({
  post: vi.fn(),
  get: vi.fn(),
}));

vi.mock("@lynse/core/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@lynse/core/api")>();
  return { ...actual, api: () => ({ post: apiMocks.post, get: apiMocks.get }) };
});

afterEach(() => {
  vi.clearAllMocks();
});

beforeEach(() => {
  // Shrink the waits so suites stay fast; the real defaults live in chatPollTiming.
  chatPollTiming.intervalMs = 1;
  chatPollTiming.submitRetryDelayMs = 1;
  // One-shot typewriter and a single pending stage keep event sequences
  // simple; dedicated tests below exercise the real slicing and staging.
  chatPollTiming.typewriterTickMs = 1;
  chatPollTiming.typewriterMaxMs = 1;
  chatPollTiming.pendingStageMs = [0];
});

function sendOptions(overrides: Partial<SendChatOptions> = {}): SendChatOptions {
  return {
    query: "hello",
    sessionId: "session-1",
    userId: "user-1",
    fileIds: [],
    userSpecifiedFile: false,
    onEvent: vi.fn(),
    ...overrides,
  };
}

describe("normalizePollConfirmation", () => {
  it("maps the cloud card shape (title/actions/confirmToken) onto ChatConfirm", () => {
    expect(
      normalizePollConfirmation({
        type: "confirmation",
        kind: "clear_todos_confirm",
        title: "清理待办",
        confirmToken: "card-token-1",
        riskLevel: "high",
        actions: [
          { label: "确认清理", value: "confirm" },
          { label: "先不了", value: "cancel" },
        ],
      }),
    ).toEqual({
      question: "清理待办",
      options: [
        { label: "确认清理", value: "confirm" },
        { label: "先不了", value: "cancel" },
      ],
      kind: "clear_todos_confirm",
      confirmToken: "card-token-1",
      riskLevel: "high",
    });
  });

  it("accepts the legacy a2UI shape (question/options)", () => {
    expect(
      normalizePollConfirmation({
        question: "继续吗?",
        options: [
          { label: "A. 继续", value: "继续" },
          { label: "B. 停", value: "停" },
        ],
      }),
    ).toMatchObject({ question: "继续吗?", confirmToken: undefined });
  });

  it("returns null for junk but keeps title-only cards", () => {
    expect(normalizePollConfirmation(null)).toBeNull();
    expect(normalizePollConfirmation({})).toBeNull();
    expect(normalizePollConfirmation({ title: "清理待办" })).toMatchObject({
      question: "清理待办",
      options: [],
    });
  });
});

describe("normalizePollAttachment / normalizeHumanSupportLink", () => {
  it("maps filename/kind/download_url onto ChatAttachment", () => {
    expect(
      normalizePollAttachment({
        id: "abc",
        kind: "pdf",
        filename: "report.pdf",
        download_url: "https://example.test/report.pdf",
      }),
    ).toEqual({
      id: "abc",
      name: "report.pdf",
      type: "pdf",
      url: "https://example.test/report.pdf",
      downloadUrl: "https://example.test/report.pdf",
    });
    expect(normalizePollAttachment("junk")).toBeNull();
    expect(normalizePollAttachment({})).toBeNull();
  });

  it("keeps the human support url and label", () => {
    expect(normalizeHumanSupportLink({ label: "联系人工", url: "https://help" })).toEqual({
      url: "https://help",
      label: "联系人工",
    });
    expect(normalizeHumanSupportLink({ label: "no url" })).toBeUndefined();
    expect(normalizeHumanSupportLink(null)).toBeUndefined();
  });
});

describe("extractConfirmFromText", () => {
  it("still detects A/B/C menus in plain text", () => {
    const confirm = extractConfirmFromText("请选择操作:\nA) 重启设备\nB) 暂不处理");
    expect(confirm?.options.map((o) => o.value)).toEqual(["重启设备", "暂不处理"]);
  });
});

describe("PollChatTransport", () => {
  it("submits, polls pending, then emits done plus the confirmation card", async () => {
    apiMocks.post.mockResolvedValue({ task_id: "task-1", status: "pending" });
    apiMocks.get
      .mockResolvedValueOnce({ status: "pending", text: null, sources: [] })
      .mockResolvedValueOnce({
        status: "done",
        text: "请确认清理待办",
        sources: ["周会"],
        attachments: [{ kind: "pdf", filename: "report.pdf", download_url: "https://x/report.pdf" }],
        human_support_link: null,
        confirmation: {
          type: "confirmation",
          kind: "clear_todos_confirm",
          title: "清理待办",
          confirmToken: "card-token-1",
          riskLevel: "high",
          actions: [
            { label: "确认", value: "yes" },
            { label: "取消", value: "no" },
          ],
        },
        error: null,
      });

    const transport = new PollChatTransport();
    const onEvent = vi.fn();
    await transport.send(sendOptions({ onEvent }));

    expect(apiMocks.post).toHaveBeenCalledTimes(1);
    // api().post(path, body) — the body is the second argument.
    const body = apiMocks.post.mock.calls[0]![1] as Record<string, unknown>;
    expect(body).toMatchObject({
      query: "hello",
      sessionId: "session-1",
    });

    const types = onEvent.mock.calls.map((call) => (call[0] as { type: string }).type);
    expect(types).toEqual(["status", "content", "done", "confirm"]);

    const events = onEvent.mock.calls.map((call) => call[0] as Record<string, unknown>);
    const done = events.find((event) => event.type === "done")!;
    expect(done.text).toBe("请确认清理待办");
    expect(done.sources).toEqual(["周会"]);
    expect((done.attachments as unknown[])[0]).toMatchObject({ name: "report.pdf", type: "pdf" });

    const confirm = events.find((event) => event.type === "confirm")!;
    expect((confirm.confirm as { confirmToken?: string }).confirmToken).toBe("card-token-1");
  });

  it("sends fileIds / confirm token / token only when relevant", async () => {
    apiMocks.post.mockResolvedValue({ task_id: "task-1", status: "pending" });
    apiMocks.get.mockResolvedValue({ status: "done", text: "ok" });

    const transport = new PollChatTransport();
    await transport.send(
      sendOptions({
        fileIds: ["f1", "f2"],
        userSpecifiedFile: true,
        token: "jwt",
        confirmToken: "card-token-9",
      }),
    );

    const body = apiMocks.post.mock.calls[0]![1] as Record<string, unknown>;
    expect(body).toEqual({
      query: "hello",
      sessionId: "session-1",
      token: "jwt",
      fileIds: ["f1", "f2"],
      confirm_token: "card-token-9",
      confirmToken: "card-token-9",
    });
  });

  it("omits file fields when no files are in scope", async () => {
    apiMocks.post.mockResolvedValue({ task_id: "task-1", status: "pending" });
    apiMocks.get.mockResolvedValue({ status: "done", text: "ok" });

    const transport = new PollChatTransport();
    await transport.send(sendOptions());

    const body = apiMocks.post.mock.calls[0]![1] as Record<string, unknown>;
    expect(body.fileIds).toBeUndefined();
    expect(body.confirm_token).toBeUndefined();
    expect(body.confirmToken).toBeUndefined();
  });

  it("surfaces the backend error text for status=error turns", async () => {
    apiMocks.post.mockResolvedValue({ task_id: "task-1", status: "pending" });
    apiMocks.get.mockResolvedValue({ status: "error", error: "当前系统繁忙，请稍后重试。" });

    const onEvent = vi.fn();
    await new PollChatTransport().send(sendOptions({ onEvent }));

    expect(onEvent).toHaveBeenCalledWith({
      type: "error",
      message: "当前系统繁忙，请稍后重试。",
    });
  });

  it("stops with an expiry message when the task 404s", async () => {
    apiMocks.post.mockResolvedValue({ task_id: "task-1", status: "pending" });
    apiMocks.get.mockRejectedValue(new ApiError(404, '{"detail":"任务不存在或已过期"}'));

    const onEvent = vi.fn();
    await new PollChatTransport().send(sendOptions({ onEvent }));

    expect(onEvent).toHaveBeenCalledWith({ type: "error", message: "结果已过期，请重新发送" });
  });

  it("retries a 503 submit with backoff before succeeding", async () => {
    apiMocks.post
      .mockRejectedValueOnce(new ApiError(503, "busy"))
      // camelCase taskId (gateway DTO spelling) must work too.
      .mockResolvedValueOnce({ taskId: "task-1", status: "pending" });
    apiMocks.get.mockResolvedValue({ status: "done", text: "ok" });

    const onEvent = vi.fn();
    await new PollChatTransport().send(sendOptions({ onEvent }));

    expect(apiMocks.post).toHaveBeenCalledTimes(2);
    expect(onEvent.mock.calls.map((c) => (c[0] as { type: string }).type)).toEqual([
      "status",
      "content",
      "done",
    ]);
  });

  it("maps submit failures onto readable errors and never polls", async () => {
    apiMocks.post.mockRejectedValue(new ApiError(400, '{"detail":"缺少 Lynse token"}'));
    apiMocks.get.mockResolvedValue({ status: "done", text: "ok" });

    const onEvent = vi.fn();
    await new PollChatTransport().send(sendOptions({ onEvent }));

    expect(apiMocks.get).not.toHaveBeenCalled();
    expect(onEvent).toHaveBeenCalledWith({ type: "error", message: "缺少 Lynse token" });
  });

  it("maps the gateway busy envelope onto readable copy and retries first", async () => {
    apiMocks.post.mockRejectedValue(
      new ApiError(500, '{"code":500,"msg":"system.error.busy","data":null}'),
    );

    const onEvent = vi.fn();
    await new PollChatTransport().send(sendOptions({ onEvent }));

    // Busy is retryable: initial submit plus the backoff attempts.
    expect(apiMocks.post).toHaveBeenCalledTimes(1 + chatPollTiming.maxSubmitRetries);
    expect(onEvent).toHaveBeenCalledWith({
      type: "error",
      message: "当前使用人数较多，请稍后再试",
    });
  });

  it("recovers when the busy envelope clears after a retry", async () => {
    apiMocks.post
      .mockRejectedValueOnce(new ApiError(503, '{"code":503,"msg":"system.error.busy","data":null}'))
      .mockResolvedValueOnce({ task_id: "task-1", status: "pending" });
    apiMocks.get.mockResolvedValue({ status: "done", text: "ok" });

    const onEvent = vi.fn();
    await new PollChatTransport().send(sendOptions({ onEvent }));

    expect(apiMocks.post).toHaveBeenCalledTimes(2);
    expect(onEvent.mock.calls.map((c) => (c[0] as { type: string }).type)).toEqual([
      "status",
      "content",
      "done",
    ]);
  });

  it("humanizes raw backend error keys from the task result", async () => {
    apiMocks.post.mockResolvedValue({ task_id: "task-1", status: "pending" });
    apiMocks.get.mockResolvedValue({ status: "error", error: "system.error.busy" });

    const onEvent = vi.fn();
    await new PollChatTransport().send(sendOptions({ onEvent }));

    expect(onEvent).toHaveBeenCalledWith({
      type: "error",
      message: "当前使用人数较多，请稍后再试",
    });
  });

  it("falls back to generic copy for unknown backend error keys", async () => {
    apiMocks.post.mockResolvedValue({ task_id: "task-1", status: "pending" });
    apiMocks.get.mockResolvedValue({ status: "error", error: "system.error.invite_only" });

    const onEvent = vi.fn();
    await new PollChatTransport().send(sendOptions({ onEvent }));

    expect(onEvent).toHaveBeenCalledWith({ type: "error", message: "生成失败，请稍后重试" });
  });

  it("emits a timeout error when the deadline passes while pending", async () => {
    chatPollTiming.deadlineMs = 1;
    apiMocks.post.mockResolvedValue({ task_id: "task-1", status: "pending" });
    apiMocks.get.mockResolvedValue({ status: "pending", text: null });

    const onEvent = vi.fn();
    await new PollChatTransport().send(sendOptions({ onEvent }));

    expect(onEvent).toHaveBeenCalledWith({ type: "error", message: "回复生成超时，请重新发送" });
    chatPollTiming.deadlineMs = 190_000;
  });

  it("cancel() stops the loop and resolves the turn quietly", async () => {
    apiMocks.post.mockResolvedValue({ task_id: "task-1", status: "pending" });
    apiMocks.get.mockResolvedValue({ status: "pending", text: null });

    const transport = new PollChatTransport();
    const onEvent = vi.fn();
    const sending = transport.send(sendOptions({ onEvent }));

    // Wait until the first GET is in flight, then stop the turn.
    await vi.waitFor(() => expect(apiMocks.get).toHaveBeenCalled());
    transport.cancel();
    await sending;

    // Only the pending stage caption may have fired; the turn settles with
    // no content, done, or error.
    const types = onEvent.mock.calls.map((call) => (call[0] as { type: string }).type);
    expect(types.every((type) => type === "status")).toBe(true);
  });

  it("replays the finished answer as typewriter content deltas before done", async () => {
    chatPollTiming.typewriterTickMs = 1;
    chatPollTiming.typewriterMaxMs = 8;
    apiMocks.post.mockResolvedValue({ task_id: "task-1", status: "pending" });
    apiMocks.get.mockResolvedValue({
      status: "done",
      text: "一二三四五六七八九十",
      sources: [],
      attachments: [],
    });

    const onEvent = vi.fn();
    await new PollChatTransport().send(sendOptions({ onEvent }));

    const events = onEvent.mock.calls.map(
      (call) => call[0] as { type: string; delta?: string; text?: string },
    );
    const types = events.map((event) => event.type);
    const deltas = events.filter((event) => event.type === "content").map((event) => event.delta!);
    // Slices arrive in order, reassemble exactly, and span several events.
    expect(deltas.join("")).toBe("一二三四五六七八九十");
    expect(deltas.length).toBeGreaterThan(1);
    // done still carries the full text and lands right after the last slice.
    expect(types.indexOf("done")).toBe(types.lastIndexOf("content") + 1);
    expect(events[types.indexOf("done")]!.text).toBe("一二三四五六七八九十");
  });

  it("advances pending stage captions while the turn stays pending", async () => {
    chatPollTiming.intervalMs = 1;
    chatPollTiming.pendingStageMs = [0, 4, 8];
    chatPollTiming.deadlineMs = 40;
    apiMocks.post.mockResolvedValue({ task_id: "task-1", status: "pending" });
    apiMocks.get.mockResolvedValue({ status: "pending", text: null });

    const onEvent = vi.fn();
    await new PollChatTransport().send(sendOptions({ onEvent }));
    chatPollTiming.deadlineMs = 190_000;

    const statuses = onEvent.mock.calls
      .map((call) => call[0] as { type: string; text?: string })
      .filter((event) => event.type === "status")
      .map((event) => event.text!);
    expect(statuses).toEqual(["thinking", "researching", "composing"]);
    expect(onEvent).toHaveBeenCalledWith({ type: "error", message: "回复生成超时，请重新发送" });
  });

  it("cancel() mid-typewriter keeps the partial text and never emits done", async () => {
    chatPollTiming.typewriterTickMs = 5;
    chatPollTiming.typewriterMaxMs = 60_000;
    apiMocks.post.mockResolvedValue({ task_id: "task-1", status: "pending" });
    apiMocks.get.mockResolvedValue({ status: "done", text: "字".repeat(300), sources: [] });

    const transport = new PollChatTransport();
    const onEvent = vi.fn();
    const sending = transport.send(sendOptions({ onEvent }));

    await vi.waitFor(() =>
      expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({ type: "content" })),
    );
    transport.cancel();
    await sending;

    const types = onEvent.mock.calls.map((call) => (call[0] as { type: string }).type);
    expect(types).not.toContain("done");
    expect(types).not.toContain("error");
  });
});

describe("direct lynclaw base URL", () => {
  // Fresh Response per call — undici bodies are single-use.
  const ok = (payload: unknown, status = 200) =>
    new Response(JSON.stringify(payload), { status });

  afterEach(() => {
    setChatDirectBaseUrl(null);
    vi.unstubAllGlobals();
  });

  it("posts the snake_case contract to the absolute lynclaw URL", async () => {
    setChatDirectBaseUrl("http://lynclaw.test:8003/");
    // POST then a terminal done GET, so send() always settles.
    const fetchFn = vi.fn().mockResolvedValueOnce(ok({ task_id: "task-9", status: "pending" }));
    fetchFn.mockImplementation(() => ok({ status: "done", text: "ok" }));
    vi.stubGlobal("fetch", fetchFn);

    const onEvent = vi.fn();
    await new PollChatTransport().send(sendOptions({ onEvent }));

    expect(fetchFn).toHaveBeenCalledTimes(2);
    const [url, init] = fetchFn.mock.calls[0] as unknown as [
      string,
      { method: string; body: string },
    ];
    expect(url).toBe("http://lynclaw.test:8003/api/chat/poll");
    expect(init.method).toBe("POST");
    const body = JSON.parse(init.body) as Record<string, unknown>;
    expect(body).toMatchObject({
      query: "hello",
      session_id: "session-1",
      user_id: "user-1",
    });
    expect(body.sessionId).toBeUndefined();
    expect(body.token).toBeUndefined();
    // The gateway client is never touched in direct mode.
    expect(apiMocks.post).not.toHaveBeenCalled();
  });

  it("polls the native task path and emits the done payload", async () => {
    setChatDirectBaseUrl("http://lynclaw.test:8003");
    const fetchFn = vi.fn();
    fetchFn
      .mockResolvedValueOnce(ok({ task_id: "task-9", status: "pending" }))
      .mockResolvedValueOnce(ok({ status: "pending", text: null, sources: [] }))
      .mockResolvedValueOnce(
        ok({
          status: "done",
          text: "你好老板",
          sources: ["周会"],
          attachments: [],
          human_support_link: null,
          confirmation: null,
          error: null,
        }),
      );
    vi.stubGlobal("fetch", fetchFn);

    const onEvent = vi.fn();
    await new PollChatTransport().send(sendOptions({ onEvent }));

    const getUrl = fetchFn.mock.calls[1]![0] as string;
    expect(getUrl).toBe("http://lynclaw.test:8003/api/chat/poll/task-9");
    expect(onEvent).toHaveBeenCalledWith({
      type: "done",
      text: "你好老板",
      sources: ["周会"],
      attachments: [],
      humanSupportLink: undefined,
    });
  });

  it("maps a 503 {detail} submit to the busy retry path", async () => {
    setChatDirectBaseUrl("http://lynclaw.test:8003");
    const fetchFn = vi.fn();
    fetchFn
      .mockResolvedValueOnce(ok({ detail: "身份校验失败，请稍后重试" }, 503))
      .mockResolvedValueOnce(ok({ task_id: "task-9", status: "pending" }))
      .mockResolvedValueOnce(ok({ status: "done", text: "ok" }));
    vi.stubGlobal("fetch", fetchFn);

    const onEvent = vi.fn();
    await new PollChatTransport().send(sendOptions({ onEvent }));

    // First POST failed with 503, retry succeeded.
    expect(fetchFn).toHaveBeenCalledTimes(3);
    expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({ type: "done" }));
  });
});
