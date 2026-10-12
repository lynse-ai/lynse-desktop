/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ApiClient, setApiInstance, setApiTransportMode } from "@lynse/core/api/client";
import { createAuthStore, registerAuthStore } from "@lynse/core/auth";
import { ContextInboxCard } from "./context-inbox-card";
import { getContextInboxEnabled } from "../notifications/context-inbox-preferences";
import { useNotificationStore } from "../notifications/use-notification-store";

const push = vi.hoisted(() => vi.fn());
const chat = vi.hoisted(() => ({ setUserId: vi.fn(), hydrate: vi.fn(), setActiveAssistant: vi.fn(), clearMessages: vi.fn(), sendMessage: vi.fn() }));
vi.mock("../navigation", () => ({ useNavigation: () => ({ push }) }));
vi.mock("../workspace/hooks/use-chat-store", () => ({ useChatStore: { getState: () => chat } }));
vi.mock("@lynse/core/i18n/react", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

let auth: ReturnType<typeof createAuthStore>;
let client: ApiClient;
let fetchMock: ReturnType<typeof vi.fn>;
const closeSettings = vi.fn();
const toggle = () => screen.getByRole("switch", { name: "settings.context_inbox_enable" });

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  client = new ApiClient("https://business.invalid");
  client.setToken("session-u1");
  client.setAgentBaseUrl("https://agent.invalid");
  setApiInstance(client);
  setApiTransportMode("direct");
  auth = createAuthStore({ api: client, storage: { getItem: () => null, setItem: () => {}, removeItem: () => {} } });
  registerAuthStore(auth);
  auth.setState({ isLoading: false, isAuthenticated: true, user: { id: "u1", name: "User", email: "" } });
  useNotificationStore.setState({ contextUnavailable: false });
  fetchMock = vi.fn(async () => Response.json({ user_id: "u1" }));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  setApiTransportMode("proxy");
});

describe("proactive suggestion settings", () => {
  it("starts off without network requests and persists explicit opt-in across remounts", async () => {
    const view = render(<ContextInboxCard onOpenChat={closeSettings} />);
    expect(toggle().getAttribute("aria-checked")).toBe("false");
    expect(fetchMock).not.toHaveBeenCalled();
    fireEvent.click(toggle());
    await waitFor(() => expect(getContextInboxEnabled("u1")).toBe(true));
    expect(chat.sendMessage).not.toHaveBeenCalled();
    view.unmount();
    render(<ContextInboxCard onOpenChat={closeSettings} />);
    expect(toggle().getAttribute("aria-checked")).toBe("true");
    fireEvent.click(toggle());
    await waitFor(() => expect(getContextInboxEnabled("u1")).toBe(false));
  });

  it("keeps another account off and restores this account's saved choice", async () => {
    render(<ContextInboxCard onOpenChat={closeSettings} />);
    fireEvent.click(toggle());
    await waitFor(() => expect(getContextInboxEnabled("u1")).toBe(true));
    await act(async () => { auth.setState({ user: { id: "u2", name: "Other", email: "" } }); });
    expect(toggle().getAttribute("aria-checked")).toBe("false");
    await act(async () => { auth.setState({ user: { id: "u1", name: "User", email: "" } }); });
    expect(toggle().getAttribute("aria-checked")).toBe("true");
  });

  it("uses normal chat to choose scope and confirm authorization only after the setup button is clicked", async () => {
    render(<ContextInboxCard onOpenChat={closeSettings} />);
    fireEvent.click(toggle());
    const setup = await screen.findByRole("button", { name: "settings.context_inbox_setup" });
    expect(chat.sendMessage).not.toHaveBeenCalled();
    fireEvent.click(setup);
    expect(closeSettings).toHaveBeenCalledOnce();
    expect(push).toHaveBeenCalledWith("/chat");
    expect(chat.setUserId).toHaveBeenCalledWith("u1");
    expect(chat.sendMessage).toHaveBeenCalledWith("settings.context_inbox_setup_prompt", undefined, false, undefined, { assistant: "lynse" });
  });

  it.each([null, { id: "", name: "", email: "" }])("resolves a profile-less session only on explicit opt-in (%j)", async (user) => {
    auth.setState({ user });
    render(<ContextInboxCard onOpenChat={closeSettings} />);
    expect(fetchMock).not.toHaveBeenCalled();
    fireEvent.click(toggle());
    await waitFor(() => expect(auth.getState().user?.id).toBe("u1"));
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("https://agent.invalid/api/connectors/identity");
    expect(getContextInboxEnabled("u1")).toBe(true);
  });

  it("ignores a delayed identity response after switching accounts", async () => {
    auth.setState({ user: null });
    let resolve!: (response: Response) => void;
    fetchMock.mockImplementationOnce(() => new Promise<Response>((done) => { resolve = done; }));
    render(<ContextInboxCard onOpenChat={closeSettings} />);
    fireEvent.click(toggle());
    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    await act(async () => {
      client.setToken("session-u2");
      auth.setState({ user: { id: "u2", name: "Other", email: "" } });
      resolve(Response.json({ user_id: "u1" }));
    });
    expect(auth.getState().user?.id).toBe("u2");
    expect(getContextInboxEnabled("u1")).toBe(false);
    expect(getContextInboxEnabled("u2")).toBe(false);
  });

  it("stays off and explains an identity failure", async () => {
    auth.setState({ user: null });
    fetchMock.mockRejectedValueOnce(new Error("offline"));
    render(<ContextInboxCard onOpenChat={closeSettings} />);
    fireEvent.click(toggle());
    await screen.findByRole("alert");
    expect(toggle().getAttribute("aria-checked")).toBe("false");
    expect(chat.sendMessage).not.toHaveBeenCalled();
  });

  it("disables opt-in when signed out", () => {
    auth.setState({ isAuthenticated: false, user: null });
    render(<ContextInboxCard onOpenChat={closeSettings} />);
    expect(toggle().getAttribute("aria-disabled")).toBe("true");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
