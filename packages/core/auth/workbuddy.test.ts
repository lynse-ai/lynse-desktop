import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The Lynse API client is routed through a path-keyed mock; values may be
// plain responses or zero-arg functions for sequenced answers. Everything the
// vi.mock factory touches must live in vi.hoisted — the factory runs before
// the module body.
const mocks = vi.hoisted(() => {
  const identity = { backend: "https://one.example.test", token: "user-one" };
  const getRoutes = new Map<string, unknown>();
  const postRoutes = new Map<string, unknown>();
  const mockApi = {
    getBaseUrl: () => identity.backend,
    getToken: () => identity.token,
    get: vi.fn(async (path: string) => {
      const handler = getRoutes.get(path);
      if (handler === undefined) throw new Error(`unexpected GET ${path}`);
      return typeof handler === "function" ? (handler as () => unknown)() : handler;
    }),
    post: vi.fn(async (path: string) => {
      const handler = postRoutes.get(path);
      if (handler === undefined) throw new Error(`unexpected POST ${path}`);
      return typeof handler === "function" ? (handler as () => unknown)() : handler;
    }),
  };
  return { mockApi, getRoutes, postRoutes, identity };
});

vi.mock("../api/client", () => ({
  api: () => mocks.mockApi,
  ApiError: class MockApiError extends Error {},
}));

import {
  callWorkBuddyOpenApi,
  clearWorkBuddyTokenCache,
  getWorkBuddyOnlineStatus,
  parseExpiresAtMs,
  pollWorkBuddyAuthorization,
  runWorkBuddyAuthorization,
  startWorkBuddyAuthorization,
  setWorkBuddyAuthorizationDiagnostics,
  setWorkBuddyHttpRelay,
  WorkBuddyPollTimeoutError,
  WorkBuddyRateLimitError,
  type WorkBuddyHttpRelayRequest,
  type WorkBuddyHttpRelayResponse,
  type WorkBuddyTokenInfo,
  type WorkBuddyAuthorizationDiagnostics,
} from "./workbuddy";

const { mockApi, getRoutes, postRoutes } = mocks;

const TOKEN_OK: WorkBuddyTokenInfo = {
  authorized: true,
  accessToken: "tok-1",
  openId: "open-1",
  scope: "user.profile.readable",
  expiresAt: "2999-01-01 00:00:00",
};

/** Direct-OpenAPI answers the injected relay hands out, in order. */
let relayQueue: WorkBuddyHttpRelayResponse[] = [];
let relayCalls: WorkBuddyHttpRelayRequest[] = [];

setWorkBuddyHttpRelay(async (req) => {
  relayCalls.push(req);
  const next = relayQueue.shift();
  if (!next) throw new Error("relay queue drained unexpectedly");
  return next;
});

beforeEach(() => {
  mocks.identity.backend = "https://one.example.test";
  mocks.identity.token = "user-one";
  clearWorkBuddyTokenCache();
  getRoutes.clear();
  postRoutes.clear();
  relayQueue = [];
  relayCalls = [];
  getRoutes.set("/api/auth/workbuddy/token", TOKEN_OK);
  mockApi.get.mockClear();
  mockApi.post.mockClear();
});

afterEach(() => {
  setWorkBuddyAuthorizationDiagnostics(null);
  vi.useRealTimers();
});

describe("parseExpiresAtMs", () => {
  it("reads the server wall clock as UTC+8, not the local timezone", () => {
    // 08:00 in Shanghai is 00:00 UTC — the machine's own offset must not matter.
    expect(parseExpiresAtMs("2026-01-01 08:00:00")).toBe(Date.UTC(2026, 0, 1, 0, 0, 0));
    expect(parseExpiresAtMs("2026-01-01T08:00:00")).toBe(Date.UTC(2026, 0, 1, 0, 0, 0));
  });

  it("yields 0 for missing or malformed values", () => {
    expect(parseExpiresAtMs(undefined)).toBe(0);
    expect(parseExpiresAtMs("")).toBe(0);
    expect(parseExpiresAtMs("not a date")).toBe(0);
  });
});

describe("callWorkBuddyOpenApi", () => {
  it("does not reuse a cached grant after switching backend or account", async () => {
    relayQueue.push({ status: 200, body: "{}" }, { status: 200, body: "{}" }, { status: 200, body: "{}" });
    await callWorkBuddyOpenApi("/tasks");
    mocks.identity.token = "user-two";
    getRoutes.set("/api/auth/workbuddy/token", { ...TOKEN_OK, accessToken: "second-user-ticket" });
    await callWorkBuddyOpenApi("/tasks");
    mocks.identity.backend = "https://two.example.test";
    getRoutes.set("/api/auth/workbuddy/token", { ...TOKEN_OK, accessToken: "second-backend-ticket" });
    await callWorkBuddyOpenApi("/tasks");
    expect(relayCalls.map((call) => call.accessToken)).toEqual(["tok-1", "second-user-ticket", "second-backend-ticket"]);
    expect(mockApi.get).toHaveBeenCalledTimes(3);
  });
  it("discards a delayed grant from a previous account before relaying it", async () => {
    let resolve!: (value: WorkBuddyTokenInfo) => void;
    getRoutes.set("/api/auth/workbuddy/token", () => new Promise<WorkBuddyTokenInfo>((done) => { resolve = done; }));
    const pending = callWorkBuddyOpenApi("/tasks").catch((error: Error) => error);
    mocks.identity.token = "other-user"; clearWorkBuddyTokenCache();
    resolve(TOKEN_OK);
    expect((await pending as Error).message).toBe("WorkBuddy session changed");
    expect(relayCalls).toEqual([]);
  });
  it("backs off 1s → 2s on 429 and succeeds on the third send", async () => {
    vi.useFakeTimers();
    relayQueue.push(
      { status: 429, body: "{}" },
      { status: 429, body: "{}" },
      { status: 200, body: '{"ok":1}' },
    );
    const promise = callWorkBuddyOpenApi<unknown>("/localassistant");
    const settled = promise.then(
      (v) => ({ ok: true as const, v }),
      (e) => ({ ok: false as const, e }),
    );
    await vi.advanceTimersByTimeAsync(0); // first send (no backoff yet)
    await vi.advanceTimersByTimeAsync(1_000); // second send
    await vi.advanceTimersByTimeAsync(2_000); // third send → 200
    await expect(settled).resolves.toEqual({ ok: true, v: { ok: 1 } });
    expect(relayCalls).toHaveLength(3);
  });

  it("raises WorkBuddyRateLimitError after the documented backoff is exhausted", async () => {
    vi.useFakeTimers();
    relayQueue.push(
      { status: 429, body: "{}" },
      { status: 429, body: "{}" },
      { status: 429, body: "{}" },
      { status: 429, body: "{}" },
    );
    const promise = callWorkBuddyOpenApi<unknown>("/localassistant");
    const settled = promise.then(
      (v) => ({ ok: true as const, v }),
      (e) => ({ ok: false as const, e }),
    );
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(2_000);
    await vi.advanceTimersByTimeAsync(4_000);
    const outcome = await settled;
    if (outcome.ok) throw new Error("expected the backoff to exhaust");
    expect(outcome.e).toBeInstanceOf(WorkBuddyRateLimitError);
    expect(relayCalls).toHaveLength(4);
  });

  it("refreshes and retries once on a 401", async () => {
    postRoutes.set("/api/auth/workbuddy/token/refresh", {
      ...TOKEN_OK,
      accessToken: "tok-2",
    });
    relayQueue.push(
      { status: 401, body: '{"error":"invalid_token"}' },
      { status: 200, body: '{"ok":1}' },
    );
    await expect(callWorkBuddyOpenApi<unknown>("/x")).resolves.toEqual({ ok: 1 });
    expect(mockApi.post).toHaveBeenCalledWith("/api/auth/workbuddy/token/refresh");
    // The retry must ride the refreshed ticket.
    expect(relayCalls[1]!.accessToken).toBe("tok-2");
  });

  it("refreshes and retries on a 403 insufficient_scope (grant moved under the ticket)", async () => {
    postRoutes.set("/api/auth/workbuddy/token/refresh", {
      ...TOKEN_OK,
      accessToken: "tok-2",
    });
    relayQueue.push(
      { status: 403, body: '{"error":"insufficient_scope"}' },
      { status: 200, body: '{"ok":1}' },
    );
    await expect(callWorkBuddyOpenApi<unknown>("/x")).resolves.toEqual({ ok: 1 });
    expect(mockApi.post).toHaveBeenCalledWith("/api/auth/workbuddy/token/refresh");
  });

  it("surfaces other 403s (denied/whitelist) immediately without a refresh", async () => {
    relayQueue.push({ status: 403, body: '{"error":"forbidden"}' });
    await expect(callWorkBuddyOpenApi<unknown>("/x")).rejects.toThrow(/\(403\).*forbidden/);
    expect(mockApi.post).not.toHaveBeenCalled();
  });

  it("carries the upstream body excerpt on terminal failures", async () => {
    relayQueue.push({ status: 400, body: '{"error":"invalid_request"}' });
    await expect(callWorkBuddyOpenApi<unknown>("/x")).rejects.toThrow(/invalid_request/);
  });

  it("rejects with context when a 2xx body is not JSON", async () => {
    relayQueue.push({ status: 200, body: "" });
    await expect(callWorkBuddyOpenApi<unknown>("/x")).rejects.toThrow(/non-JSON body \(200\)/);
  });
});

describe("getWorkBuddyOnlineStatus", () => {
  it("reads data.online and tolerates the bare shape", async () => {
    relayQueue.push({ status: 200, body: '{"code":0,"data":{"online":true}}' });
    await expect(getWorkBuddyOnlineStatus()).resolves.toBe(true);

    relayQueue.push({ status: 200, body: '{"online":true}' });
    await expect(getWorkBuddyOnlineStatus()).resolves.toBe(true);

    relayQueue.push({ status: 200, body: '{"code":0,"data":{"online":false}}' });
    await expect(getWorkBuddyOnlineStatus()).resolves.toBe(false);
  });
});

describe("pollWorkBuddyAuthorization", () => {
  it("rejects a grant that arrives after the attempt is cancelled", async () => {
    let resolve!: (value: WorkBuddyTokenInfo) => void;
    getRoutes.set("/api/auth/workbuddy/token", () => new Promise<WorkBuddyTokenInfo>((done) => { resolve = done; }));
    let cancelled = false;
    const pending = pollWorkBuddyAuthorization({ isCancelled: () => cancelled }).catch((error: Error) => error);
    cancelled = true;
    resolve(TOKEN_OK);
    expect((await pending as Error).message).toBe("cancelled");
  });
  const stale: WorkBuddyTokenInfo = {
    ...TOKEN_OK,
    expiresAt: "2026-10-01 12:00:00",
  };
  const fresh: WorkBuddyTokenInfo = {
    ...TOKEN_OK,
    expiresAt: "2026-10-09 12:00:00",
  };

  it("does not resolve on a pre-existing unchanged binding", async () => {
    getRoutes.set("/api/auth/workbuddy/token", stale);
    await expect(
      pollWorkBuddyAuthorization({ previous: stale, intervalMs: 1, timeoutMs: 60 }),
    ).rejects.toBeInstanceOf(WorkBuddyPollTimeoutError);
  });

  it("resolves once the binding fingerprint moves", async () => {
    getRoutes.set("/api/auth/workbuddy/token", () => fresh);
    await expect(
      pollWorkBuddyAuthorization({ previous: stale, intervalMs: 1, timeoutMs: 2_000 }),
    ).resolves.toEqual(fresh);
  });

  it("resolves immediately for a first-time bind (no previous)", async () => {
    getRoutes.set("/api/auth/workbuddy/token", () => fresh);
    await expect(
      pollWorkBuddyAuthorization({ intervalMs: 1, timeoutMs: 2_000 }),
    ).resolves.toEqual(fresh);
  });
});

describe("runWorkBuddyAuthorization", () => {
  it("does not open a delayed authorize URL after switching account", async () => {
    let resolve!: (value: { authorizeUrl: string; state: string }) => void;
    const requested = new Promise<void>((started) => {
      getRoutes.set("/api/auth/workbuddy/authorize", () => { started(); return new Promise((done) => { resolve = done; }); });
    });
    const opened: string[] = [];
    const pending = runWorkBuddyAuthorization({ openUrl: (url) => opened.push(url) }).catch((error: Error) => error);
    await requested;
    mocks.identity.token = "other-account";
    resolve({ authorizeUrl: "https://www.workbuddy.cn/openapi/v2/authorize?scope=user.profile.readable", state: "opaque" });
    expect((await pending as Error).message).toBe("WorkBuddy session changed");
    expect(opened).toEqual([]);
  });
  it("requests the cloud scope list and reports its configuration without secrets", async () => {
    const state = "private-state";
    const url = new URL("https://www.workbuddy.cn/openapi/v2/authorize");
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", "private-client-id");
    url.searchParams.set("redirect_uri", "https://gapp.lynse.cn/api/auth/workbuddy/callback?tenant=private-tenant");
    url.searchParams.set("state", state);
    url.searchParams.set("scope", "user.task.readable user.credit.exchange user.contact.readable user.task.invokable");
    url.searchParams.set("client_secret", "private-secret");
    getRoutes.set("/api/auth/workbuddy/authorize", { authorizeUrl: url.href, state });
    const records: WorkBuddyAuthorizationDiagnostics[] = [];
    setWorkBuddyAuthorizationDiagnostics((value) => records.push(value));
    const opened: string[] = [];
    let reads = 0;
    getRoutes.set("/api/auth/workbuddy/token", () => ({ ...TOKEN_OK, expiresAt: `${++reads}` }));
    await runWorkBuddyAuthorization({ cloud: true, openUrl: (value) => opened.push(value), intervalMs: 1, timeoutMs: 2000 });
    expect(opened).toHaveLength(1);
    const actual = new URL(opened[0]!);
    expect(actual.searchParams.get("scope")).toBe("user.profile.readable user.task.readable user.task.invokable");
    for (const [key, value] of url.searchParams) {
      if (key !== "scope") expect(actual.searchParams.get(key)).toBe(value);
    }
    expect(records).toEqual([{
      backendOrigin: "https://one.example.test",
      authorizeEndpoint: "https://www.workbuddy.cn/openapi/v2/authorize",
      redirectEndpoint: "https://gapp.lynse.cn/api/auth/workbuddy/callback",
      responseTypeCode: true, clientIdPresent: true, redirectUriPresent: true,
      statePresent: true, stateMatches: true, scopeExplicit: true, contactReadable: false, creditExchange: false,
      taskReadable: true, taskInvokable: true,
    }]);
    expect(JSON.stringify(records)).not.toContain("private-");
  });

  it("opens the authorize URL and waits for the binding to move", async () => {
    const stale: WorkBuddyTokenInfo = { ...TOKEN_OK, expiresAt: "2026-10-01 12:00:00" };
    const fresh: WorkBuddyTokenInfo = { ...TOKEN_OK, expiresAt: "2026-10-09 12:00:00" };
    getRoutes.set("/api/auth/workbuddy/authorize", {
      authorizeUrl: "https://www.workbuddy.cn/openapi/v2/authorize?client_id=x&scope=user.profile.readable",
      state: "s1",
    });
    let tokenCall = 0;
    getRoutes.set("/api/auth/workbuddy/token", () => (tokenCall++ === 0 ? stale : fresh));

    const opened: string[] = [];
    const result = await runWorkBuddyAuthorization({
      openUrl: (url) => opened.push(url),
      intervalMs: 1,
      timeoutMs: 2_000,
    });

    expect(opened).toEqual(["https://www.workbuddy.cn/openapi/v2/authorize?client_id=x&scope=user.profile.readable"]);
    expect(result).toEqual(fresh);
  });

  it("surfaces authorize-start failures instead of opening the browser", async () => {
    getRoutes.delete("/api/auth/workbuddy/authorize");
    const opened: string[] = [];
    await expect(
      runWorkBuddyAuthorization({ openUrl: (url) => opened.push(url) }),
    ).rejects.toThrow(/unexpected GET/);
    expect(opened).toEqual([]);
  });
});

describe("WorkBuddy authorization scope policy", () => {
  it("requests both cloud task scopes and profile access instead of unrelated backend scopes", async () => {
    const original = new URL("https://www.workbuddy.cn/openapi/v2/authorize");
    original.searchParams.set("redirect_uri", "https://api.lynse.cn/api/auth/workbuddy/callback");
    original.searchParams.set("state", "opaque-state");
    original.searchParams.set("scope", "user.profile.readable user.contact.readable user.credit.exchange user.task.invokable user.localassistant.readable user.localassistant.invokable");
    getRoutes.set("/api/auth/workbuddy/authorize", { authorizeUrl: original.href, state: "opaque-state" });
    const opened = new URL((await startWorkBuddyAuthorization({ cloud: true })).authorizeUrl);
    expect(opened.searchParams.get("scope")).toBe("user.profile.readable user.task.readable user.task.invokable");
    expect(opened.searchParams.get("redirect_uri")).toBe(original.searchParams.get("redirect_uri"));
    expect(opened.searchParams.get("state")).toBe("opaque-state");
  });

  it("uses an explicit cloud scope list even when the backend relies on platform defaults", async () => {
    getRoutes.set("/api/auth/workbuddy/authorize", { authorizeUrl: "https://www.workbuddy.cn/openapi/v2/authorize", state: "opaque" });
    const result = await startWorkBuddyAuthorization({ cloud: true });
    expect(new URL(result.authorizeUrl).searchParams.get("scope")).toBe("user.profile.readable user.task.readable user.task.invokable");
  });

  it("removes contact and credit access and preserves callback, state and other scopes", async () => {
    const original = new URL("https://www.workbuddy.cn/openapi/v2/authorize");
    original.searchParams.set("response_type", "code");
    original.searchParams.set("client_id", "mock-client");
    original.searchParams.set("redirect_uri", "https://api.lynse.cn/api/auth/workbuddy/callback");
    original.searchParams.set("state", "opaque-state");
    original.searchParams.set("scope", "user.profile.readable user.contact.readable user.credit.exchange user.task.invokable user.localassistant.readable user.localassistant.invokable");
    getRoutes.set("/api/auth/workbuddy/authorize", { authorizeUrl: original.href, state: "opaque-state" });
    const result = await startWorkBuddyAuthorization();
    const opened = new URL(result.authorizeUrl);
    expect(opened.searchParams.get("scope")).toBe("user.profile.readable user.task.invokable user.localassistant.readable user.localassistant.invokable");
    for (const key of ["response_type", "client_id", "redirect_uri", "state"]) {
      expect(opened.searchParams.get(key)).toBe(original.searchParams.get(key));
    }
    expect(result.state).toBe("opaque-state");
  });

  it("refuses an empty or implicit scope list instead of requesting all registered permissions", async () => {
    for (const query of ["", "?scope=", "?scope=user.contact.readable", "?scope=user.credit.exchange", "?scope=user.contact.readable+user.credit.exchange"]) {
      getRoutes.set("/api/auth/workbuddy/authorize", { authorizeUrl: `https://www.workbuddy.cn/openapi/v2/authorize${query}`, state: "opaque" });
      await expect(startWorkBuddyAuthorization()).rejects.toThrow(/scope/i);
    }
  });
});
