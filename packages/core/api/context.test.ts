import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiClient, setApiInstance, setApiTransportMode } from "./client";
import {
  GLOBAL_CONTEXT_SCOPE, actOnContextInbox, deviceTimeZone, downloadContextReview, getContextPreferences,
  listContextInbox, setContextPreferences,
} from "./context";
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

  it("reads the cloud grant as the switch state and normalizes missing fields", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ status: "ok", preferences: {
      enabled: true, scopes: [GLOBAL_CONTEXT_SCOPE], timezone: "Europe/Berlin", grant_version: 3, coverage: {} } })));
    await expect(getContextPreferences("test-session")).resolves.toEqual({
      enabled: true, scopes: [GLOBAL_CONTEXT_SCOPE], timezone: "Europe/Berlin", grant_version: 3 });
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://agent.invalid/api/context/preferences");
    expect(fetchMock.mock.calls[0]?.[1].headers["X-API-Key"]).toBeUndefined();
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ status: "ok", preferences: { grant_version: 0 } })));
    await expect(getContextPreferences("test-session")).resolves.toEqual({
      enabled: false, scopes: [], timezone: "Asia/Shanghai", grant_version: 0 });
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ status: "ok", preferences: { enabled: true } })));
    await expect(getContextPreferences("test-session")).rejects.toThrow("unavailable");
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ status: "error", error: { code: "context_unavailable" } }), { status: 503 }));
    await expect(getContextPreferences("test-session")).rejects.toMatchObject({ status: 503 });
  });

  it("writes the switch as an explicit grant or stop with the frozen operation ID and base version", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ status: "ok", changed: true, preferences: {
      enabled: true, scopes: [GLOBAL_CONTEXT_SCOPE], timezone: "Europe/Berlin", grant_version: 4 } })));
    const granted = await setContextPreferences(
      { action: "set", enabled: true, scopes: [GLOBAL_CONTEXT_SCOPE], timezone: "Europe/Berlin" }, 3, "test-session", "switch-1");
    expect(fetchMock.mock.calls[0]?.[1].method).toBe("POST");
    expect(JSON.parse(fetchMock.mock.calls[0]?.[1].body)).toEqual({
      operation_id: "switch-1", base_version: 3, action: "set", enabled: true, scopes: [GLOBAL_CONTEXT_SCOPE], timezone: "Europe/Berlin" });
    expect(granted.grant_version).toBe(4);
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ status: "ok", changed: true, preferences: {
      enabled: false, scopes: [GLOBAL_CONTEXT_SCOPE], timezone: "Europe/Berlin", grant_version: 5 } })));
    const stopped = await setContextPreferences({ action: "stop" }, 4, "test-session", "switch-2");
    expect(JSON.parse(fetchMock.mock.calls[1]?.[1].body)).toEqual({ operation_id: "switch-2", base_version: 4, action: "stop" });
    expect(stopped.enabled).toBe(false);
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ status: "error", error: { code: "version_conflict" } }), { status: 409 }));
    await expect(setContextPreferences({ action: "stop" }, 1, "test-session", "switch-3")).rejects.toMatchObject({ status: 409 });
  });

  it("reports the device IANA zone and falls back to the server default", () => {
    const resolved = vi.spyOn(Intl.DateTimeFormat.prototype, "resolvedOptions");
    resolved.mockReturnValue({ timeZone: "Europe/Berlin" } as Intl.ResolvedDateTimeFormatOptions);
    expect(deviceTimeZone()).toBe("Europe/Berlin");
    resolved.mockReturnValue({ timeZone: "UTC" } as Intl.ResolvedDateTimeFormatOptions);
    expect(deviceTimeZone()).toBe("UTC");
    resolved.mockReturnValue({ timeZone: "CST" } as Intl.ResolvedDateTimeFormatOptions);
    expect(deviceTimeZone()).toBe("Asia/Shanghai");
    resolved.mockImplementation(() => { throw new TypeError("unsupported"); });
    expect(deviceTimeZone()).toBe("Asia/Shanghai");
    resolved.mockRestore();
  });

  it("treats HTTP200 domain failures as failures and a closed gate as a business state", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ status: "error", item })));
    await expect(actOnContextInbox(item, "dismiss", "test-session", "op-1")).rejects.toThrow("not accepted");
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ status: "ok", user_id: "u1", items: [] })));
    await expect(listContextInbox("test-session")).rejects.toThrow("unavailable");
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: "context_unavailable" }), { status: 503 }));
    await expect(listContextInbox("test-session")).rejects.toMatchObject({ status: 503 });
    // The disabled gate arrives as HTTP 200 + available:false: a terminal
    // business state the poller stops on, never an error.
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ status: "ok", available: false, items: [], can_display: false })));
    await expect(listContextInbox("test-session")).resolves.toEqual({ status: "ok", available: false, items: [], can_display: false });
  });

  it("downloads Markdown through the authenticated endpoint and rejects external paths and error payloads", async () => {
    fetchMock.mockResolvedValueOnce(new Response("# Goal review", { headers: { "Content-Type": "text/markdown; charset=utf-8" } }));
    const result = await downloadContextReview("/api/context/goals/goal-1/export", "test-session");
    expect(await result.text()).toBe("# Goal review");
    expect(fetchMock.mock.calls[0]?.[1].headers["X-API-Key"]).toBeUndefined();
    await expect(downloadContextReview("https://other.invalid/api/context/goals/goal-1/export", "test-session")).rejects.toThrow("Invalid");
    fetchMock.mockResolvedValueOnce(Response.json({ status: "error" }));
    await expect(downloadContextReview("/api/context/goals/goal-1/export", "test-session")).rejects.toThrow("unavailable");
    // Gateways may relabel the document or drop the header entirely.
    fetchMock.mockResolvedValueOnce(new Response("# Goal review", { headers: { "Content-Type": "text/plain" } }));
    await expect(downloadContextReview("/api/context/goals/goal-1/export", "test-session")).resolves.toBeInstanceOf(Blob);
    fetchMock.mockResolvedValueOnce(new Response("<html>proxy login</html>", { headers: { "Content-Type": "text/html" } }));
    await expect(downloadContextReview("/api/context/goals/goal-1/export", "test-session")).rejects.toThrow("unavailable");
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it.each(["", "text/plain", "application/octet-stream"])("rejects HTML and API error bodies served as '%s'", async (contentType) => {
    for (const body of [
      "<html>proxy login</html>",
      " \n<!DOCTYPE HTML><html><body>Bad gateway</body></html>",
      JSON.stringify({ status: "error", message: "Context unavailable" }),
      JSON.stringify({ error: "context_unavailable" }),
      JSON.stringify({ detail: "Not authenticated" }),
      JSON.stringify({ code: 2013, msg: "Please provide authentication token", data: null }),
    ]) {
      // A Blob body keeps the missing-header case truly untyped.
      const response = new Response(new Blob([body], { type: contentType }));
      expect(response.headers.get("Content-Type")).toBe(contentType || null);
      fetchMock.mockResolvedValueOnce(response);
      await expect(downloadContextReview("/api/context/goals/goal-1/export", "test-session")).rejects.toThrow("Context export unavailable");
    }
  });

  it.each(["", "text/plain", "application/octet-stream"])("preserves Markdown served as '%s'", async (contentType) => {
    const body = '# Goal review\n\n<div>Meeting notes</div>\n\n```json\n{"error":"example"}\n```';
    fetchMock.mockResolvedValueOnce(new Response(new Blob([body], { type: contentType })));
    const result = await downloadContextReview("/api/context/goals/goal-1/export", "test-session");
    expect(result.type).toBe(contentType);
    expect(await result.text()).toBe(body);
  });

  it("rejects a downloaded result when the account changes during body validation", async () => {
    const blob = new Blob(["# Old review"]);
    let finish!: (body: string) => void;
    const readBody = vi.spyOn(blob, "text").mockImplementation(() => new Promise<string>((resolve) => { finish = resolve; }));
    vi.spyOn(client, "getBlob").mockResolvedValueOnce(blob);
    const result = downloadContextReview("/api/context/goals/goal-1/export", "test-session");
    await vi.waitFor(() => expect(readBody).toHaveBeenCalledOnce());
    client.setToken("other-session");
    finish("# Old review");
    await expect(result).rejects.toThrow("Session changed");
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
