/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import { CloudChatTransport, parseChatChunk } from "./chat-transport";

const apiMocks = vi.hoisted(() => ({
  stream: vi.fn(),
}));

vi.mock("@lynse/core/api", () => ({
  api: () => ({ stream: apiMocks.stream }),
}));

afterEach(() => {
  delete (window as Window & { desktopAPI?: unknown }).desktopAPI;
  window.localStorage.clear();
  vi.clearAllMocks();
});

describe("parseChatChunk: thinking", () => {
  it("maps cloud thinking deltas onto the thinking event", () => {
    expect(parseChatChunk(JSON.stringify({ type: "thinking", content: "让我想想" }))).toEqual({
      type: "thinking",
      delta: "让我想想",
    });
    expect(parseChatChunk(JSON.stringify({ type: "reasoning", text: "hmm" }))).toEqual({
      type: "thinking",
      delta: "hmm",
    });
  });

  it("closes the trace on thinking_end and accepts empty deltas", () => {
    expect(parseChatChunk(JSON.stringify({ type: "thinking_end" }))).toEqual({
      type: "thinking",
      delta: "",
    });
    expect(parseChatChunk(JSON.stringify({ type: "thinking", content: "" }))).toEqual({
      type: "thinking",
      delta: "",
    });
  });

  it("maps OpenAI-style reasoning_content deltas", () => {
    const payload = { choices: [{ delta: { reasoning_content: "step 1" } }] };
    expect(parseChatChunk(JSON.stringify(payload))).toEqual({ type: "thinking", delta: "step 1" });
  });
});

describe("parseChatChunk: tool activity", () => {
  it("maps tool_use / tool / tool_start onto running tool events", () => {
    expect(parseChatChunk(JSON.stringify({ type: "tool_use", name: "search_meetings", id: "t1" }))).toEqual({
      type: "tool",
      name: "search_meetings",
      id: "t1",
      state: "running",
    });
    expect(parseChatChunk(JSON.stringify({ type: "tool", tool: "transcribe" }))).toEqual({
      type: "tool",
      name: "transcribe",
      id: undefined,
      state: "running",
    });
  });

  it("maps tool_result / tool_end onto done tool events", () => {
    expect(parseChatChunk(JSON.stringify({ type: "tool_result", name: "search_meetings" }))).toEqual({
      type: "tool",
      name: "search_meetings",
      id: undefined,
      state: "done",
    });
  });
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

