/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import { CloudChatTransport, QoderChatTransport } from "./chat-transport";

const apiMocks = vi.hoisted(() => ({
  stream: vi.fn(),
}));

vi.mock("@lynse/core/api", () => ({
  api: () => ({ stream: apiMocks.stream }),
}));

afterEach(() => {
  delete (window as Window & { desktopAPI?: unknown }).desktopAPI;
  vi.clearAllMocks();
});

describe("CloudChatTransport", () => {
  it("stays pending until the SSE response completes", async () => {
    let complete: (() => void) | undefined;
    apiMocks.stream.mockImplementation(
      (_path, _body, _onChunk, _onError, onComplete: () => void) => {
        complete = onComplete;
        return new AbortController();
      },
    );

    const transport = new CloudChatTransport();
    let settled = false;
    const sending = transport
      .send({
        query: "hello",
        sessionId: "session-1",
        userId: "user-1",
        fileIds: [],
        userSpecifiedFile: false,
        onEvent: vi.fn(),
      })
      .then(() => {
        settled = true;
      });

    await Promise.resolve();
    expect(settled).toBe(false);

    complete?.();
    await sending;
    expect(settled).toBe(true);
  });
});

describe("QoderChatTransport", () => {
  it("creates one Qoder session and resumes the event cursor across turns", async () => {
    let listener: ((event: Record<string, unknown>) => void) | undefined;
    const qoderChat = {
      getConfig: vi.fn(),
      savePat: vi.fn(),
      createSession: vi.fn().mockResolvedValue("sess_1"),
      sendMessage: vi
        .fn()
        .mockImplementationOnce(async (_sessionId, _message, requestId) => {
          listener?.({ requestId, type: "content", delta: "first" });
          listener?.({ requestId, type: "done" });
          return { lastEventId: "evt_1" };
        })
        .mockImplementationOnce(async (_sessionId, _message, requestId) => {
          listener?.({ requestId, type: "content", delta: "second" });
          listener?.({ requestId, type: "done" });
          return { lastEventId: "evt_2" };
        }),
      cancel: vi.fn().mockResolvedValue(undefined),
      onEvent: vi.fn().mockImplementation(async (callback) => {
        listener = callback;
        return () => {
          listener = undefined;
        };
      }),
    };
    (window as Window & { desktopAPI?: unknown }).desktopAPI = { qoderChat };

    const transport = new QoderChatTransport();
    const events: unknown[] = [];
    const options = {
      sessionId: "local-session",
      userId: "user-1",
      fileIds: [],
      userSpecifiedFile: false,
      onEvent: (event: unknown) => events.push(event),
    };

    await transport.send({ ...options, query: "first" });
    await transport.send({ ...options, query: "second" });

    expect(qoderChat.createSession).toHaveBeenCalledTimes(1);
    expect(qoderChat.sendMessage).toHaveBeenNthCalledWith(
      1,
      "sess_1",
      "first",
      expect.any(String),
      undefined,
    );
    expect(qoderChat.sendMessage).toHaveBeenNthCalledWith(
      2,
      "sess_1",
      "second",
      expect.any(String),
      "evt_1",
    );
    expect(events).toEqual([
      { type: "content", delta: "first" },
      { type: "done" },
      { type: "content", delta: "second" },
      { type: "done" },
    ]);
  });

  it("cancels the active Qoder session", async () => {
    let resolveTurn: ((value: { lastEventId?: string }) => void) | undefined;
    const qoderChat = {
      getConfig: vi.fn(),
      savePat: vi.fn(),
      createSession: vi.fn().mockResolvedValue("sess_cancel"),
      sendMessage: vi.fn().mockImplementation(() => new Promise((resolve) => {
        resolveTurn = resolve;
      })),
      cancel: vi.fn().mockResolvedValue(undefined),
      onEvent: vi.fn().mockResolvedValue(() => undefined),
    };
    (window as Window & { desktopAPI?: unknown }).desktopAPI = { qoderChat };

    const transport = new QoderChatTransport();
    const sending = transport.send({
      query: "stop me",
      sessionId: "local-session",
      userId: "user-1",
      fileIds: [],
      userSpecifiedFile: false,
      onEvent: vi.fn(),
    });
    await vi.waitFor(() => expect(qoderChat.sendMessage).toHaveBeenCalled());

    transport.cancel();
    expect(qoderChat.cancel).toHaveBeenCalledWith("sess_cancel");

    resolveTurn?.({});
    await sending;
  });
});
