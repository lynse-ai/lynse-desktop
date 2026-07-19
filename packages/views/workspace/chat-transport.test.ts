import { describe, expect, it, vi } from "vitest";
import { CloudChatTransport } from "./chat-transport";

const apiMocks = vi.hoisted(() => ({
  stream: vi.fn(),
}));

vi.mock("@lynse/core/api", () => ({
  api: () => ({ stream: apiMocks.stream }),
}));

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
