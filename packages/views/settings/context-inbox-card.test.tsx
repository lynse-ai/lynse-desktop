/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ApiClient, setApiInstance, setApiTransportMode } from "@lynse/core/api/client";
import { createAuthStore, registerAuthStore } from "@lynse/core/auth";
import { ContextInboxCard } from "./context-inbox-card";
import { getContextInboxEnabled } from "../notifications/context-inbox-preferences";
import { useNotificationStore } from "../notifications/use-notification-store";

vi.mock("@lynse/core/i18n/react", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

interface Prefs { enabled: boolean; scopes: { scope_type: string; scope_id: string }[]; timezone: string; grant_version: number }
interface Recorded { method: string; url: string; token: string | undefined; body?: Record<string, unknown> }

const GLOBAL = { scope_type: "global", scope_id: "" };
let auth: ReturnType<typeof createAuthStore>;
let client: ApiClient;
let fetchMock: ReturnType<typeof vi.fn>;
let requests: Recorded[];
let server: { prefs: Record<string, Prefs>; conflictOnce: boolean; unavailable: boolean; failWrite: boolean };
const toggle = () => screen.getByRole("switch", { name: "settings.context_inbox_enable" });
const posts = () => requests.filter((r) => r.method === "POST" && r.url.endsWith("/api/context/preferences"));

function fakeServer(input: RequestInfo | URL, init?: RequestInit): Response {
  const url = String(input);
  const method = init?.method ?? "GET";
  const token = (init?.headers as Record<string, string> | undefined)?.Authorization;
  const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
  requests.push({ method, url, token, body });
  if (url.endsWith("/api/connectors/identity")) return Response.json({ user_id: "u1" });
  if (!url.endsWith("/api/context/preferences")) throw new Error(`unexpected ${method} ${url}`);
  if (server.unavailable) return Response.json({ status: "error", error: { code: "context_unavailable" } }, { status: 503 });
  const prefs = server.prefs[token ?? ""] ?? { enabled: false, scopes: [], timezone: "Asia/Shanghai", grant_version: 0 };
  if (method === "GET") return Response.json({ status: "ok", preferences: prefs });
  if (server.failWrite) return Response.json({ status: "error", error: { code: "memory_down" } }, { status: 502 });
  if (server.conflictOnce || body?.base_version !== prefs.grant_version) {
    server.conflictOnce = false;
    return Response.json({ status: "error", error: { code: "version_conflict" } }, { status: 409 });
  }
  const next: Prefs = body?.action === "set"
    ? { enabled: true, scopes: body.scopes as Prefs["scopes"], timezone: String(body.timezone), grant_version: prefs.grant_version + 1 }
    : { ...prefs, enabled: false, grant_version: prefs.grant_version + 1 };
  server.prefs[token ?? ""] = next;
  return Response.json({ status: "ok", changed: true, preferences: next });
}

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  requests = [];
  server = { prefs: {}, conflictOnce: false, unavailable: false, failWrite: false };
  client = new ApiClient("https://business.invalid");
  client.setToken("session-u1");
  client.setAgentBaseUrl("https://agent.invalid");
  setApiInstance(client);
  setApiTransportMode("direct");
  auth = createAuthStore({ api: client, storage: { getItem: () => null, setItem: () => {}, removeItem: () => {} } });
  registerAuthStore(auth);
  auth.setState({ isLoading: false, isAuthenticated: true, user: { id: "u1", name: "User", email: "" } });
  useNotificationStore.setState({ contextUnavailable: false });
  fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => fakeServer(input, init));
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(Intl.DateTimeFormat.prototype, "resolvedOptions").mockReturnValue(
    { timeZone: "Europe/Berlin" } as Intl.ResolvedDateTimeFormatOptions,
  );
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  setApiTransportMode("proxy");
});

async function renderSettled() {
  const view = render(<ContextInboxCard />);
  await waitFor(() => expect(requests.some((r) => r.method === "GET" && r.url.endsWith("/api/context/preferences"))).toBe(true));
  return view;
}

describe("proactive suggestion settings", () => {
  it("mirrors the cloud grant into the switch and this device's flag when the card opens", async () => {
    server.prefs["session-u1"] = { enabled: true, scopes: [GLOBAL], timezone: "Asia/Shanghai", grant_version: 2 };
    await renderSettled();
    await waitFor(() => expect(toggle().getAttribute("aria-checked")).toBe("true"));
    expect(getContextInboxEnabled("u1")).toBe(true);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ method: "GET", url: "https://agent.invalid/api/context/preferences", token: "session-u1" });
  });

  it("turning the switch on grants global cloud analysis with the device timezone; turning it off stops it", async () => {
    await renderSettled();
    expect(toggle().getAttribute("aria-checked")).toBe("false");
    fireEvent.click(toggle());
    await waitFor(() => expect(getContextInboxEnabled("u1")).toBe(true));
    expect(toggle().getAttribute("aria-checked")).toBe("true");
    expect(posts()).toHaveLength(1);
    expect(posts()[0]?.body).toEqual({
      operation_id: expect.any(String), base_version: 0, action: "set", enabled: true,
      scopes: [GLOBAL], timezone: "Europe/Berlin",
    });
    fireEvent.click(toggle());
    await waitFor(() => expect(getContextInboxEnabled("u1")).toBe(false));
    expect(posts()).toHaveLength(2);
    expect(posts()[1]?.body).toEqual({ operation_id: expect.any(String), base_version: 1, action: "stop" });
    expect(posts()[0]?.body?.operation_id).not.toBe(posts()[1]?.body?.operation_id);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("re-reads the grant version once and retries when another device changed it", async () => {
    await renderSettled();
    server.conflictOnce = true;
    fireEvent.click(toggle());
    await waitFor(() => expect(getContextInboxEnabled("u1")).toBe(true));
    expect(requests.map((r) => r.method)).toEqual(["GET", "POST", "GET", "POST"]);
    expect(posts()).toHaveLength(2);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("keeps the switch off and explains a failed write", async () => {
    await renderSettled();
    server.failWrite = true;
    fireEvent.click(toggle());
    await screen.findByRole("alert");
    expect(toggle().getAttribute("aria-checked")).toBe("false");
    expect(getContextInboxEnabled("u1")).toBe(false);
  });

  it("disables the switch while the server-side service is not enabled", async () => {
    server.unavailable = true;
    await renderSettled();
    await screen.findByText("settings.context_inbox_service_unavailable");
    expect(toggle().getAttribute("aria-disabled")).toBe("true");
    expect(getContextInboxEnabled("u1")).toBe(false);
  });

  it("reflects each account's own cloud grant after switching accounts", async () => {
    server.prefs["session-u1"] = { enabled: true, scopes: [GLOBAL], timezone: "Asia/Shanghai", grant_version: 1 };
    await renderSettled();
    await waitFor(() => expect(toggle().getAttribute("aria-checked")).toBe("true"));
    await act(async () => {
      client.setToken("session-u2");
      auth.setState({ user: { id: "u2", name: "Other", email: "" } });
    });
    await waitFor(() => expect(requests.filter((r) => r.token === "session-u2")).toHaveLength(1));
    expect(toggle().getAttribute("aria-checked")).toBe("false");
    expect(getContextInboxEnabled("u2")).toBe(false);
    await act(async () => {
      client.setToken("session-u1");
      auth.setState({ user: { id: "u1", name: "User", email: "" } });
    });
    await waitFor(() => expect(toggle().getAttribute("aria-checked")).toBe("true"));
  });

  it.each([null, { id: "", name: "", email: "" }])("resolves a profile-less session only on an explicit toggle (%j)", async (user) => {
    auth.setState({ user });
    render(<ContextInboxCard />);
    expect(fetchMock).not.toHaveBeenCalled();
    fireEvent.click(toggle());
    await waitFor(() => expect(getContextInboxEnabled("u1")).toBe(true));
    expect(auth.getState().user?.id).toBe("u1");
    expect(requests.map((r) => `${r.method} ${r.url}`)).toEqual([
      "GET https://agent.invalid/api/connectors/identity",
      "GET https://agent.invalid/api/context/preferences",
      "POST https://agent.invalid/api/context/preferences",
    ]);
  });

  it("ignores a delayed identity response after switching accounts", async () => {
    auth.setState({ user: null });
    let resolve!: (response: Response) => void;
    fetchMock.mockImplementationOnce(() => new Promise<Response>((done) => { resolve = done; }));
    render(<ContextInboxCard />);
    fireEvent.click(toggle());
    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    await act(async () => {
      client.setToken("session-u2");
      auth.setState({ user: { id: "u2", name: "Other", email: "" } });
      resolve(Response.json({ user_id: "u1" }));
    });
    expect(auth.getState().user?.id).toBe("u2");
    expect(posts()).toHaveLength(0);
    expect(getContextInboxEnabled("u1")).toBe(false);
    expect(getContextInboxEnabled("u2")).toBe(false);
  });

  it("stays off and explains an identity failure", async () => {
    auth.setState({ user: null });
    fetchMock.mockRejectedValueOnce(new Error("offline"));
    render(<ContextInboxCard />);
    fireEvent.click(toggle());
    await screen.findByRole("alert");
    expect(toggle().getAttribute("aria-checked")).toBe("false");
    expect(posts()).toHaveLength(0);
  });

  it("disables opt-in when signed out", () => {
    auth.setState({ isAuthenticated: false, user: null });
    render(<ContextInboxCard />);
    expect(toggle().getAttribute("aria-disabled")).toBe("true");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
