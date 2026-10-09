import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

beforeEach(() => vi.resetModules());
afterEach(() => vi.unstubAllGlobals());

describe("Connections routing at startup", () => {
  it.each([
    { http: 401, code: "unauthorized", message: "error.integrations.unauthorized" },
    { http: 200, code: 2013, message: "Please provide authentication token" },
    { http: 200, code: 2000, message: "User is not logged in or session has expired" },
  ])("keeps the main login and credentials when calendar auth fails with $code", async ({ http, code, message }) => {
    const { initCore } = await import("./core-provider");
    const { api, setApiTransportMode } = await import("../api/client");
    const { getAuthStore } = await import("../auth");
    const { fetchCalendarEvents, fetchIntegrationStatus } = await import("../integrations/api");
    const values = new Map<string, string>();
    const onLogout = vi.fn();
    initCore("https://business.test", {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => { values.set(key, value); },
      removeItem: (key) => { values.delete(key); },
    }, undefined, onLogout);
    const auth = getAuthStore()!;
    auth.getState().completeLogin({
      accessToken: "valid-main-session",
      apiKey: "main-api-key",
      user: { id: "u1", name: "User", email: "" },
    });
    setApiTransportMode("direct");
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(
      Response.json({ code, msg: message, data: null }, { status: http }),
    ));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchCalendarEvents({ from: "2026-10-09", to: "2026-10-10" })).rejects.toMatchObject({ status: http === 401 ? 401 : code });
    await expect(fetchIntegrationStatus("google-calendar")).rejects.toBeTruthy();
    expect(auth.getState().isAuthenticated).toBe(true);
    expect(values.get("lynse_token")).toBe("valid-main-session");
    expect(values.get("lynse_api_key")).toBe("main-api-key");
    expect(api().getToken()).toBe("valid-main-session");
    expect(onLogout).not.toHaveBeenCalled();
    for (const [url, init] of fetchMock.mock.calls) {
      expect(String(url)).toMatch(/^https:\/\/www\.lynse\.ai\/api\/v2\//);
      expect(init.headers.Authorization).toBe("Bearer valid-main-session");
      expect(init.headers["X-API-Key"]).toBeUndefined();
    }

    // Main-account failures still expire the main login, using its raw token.
    fetchMock.mockResolvedValueOnce(new Response("{}", { status: 401 }));
    await expect(api().get("/api/business/customer/current")).rejects.toMatchObject({ status: 401 });
    expect(fetchMock.mock.calls.at(-1)?.[1].headers.Authorization).toBe("valid-main-session");
    expect(auth.getState().isAuthenticated).toBe(false);
    expect(onLogout).toHaveBeenCalledOnce();
  });

  it("isolates integration auth even when the service shares the main origin", async () => {
    const { ApiClient, setApiInstance, setApiTransportMode } = await import("../api/client");
    const { fetchIntegrationStatus } = await import("../integrations/api");
    const unauthorized = vi.fn();
    const client = new ApiClient("https://business.test", { onUnauthorized: unauthorized });
    client.setToken("main-session");
    setApiInstance(client);
    setApiTransportMode("direct");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}", { status: 401 })));

    await expect(fetchIntegrationStatus("google-calendar")).rejects.toMatchObject({ status: 401 });
    expect(client.getToken()).toBe("main-session");
    expect(unauthorized).not.toHaveBeenCalled();
  });

  it.each([undefined, "", " \n "])("routes Feishu setup to the BFF with a saved origin of %j", async (savedOrigin) => {
    const { initCore } = await import("./core-provider");
    const { api, setApiTransportMode } = await import("../api/client");
    const { startFeishuAppSetup } = await import("../integrations/api");
    const values = new Map<string, string>();
    if (savedOrigin !== undefined) values.set("lynse_integrations_api_url", savedOrigin);
    initCore("https://business.test", {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => { values.set(key, value); },
      removeItem: (key) => { values.delete(key); },
    });
    setApiTransportMode("direct");
    const fetchMock = vi.fn().mockResolvedValue(Response.json({
      state: "setup-feishu-test",
      url: "https://accounts.feishu.cn/confirm",
      expire_in: 600,
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(startFeishuAppSetup()).resolves.toMatchObject({ state: "setup-feishu-test" });
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://www.lynse.ai/api/v2/integrations/feishu-app-setup");
    expect(api().getBaseUrl()).toBe("https://business.test");
  });

  it("preserves an explicitly configured BFF without overwriting saved settings", async () => {
    const { initCore } = await import("./core-provider");
    const { api } = await import("../api/client");
    const setItem = vi.fn();
    initCore("https://business.test", {
      getItem: (key) => key === "lynse_integrations_api_url" ? " https://custom.test/ \n" : null,
      setItem,
      removeItem: vi.fn(),
    });

    expect(api().getIntegrationsBaseUrl()).toBe("https://custom.test");
    expect(api().getBaseUrl()).toBe("https://business.test");
    expect(setItem).not.toHaveBeenCalled();
  });
});
