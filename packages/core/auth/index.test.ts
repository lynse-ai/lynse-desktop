import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAuthStore } from "./index";
import { CLOUDBASE_AGENT_URL, STAGING_CLOUDBASE_AGENT_URL } from "../config";
import { ApiClient, setApiTransportMode } from "../api/client";
import type { StorageAdapter } from "../types/storage";

let client: ApiClient;
let storage: StorageAdapter;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  const values = new Map<string, string>();
  storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
    removeItem: (key) => { values.delete(key); },
  };
  client = new ApiClient("https://api.lynse.cn");
  client.setAgentBaseUrl(CLOUDBASE_AGENT_URL);
  setApiTransportMode("direct");
  fetchMock = vi.fn(async (url: string) => url.endsWith("/api/session/backend")
    ? Response.json({ host: client.getBaseUrl(), user_id: "u-1" })
    : Response.json({ accessToken: "fresh-token" }));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  client.setToken(null);
  vi.unstubAllGlobals();
  setApiTransportMode("proxy");
});

function expectRegistration(token: string, host = "https://api.lynse.cn") {
  const request = fetchMock.mock.calls.find(([url]) => url.endsWith("/api/session/backend"));
  const agent = host === "https://gapp.lynse.cn" ? STAGING_CLOUDBASE_AGENT_URL : CLOUDBASE_AGENT_URL;
  expect(request?.[0]).toBe(`${agent}/api/session/backend`);
  const options = request?.[1] as RequestInit;
  expect(JSON.parse(options.body as string)).toEqual({ host });
  expect(options.headers).toMatchObject({ Authorization: token });
  expect(options.headers).not.toHaveProperty("X-API-Key");
}

describe("auth backend-host registration", () => {
  it("registers the selected gateway and the newly minted API login token", async () => {
    const store = createAuthStore({ api: client, storage });
    await store.getState().login("dk-key", "https://gapp.lynse.cn");
    await client.ensureAgentSession();
    expectRegistration("fresh-token", "https://gapp.lynse.cn");
    expect(store.getState().isAuthenticated).toBe(true);
  });

  it.each(["phone", "wechat"])("registers a %s token through completeLogin", async (channel) => {
    const store = createAuthStore({ api: client, storage });
    store.getState().completeLogin({ accessToken: `${channel}-token`, user: { id: "u-1", name: "", email: "" } });
    await client.ensureAgentSession();
    expectRegistration(`${channel}-token`);
    expect(storage.getItem("lynse_token")).toBe(`${channel}-token`);
  });

  it.each([false, true])("re-registers restored sessions (has API key: %s)", async (hasKey) => {
    storage.setItem("lynse_token", "saved-token");
    if (hasKey) storage.setItem("lynse_api_key", "dk-key");
    const store = createAuthStore({ api: client, storage });
    await store.getState().restoreSession();
    await client.ensureAgentSession();
    expectRegistration(hasKey ? "fresh-token" : "saved-token");
    expect(store.getState().isAuthenticated).toBe(true);
  });

  it("drops a previous API key when a phone/WeChat login supplies only its own token", async () => {
    client.setApiKey("previous-account-key");
    storage.setItem("lynse_api_key", "previous-account-key");
    const store = createAuthStore({ api: client, storage });
    store.getState().completeLogin({ accessToken: "phone-token", user: { id: "new-user", name: "", email: "" } });
    await client.ensureAgentSession();
    expect(storage.getItem("lynse_api_key")).toBeNull();
    await client.get("/api/business/customer/current");
    const request = fetchMock.mock.calls.at(-1)?.[1] as RequestInit;
    expect(request.headers).toMatchObject({ Authorization: "phone-token" });
    expect(request.headers).not.toHaveProperty("X-API-Key");
  });

  it("does not require direct-agent registration for gateway mode", async () => {
    client.setAgentBaseUrl(null);
    const store = createAuthStore({ api: client, storage });
    await store.getState().login("dk-key");
    await client.ensureAgentSession();
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(["https://api.lynse.cn/api/auth/apikey/token"]);
    expect(store.getState().isAuthenticated).toBe(true);
  });
});
