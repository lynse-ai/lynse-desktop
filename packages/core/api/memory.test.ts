import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiClient, setApiInstance, setApiTransportMode } from "./client";
import { memoryApi } from "./memory";
let client: ApiClient;
let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  client = new ApiClient("https://business.invalid"); client.setAgentBaseUrl("https://runtime.invalid"); client.setToken("synthetic-token"); client.setApiKey("never-transmit");
  vi.spyOn(client, "ensureAgentSession").mockResolvedValue(undefined);
  setApiInstance(client); setApiTransportMode("direct"); fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => { vi.unstubAllGlobals(); setApiTransportMode("proxy"); });
describe("memory authority client", () => {
  it("sends token-only writes with a frozen operation and revision", async () => {
    fetchMock.mockImplementation(async () => new Response(JSON.stringify({ status: "ok" })));
    const body = { action: "replace" as const, record_id: "one", expected_revision: 7, content: "Human correction" };
    await memoryApi.action(body, "same-operation"); await memoryApi.action(body, "same-operation");
    for (const [url, options] of fetchMock.mock.calls) {
      expect(url).toBe("https://runtime.invalid/api/memory/actions");
      expect(options.headers).toMatchObject({ Authorization: "synthetic-token", "Operation-Id": "same-operation" });
      expect(options.headers["X-API-Key"]).toBeUndefined(); expect(JSON.parse(options.body)).toEqual(body);
    }
  });
  it("does not fall back to legacy save endpoints when the capability is unavailable", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: { code: "knowledge_unavailable" } }), { status: 503 }));
    await expect(memoryApi.capabilities()).rejects.toThrow(); expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it("discards an old account response", async () => {
    let finish!: (response: Response) => void;
    fetchMock.mockImplementation(() => new Promise<Response>(resolve => { finish = resolve; }));
    const result = memoryApi.explain("one"); await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    client.setToken("new-account"); finish(new Response(JSON.stringify({ content: "Previous account" })));
    await expect(result).rejects.toThrow("Session changed");
  });
  it("does not send a request after logout", async () => {
    client.setToken(null); await expect(memoryApi.list("confirmed")).rejects.toThrow("Sign in"); expect(fetchMock).not.toHaveBeenCalled();
  });
});
