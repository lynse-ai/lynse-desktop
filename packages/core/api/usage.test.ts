import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ApiClient, setApiInstance, setApiTransportMode } from "./client";
import { getUsageSummary } from "./usage";

let client: ApiClient;
let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  client = new ApiClient("https://business.invalid");
  client.setAgentBaseUrl("https://agent.invalid");
  client.setToken("session");
  client.setApiKey("must-not-be-used");
  setApiInstance(client);
  setApiTransportMode("direct");
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => { vi.unstubAllGlobals(); setApiTransportMode("proxy"); });

it("queries the selected agent with the current token and no API key", async () => {
  fetchMock.mockResolvedValue(new Response(JSON.stringify({
    mode: "shadow", available: true, charged_micro_points: 0,
    totals: { calls: 1 }, shadow_micro_points: 100, pending_orders: 0, groups: [],
  })));
  const controller = new AbortController();
  await getUsageSummary("session", controller.signal);
  expect(fetchMock.mock.calls[0]?.[0]).toBe("https://agent.invalid/api/usage/summary");
  expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ signal: controller.signal, headers: { Authorization: "session" } });
  expect(fetchMock.mock.calls[0]?.[1].headers["X-API-Key"]).toBeUndefined();
});

it("does not query after logout or a session change", async () => {
  client.setToken("other");
  await expect(getUsageSummary("session")).rejects.toThrow("Session changed");
  client.setToken(null);
  await expect(getUsageSummary("session")).rejects.toThrow("Session changed");
  expect(fetchMock).not.toHaveBeenCalled();
});

it("does not display a paid or unavailable response as a shadow zero", async () => {
  fetchMock.mockImplementation(() => Promise.resolve(new Response(JSON.stringify({ mode: "paid", available: true, charged_micro_points: 1, totals: {} }))));
  await expect(getUsageSummary("session")).rejects.toThrow("Usage summary unavailable");
});
