/* @vitest-environment jsdom */

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiClient, setApiInstance } from "@lynse/core/api/client";
import { createAuthStore, registerAuthStore } from "@lynse/core/auth";
import { NavigationProvider } from "../navigation";
import { DeviceAuthorizationView } from "./device-authorization-view";

vi.mock("@lynse/core/i18n/react", () => {
  const t = (key: string) => key;
  return { useTranslation: () => ({ t, i18n: { language: "en" } }) };
});

const API = "/platform/oauth/api";
const TICKET = "a".repeat(43);
const CODE_LABEL = "mcpAuthorizations.device_code";
const CONTINUE = "mcpAuthorizations.device_continue";
let apiClient: ApiClient;
let auth: ReturnType<typeof createAuthStore>;
let requests: string[];
let queryClient: QueryClient;
let expectedWrite: boolean;

function renderEntry(codeLength: 6 | 8 = 6) {
  return render(
    <QueryClientProvider client={queryClient}>
      <NavigationProvider value={{
        push: vi.fn(), replace: vi.fn(), back: vi.fn(),
        pathname: "/login/device", searchParams: new URLSearchParams(), getShareableUrl: (path) => path,
      }}>
        <DeviceAuthorizationView codeLength={codeLength} logoSrc="/test-lynse.png" />
      </NavigationProvider>
    </QueryClientProvider>,
  );
}

function signIn(account = "alice") {
  act(() => {
    apiClient.setToken("test-session-" + account);
    auth.setState({ isLoading: false, isAuthenticated: true, user: { id: account, name: "", email: "" } });
  });
}

beforeEach(() => {
  requests = [];
  expectedWrite = false;
  queryClient = new QueryClient();
  apiClient = new ApiClient("https://example.test");
  setApiInstance(apiClient);
  auth = createAuthStore({ api: apiClient, storage: window.localStorage });
  auth.setState({ isLoading: false });
  registerAuthStore(auth);
  vi.stubGlobal("ResizeObserver", class {
    observe() {}
    disconnect() {}
  });
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    requests.push(url);
    if (url === API + "/authorizations") {
      return Response.json({ user: null, csrf: "guard", authorizations: [], supports_device_authorization: true });
    }
    if (url === API + "/agent/device/account") {
      const bob = init?.body === JSON.stringify({ token: "test-session-bob" });
      return Response.json({ subject: bob ? "bob" : "alice", name: bob ? "Bob" : "Alice", avatar_url: null });
    }
    if (url === API + "/agent/device/review") {
      expect(init?.body).toBe(JSON.stringify({ user_code: "BCDFGH", subject: "alice", token: "test-session-alice" }));
      return Response.json({
        client_name: "Lynse CLI", source: "cli", scopes: ["lynse:read", "lynse:write"],
        write_optional: true, ticket: TICKET,
        requested_at: 1_800_000_000, request_ip: "192.0.2.1",
      });
    }
    if (url === API + "/agent/device/complete") {
      expect(init?.body).toBe(JSON.stringify({
        ticket: TICKET, token: "test-session-alice", decision: "allow", allow_write: expectedWrite,
      }));
      return Response.json({ decision: "allowed" });
    }
    throw new Error("Unexpected request");
  }));
});

afterEach(() => {
  cleanup();
  queryClient.clear();
  vi.unstubAllGlobals();
  window.sessionStorage.clear();
});

describe("device authorization page", () => {
  it.each([false, true])("grants only the selected permissions after login and code entry (write %s)", async (selected) => {
    expectedWrite = selected;
    const { container } = renderEntry();
    await waitFor(() => expect(window.sessionStorage.getItem("lynse_post_login_redirect")).toBe("/login/device"));
    expect(screen.queryByLabelText(CODE_LABEL)).toBeNull();
    expect(requests).toEqual([]);

    signIn();
    await screen.findByText("Alice");
    expect(screen.getByRole<HTMLImageElement>("img", { name: "Lynse" }).getAttribute("src")).toBe("/test-lynse.png");
    expect(screen.queryByLabelText(CODE_LABEL)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: CONTINUE }));

    const input = screen.getByLabelText<HTMLInputElement>(CODE_LABEL);
    const next = screen.getByRole<HTMLButtonElement>("button", { name: CONTINUE });
    expect(container.querySelectorAll('[data-slot="input-otp-slot"]')).toHaveLength(6);
    fireEvent.change(input, { target: { value: "bcdfg" } });
    expect(next.disabled).toBe(true);
    fireEvent.change(input, { target: { value: "bcdfgh" } });
    fireEvent.click(next);

    await screen.findByText("mcpAuthorizations.device_scope_read");
    const writePermission = screen.getByRole("checkbox", { name: "mcpAuthorizations.device_scope_write_optional" });
    expect(writePermission.getAttribute("aria-checked")).toBe("false");
    if (selected) fireEvent.click(writePermission);
    expect(requests).not.toContain(API + "/agent/device/complete");
    fireEvent.click(screen.getByRole("button", { name: "mcpAuthorizations.device_allow" }));
    await screen.findByText("mcpAuthorizations.device_success_title");
    expect(requests.at(-1)).toBe(API + "/agent/device/complete");
  });

  it("returns to login to switch accounts, with eight slots for legacy CLI links", async () => {
    signIn();
    const { container } = renderEntry(8);
    await screen.findByText("Alice");
    fireEvent.click(screen.getByRole("button", { name: "mcpAuthorizations.device_switch_account" }));
    await waitFor(() => expect(window.sessionStorage.getItem("lynse_post_login_redirect")).toBe("/login/device"));
    signIn("bob");
    await screen.findByText("Bob");
    expect(screen.queryByText("Alice")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: CONTINUE }));
    expect(container.querySelectorAll('[data-slot="input-otp-slot"]')).toHaveLength(8);
  });
});
