import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiClient, setApiTransportMode } from "./client";
import { createAuthStore } from "../auth";
import { CLOUDBASE_AGENT_URL } from "../config";

const backend = "https://api.lynse.cn";
let client: ApiClient;
let fetchMock: ReturnType<typeof vi.fn>;

function bindingResponse(host = backend) {
  return Response.json({ host, user_id: "verified-user" });
}

function login(token = "phone-or-wechat-token") {
  const values = new Map<string, string>();
  const store = createAuthStore({
    api: client,
    storage: {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => { values.set(key, value); },
      removeItem: (key) => { values.delete(key); },
    },
  });
  store.getState().completeLogin({ accessToken: token, user: { id: "", name: "", email: "" } });
  return store;
}

beforeEach(() => {
  vi.useFakeTimers();
  setApiTransportMode("direct");
  client = new ApiClient(backend);
  client.setAgentBaseUrl(CLOUDBASE_AGENT_URL);
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  client.setToken(null);
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  setApiTransportMode("proxy");
});

describe("CloudBase login binding", () => {
  it("holds the first chat until the login's backend registration succeeds", async () => {
    let finish!: (response: Response) => void;
    fetchMock.mockImplementation((url: string) => url.endsWith("/api/session/backend")
      ? new Promise<Response>((resolve) => { finish = resolve; })
      : Promise.resolve(Response.json({ task_id: "task" })));
    login();
    const chat = client.post("/api/chat/poll", { query: "hello" }, { baseUrl: CLOUDBASE_AGENT_URL });
    await vi.advanceTimersByTimeAsync(0);
    const beforeBinding = fetchMock.mock.calls.length;
    finish(bindingResponse());
    await chat;

    expect(beforeBinding).toBe(1);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      `${CLOUDBASE_AGENT_URL}/api/session/backend`, `${CLOUDBASE_AGENT_URL}/api/chat/poll`,
    ]);
  });

  it("retries a temporary registration failure while keeping the main login usable", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("offline")).mockImplementation(() => Promise.resolve(bindingResponse()));
    const store = login();
    expect(store.getState().isAuthenticated).toBe(true);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(store.getState().isAuthenticated).toBe(true);
  });

  it("shares registration across streaming and polling and only sends the live token", async () => {
    let finish!: (response: Response) => void;
    fetchMock.mockImplementation((url: string) => {
      if (url.endsWith("/api/session/backend")) return new Promise<Response>((resolve) => { finish = resolve; });
      if (url.endsWith("/stream")) return Promise.resolve(new Response('data: {"type":"done","text":"ok"}\n\n'));
      return Promise.resolve(Response.json({ task_id: "task" }));
    });
    client.setApiKey("private-api-key");
    login();
    const error = vi.fn();
    const chunk = vi.fn();
    const stream = new Promise<void>((resolve) => client.stream("/api/chat/stream", { query: "hello" }, chunk, error, resolve, { baseUrl: CLOUDBASE_AGENT_URL }));
    const poll = client.post("/api/chat/poll", { query: "hello" }, { baseUrl: CLOUDBASE_AGENT_URL });
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledOnce();
    finish(bindingResponse());
    await Promise.all([stream, poll]);
    expect(error).not.toHaveBeenCalled();
    expect(chunk).toHaveBeenCalledWith('{"type":"done","text":"ok"}');
    for (const [, options] of fetchMock.mock.calls) {
      expect(options.headers.Authorization).toBe("phone-or-wechat-token");
      expect(options.headers).not.toHaveProperty("X-API-Key");
    }
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body)).toEqual({ host: backend });
  });

  it("stops after three temporary failures and re-registers on a later turn", async () => {
    fetchMock.mockImplementation(() => Promise.resolve(Response.json({ detail: "busy" }, { status: 503 })));
    login();
    const chat = client.post("/api/chat/poll", {}, { baseUrl: CLOUDBASE_AGENT_URL }).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(await chat).toMatchObject({ status: 412 });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls.every(([url]) => url.endsWith("/api/session/backend"))).toBe(true);
    fetchMock.mockImplementation((url: string) => Promise.resolve(url.endsWith("/api/session/backend") ? bindingResponse() : Response.json({ task_id: "new-task" })));
    await expect(client.post("/api/chat/poll", {}, { baseUrl: CLOUDBASE_AGENT_URL })).resolves.toEqual({ task_id: "new-task" });
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it.each([400, 401, 403, 404, 2013])("does not retry a permanent binding rejection (%s) or expire the main login", async (status) => {
    const unauthorized = vi.fn();
    client = new ApiClient(backend, { onUnauthorized: unauthorized });
    client.setAgentBaseUrl(CLOUDBASE_AGENT_URL);
    fetchMock.mockImplementation(() => Promise.resolve(status === 2013
      ? Response.json({ code: status, data: null, msg: "Please provide authentication token" })
      : Response.json({ detail: "rejected" }, { status })));
    const store = login();
    await expect(client.post("/api/chat/poll", {}, { baseUrl: CLOUDBASE_AGENT_URL })).rejects.toMatchObject({ status: 412 });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(store.getState().isAuthenticated).toBe(true);
    expect(unauthorized).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds stalled registration even when the native adapter ignores cancellation", async () => {
    fetchMock.mockImplementation(() => new Promise<Response>(() => {}));
    login();
    const chat = client.post("/api/chat/poll", {}, { baseUrl: CLOUDBASE_AGENT_URL }).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(27_000);
    expect(await chat).toMatchObject({ status: 412 });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls.every(([, init]) => init.signal.aborted)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels a waiting chat immediately without cancelling the shared login registration", async () => {
    let finish!: (response: Response) => void;
    fetchMock.mockImplementation(() => new Promise<Response>((resolve) => { finish = resolve; }));
    login();
    const controller = new AbortController();
    const chat = client.post("/api/chat/poll", {}, { baseUrl: CLOUDBASE_AGENT_URL, signal: controller.signal });
    controller.abort();
    await expect(chat).rejects.toMatchObject({ name: "AbortError" });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]![1].signal.aborted).toBe(false);
    finish(bindingResponse());
    await client.ensureAgentSession();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["token", "backend", "agent", "logout"])("discards pending registration after a %s change", async (change) => {
    const responses: ((response: Response) => void)[] = [];
    fetchMock.mockImplementation(() => new Promise<Response>((resolve) => { responses.push(resolve); }));
    login();
    const oldChat = client.post("/api/chat/poll", {}, { baseUrl: CLOUDBASE_AGENT_URL }).catch((error: unknown) => error);
    if (change === "token") client.setToken("new-user-token");
    if (change === "backend") client.setBaseUrl("https://gapp.lynse.cn");
    if (change === "agent") client.setAgentBaseUrl("https://other-agent.invalid");
    if (change === "logout") client.setToken(null);
    expect(await oldChat).toMatchObject({ status: 401 });
    responses[0]!(new Response("expired", { status: 401 }));
    if (change !== "logout") {
      const fresh = client.ensureAgentSession();
      responses[1]!(bindingResponse(client.getBaseUrl()));
      await fresh;
      const call = fetchMock.mock.calls[1]!;
      expect(call[0]).toBe(`${client.getAgentBaseUrl()}/api/session/backend`);
      expect(call[1].headers.Authorization).toBe(client.getToken());
      expect(JSON.parse(call[1].body)).toEqual({ host: client.getBaseUrl() });
    }
    expect(fetchMock.mock.calls.every(([url]) => url.endsWith("/api/session/backend"))).toBe(true);
  });

  it("reuses a confirmed binding and clears it for each new token, backend or agent", async () => {
    fetchMock.mockImplementation(() => Promise.resolve(bindingResponse(client.getBaseUrl())));
    login();
    await client.ensureAgentSession();
    await client.ensureAgentSession();
    expect(fetchMock).toHaveBeenCalledOnce();
    client.setToken("new-token");
    await client.ensureAgentSession();
    client.setBaseUrl("https://gapp.lynse.cn");
    await client.ensureAgentSession();
    client.setAgentBaseUrl("https://other-agent.invalid");
    await client.ensureAgentSession();
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("rejects a stale turn's token before sending it under the new account", async () => {
    client.setToken("new-user-token");
    await expect(client.post("/api/chat/poll", {}, { baseUrl: CLOUDBASE_AGENT_URL, sessionToken: "old-user-token" })).rejects.toMatchObject({ status: 401 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not accept a success response for a different backend", async () => {
    fetchMock.mockImplementation(() => Promise.resolve(bindingResponse("https://gapp.lynse.cn")));
    login();
    await expect(client.post("/api/chat/poll", {}, { baseUrl: CLOUDBASE_AGENT_URL })).rejects.toMatchObject({ status: 412 });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("reports an undeployed CloudBase binding endpoint without sending the chat", async () => {
    fetchMock.mockImplementation(() => Promise.resolve(Response.json({ detail: "Not Found" }, { status: 404 })));
    login();
    const error = vi.fn();
    const complete = vi.fn();
    client.stream("/api/chat/stream", { query: "hello" }, vi.fn(), error, complete, { baseUrl: CLOUDBASE_AGENT_URL });
    await vi.advanceTimersByTimeAsync(0);
    expect(error).toHaveBeenCalledWith(expect.objectContaining({ status: 412, message: "助手服务需要更新，请更新后重试" }));
    expect(complete).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("does not turn a server switch during stream preflight into a recoverable stream drop", async () => {
    fetchMock.mockImplementation(() => new Promise<Response>(() => {}));
    login();
    const error = vi.fn();
    const complete = vi.fn();
    client.stream("/api/chat/stream", { query: "hello" }, vi.fn(), error, complete, { baseUrl: CLOUDBASE_AGENT_URL });
    client.setBaseUrl("https://gapp.lynse.cn");
    await vi.advanceTimersByTimeAsync(0);
    expect(error).toHaveBeenCalledWith(expect.objectContaining({ status: 401 }));
    expect(complete).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("leaves business, gateway and WorkBuddy requests on their existing paths", async () => {
    client.setToken("current-token");
    fetchMock.mockImplementation(() => Promise.resolve(Response.json({ ok: true })));
    await client.get("/api/business/customer/current");
    await client.get("/api/auth/workbuddy/token");
    client.setAgentBaseUrl(null);
    await client.post("/api/business/ai/chat/poll", {});
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      `${backend}/api/business/customer/current`, `${backend}/api/auth/workbuddy/token`, `${backend}/api/business/ai/chat/poll`,
    ]);
  });
});
