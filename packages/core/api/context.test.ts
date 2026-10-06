import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiClient, setApiInstance, setApiTransportMode } from "./client";
import { actOnContextInbox, downloadContextReview, listContextInbox } from "./context";
import type { ContextInboxItem } from "./context";

const item: ContextInboxItem = {
  item_id: "proposal-1", kind: "goal_suggestion", title: "A", body: "B", status: "pending", version: 2,
  created_at: "2026-10-06T01:00:00Z", updated_at: "2026-10-06T01:00:00Z", displayed_at: "", snoozed_until: "", goal_id: "", source_refs: [],
};

let client: ApiClient;
let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  client = new ApiClient("https://business.invalid");
  client.setAgentBaseUrl("https://agent.invalid");
  client.setToken("test-session");
  client.setApiKey("test-api-key");
  setApiInstance(client);
  setApiTransportMode("direct");
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => { vi.unstubAllGlobals(); setApiTransportMode("proxy"); });

describe("context API session boundary", () => {
  it("sends the current user token to the agent without an API key and forwards cancellation", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ status: "ok", available: true, user_id: "u1", items: [item], can_display: true })));
    const controller = new AbortController();
    await listContextInbox("test-session", controller.signal);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://agent.invalid/api/context/inbox?status=pending");
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ signal: controller.signal, headers: { Authorization: "test-session" } });
    expect(fetchMock.mock.calls[0]?.[1].headers["X-API-Key"]).toBeUndefined();
  });

  it("never falls back to an API key after logout or an account change", async () => {
    client.setToken(null);
    await expect(listContextInbox("test-session")).rejects.toThrow("Session changed");
    client.setToken("other-session");
    await expect(listContextInbox("test-session")).rejects.toThrow("Session changed");
    await expect(listContextInbox("")).rejects.toThrow("Session changed");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not log out the new account when an old request returns unauthorized", async () => {
    const unauthorized = vi.fn();
    client = new ApiClient("https://business.invalid", { onUnauthorized: unauthorized });
    client.setToken("test-session");
    setApiInstance(client);
    let finish!: (response: Response) => void;
    fetchMock.mockImplementation(() => new Promise<Response>((resolve) => { finish = resolve; }));
    const result = listContextInbox("test-session");
    client.setToken("other-session");
    finish(new Response("expired", { status: 401 }));
    await expect(result).rejects.toThrow("Session changed");
    expect(unauthorized).not.toHaveBeenCalled();
    expect(client.getToken()).toBe("other-session");
  });

  it("keeps the frozen operation ID and version for retries", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ status: "ok", changed: false, item })));
    await actOnContextInbox(item, "dismiss", "test-session", "op-1");
    expect(JSON.parse(fetchMock.mock.calls[0]?.[1].body)).toEqual({ action: "dismiss", base_version: 2, operation_id: "op-1" });
  });

  it("treats HTTP200 domain failures and unavailable feature responses as failures", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ status: "error", item })));
    await expect(actOnContextInbox(item, "dismiss", "test-session", "op-1")).rejects.toThrow("not accepted");
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ status: "ok", user_id: "u1", items: [] })));
    await expect(listContextInbox("test-session")).rejects.toThrow("unavailable");
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: "context_unavailable" }), { status: 503 }));
    await expect(listContextInbox("test-session")).rejects.toMatchObject({ status: 503 });
  });

  it("downloads Markdown through the authenticated endpoint and rejects external paths and JSON errors", async () => {
    fetchMock.mockResolvedValueOnce(new Response("# Goal review", { headers: { "Content-Type": "text/markdown; charset=utf-8" } }));
    const result = await downloadContextReview("/api/context/goals/goal-1/export", "test-session");
    expect(await result.text()).toBe("# Goal review");
    expect(fetchMock.mock.calls[0]?.[1].headers["X-API-Key"]).toBeUndefined();
    await expect(downloadContextReview("https://other.invalid/api/context/goals/goal-1/export", "test-session")).rejects.toThrow("Invalid");
    fetchMock.mockResolvedValueOnce(Response.json({ status: "error" }));
    await expect(downloadContextReview("/api/context/goals/goal-1/export", "test-session")).rejects.toThrow("unavailable");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("rejects a downloaded result when the account changes during its request", async () => {
    let finish!: (response: Response) => void;
    fetchMock.mockImplementation(() => new Promise<Response>((resolve) => { finish = resolve; }));
    const result = downloadContextReview("/api/context/goals/goal-1/export", "test-session");
    client.setToken("other-session");
    finish(new Response("# Old review", { headers: { "Content-Type": "text/markdown" } }));
    await expect(result).rejects.toThrow("Session changed");
  });
});
