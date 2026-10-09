import { afterEach, describe, expect, it, vi } from "vitest";
import { setWorkBuddyAcpBridge, WorkBuddyAcpClient, WorkBuddySseParser, type RpcMessage, type WorkBuddyAcpEvent } from "./acp";

afterEach(() => { setWorkBuddyAcpBridge(null); vi.useRealTimers(); });

describe("WorkBuddy ACP stream", () => {
  it("frames fragmented CRLF, comments and multiline data without losing text", () => {
    const frames: string[] = [];
    const parser = new WorkBuddySseParser((data) => frames.push(data));
    const text = ': ping\r\nevent: message\r\ndata: {"text":\r\ndata: "你好"}\r\n\r\ndata: next\n\n';
    for (const character of text) parser.push(character);
    expect(frames).toEqual(['{"text":\n"你好"}', "next"]);
  });

  it("limits unbounded frames", () => {
    const parser = new WorkBuddySseParser(() => {});
    expect(() => parser.push("data: " + "x".repeat(2_000_001))).toThrow("too large");
  });

  it("correlates SSE responses, never treating the POST acknowledgement as completion", async () => {
    let receive!: (event: WorkBuddyAcpEvent) => void;
    const posts: RpcMessage[] = [];
    const post = vi.fn(async (message: RpcMessage) => { posts.push(message); });
    const close = vi.fn(async () => {});
    setWorkBuddyAcpBridge({ open: async (_url, _token, listener) => { receive = listener; return { post, close }; } });
    const notification = vi.fn(); const request = vi.fn();
    const client = new WorkBuddyAcpClient(notification, request);
    await client.connect("https://acp.workbuddy.cn/sessions/a", "ticket");
    const completed = vi.fn();
    const first = client.request("initialize", {}).then(completed);
    const second = client.request("session/load", {});
    await Promise.resolve();
    expect(posts.slice(0, 2).map((message) => message.id)).toEqual([1, 2]);
    expect(completed).not.toHaveBeenCalled();
    receive({ type: "data", data: `data: ${JSON.stringify([
      { jsonrpc: "2.0", id: posts[1]!.id, result: { loaded: true } },
      { jsonrpc: "2.0", method: "session/update", params: { text: "hi" } },
      { jsonrpc: "2.0", id: "approval-1", method: "session/request_permission", params: {} },
    ])}\n\n` });
    await expect(second).resolves.toEqual({ loaded: true });
    expect(notification).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledWith(expect.objectContaining({ id: "approval-1" }));
    expect(completed).not.toHaveBeenCalled();
    receive({ type: "data", data: `data: ${JSON.stringify({ jsonrpc: "2.0", id: posts[0]!.id, result: { protocolVersion: 1 } })}\n\n` });
    await first;
    expect(completed).toHaveBeenCalledWith({ protocolVersion: 1 });
    await client.respond("approval-1", { outcome: { outcome: "cancelled" } });
    expect(posts.at(-1)).toEqual({ jsonrpc: "2.0", id: "approval-1", result: { outcome: { outcome: "cancelled" } } });
    await client.close(); await client.close();
    expect(close).toHaveBeenCalledOnce();
  });

  it("rejects a waiting turn when the stream disconnects", async () => {
    let receive!: (event: WorkBuddyAcpEvent) => void;
    setWorkBuddyAcpBridge({ open: async (_url, _token, listener) => { receive = listener; return { post: async () => {}, close: async () => {} }; } });
    const client = new WorkBuddyAcpClient(() => {}, () => {});
    await client.connect("https://acp.workbuddy.cn/sessions/a", "ticket");
    const pending = client.request("session/prompt", {}).catch((error: Error) => error);
    receive({ type: "closed" });
    expect(await pending).toEqual(expect.objectContaining({ message: "WorkBuddy connection interrupted" }));
    await expect(client.request("session/prompt", {})).rejects.toThrow("interrupted");
    await client.close();
  });

  it("closes a connection whose open finished after cancellation", async () => {
    let resolve!: (value: { post: () => Promise<void>; close: () => Promise<void> }) => void;
    const close = vi.fn(async () => {});
    setWorkBuddyAcpBridge({ open: () => new Promise((done) => { resolve = done; }) });
    const client = new WorkBuddyAcpClient(() => {}, () => {});
    const opening = client.connect("https://acp.workbuddy.cn/sessions/a", "ticket").catch((error: Error) => error);
    await client.close(); resolve({ post: async () => {}, close });
    expect((await opening as Error).message).toBe("cancelled");
    expect(close).toHaveBeenCalledOnce();
  });
});
