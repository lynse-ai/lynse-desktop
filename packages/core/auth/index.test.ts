import { beforeEach, describe, expect, it, vi } from "vitest";
import { createAuthStore } from "./index";
import { CLOUDBASE_AGENT_URL } from "../config";
import type { ApiClient } from "../api/client";
import type { StorageAdapter } from "../types/storage";

function memoryStorage(): StorageAdapter {
  const map = new Map<string, string>();
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    removeItem: (key: string) => void map.delete(key),
  } as unknown as StorageAdapter;
}

interface RecordedPost {
  path: string;
  body: unknown;
  options: Record<string, unknown> | undefined;
}

function fakeApi(opts: { baseUrl?: string; failRegister?: boolean } = {}) {
  const posts: RecordedPost[] = [];
  let baseUrl = opts.baseUrl ?? "";
  const api = {
    setBaseUrl: (url: string) => {
      baseUrl = url;
    },
    getBaseUrl: () => baseUrl,
    setAgentBaseUrl: vi.fn(),
    getAgentBaseUrl: () => CLOUDBASE_AGENT_URL,
    setApiKey: vi.fn(),
    getToken: () => "session-token",
    setToken: vi.fn(),
    post: vi.fn(async (path: string, body?: unknown, options?: Record<string, unknown>) => {
      posts.push({ path, body, options });
      if (path !== "/api/auth/apikey/token" && opts.failRegister) {
        throw new Error("agent unreachable");
      }
      return { accessToken: "token-123" };
    }),
  };
  return { api: api as unknown as ApiClient, posts };
}

describe("auth backend-host registration", () => {
  let storage: StorageAdapter;

  beforeEach(() => {
    storage = memoryStorage();
  });

  it("registers the login gateway with the agent after API login", async () => {
    const { api, posts } = fakeApi();
    const store = createAuthStore({ api, storage });

    await store.getState().login("dk-key", "https://api.test.local");

    const register = posts.find((p) => p.path === "/api/session/backend");
    expect(register).toBeDefined();
    expect(register!.body).toEqual({ host: "https://api.test.local" });
    expect(register!.options).toMatchObject({ baseUrl: CLOUDBASE_AGENT_URL, tokenOnly: true });
    expect(store.getState().isAuthenticated).toBe(true);
  });

  it("a failed registration never breaks the login state", async () => {
    const { api, posts } = fakeApi({ baseUrl: "https://api.test.local", failRegister: true });
    const store = createAuthStore({ api, storage });

    await expect(store.getState().login("dk-key")).resolves.toBeUndefined();

    expect(posts.some((p) => p.path === "/api/session/backend")).toBe(true);
    expect(store.getState().isAuthenticated).toBe(true);
  });

  it("completing a phone/WeChat session registers through persistSession", async () => {
    const { api, posts } = fakeApi({ baseUrl: "https://api.test.local" });
    const store = createAuthStore({ api, storage });

    store.getState().completeLogin({
      accessToken: "wechat-token",
      user: { id: "u-1", name: "Lynse", email: "" },
    });

    const register = posts.find((p) => p.path === "/api/session/backend");
    expect(register).toBeDefined();
    expect(register!.body).toEqual({ host: "https://api.test.local" });
  });

  it("restoreSession re-registers saved-token sessions", async () => {
    const { api, posts } = fakeApi({ baseUrl: "https://api.test.local" });
    storage.setItem("lynse_token", "saved-token");
    const store = createAuthStore({ api, storage });

    await store.getState().restoreSession();

    expect(store.getState().isAuthenticated).toBe(true);
    const register = posts.find((p) => p.path === "/api/session/backend");
    expect(register).toBeDefined();
    expect(register!.body).toEqual({ host: "https://api.test.local" });
  });

  it("skips registration when no agent URL is configured", async () => {
    const posts: RecordedPost[] = [];
    const api = {
      setBaseUrl: vi.fn(),
      getBaseUrl: () => "https://api.test.local",
      setAgentBaseUrl: vi.fn(),
      getAgentBaseUrl: () => null,
      setApiKey: vi.fn(),
      getToken: () => "session-token",
      setToken: vi.fn(),
      post: vi.fn(async () => ({ accessToken: "token-123" })),
    } as unknown as ApiClient;
    const store = createAuthStore({ api, storage });

    await store.getState().login("dk-key", "https://api.test.local");

    expect(store.getState().isAuthenticated).toBe(true);
    expect(vi.mocked(api.post).mock.calls.every((call) => call[0] !== "/api/session/backend")).toBe(true);
    void posts;
  });
});
