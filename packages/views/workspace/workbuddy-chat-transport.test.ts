import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The transport is driven through a mocked OpenAPI caller; the pure envelope
// parsers are exercised directly so real payloads map predictably.
const mockedOpenApi = vi.hoisted(() => vi.fn());
vi.mock("@lynse/core/auth/workbuddy", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@lynse/core/auth/workbuddy")>();
  return { ...actual, callWorkBuddyOpenApi: mockedOpenApi };
});

import {
  WorkBuddyChatTransport,
  extractWorkBuddyMessages,
  isWorkBuddyAuthError,
  normalizeWorkBuddyAttachments,
  workbuddyChatTiming,
  workbuddyContentToText,
  workbuddyMessageId,
  type WorkBuddyServerMessage,
} from "./workbuddy-chat-transport";

const mockedCall = vi.mocked(mockedOpenApi);

beforeEach(() => {
  mockedCall.mockReset();
  // Shrink the poll cadence so turns finish in milliseconds.
  workbuddyChatTiming.intervalMs = 5;
  workbuddyChatTiming.graceMs = 30;
  workbuddyChatTiming.deadlineMs = 5_000;
});

afterEach(() => {
  workbuddyChatTiming.intervalMs = 1_500;
  workbuddyChatTiming.graceMs = 4_000;
  workbuddyChatTiming.deadlineMs = 190_000;
});

describe("workbuddy envelope parsing", () => {
  it("finds the message array under data.messages, data, or messages", () => {
    const one: WorkBuddyServerMessage[] = [{ message_id: "m1" }];
    expect(extractWorkBuddyMessages({ code: 0, data: { messages: one } })).toEqual(one);
    expect(extractWorkBuddyMessages({ code: 0, data: one })).toEqual(one);
    expect(extractWorkBuddyMessages({ messages: one })).toEqual(one);
    expect(extractWorkBuddyMessages({ code: 1, msg: "fail" })).toEqual([]);
    expect(extractWorkBuddyMessages(null)).toEqual([]);
  });

  it("reads ids and flattens array/strings content", () => {
    expect(workbuddyMessageId({ message_id: "a" })).toBe("a");
    expect(workbuddyMessageId({ id: "b" })).toBe("b");
    expect(workbuddyMessageId({})).toBeNull();
    expect(workbuddyContentToText([{ type: "text", text: "你好" }, "，世界"])).toBe("你好，世界");
    expect(workbuddyContentToText("plain")).toBe("plain");
    expect(workbuddyContentToText(undefined)).toBe("");
  });

  it("normalizes attachments across key spellings", () => {
    expect(
      normalizeWorkBuddyAttachments([{ filename: "doc.pdf", download_url: "https://x/d" }]),
    ).toEqual([{ id: undefined, name: "doc.pdf", type: undefined, url: "https://x/d", downloadUrl: "https://x/d" }]);
    expect(normalizeWorkBuddyAttachments([{ name: "a", link: "https://x/a" }])[0]!.downloadUrl).toBe("https://x/a");
    expect(normalizeWorkBuddyAttachments([null, "text", {}])).toEqual([]);
  });

  it("flags the not-bound and token-expired errors as authorization failures", () => {
    expect(isWorkBuddyAuthError(new Error("error.workbuddy.oauth.not.bound"))).toBe(true);
    expect(isWorkBuddyAuthError(new Error("error.workbuddy.oauth.token.expired"))).toBe(true);
    expect(isWorkBuddyAuthError(new Error("network down"))).toBe(false);
  });
});

describe("WorkBuddyChatTransport", () => {
  const opts = (events: unknown[], signal?: AbortSignal) => ({
    query: "帮我查一下今天的日程",
    sessionId: "conversation-1",
    userId: "user",
    fileIds: [] as string[],
    userSpecifiedFile: false,
    signal,
    onEvent: (event: unknown) => events.push(event),
  });

  it("posts the turn, renders the reply, and finishes after the quiet gap", async () => {
    const baseline = {
      code: 0,
      data: { messages: [{ message_id: "m1", role: "user", content: ["早"] }] },
    };
    const reply = {
      code: 0,
      data: {
        messages: [
          baseline.data.messages[0],
          {
            message_id: "m3",
            role: "assistant",
            content: [{ type: "text", text: "今天有 3 个会" }],
            attachments: [{ filename: "agenda.pdf", url: "https://x/agenda.pdf" }],
          },
        ],
      },
    };
    mockedCall
      .mockResolvedValueOnce(baseline) // baseline GET
      .mockResolvedValueOnce({ code: 0, data: { message_id: "m2" } }) // POST
      .mockResolvedValueOnce({ code: 0, data: { messages: [] } }) // poll 1: not yet
      .mockResolvedValue(reply); // poll 2+: reply present

    const events: unknown[] = [];
    await new WorkBuddyChatTransport().send(opts(events));

    expect(mockedCall).toHaveBeenNthCalledWith(2, "/localassistant/message", {
      method: "POST",
      body: { content: "帮我查一下今天的日程", msg_type: "text" },
    });

    const types = events.map((e) => (e as { type: string }).type);
    expect(types[0]).toBe("status");
    expect(types).toContain("workbuddy_seen");
    expect(types).toContain("meta");
    expect(types.at(-1)).toBe("done");

    const done = events.at(-1) as { type: string; text: string; attachments: unknown[] };
    expect(done.text).toContain("今天有 3 个会");
    expect(done.attachments).toHaveLength(1);

    const seen = events.find((e) => (e as { type: string }).type === "workbuddy_seen") as {
      serverId: string;
      role: string;
    };
    expect(seen).toEqual({ type: "workbuddy_seen", serverId: "m3", role: "assistant" });

    // The full typed text arrived through content deltas before done.
    const content = events
      .filter((e) => (e as { type: string }).type === "content")
      .reduce((acc, e) => acc + (e as { delta: string }).delta, "");
    expect(content).toContain("今天有 3 个会");
  });

  it("ignores the user's own echo but records its server id", async () => {
    const echoed = {
      code: 0,
      data: {
        // Newest first, as the history API returns them.
        messages: [
          { message_id: "a9", role: "assistant", content: ["好的"] },
          {
            message_id: "u9",
            role: "user",
            content: ["帮我查一下今天的日程"],
          },
        ],
      },
    };
    mockedCall
      .mockResolvedValueOnce({ code: 0, data: { messages: [] } })
      .mockResolvedValueOnce({ code: 0, data: { message_id: "u9" } })
      .mockResolvedValue(echoed);

    const events: unknown[] = [];
    await new WorkBuddyChatTransport().send(opts(events));

    const seen = events.filter((e) => (e as { type: string }).type === "workbuddy_seen");
    expect(seen).toEqual([
      { type: "workbuddy_seen", serverId: "u9", role: "user" },
      { type: "workbuddy_seen", serverId: "a9", role: "assistant" },
    ]);
    const done = events.at(-1) as { text: string };
    expect(done.text).toBe("好的");
  });

  it("maps an unbound ticket to an authorization error", async () => {
    mockedCall.mockRejectedValue(new Error("error.workbuddy.oauth.not.bound"));

    const events: unknown[] = [];
    await new WorkBuddyChatTransport().send(opts(events));

    expect(events).toEqual([
      { type: "status", text: "thinking" },
      {
        type: "error",
        message: "Work buddy 尚未授权，请先完成授权",
        workbuddyAuthRequired: true,
      },
    ]);
  });

  it("surfaces a timeout as an error when no reply ever lands", async () => {
    workbuddyChatTiming.deadlineMs = 20;
    mockedCall.mockResolvedValue({ code: 0, data: { messages: [] } });

    const events: unknown[] = [];
    await new WorkBuddyChatTransport().send(opts(events));

    expect(events.at(-1)).toEqual({
      type: "error",
      message: "Work buddy 回复超时，请稍后重试",
    });
  });
});
