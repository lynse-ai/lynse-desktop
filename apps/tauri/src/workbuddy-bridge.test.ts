import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ invoke: vi.fn(), logInfo: vi.fn(), bridge: null as unknown, http: vi.fn(), resource: vi.fn(), guard: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke, Channel: class { onmessage?: (event: unknown) => void } }));
vi.mock("@tauri-apps/plugin-log", () => ({ info: mocks.logInfo }));
vi.mock("@lynse/core/auth/workbuddy", () => ({ setWorkBuddyAuthorizationDiagnostics: vi.fn(), setWorkBuddyHttpRelay: mocks.http, workBuddySessionGuard: () => mocks.guard }));
vi.mock("@lynse/core/workbuddy", async (original) => ({ ...await original<typeof import("@lynse/core/workbuddy")>(),
  setWorkBuddyAcpBridge: (bridge: unknown) => { mocks.bridge = bridge; }, setWorkBuddyResourceRelay: mocks.resource,
}));
import type { WorkBuddyAcpBridge, WorkBuddyAcpEvent } from "@lynse/core/workbuddy";
import { installWorkBuddyBridge } from "./workbuddy-bridge";

beforeEach(() => { vi.resetAllMocks(); mocks.logInfo.mockResolvedValue(undefined); installWorkBuddyBridge(); });
describe("native WorkBuddy ACP bridge", () => {
  it.each(["json", "sse"])("finishes the pending turn from an HTTP 200 %s RPC result", async (format) => {
    const original = await vi.importActual<typeof import("@lynse/core/workbuddy")>("@lynse/core/workbuddy");
    original.setWorkBuddyAcpBridge(mocks.bridge as WorkBuddyAcpBridge);
    const client = new original.WorkBuddyAcpClient(() => {}, () => {});
    mocks.invoke.mockResolvedValueOnce({ status: 200, handle: "owned-handle", connectionId: "private-connection" });
    await client.connect("https://acp.workbuddy.cn/sessions/private-session", "private-ticket");
    const result = { jsonrpc: "2.0", id: 1, result: { stopReason: "end_turn" } };
    mocks.invoke.mockResolvedValueOnce({ status: 200, body: format === "json" ? JSON.stringify(result) : `data: ${JSON.stringify(result)}\n\n` });
    await expect(client.request("session/prompt", { prompt: [{ type: "text", text: "private prompt" }] }, 500)).resolves.toEqual({ stopReason: "end_turn" });
    expect(JSON.stringify(mocks.logInfo.mock.calls)).not.toContain("private");
    mocks.invoke.mockResolvedValueOnce(null); await client.close();
    original.setWorkBuddyAcpBridge(null);
  });
  it("ignores HTTP acknowledgements and late POST results after closing", async () => {
    const events: WorkBuddyAcpEvent[] = [];
    mocks.invoke.mockResolvedValueOnce({ status: 200, handle: "owned", connectionId: "connection" });
    const connection = await (mocks.bridge as WorkBuddyAcpBridge).open("https://acp.workbuddy.cn/sessions/a", "ticket", (event) => events.push(event));
    mocks.invoke.mockResolvedValueOnce({ status: 200, body: '{"accepted":true}' });
    await connection.post({ jsonrpc: "2.0", id: 1, method: "session/prompt", params: {} });
    mocks.invoke.mockResolvedValueOnce({ status: 202, body: '{"jsonrpc":"2.0","id":1,"result":{"stopReason":"end_turn"}}' });
    await connection.post({ jsonrpc: "2.0", id: 1, method: "session/prompt", params: {} });
    expect(events).toEqual([]);
    let resolve!: (response: { status: number; body: string }) => void;
    mocks.invoke.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    const pending = connection.post({ jsonrpc: "2.0", id: 2, method: "session/prompt", params: {} });
    mocks.invoke.mockResolvedValueOnce(null); await connection.close();
    resolve({ status: 200, body: '{"jsonrpc":"2.0","id":2,"result":{"stopReason":"end_turn"}}' });
    await pending;
    expect(events).toEqual([]);
  });
  it("reports initialization errors without logging task credentials or later prompt errors", async () => {
    const url = "https://acp.workbuddy.cn/sessions/private-session";
    mocks.invoke.mockResolvedValueOnce({ status: 200, handle: "private-handle", connectionId: "private-connection" });
    const connection = await (mocks.bridge as WorkBuddyAcpBridge).open(url, "private-ticket", () => {});
    mocks.invoke.mockResolvedValueOnce({ status: 400, body: JSON.stringify({ error: { code: -32600, message: `Invalid request private-ticket private-connection private-handle ${url}` } }) });
    await expect(connection.post({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })).rejects.toMatchObject({ status: 400 });
    expect(mocks.logInfo).toHaveBeenLastCalledWith('[workbuddy-acp-initialize] {"status":400,"code":-32600,"message":"Invalid request [redacted] [redacted] [redacted] [redacted]"}');
    const logged = JSON.stringify(mocks.logInfo.mock.calls);
    expect(logged).not.toContain("private-");
    mocks.invoke.mockResolvedValueOnce({ status: 400, body: JSON.stringify({ error: "Invalid request body", details: [{ path: ["id"], message: "Expected number" }] }) });
    await expect(connection.post({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })).rejects.toMatchObject({ status: 400 });
    expect(mocks.logInfo.mock.lastCall?.[0]).toContain("Expected number");
    mocks.logInfo.mockClear();
    mocks.invoke.mockResolvedValueOnce({ status: 400, body: "private user prompt" });
    await expect(connection.post({ jsonrpc: "2.0", id: 2, method: "session/prompt", params: {} })).rejects.toMatchObject({ status: 400 });
    expect(mocks.logInfo).not.toHaveBeenCalled();
  });
  it("logs only endpoint metadata without task credentials or session identifiers", async () => {
    mocks.invoke.mockRejectedValueOnce(new Error("untrusted WorkBuddy cloud URL"));
    await expect((mocks.bridge as WorkBuddyAcpBridge).open("https://unknown.example/sessions/private-session?ticket=private-query", "private-token", () => {})).rejects.toThrow("untrusted");
    expect(mocks.logInfo).toHaveBeenCalledWith('[workbuddy-acp] {"protocol":"https:","hostname":"unknown.example","port":""}');
    expect(JSON.stringify(mocks.logInfo.mock.calls)).not.toContain("private-");
  });
  it("rejects stale stream events and writes after the login session changes", async () => {
    mocks.invoke.mockResolvedValueOnce({ status: 200, handle: "h", connectionId: "c" });
    const events: WorkBuddyAcpEvent[] = [];
    const connection = await (mocks.bridge as WorkBuddyAcpBridge).open("https://acp.workbuddy.cn/sessions/a", "ticket", (event) => events.push(event));
    mocks.guard.mockImplementation(() => { throw new Error("WorkBuddy session changed"); });
    const channel = mocks.invoke.mock.calls[0]![1].onEvent as { onmessage: (event: unknown) => void };
    channel.onmessage({ kind: "chunk", bytes: [65] });
    expect(events).toEqual([{ type: "error", message: "WorkBuddy session changed" }]);
    await expect(connection.post({ jsonrpc: "2.0", method: "session/prompt", params: {} })).rejects.toThrow("session changed");
    expect(mocks.invoke).toHaveBeenCalledOnce();
    mocks.invoke.mockResolvedValueOnce(null); await connection.close();
  });
  it("preserves Chinese split across native byte chunks and posts with its handle", async () => {
    const events: WorkBuddyAcpEvent[] = [];
    mocks.invoke.mockResolvedValueOnce({ status: 200, handle: "owned-handle", connectionId: "connection-1" });
    const connection = await (mocks.bridge as WorkBuddyAcpBridge).open("https://acp.workbuddy.cn/sessions/a", "task-ticket", (event) => events.push(event));
    const command = mocks.invoke.mock.calls[0]!;
    expect(command[0]).toBe("workbuddy_acp_open");
    expect(command[1]).toMatchObject({ url: "https://acp.workbuddy.cn/sessions/a", token: "task-ticket" });
    const channel = command[1].onEvent as { onmessage: (event: unknown) => void };
    const bytes = new TextEncoder().encode('data: {"text":"你好"}\n\n');
    for (const byte of bytes) channel.onmessage({ kind: "chunk", bytes: [byte] });
    expect(events.map((event) => event.type === "data" ? event.data : "").join("")).toBe('data: {"text":"你好"}\n\n');
    mocks.invoke.mockResolvedValueOnce({ status: 202 });
    await connection.post({ jsonrpc: "2.0", id: "prompt-1", method: "session/prompt", params: {} });
    expect(mocks.invoke).toHaveBeenLastCalledWith("workbuddy_acp_post", { handle: "owned-handle", body: '{"jsonrpc":"2.0","id":"prompt-1","method":"session/prompt","params":{}}' });
    mocks.invoke.mockResolvedValue(null);
    await connection.close(); await connection.close();
    expect(mocks.invoke).toHaveBeenLastCalledWith("workbuddy_acp_close", { handle: "owned-handle" });
    expect(mocks.invoke.mock.calls.filter(([name]) => name === "workbuddy_acp_close")).toHaveLength(1);
    channel.onmessage({ kind: "chunk", bytes: [65] });
    expect(events.map((event) => event.type === "data" ? event.data : "").join("")).not.toMatch(/A$/);
  });
  it("surfaces native HTTP failures and releases incomplete connections", async () => {
    mocks.invoke.mockResolvedValueOnce({ status: 401 });
    await expect((mocks.bridge as WorkBuddyAcpBridge).open("https://acp.workbuddy.cn/sessions/a", "ticket", () => {})).rejects.toMatchObject({ status: 401 });
    mocks.invoke.mockResolvedValueOnce({ status: 200, handle: "incomplete" }).mockResolvedValueOnce(null);
    await expect((mocks.bridge as WorkBuddyAcpBridge).open("https://acp.workbuddy.cn/sessions/a", "ticket", () => {})).rejects.toThrow("connection ID missing");
    expect(mocks.invoke).toHaveBeenLastCalledWith("workbuddy_acp_close", { handle: "incomplete" });
  });
});
