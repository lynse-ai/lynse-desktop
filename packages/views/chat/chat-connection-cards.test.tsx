/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ConnectorConnectionRequest } from "@lynse/core/api";

const mocks = vi.hoisted(() => ({ get: vi.fn(), resume: vi.fn(), cancel: vi.fn(), open: vi.fn(), token: "test-session" as string | null, authenticated: true }));
vi.mock("@lynse/core/api", async (original) => ({
  ...(await original<object>()),
  api: () => ({ getToken: () => mocks.token }),
  getConnectorRequest: mocks.get,
  resumeConnectorRequest: mocks.resume,
  cancelConnectorRequest: mocks.cancel,
}));
vi.mock("@lynse/core/auth", () => ({ useAuthStore: (selector: (state: { isAuthenticated: boolean }) => unknown) => selector({ isAuthenticated: mocks.authenticated }) }));
vi.mock("@lynse/core/i18n/react", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

import { ChatConnectionCard, continueConnection } from "./chat-connection-cards";
import { useChatStore } from "../workspace/hooks/use-chat-store";

const card: ConnectorConnectionRequest = { request_id: "req-1", provider: "notion", provider_display_name: "Notion", reason: "Read shared pages", action_url: "https://auth.invalid/start", status: "waiting_auth" };

beforeEach(() => {
  vi.resetAllMocks();
  mocks.token = "test-session";
  mocks.authenticated = true;
  mocks.get.mockResolvedValue({ request_id: "req-1", status: "waiting_auth" });
  mocks.resume.mockResolvedValue({ request_id: "req-1", status: "done", result: { account: { display_name: "Work" } } });
  mocks.cancel.mockResolvedValue({ request_id: "req-1", status: "cancelled" });
  mocks.open.mockResolvedValue(undefined);
  Object.assign(window, { desktopAPI: { openExternal: mocks.open } });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

function mount(request = card, onContinue = vi.fn()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const wrap = () => <QueryClientProvider client={client}><ChatConnectionCard request={request} onContinue={onContinue} /></QueryClientProvider>;
  return { ...render(wrap()), wrap, onContinue };
}

async function connect() {
  const button = screen.getByRole("button", { name: "connections.connect" });
  await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(button);
}

describe("chat connector card", () => {
  it("opens the backend authorization page only on click, verifies completion and waits for an explicit continuation", async () => {
    const { onContinue } = mount();
    expect(mocks.open).not.toHaveBeenCalled();
    await connect();
    await screen.findByText("connections.connected · Work");
    expect(mocks.open).toHaveBeenCalledWith(card.action_url);
    expect(mocks.resume).toHaveBeenCalledWith("req-1", "test-session", expect.any(AbortSignal));
    expect(onContinue).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "chat.connection.continue" }));
    expect(onContinue).toHaveBeenCalledOnce();
  });

  it("cancels waiting and ignores a late completed read", async () => {
    let finish!: (result: unknown) => void;
    mocks.resume.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    mount();
    await connect();
    const cancel = await screen.findByRole("button", { name: "chat.connection.cancel" });
    fireEvent.click(cancel);
    await screen.findByText("chat.connection.cancelled");
    finish({ status: "done" });
    await waitFor(() => expect(mocks.cancel).toHaveBeenCalledOnce());
    expect(screen.queryByText("connections.connected")).toBeNull();
  });

  it("allows retry after a verification failure", async () => {
    mocks.resume.mockRejectedValueOnce(new Error("network"));
    mount();
    await connect();
    await screen.findByRole("alert");
    fireEvent.click(screen.getByRole("button", { name: "connections.retry" }));
    await screen.findByText("connections.connected · Work");
    expect(mocks.open).toHaveBeenCalledOnce();
  });

  it("does not open expired entries or trust a historical connected status", async () => {
    mocks.get.mockResolvedValue({ status: "expired" });
    mount({ ...card, status: "done" });
    expect(screen.queryByText("connections.connected")).toBeNull();
    await screen.findByText("chat.connection.expired");
    expect(mocks.open).not.toHaveBeenCalled();
    expect(mocks.resume).not.toHaveBeenCalled();
  });

  it("blocks unsafe URLs and reports browser-open failures", async () => {
    mount({ ...card, action_url: "javascript:alert(1)" });
    await connect();
    await screen.findByText("chat.connection.open_failed");
    expect(mocks.open).not.toHaveBeenCalled();
    expect(mocks.resume).not.toHaveBeenCalled();
  });

  it("drops in-flight results on sign out", async () => {
    let finish!: (result: unknown) => void;
    mocks.resume.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const view = mount();
    await connect();
    await screen.findByRole("button", { name: "chat.connection.cancel" });
    mocks.authenticated = false;
    mocks.token = null;
    view.rerender(view.wrap());
    finish({ status: "done" });
    await waitFor(() => expect(mocks.resume).toHaveBeenCalledOnce());
    expect(screen.queryByText("connections.connected")).toBeNull();
  });

  it.each(["permission_denied", "reauthorization_required"])("distinguishes %s without reopening an old authorization entry", async (read_status) => {
    mocks.resume.mockResolvedValue({ status: "error", read_status });
    mount();
    await connect();
    await screen.findByText(`chat.connection.${read_status}`);
    expect(screen.queryByRole("button", { name: "connections.retry" })).toBeNull();
    expect(mocks.open).toHaveBeenCalledOnce();
  });

  it("stops verification when the service rate-limits instead of looping or reconnecting", async () => {
    mocks.resume.mockResolvedValue({ status: "rate_limited" });
    mount();
    await connect();
    await screen.findByText("chat.connection.rate_limited");
    expect(mocks.resume).toHaveBeenCalledOnce();
    expect(screen.queryByRole("button", { name: "chat.connection.cancel" })).toBeNull();
    expect(mocks.open).toHaveBeenCalledOnce();
  });

  it("asks the user to select an account without inventing an OAuth task", () => {
    const onContinue = vi.fn();
    mount({ ...card, request_id: "", status: "account_selection_required", accounts: [{ id: "work", display_name: "Work" }, { id: "personal", display_name: "Personal" }] }, onContinue);
    fireEvent.click(screen.getByRole("button", { name: "Work" }));
    expect(onContinue).toHaveBeenCalledWith("work");
    expect(mocks.get).not.toHaveBeenCalled();
    expect(mocks.open).not.toHaveBeenCalled();
  });

  it("continues only the card's own conversation with its original file context", () => {
    const send = vi.fn();
    const previous = useChatStore.getState();
    const messages = [{ id: "q1", role: "user" as const, content: "Read my notes", timestamp: 1, fileIds: ["file-1"] }, { id: "a1", role: "assistant" as const, content: "Connect", timestamp: 2 }];
    useChatStore.setState({ isLoading: false, activeConversationId: "c1", sendMessage: send, messages, conversations: [{ id: "c1", title: "Read", provider: "cloud", createdAt: 1, updatedAt: 2, messages }] });
    expect(continueConnection("a1", "Authorized")).toBe(true);
    expect(send).toHaveBeenCalledWith("Authorized\nRead my notes", ["file-1"], true);
    useChatStore.setState({ activeConversationId: "other" });
    expect(continueConnection("a1", "Authorized")).toBe(false);
    expect(send).toHaveBeenCalledOnce();
    useChatStore.setState(previous);
  });
});
