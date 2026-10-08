/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PollChatTransport,
  StreamChatTransport,
  chatPollTiming,
  extractConfirmFromText,
  normalizeHumanSupportLink,
  normalizePollAttachment,
  normalizePollConfirmation,
  parseChatStreamData,
  refreshAttachmentUrl,
  safeSliceEnd,
  type SendChatOptions,
} from "./chat-transport";
import { ApiError } from "@lynse/core/api";
import type { ChatStreamEvent } from "./types";

const apiMocks = vi.hoisted(() => ({
  post: vi.fn(),
  get: vi.fn(),
  stream: vi.fn(),
  getBaseUrl: vi.fn(() => "https://api.test.local"),
  getAgentBaseUrl: vi.fn((): string | null => null),
  getToken: vi.fn((): string | null => "session-token"),
}));

vi.mock("@lynse/core/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@lynse/core/api")>();
  return {
    ...actual,
    api: () => ({
      post: apiMocks.post,
      get: apiMocks.get,
      stream: apiMocks.stream,
      getBaseUrl: apiMocks.getBaseUrl,
      getAgentBaseUrl: apiMocks.getAgentBaseUrl,
      getToken: apiMocks.getToken,
    }),
  };
});

afterEach(() => {
  vi.clearAllMocks();
});

beforeEach(() => {
  // Shrink the waits so suites stay fast; the real defaults live in chatPollTiming.
  chatPollTiming.intervalMs = 1;
  chatPollTiming.intervalFastMs = 1;
  chatPollTiming.submitRetryDelayMs = 1;
  // One-shot typewriter and a single pending stage keep event sequences
  // simple; dedicated tests below exercise the real slicing and staging.
  chatPollTiming.typewriterTickMs = 1;
  chatPollTiming.typewriterMaxMs = 1;
  chatPollTiming.pendingStageMs = [0];
  // No dedicated agent backend unless a test opts in (mockReturnValue from a
  // previous test would otherwise leak past clearAllMocks).
  apiMocks.getAgentBaseUrl.mockReturnValue(null);
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
        expires_at: "2026-09-26T12:00:00Z",
      }),
    ).toEqual({
      id: "abc",
      name: "report.pdf",
      type: "pdf",
      url: "https://example.test/report.pdf",
      downloadUrl: "https://example.test/report.pdf",
      expiresAt: "2026-09-26T12:00:00Z",
    });
    expect(normalizePollAttachment("junk")).toBeNull();
    // lynclaw's CloudBase storage mode leaves expires_at empty — no field.
    expect(normalizePollAttachment({ kind: "image", download_url: "https://x/a.png" })).toEqual({
      id: undefined,
      name: undefined,
      type: "image",
      url: "https://x/a.png",
      downloadUrl: "https://x/a.png",
      expiresAt: undefined,
    });
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

describe("refreshAttachmentUrl", () => {
  const artifactId = "a".repeat(32);

  it("re-signs a lynclaw artifact on its own origin and returns the fresh url", async () => {
    apiMocks.post.mockResolvedValue({
      artifact_id: artifactId,
      download_url: "https://signed.example.com/fresh.png",
    });

    const url = await refreshAttachmentUrl(
      { id: artifactId, name: "pic.png", downloadUrl: "https://signed.example.com/stale.png" },
      { userId: "user-1" },
    );

    expect(url).toBe("https://signed.example.com/fresh.png");
    expect(apiMocks.post).toHaveBeenCalledWith(
      `/api/attachments/${artifactId}/download-url`,
      { user_id: "user-1", token: "session-token" },
      { baseUrl: undefined },
    );
  });

  it("skips attachments without a lynclaw artifact id", async () => {
    expect(
      await refreshAttachmentUrl({ id: "wb-local-1", downloadUrl: "https://x/a.pdf" }),
    ).toBeNull();
    expect(await refreshAttachmentUrl({ downloadUrl: "https://x/a.pdf" })).toBeNull();
    expect(apiMocks.post).not.toHaveBeenCalled();
  });

  it("returns null when the refresh endpoint fails (keep the old link)", async () => {
    apiMocks.post.mockRejectedValue(new ApiError(404, '{"detail":"no route"}'));

    const url = await refreshAttachmentUrl({ id: artifactId });

    expect(url).toBeNull();
  });
});

describe("extractConfirmFromText", () => {
  it("still detects A/B/C menus in plain text", () => {
    const confirm = extractConfirmFromText("请选择操作:\nA) 重启设备\nB) 暂不处理");
    expect(confirm?.options.map((o) => o.value)).toEqual(["重启设备", "暂不处理"]);
  });

  it("detects bracketed, fullwidth-paren and circled-key menus", () => {
    const bracketed = extractConfirmFromText("选择:\n[A] 导出 PDF\n[B] 导出 Word");
    expect(bracketed?.options.map((o) => o.value)).toEqual(["导出 PDF", "导出 Word"]);

    const fullwidth = extractConfirmFromText("（A）同意\n（B）拒绝");
    expect(fullwidth?.options.map((o) => o.value)).toEqual(["同意", "拒绝"]);

    const circled = extractConfirmFromText("请确认:\n① 全部删除\n② 仅删附件\n③ 取消");
    expect(circled?.options.map((o) => o.value)).toEqual(["全部删除", "仅删附件", "取消"]);
  });

  it("rejects malformed or ambiguous menus", () => {
    // Keys must be strictly sequential from the first key.
    expect(extractConfirmFromText("选一个:\nA) 甲\nC) 乙")).toBeNull();
    expect(extractConfirmFromText("选一个:\nB) 甲\nC) 乙")).toBeNull();
    // A single line is not a menu.
    expect(extractConfirmFromText("1) 只有这一项")).toBeNull();
    // More than 8 options is prose, not a menu.
    expect(
      extractConfirmFromText("列表:\nA) 1\nB) 2\nC) 3\nD) 4\nE) 5\nF) 6\nG) 7\nH) 8\nI) 9"),
    ).toBeNull();
    // Ordinary prose without list markers.
    expect(extractConfirmFromText("今天天气不错，我们去爬山吧，顺便带上午饭和水。")).toBeNull();
    // Note: the <6-character length guard is unreachable for real menus —
    // two options plus a newline are always ≥7 characters — so there is no
    // valid "too short" case to pin here.
  });

  // FIXED (2026-10-02): this was pinned as KNOWN MISFIRE (2026-09-19) — bare
  // numbers alone cannot distinguish a menu from an ordinary ordered list, so
  // the numeric branch now additionally requires choice phrasing in the
  // preamble (extractConfirmFromText's semantic gate).
  it("no longer reads plain numbered lists as menus", () => {
    // The originally pinned misfire: a suggestion list, not a menu.
    expect(
      extractConfirmFromText("提高会议效率的建议：\n1. 会前发议程\n2. 限制参会人数\n3. 会后跟进"),
    ).toBeNull();
    // The 2026-10-02 screenshot: markdown-styled difficulty list, no ask.
    expect(
      extractConfirmFromText(
        "项目的困难点主要集中在以下几个方面：\n## 核心困难\n\n1. **成本压不下去，低价必亏**\n" +
          "2. **海外市场只能走高端，低端路线难存活**\n3. **认证审核反复**\n4. **供应链议价能力弱**",
      ),
    ).toBeNull();
    // Bare numbered list with no preamble at all.
    expect(extractConfirmFromText("1. 甲方案\n2. 乙方案")).toBeNull();
    // Numbered list buried mid-answer with prose after it.
    expect(extractConfirmFromText("你想选哪个：\n1. 甲\n2. 乙\n\n以上仅供参考。")).toBeNull();
  });

  it("numbered menus still pop when the preamble asks for a choice", () => {
    // Strong cue: question mark + imperative.
    const ask = extractConfirmFromText("你想怎么处理？\n1) 重启设备\n2) 暂不处理");
    expect(ask?.options.map((o) => o.value)).toEqual(["重启设备", "暂不处理"]);

    // Soft second-person ask without an enumeration intro.
    const soft = extractConfirmFromText("你想：\n1. 全部删除\n2. 仅删附件");
    expect(soft?.options.map((o) => o.value)).toEqual(["全部删除", "仅删附件"]);
  });

  /** Deterministic PRNG so CI failures reproduce exactly. */
  function mulberry32(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  it("fuzz: valid menus are always detected and broken ones never are", () => {
    const rand = mulberry32(20260919);
    const words = ["确认", "取消", "导出", "删除", "重试", "稍后", "覆盖", "跳过", "继续", "终止"];
    const pick = () => words[Math.floor(rand() * words.length)]!;

    for (let i = 0; i < 150; i++) {
      const count = 2 + Math.floor(rand() * 5); // 2..6 options
      const decor = ["A) ", "（A）", "[A] ", "A、", "A."][Math.floor(rand() * 5)]!;
      const key = (n: number) => String.fromCharCode(65 + n);

      const items = Array.from({ length: count }, (_, n) => `${decor.replace("A", key(n))}${pick()}`);
      const valid = extractConfirmFromText(`请选择:\n${items.join("\n")}`);
      expect(valid, `valid menu case ${i}: ${items.join(" / ")}`).not.toBeNull();
      expect(valid?.options).toHaveLength(count);

      // Swap two adjacent keys — sequential order breaks, detection must fail.
      const broken = [...items];
      [broken[0], broken[1]] = [broken[1]!, broken[0]!];
      expect(
        extractConfirmFromText(`请选择:\n${broken.join("\n")}`),
        `broken menu case ${i}: ${broken.join(" / ")}`,
      ).toBeNull();
    }
  });
});

describe("PollChatTransport", () => {
  it("delivers structured connector cards from poll without deriving URLs from reply text", async () => {
    apiMocks.post.mockResolvedValue({ task_id: "connector-task", status: "pending" });
    apiMocks.get.mockResolvedValueOnce({ status: "done", text: "Connect Notion", connection_requests: [
      { request_id: "req-1", provider: "notion", provider_display_name: "Notion", status: "waiting_auth", action_url: "https://auth.invalid/start" },
      { request_id: "../invalid", provider: "notion", status: "waiting_auth" },
    ] });
    const onEvent = vi.fn();
    await new PollChatTransport().send(sendOptions({ onEvent }));
    expect(onEvent.mock.calls.find(([event]) => event.type === "done")?.[0].connectionRequests).toEqual([
      expect.objectContaining({ request_id: "req-1", action_url: "https://auth.invalid/start" }),
    ]);
  });

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

  it("emits attachments for attachment-only replies (the weekly-report PDF turn empties text)", async () => {
    apiMocks.post.mockResolvedValue({ task_id: "task-2", status: "pending" });
    apiMocks.get.mockResolvedValueOnce({
      status: "done",
      // lynclaw strips the body for pdf-only turns — the PDF speaks through
      // attachments[] alone, so the payload must pass through untouched.
      text: "",
      sources: [],
      attachments: [
        {
          artifact_id: "c".repeat(32),
          kind: "pdf",
          filename: "灵光记周报-2026-09-21_2026-09-27.pdf",
          download_url: "https://signed.example.com/weekly.pdf",
          expires_at: "",
        },
      ],
    });

    const onEvent = vi.fn();
    await new PollChatTransport().send(sendOptions({ onEvent }));

    const done = onEvent.mock.calls
      .map((call) => call[0] as Record<string, unknown>)
      .find((event) => event.type === "done")!;
    expect(done.text).toBe("");
    expect(done.attachments).toEqual([
      {
        id: "c".repeat(32),
        name: "灵光记周报-2026-09-21_2026-09-27.pdf",
        type: "pdf",
        url: "https://signed.example.com/weekly.pdf",
        downloadUrl: "https://signed.example.com/weekly.pdf",
        expiresAt: undefined,
      },
    ]);
  });

  it("emits image attachments for visual-summary replies", async () => {
    apiMocks.post.mockResolvedValue({ task_id: "task-3", status: "pending" });
    apiMocks.get.mockResolvedValueOnce({
      status: "done",
      text: "图文总结已生成。\n\n![灵光记图文总结](https://signed.example.com/card.png)",
      sources: ["周会"],
      attachments: [
        {
          artifact_id: "d".repeat(32),
          kind: "image",
          filename: "灵光记图文总结-2026-09-26-m1.png",
          download_url: "https://signed.example.com/card.png",
        },
      ],
    });

    const onEvent = vi.fn();
    await new PollChatTransport().send(sendOptions({ onEvent }));

    const done = onEvent.mock.calls
      .map((call) => call[0] as Record<string, unknown>)
      .find((event) => event.type === "done")!;
    expect(done.text).toContain("图文总结已生成");
    expect(done.attachments).toHaveLength(1);
    expect((done.attachments as unknown[])[0]).toMatchObject({ type: "image" });
  });

  it("emits poll progress events as status ticks and tool rows exactly once", async () => {
    apiMocks.post.mockResolvedValue({ task_id: "task-1", status: "pending" });
    // Successive GETs return growing progress lists (the server sends the
    // full list every time) and finally the done payload.
    apiMocks.get
      .mockResolvedValueOnce({
        status: "pending",
        progress_events: [{ type: "round_start", round: 1, content: "我去会议记录里翻一翻…" }],
      })
      .mockResolvedValueOnce({
        status: "pending",
        progress_events: [
          { type: "round_start", round: 1, content: "我去会议记录里翻一翻…" },
          { type: "tool_start", tool: "search_meetings", label: "搜索会议", round: 1 },
        ],
      })
      .mockResolvedValueOnce({
        status: "done",
        text: "找到 2 场会议",
        sources: ["会议A"],
        progress_events: [
          { type: "round_start", round: 1, content: "我去会议记录里翻一翻…" },
          { type: "tool_start", tool: "search_meetings", label: "搜索会议", round: 1 },
          { type: "tool_end", tool: "search_meetings", label: "搜索会议", duration_ms: 1200, round: 1 },
        ],
      });

    const transport = new PollChatTransport();
    const onEvent = vi.fn();
    await transport.send(sendOptions({ onEvent }));

    const events = onEvent.mock.calls.map((call) => call[0] as Record<string, unknown>);
    const statuses = events.filter((event) => event.type === "status");
    const tools = events.filter((event) => event.type === "tool");
    // The local "thinking" placeholder fires first; the server's round_start
    // caption then replaces it exactly once (no re-emission on later polls).
    expect(statuses).toEqual([
      { type: "status", text: "thinking" },
      { type: "status", text: "我去会议记录里翻一翻…" },
    ]);
    // tool_start/tool_end drive the tool row lifecycle.
    expect(tools).toEqual([
      { type: "tool", name: "搜索会议", state: "running" },
      { type: "tool", name: "搜索会议", state: "done" },
    ]);

    const done = events.find((event) => event.type === "done")!;
    expect(done.text).toBe("找到 2 场会议");
  });

  it("ignores progress events without a usable type or label", async () => {
    apiMocks.post.mockResolvedValue({ task_id: "task-1", status: "pending" });
    apiMocks.get
      .mockResolvedValueOnce({
        status: "pending",
        progress_events: [
          { type: "thinking", content: "不应透出的思维链" },
          { type: "tool_start", round: 1 },
          { type: "round_start", round: 1 },
          { type: "tool_start", tool: "render_report_pdf", label: "生成报告", round: 2 },
        ],
      })
      .mockResolvedValue({ status: "done", text: "ok" });

    const onEvent = vi.fn();
    await new PollChatTransport().send(sendOptions({ onEvent }));

    const relevant = onEvent.mock.calls
      .map((call) => call[0] as Record<string, unknown>)
      .filter((event) => event.type === "status" || event.type === "tool");
    // The local "thinking" placeholder aside, thinking/content poll events
    // and label-less tool events never reach the UI.
    expect(relevant).toEqual([
      { type: "status", text: "thinking" },
      { type: "tool", name: "生成报告", state: "running" },
    ]);
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

  it("asks for re-login instead of busy when a 503 is an identity failure", async () => {
    apiMocks.post.mockRejectedValue(
      new ApiError(503, '{"detail":"身份校验失败，请稍后重试"}'),
    );

    const onEvent = vi.fn();
    await new PollChatTransport().send(sendOptions({ onEvent }));

    // An unverifiable token never succeeds on retry — surface it immediately.
    expect(apiMocks.post).toHaveBeenCalledTimes(1);
    expect(onEvent).toHaveBeenCalledWith({
      type: "error",
      message: "登录状态已失效，请重新登录后再试",
    });
  });

  it("passes real 503 details through instead of rewriting them as busy", async () => {
    apiMocks.post.mockRejectedValue(new ApiError(503, '{"detail":"身份校验超时，请稍后重试"}'));

    const onEvent = vi.fn();
    await new PollChatTransport().send(sendOptions({ onEvent }));

    // Timeout stays retryable busy semantics, but the message is the
    // backend's own copy — not the phantom "too many users".
    expect(apiMocks.post).toHaveBeenCalledTimes(1 + chatPollTiming.maxSubmitRetries);
    expect(onEvent).toHaveBeenCalledWith({
      type: "error",
      message: "身份校验超时，请稍后重试",
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

  it("streams partial pending text as content deltas and only replays the remainder at done", async () => {
    chatPollTiming.typewriterTickMs = 1;
    chatPollTiming.typewriterMaxMs = 1; // one-shot remainder slice
    apiMocks.post.mockResolvedValue({ task_id: "task-1", status: "pending" });
    apiMocks.get
      .mockResolvedValueOnce({ status: "pending", text: "你好" })
      .mockResolvedValueOnce({ status: "pending", text: "你好，会议" })
      // A shrunken/stale payload must not re-emit or rewind the cursor.
      .mockResolvedValueOnce({ status: "pending", text: "你好" })
      .mockResolvedValueOnce({
        status: "done",
        text: "你好，会议纪要整理好了",
        sources: [],
        attachments: [],
      });

    const onEvent = vi.fn();
    await new PollChatTransport().send(sendOptions({ onEvent }));

    const events = onEvent.mock.calls.map(
      (call) => call[0] as { type: string; delta?: string; text?: string },
    );
    const deltas = events.filter((event) => event.type === "content").map((event) => event.delta!);
    // The two pending growths stream immediately; done types only the tail.
    expect(deltas).toEqual(["你好", "，会议", "纪要整理好了"]);
    const done = events.find((event) => event.type === "done")!;
    expect(done.text).toBe("你好，会议纪要整理好了");
  });

  it("stays caption-only when pending payloads carry no partial text", async () => {
    chatPollTiming.typewriterTickMs = 1;
    chatPollTiming.typewriterMaxMs = 1;
    apiMocks.post.mockResolvedValue({ task_id: "task-1", status: "pending" });
    apiMocks.get
      .mockResolvedValueOnce({ status: "pending", text: null })
      .mockResolvedValueOnce({ status: "pending" })
      .mockResolvedValueOnce({ status: "done", text: "完整答案", sources: [] });

    const onEvent = vi.fn();
    await new PollChatTransport().send(sendOptions({ onEvent }));

    const events = onEvent.mock.calls.map(
      (call) => call[0] as { type: string; delta?: string },
    );
    const types = events.map((event) => event.type);
    // No content before done's single typewriter slice.
    expect(types.filter((type) => type === "content")).toHaveLength(1);
    expect(types.indexOf("done")).toBe(types.lastIndexOf("content") + 1);
  });

  it("re-polls immediately when the app returns to the foreground mid-wait", async () => {
    // Interval long enough that only the foreground wake can explain a fast
    // second GET (frozen-timer recovery after backgrounding the app).
    chatPollTiming.intervalMs = 5_000;
    chatPollTiming.intervalFastMs = 5_000;
    apiMocks.post.mockResolvedValue({ task_id: "task-1", status: "pending" });
    apiMocks.get
      .mockResolvedValueOnce({ status: "pending", text: null })
      .mockResolvedValueOnce({ status: "done", text: "接上了", sources: [] });

    const onEvent = vi.fn();
    const sending = new PollChatTransport().send(sendOptions({ onEvent }));
    await vi.waitFor(() => expect(apiMocks.get).toHaveBeenCalledTimes(1));
    const returnedAt = Date.now();
    // jsdom reports visibilityState "visible", so this fires the wake.
    document.dispatchEvent(new Event("visibilitychange"));
    await sending;
    expect(apiMocks.get).toHaveBeenCalledTimes(2);
    expect(Date.now() - returnedAt).toBeLessThan(2_000);
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

describe("parseChatStreamData", () => {
  it("handles standalone, meta and done connection cards consistently", () => {
    const card = { request_id: "req-1", provider: "google_calendar", provider_display_name: "Google Calendar", status: "waiting_auth", action_url: "https://auth.invalid/start" };
    const standalone = parseChatStreamData(JSON.stringify({ type: "connection_request", connection_request: card }));
    expect(standalone).toEqual([{ type: "connection_request", request: expect.objectContaining(card) }]);
    for (const type of ["meta", "done"]) {
      expect(parseChatStreamData(JSON.stringify({ type, connection_requests: [card] }))[0]).toMatchObject({ connectionRequests: [expect.objectContaining(card)] });
    }
  });

  it("maps the lynclaw stream frames onto UI events", () => {
    expect(parseChatStreamData('{"round":1,"content":"听明白…","type":"round_start"}')).toEqual([
      { type: "status", text: "听明白…" },
    ]);
    expect(parseChatStreamData('{"type":"thinking","op":"append","content":"…"}')).toEqual([
      { type: "thinking", delta: "…" },
    ]);
    expect(parseChatStreamData('{"type":"content","content":"你好老"}')).toEqual([
      { type: "content", delta: "你好老" },
    ]);
  });

  it("splits done+confirmation into done then confirm, mapping camelCase fields", () => {
    const events = parseChatStreamData(
      JSON.stringify({
        type: "done",
        text: "请确认",
        sources: ["周会"],
        attachments: [{ kind: "pdf", filename: "r.pdf", download_url: "https://x/r.pdf" }],
        humanSupportLink: { label: "人工", url: "https://h" },
        confirmation: {
          type: "confirmation",
          title: "清理待办",
          confirmToken: "tok-1",
          actions: [
            { label: "确认", value: "yes" },
            { label: "取消", value: "no" },
          ],
        },
      }),
    );
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ type: "done", text: "请确认", sources: ["周会"] });
    expect(events[1]).toMatchObject({
      type: "confirm",
      confirm: { question: "清理待办", confirmToken: "tok-1" },
    });
  });

  it("humanizes raw backend error keys and passes plain text frames through", () => {
    expect(parseChatStreamData('{"type":"error","message":"system.error.busy"}')).toEqual([
      { type: "error", message: "当前使用人数较多，请稍后再试" },
    ]);
    expect(parseChatStreamData("普通文本增量")).toEqual([{ type: "content", delta: "普通文本增量" }]);
    expect(parseChatStreamData('{"type":"unknown"}')).toEqual([]);
  });
});

describe("transport selection by server", () => {
  /** Collect onEvent calls into a plain array. */
  function collector() {
    const events: ChatStreamEvent[] = [];
    return { events, onEvent: (e: ChatStreamEvent) => events.push(e) };
  }

  /** api().stream fake that replays frames then completes. */
  function streamReplaying(frames: unknown[]) {
    return vi.fn(
      (
        _path: string,
        _body: unknown,
        onChunk: (data: string) => void,
        _onError?: (err: Error) => void,
        onComplete?: () => void,
      ) => {
        for (const frame of frames) onChunk(JSON.stringify(frame));
        onComplete?.();
        return new AbortController();
      },
    );
  }

  it("always polls — even on the managed gateway host — and never touches stream", async () => {
    apiMocks.getBaseUrl.mockReturnValue("https://api.lynse.cn");
    apiMocks.post.mockResolvedValue({ task_id: "task-1", status: "pending" });
    apiMocks.get.mockResolvedValue({ status: "done", text: "ok" });

    const { events, onEvent } = collector();
    await new PollChatTransport().send(sendOptions({ onEvent }));

    expect(apiMocks.post.mock.calls[0]![0]).toBe("/api/business/ai/chat/poll");
    expect(apiMocks.stream).not.toHaveBeenCalled();
    expect(events.at(-1)).toMatchObject({ type: "done" });
  });

  it("uses poll on every other server and never touches stream", async () => {
    apiMocks.getBaseUrl.mockReturnValue("http://10.20.0.5:10060");
    apiMocks.post.mockResolvedValue({ task_id: "task-1", status: "pending" });
    apiMocks.get.mockResolvedValue({ status: "done", text: "ok" });

    const { events, onEvent } = collector();
    await new PollChatTransport().send(sendOptions({ onEvent }));

    expect(apiMocks.post).toHaveBeenCalledTimes(1);
    expect(apiMocks.stream).not.toHaveBeenCalled();
    expect(events.at(-1)).toMatchObject({ type: "done" });
  });

  it("surfaces poll submit errors directly on non-managed servers", async () => {
    apiMocks.getBaseUrl.mockReturnValue("http://10.20.0.5:10060");
    apiMocks.post.mockRejectedValue(new ApiError(404, "Not Found"));

    const { events, onEvent } = collector();
    await new PollChatTransport().send(sendOptions({ onEvent }));

    expect(apiMocks.stream).not.toHaveBeenCalled();
    expect(events.at(-1)).toMatchObject({ type: "error" });
  });

  it("targets the dedicated agent base URL with native lynclaw paths when configured (route B)", async () => {
    const agentBase = "https://lynclaw-api-321192-9-1401959758.sh.run.tcloudbase.com";
    apiMocks.getAgentBaseUrl.mockReturnValue(agentBase);
    apiMocks.post.mockResolvedValue({ task_id: "task-1", status: "pending" });
    apiMocks.get.mockResolvedValue({ status: "done", text: "ok" });

    const { events, onEvent } = collector();
    await new PollChatTransport().send(sendOptions({ onEvent }));

    // Direct connections skip the gateway prefix: the service serves
    // /api/chat/* natively (verified against the CloudRun deployment).
    expect(apiMocks.post).toHaveBeenCalledWith(
      "/api/chat/poll",
      expect.objectContaining({ query: "hello", sessionId: "session-1" }),
      { baseUrl: agentBase },
    );
    expect(apiMocks.get).toHaveBeenCalledWith("/api/chat/poll/task-1", {
      baseUrl: agentBase,
    });
    expect(apiMocks.stream).not.toHaveBeenCalled();
    expect(events.at(-1)).toMatchObject({ type: "done" });
  });

  it("StreamChatTransport forwards confirm frames after done", async () => {
    apiMocks.stream = streamReplaying([
      {
        type: "done",
        text: "选一个",
        confirmation: {
          title: "选择",
          confirmToken: "t1",
          actions: [
            { label: "A", value: "a" },
            { label: "B", value: "b" },
          ],
        },
      },
    ]);

    const { events, onEvent } = collector();
    await new StreamChatTransport().send(sendOptions({ onEvent }));

    expect(events.map((e) => e.type)).toEqual(["done", "confirm"]);
    expect(events[1]).toMatchObject({ type: "confirm", confirm: { confirmToken: "t1" } });
  });
});

describe("safeSliceEnd", () => {
  it("never cuts a surrogate pair, pulling the high half into the slice", () => {
    const text = `前文😀后文${"占".repeat(40)}`;
    const cut = text.indexOf("😀") + 1; // lands between the pair
    const end = safeSliceEnd(text, cut);
    expect(text.slice(end - 2, end)).toBe("😀");
  });

  it("snaps a cut inside a Latin word to the word end, within a bounded chase", () => {
    expect(safeSliceEnd("see the word next", 10)).toBe(13); // "see the word "
    // A word end further than the lookahead is not chased.
    expect(safeSliceEnd("see the transcription now", 10)).toBe(10);
  });

  it("leaves CJK, boundaries and the string end untouched", () => {
    const cjk = "会议纪要整理好了";
    expect(safeSliceEnd(cjk, 3)).toBe(3);
    expect(safeSliceEnd("a b c", 2)).toBe(2);
    expect(safeSliceEnd(cjk, cjk.length)).toBe(cjk.length);
  });
});

describe("typewriter slice integrity", () => {
  const contentDeltas = (onEvent: ReturnType<typeof vi.fn>) =>
    onEvent.mock.calls
      .map((call) => call[0] as { type: string; delta?: string })
      .filter((event) => event.type === "content")
      .map((event) => event.delta ?? "");

  it("replays without ever emitting half an emoji or a split word", async () => {
    chatPollTiming.typewriterTickMs = 1;
    chatPollTiming.typewriterMaxMs = 120; // many small slices
    const full = `这是一段包含 emoji 😀 的回答，还有英文单词 summary 和表格。\n\n| 阶段 | 状态 |\n| --- | --- |\n| 转写 | 完成 |\n`;
    apiMocks.post.mockResolvedValue({ task_id: "task-1", status: "pending" });
    apiMocks.get.mockResolvedValue({ status: "done", text: full, sources: [], attachments: [] });

    const onEvent = vi.fn();
    await new PollChatTransport().send(sendOptions({ onEvent }));

    const deltas = contentDeltas(onEvent);
    expect(deltas.length).toBeGreaterThan(4);
    expect(deltas.join("")).toBe(full);
    // Every cut lands on a safe boundary: never between a surrogate pair,
    // never between two characters of the same word.
    let at = 0;
    for (const delta of deltas.slice(0, -1)) {
      at += delta.length;
      expect(/[\uD800-\uDBFF]$/.test(delta)).toBe(false);
      expect(/\w/.test(full[at - 1]!) && /\w/.test(full[at]!)).toBe(false);
    }
  });

  it("holds a partial pending payload's trailing surrogate until its pair arrives", async () => {
    chatPollTiming.typewriterTickMs = 1;
    chatPollTiming.typewriterMaxMs = 1;
    const half = "好的 😀".slice(0, 4); // ends on the emoji's high surrogate
    apiMocks.post.mockResolvedValue({ task_id: "task-1", status: "pending" });
    apiMocks.get
      .mockResolvedValueOnce({ status: "pending", text: half })
      .mockResolvedValueOnce({
        status: "done",
        text: "好的 😀 完成",
        sources: [],
        attachments: [],
      });

    const onEvent = vi.fn();
    await new PollChatTransport().send(sendOptions({ onEvent }));

    const deltas = contentDeltas(onEvent);
    expect(deltas.join("")).toBe("好的 😀 完成");
    expect(deltas.some((delta) => /[\uD800-\uDBFF]$/.test(delta))).toBe(false);
  });
});
