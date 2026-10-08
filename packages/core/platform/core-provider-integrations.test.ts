import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

beforeEach(() => vi.resetModules());
afterEach(() => vi.unstubAllGlobals());

describe("Connections routing at startup", () => {
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
