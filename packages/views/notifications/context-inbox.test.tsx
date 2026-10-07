/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ApiClient, setApiInstance, setApiTransportMode } from "@lynse/core/api/client";
import { createAuthStore, registerAuthStore } from "@lynse/core/auth";
import type { ContextInboxItem } from "@lynse/core/api";
import { ContextInboxNotifier, actOnContextNotification, openContextNotification } from "./context-inbox";
import { NotificationList } from "./notification-list";
import { useNotificationStore } from "./use-notification-store";
import { useChat } from "../workspace/hooks/use-chat";

const fakeChat = vi.hoisted(() => ({ setUserId: vi.fn(), switchUser: vi.fn(), hydrate: vi.fn(), setChatVisible: vi.fn(), setActiveAssistant: vi.fn(), clearMessages: vi.fn(), sendMessage: vi.fn(), unreadCounts: {} }));
vi.mock("../workspace/hooks/use-chat-store", () => ({
  useChatStore: Object.assign((selector: (state: typeof fakeChat) => unknown) => selector(fakeChat), { getState: () => fakeChat }),
}));
vi.mock("@lynse/core/i18n/react", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

const initialItem: ContextInboxItem = {
  item_id: "proposal-1", kind: "goal_suggestion", title: "Follow up project A", body: "Three meetings have follow-up actions", status: "pending", version: 1,
  created_at: "2026-10-06T01:00:00Z", updated_at: "2026-10-06T01:00:00Z", displayed_at: "", snoozed_until: "", goal_id: "", source_refs: [],
};

let client: ApiClient;
let auth: ReturnType<typeof createAuthStore>;
let queryClient: QueryClient;
let fetchMock: ReturnType<typeof vi.fn>;
let item: ContextInboxItem;
let userId: string;
let canDisplay: boolean;
const observers: IntersectionObserverCallback[] = [];

function start(showList = false) {
  return render(<QueryClientProvider client={queryClient}><ContextInboxNotifier />{showList && <NotificationList />}</QueryClientProvider>);
}
function actionCalls() {
  return fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/actions"));
}
async function visibleRows() {
  await act(async () => {
    for (const callback of [...observers]) callback([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  item = { ...initialItem };
  userId = "u1";
  canDisplay = true;
  observers.length = 0;
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  vi.stubGlobal("IntersectionObserver", class {
    constructor(callback: IntersectionObserverCallback) { observers.push(callback); }
    observe() {}
    disconnect() {}
  });
  useNotificationStore.setState({ items: [], contextUserId: null });
  client = new ApiClient("https://business.invalid");
  client.setToken("session-u1");
  client.setAgentBaseUrl("https://agent.invalid");
  setApiInstance(client);
  setApiTransportMode("direct");
  auth = createAuthStore({ api: client, storage: { getItem: () => null, setItem: () => {}, removeItem: () => {} } });
  registerAuthStore(auth);
  auth.setState({ isLoading: false, isAuthenticated: true, user: { id: "u1", name: "User", email: "" } });
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  fetchMock = vi.fn(async (url: string, options?: RequestInit) => {
    const path = new URL(url).pathname;
    if (path.endsWith("/actions")) {
      const body = JSON.parse(String(options?.body));
      item = { ...item, version: item.version + 1,
        ...(body.action === "displayed" ? { displayed_at: "2026-10-06T01:01:00Z" } : {}),
        ...(body.action === "dismiss" ? { status: "dismissed" as const } : {}),
        ...(body.action === "snooze" ? { snoozed_until: body.snoozed_until } : {}),
      };
      return Response.json({ status: "ok", changed: true, item });
    }
    if (path.endsWith("/sync")) return Response.json({ status: "accepted", queued: true });
    if (path.endsWith("/proposal-1")) return Response.json({ status: "ok", user_id: userId, item });
    return Response.json({ status: "ok", available: true, user_id: userId, items: [item], can_display: canDisplay });
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  queryClient.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  setApiTransportMode("proxy");
  useNotificationStore.setState({ items: [], contextUserId: null });
});

describe("persistent context inbox bridge", () => {
  it("mirrors fetch results without acknowledging delivery or persisting their text", async () => {
    start();
    await waitFor(() => expect(useNotificationStore.getState().items).toHaveLength(1));
    expect(actionCalls()).toHaveLength(0);
    expect(window.localStorage.getItem("lynse_notifications_v1")).not.toContain("Follow up project A");
    expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/sync"))).toHaveLength(1);
  });

  it("acknowledges a visible committed row once, including after remount", async () => {
    const view = start(true);
    await screen.findByText("Follow up project A");
    expect(actionCalls()).toHaveLength(0);
    await visibleRows();
    await waitFor(() => expect(actionCalls()).toHaveLength(1));
    expect(JSON.parse(String(actionCalls()[0]?.[1].body))).toMatchObject({ action: "displayed", base_version: 1 });
    await waitFor(() => expect(useNotificationStore.getState().items[0]?.context?.item.displayed_at).toBeTruthy());
    view.unmount();
    observers.length = 0;
    start(true);
    await screen.findByText("Follow up project A");
    await visibleRows();
    expect(actionCalls()).toHaveLength(1);
  });

  it("reveals only one new backlog suggestion and keeps the rest hidden after its display acknowledgement", async () => {
    const other = [
      { ...initialItem, item_id: "proposal-2", title: "Hidden second suggestion", body: "Private second preview" },
      { ...initialItem, item_id: "proposal-3", title: "Hidden third suggestion", body: "Private third preview" },
    ];
    const implementation = fetchMock.getMockImplementation() as (url: string, options?: RequestInit) => Promise<Response>;
    fetchMock.mockImplementation(async (url: string, options?: RequestInit) => String(url).includes("/inbox?")
      ? Response.json({ status: "ok", available: true, user_id: userId, items: [item, ...other], can_display: canDisplay })
      : implementation(url, options));
    useNotificationStore.getState().add({ id: "sync:existing", type: "sync", title: "Existing notification" });
    start(true);
    await screen.findByText("Follow up project A");
    expect(screen.queryByText("Hidden second suggestion")).toBeNull();
    expect(screen.queryByText("Private third preview")).toBeNull();
    expect(useNotificationStore.getState().items.filter((entry) => entry.type === "context")).toHaveLength(1);
    await visibleRows();
    await waitFor(() => expect(actionCalls()).toHaveLength(1));
    canDisplay = false;
    await act(async () => { await queryClient.refetchQueries({ queryKey: ["context-inbox"] }); });
    expect(screen.queryByText("Private second preview")).toBeNull();
    expect(screen.queryByText("Hidden third suggestion")).toBeNull();
    expect(useNotificationStore.getState().items.filter((entry) => entry.type === "context")).toHaveLength(1);
    expect(useNotificationStore.getState().items.some((entry) => entry.id === "sync:existing")).toBe(true);
  });

  it("does not acknowledge a hidden row or a server-ineligible time window", async () => {
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    start(true);
    await screen.findByText("Follow up project A");
    await visibleRows();
    expect(actionCalls()).toHaveLength(0);
    visibility.mockReturnValue("visible");
    canDisplay = false;
    await act(async () => { await queryClient.refetchQueries({ queryKey: ["context-inbox"] }); });
    await visibleRows();
    expect(actionCalls()).toHaveLength(0);
  });

  it("cancels an old user's request and ignores its late response after account switch", async () => {
    let resolveOld!: (response: Response) => void;
    fetchMock.mockImplementationOnce(() => new Promise<Response>((resolve) => { resolveOld = resolve; }));
    start();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const oldSignal = fetchMock.mock.calls[0]?.[1].signal as AbortSignal;
    await act(async () => {
      client.setToken("session-u2");
      userId = "u2";
      auth.setState({ user: { id: "u2", name: "Other", email: "" } });
    });
    await waitFor(() => expect(useNotificationStore.getState().contextUserId).toBe("u2"));
    expect(oldSignal.aborted).toBe(true);
    await act(async () => { resolveOld(Response.json({ status: "ok", available: true, user_id: "u1", items: [{ ...item, title: "Private old-user fact" }], can_display: true })); });
    expect(useNotificationStore.getState().items.some((entry) => entry.title === "Private old-user fact")).toBe(false);
    await act(async () => { auth.getState().logout(); });
    expect(useNotificationStore.getState().items).toHaveLength(0);
  });

  it("gets the user's current item and opens it through a normal chat request", async () => {
    start();
    await waitFor(() => expect(useNotificationStore.getState().items).toHaveLength(1));
    const push = vi.fn();
    await openContextNotification(useNotificationStore.getState().items[0]!, push);
    expect(push).toHaveBeenCalledWith("/chat");
    expect(fakeChat.sendMessage).toHaveBeenCalledWith("查看上下文建议 proposal-1", undefined, false, undefined, { assistant: "lynse" });
    expect(fakeChat.hydrate).toHaveBeenCalled();
    expect(fakeChat.setUserId.mock.invocationCallOrder[0]).toBeLessThan(fakeChat.hydrate.mock.invocationCallOrder[0]!);
    expect(fakeChat.hydrate.mock.invocationCallOrder[0]).toBeLessThan(fakeChat.sendMessage.mock.invocationCallOrder[0]!);
    expect(actionCalls()).toHaveLength(0);
    userId = "u2";
    fakeChat.sendMessage.mockClear();
    await expect(openContextNotification(useNotificationStore.getState().items[0]!, push)).rejects.toThrow("changed");
    expect(fakeChat.sendMessage).not.toHaveBeenCalled();
  });

  it("binds profile-less login to the verified account before opening context chat", async () => {
    auth.setState({ user: null });
    start();
    await waitFor(() => expect(auth.getState().user?.id).toBe("u1"));
    await waitFor(() => expect(useNotificationStore.getState().items).toHaveLength(1));
    await openContextNotification(useNotificationStore.getState().items[0]!, vi.fn());
    function ChatMount() { useChat(); return null; }
    render(<ChatMount />);
    expect(fakeChat.setUserId).toHaveBeenCalledWith("u1");
    expect(fakeChat.setUserId.mock.calls.at(-1)?.[0]).toBe("u1");
    expect(fakeChat.sendMessage).toHaveBeenCalled();
    expect(auth.getState().user?.id).not.toBe("user");
  });

  it("ignores an old account's delayed click before hydrating or sending a chat", async () => {
    start();
    await waitFor(() => expect(useNotificationStore.getState().items).toHaveLength(1));
    let resolveDetail!: (response: Response) => void;
    fetchMock.mockImplementationOnce(() => new Promise<Response>((resolve) => { resolveDetail = resolve; }));
    const opening = openContextNotification(useNotificationStore.getState().items[0]!, vi.fn());
    await act(async () => {
      client.setToken("session-u2");
      userId = "u2";
      auth.setState({ user: { id: "u2", name: "Other", email: "" } });
    });
    await act(async () => {
      resolveDetail(Response.json({ status: "ok", user_id: "u1", item }));
      await opening.catch(() => undefined);
    });
    expect(fakeChat.hydrate).not.toHaveBeenCalled();
    expect(fakeChat.sendMessage).not.toHaveBeenCalled();
  });

  it("snoozes cloud entries using their current version", async () => {
    start();
    await waitFor(() => expect(useNotificationStore.getState().items).toHaveLength(1));
    await act(async () => { await actOnContextNotification(useNotificationStore.getState().items[0]!, "snooze"); });
    await waitFor(() => expect(useNotificationStore.getState().items).toHaveLength(0));
    expect(JSON.parse(String(actionCalls()[0]?.[1].body))).toMatchObject({ action: "snooze", base_version: 1 });
  });

  it("dismisses cloud entries and removes the mirror after the server accepts", async () => {
    start();
    await waitFor(() => expect(useNotificationStore.getState().items).toHaveLength(1));
    await act(async () => { await actOnContextNotification(useNotificationStore.getState().items[0]!, "dismiss"); });
    await waitFor(() => expect(useNotificationStore.getState().items).toHaveLength(0));
    expect(JSON.parse(String(actionCalls()[0]?.[1].body))).toMatchObject({ action: "dismiss", base_version: 1 });
  });

  it("reuses the same display operation after a failed acknowledgement without marking delivery", async () => {
    start();
    await waitFor(() => expect(useNotificationStore.getState().items).toHaveLength(1));
    const notification = useNotificationStore.getState().items[0]!;
    fetchMock.mockRejectedValueOnce(new Error("offline"));
    await expect(actOnContextNotification(notification, "displayed")).rejects.toThrow("offline");
    expect(useNotificationStore.getState().items[0]?.context?.item.displayed_at).toBe("");
    await act(async () => { await actOnContextNotification(notification, "displayed"); });
    const operations = actionCalls().map(([, options]) => JSON.parse(String(options.body)).operation_id);
    expect(operations).toHaveLength(2);
    expect(operations[0]).toBe(operations[1]);
  });

  it("refreshes inbox and foreground sync on a visible window resume", async () => {
    start();
    await waitFor(() => expect(useNotificationStore.getState().items).toHaveLength(1));
    const before = fetchMock.mock.calls.length;
    await act(async () => { window.dispatchEvent(new Event("focus")); });
    await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThan(before));
    await waitFor(() => expect(useNotificationStore.getState().items).toHaveLength(1));
    expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/sync"))).toHaveLength(2);
    expect(actionCalls()).toHaveLength(0);
  });

  it("polls every minute while visible and pauses automatic requests in a hidden window", async () => {
    vi.useFakeTimers();
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    start();
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    const lists = () => fetchMock.mock.calls.filter(([url]) => String(url).includes("/inbox?"));
    expect(lists()).toHaveLength(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(lists()).toHaveLength(2);
    visibility.mockReturnValue("hidden");
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(lists()).toHaveLength(2);
    expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/sync"))).toHaveLength(1);
  });

  it("fails closed for REST/off/unknown capabilities and never starts sync", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: "context_unavailable" }), { status: 503 }));
    start();
    await waitFor(() => expect(queryClient.getQueryCache().getAll()[0]?.state.status).toBe("error"));
    expect(useNotificationStore.getState().items).toHaveLength(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
