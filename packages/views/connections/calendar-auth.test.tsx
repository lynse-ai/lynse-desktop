/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ApiClient, setApiInstance, setApiTransportMode } from "@lynse/core/api/client";
import { createAuthStore, registerAuthStore } from "@lynse/core/auth";
import { setActiveQueryClient } from "@lynse/core/query-client";
import { openExternalUrl } from "../app-update";
import { CalendarReminderBanner } from "./calendar-reminder-banner";
import { ProviderRow } from "./provider-row";
import { cancelConnect } from "./use-connect-flow";

vi.mock("@lynse/core/i18n/react", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("../feature-flags", () => ({
  featureFlags: { connections: true },
  isConnectionsEnabled: () => true,
}));
vi.mock("../navigation", () => ({ useNavigation: () => ({ push: vi.fn() }) }));
vi.mock("../app-update", () => ({ openExternalUrl: vi.fn() }));
vi.mock("../settings/settings-dialog", () => ({
  SettingsDialog: ({ initialSectionId }: { initialSectionId: string }) => (
    <div role="dialog" data-section={initialSectionId}>Settings</div>
  ),
}));

let auth: ReturnType<typeof createAuthStore>;
let queryClient: QueryClient;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  const client = new ApiClient("https://business.test", { onUnauthorized: () => auth.getState().logout() });
  client.setIntegrationsBaseUrl("https://calendar.test");
  setApiInstance(client);
  setApiTransportMode("direct");
  auth = createAuthStore({ api: client, storage: { getItem: () => null, setItem: () => {}, removeItem: () => {} } });
  registerAuthStore(auth);
  auth.getState().completeLogin({ accessToken: "main-session", user: { id: "u1", name: "User", email: "" } });
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  setActiveQueryClient(queryClient);
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cancelConnect("google-calendar");
  cleanup();
  queryClient.clear();
  vi.unstubAllGlobals();
  setApiTransportMode("proxy");
});

function failCalendar(status: number) {
  fetchMock.mockImplementation(() => Promise.resolve(Response.json({
    code: status === 401 ? "unauthorized" : "unavailable",
    message: status === 401 ? "error.integrations.unauthorized" : "Calendar unavailable",
  }, { status })));
}

describe("calendar service auth failures", () => {
  it("preserves the main login and opens Connections from the reconnect prompt", async () => {
    failCalendar(401);
    render(<QueryClientProvider client={queryClient}><CalendarReminderBanner /></QueryClientProvider>);

    await screen.findByRole("alert");
    expect(screen.getByText("connections.calendar_reconnect_required")).toBeTruthy();
    expect(auth.getState().isAuthenticated).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "connections.reconnect" }));
    expect(screen.getByRole("dialog").getAttribute("data-section")).toBe("connections");
  });

  it("shows status-query auth failures in the provider row with a reconnect action", async () => {
    failCalendar(401);
    render(<QueryClientProvider client={queryClient}><ProviderRow provider="google-calendar" kind="calendar" isAuthenticated /></QueryClientProvider>);

    await screen.findByRole("alert");
    expect(screen.getByText("connections.error.unauthorized")).toBeTruthy();
    expect(screen.getByRole("button", { name: "connections.reconnect" })).toBeTruthy();
    expect(auth.getState().isAuthenticated).toBe(true);
  });

  it("offers a retry for an outage and clears the error once the calendar recovers", async () => {
    failCalendar(503);
    render(<QueryClientProvider client={queryClient}><CalendarReminderBanner /></QueryClientProvider>);

    await screen.findByText("connections.calendar_unavailable");
    expect(screen.queryByRole("button", { name: "connections.reconnect" })).toBeNull();
    fetchMock.mockImplementation((url: string) => Promise.resolve(Response.json(
      url.includes("/calendar/events") ? { events: [] } : { connected: false, accounts: [] },
    )));
    fireEvent.click(screen.getByRole("button", { name: "connections.retry" }));

    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(auth.getState().isAuthenticated).toBe(true);
  });

  it("completes calendar reauthorization and refreshes the failed events without another main login", async () => {
    failCalendar(401);
    render(<QueryClientProvider client={queryClient}>
      <CalendarReminderBanner />
      <section aria-label="calendar connection"><ProviderRow provider="google-calendar" kind="calendar" isAuthenticated /></section>
    </QueryClientProvider>);
    const row = within(screen.getByRole("region", { name: "calendar connection" }));
    const reconnect = await row.findByRole("button", { name: "connections.reconnect" });
    await screen.findByText("connections.calendar_reconnect_required");
    fetchMock.mockImplementation((url: string) => Promise.resolve(Response.json(
      url.includes("oauth-state") ? { state: "new-calendar-state", authorization_url: "https://calendar.test/authorize" }
        : url.includes("oauth-result") ? { status: "done" }
          : url.includes("/calendar/events") ? { events: [] }
            : { connected: true, accounts: [] },
    )));

    fireEvent.click(reconnect);

    await row.findByText("connections.connected");
    await waitFor(() => expect(screen.queryByText("connections.calendar_reconnect_required")).toBeNull());
    expect(openExternalUrl).toHaveBeenCalledWith("https://calendar.test/authorize");
    expect(auth.getState().isAuthenticated).toBe(true);
  });
});
