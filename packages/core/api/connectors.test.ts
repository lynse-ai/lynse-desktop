import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiClient, setApiInstance, setApiTransportMode } from "./client";
import { getConnectorRequest, normalizeConnectionRequest, resumeConnectorRequest } from "./connectors";

let client: ApiClient;
beforeEach(() => {
  client = new ApiClient("https://business.invalid");
  client.setAgentBaseUrl("https://agent.invalid");
  client.setToken("test-session");
  client.setApiKey("test-api-key");
  setApiInstance(client);
  setApiTransportMode("direct");
});
afterEach(() => { vi.unstubAllGlobals(); setApiTransportMode("proxy"); });

describe("connector requests", () => {
  it("only opens HTTPS authorization entries and drops unrelated credentials and paths", () => {
    const raw = { request_id: "req-1", provider: "notion", status: "waiting_auth", action_url: "https://auth.invalid/start", access_token: "secret", resume_url: "https://attacker.invalid" };
    const card = normalizeConnectionRequest(raw)!;
    expect(card.action_url).toBe(raw.action_url);
    expect(card).not.toHaveProperty("access_token");
    expect(card).not.toHaveProperty("resume_url");
    for (const action_url of ["javascript:alert(1)", "file:///etc/passwd", "https://user:password@auth.invalid", "http://auth.invalid"]) {
      expect(normalizeConnectionRequest({ ...raw, action_url })?.action_url).toBeUndefined();
    }
    expect(normalizeConnectionRequest({ ...raw, request_id: "../other" })).toBeNull();
  });

  it("accepts the backend account-selection card without a waiting task", () => {
    expect(normalizeConnectionRequest({ provider: "notion", status: "account_selection_required", accounts: [{ account_id: "work", display_name: "Work" }] })).toMatchObject({ request_id: "", accounts: [{ id: "work", display_name: "Work" }] });
  });

  it("uses fixed agent routes and current user credentials without the API key", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ request_id: "req-1", status: "waiting_auth" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await getConnectorRequest("req-1", "test-session");
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://agent.invalid/api/connectors/requests/req-1");
    expect(fetchMock.mock.calls[0]?.[1].headers.Authorization).toBe("test-session");
    expect(fetchMock.mock.calls[0]?.[1].headers["X-API-Key"]).toBeUndefined();
    await expect(resumeConnectorRequest("../other", "test-session")).rejects.toThrow("Invalid connector request");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    client.setToken("new-session");
    await expect(getConnectorRequest("req-1", "test-session")).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects a late response after account changes", async () => {
    let finish!: (response: Response) => void;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((resolve) => { finish = resolve; })));
    const pending = getConnectorRequest("req-1", "test-session");
    client.setToken("new-session");
    finish(new Response(JSON.stringify({ request_id: "req-1", status: "done" }), { status: 200 }));
    await expect(pending).rejects.toThrow();
  });
});
