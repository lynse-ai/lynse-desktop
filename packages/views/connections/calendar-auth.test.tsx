/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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

const respond = (body: unknown, init?: ResponseInit) =>
  Promise.resolve(Response.json(body, init));

const CONNECTED_ACCOUNT = { id: "acc1", notify_enabled: true };

/** Status probe answers connected; the events endpoint fails as directed. */
function mockConnectedStatusWithFailingEvents(status: 401 | 503) {
  fetchMock.mockImplementation((url: string) =>
    url.includes("/calendar/events")
      ? respond({
          code: status === 401 ? "unauthorized" : "unavailable",
          message: status === 401 ? "error.integrations.unauthorized" : "Calendar unavailable",
        }, { status })
      : respond({ connected: true, provider: "google-calendar", accounts: [CONNECTED_ACCOUNT] }),
  );
}

describe("calendar service auth failures", () => {
  it("preserves the main login and opens Connections from the reconnect prompt", async () => {
    mockConnectedStatusWithFailingEvents(401);
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
    mockConnectedStatusWithFailingEvents(503);
    render(<QueryClientProvider client={queryClient}><CalendarReminderBanner /></QueryClientProvider>);

    await screen.findByText("connections.calendar_unavailable");
    expect(screen.queryByRole("button", { name: "connections.reconnect" })).toBeNull();
    fetchMock.mockImplementation((url: string) => Promise.resolve(Response.json(
      url.includes("/calendar/events") ? { events: [] } : { connected: true, accounts: [CONNECTED_ACCOUNT] },
    )));
    fireEvent.click(screen.getByRole("button", { name: "connections.retry" }));

    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(auth.getState().isAuthenticated).toBe(true);
  });

  it("completes calendar reauthorization and refreshes the failed events without another main login", async () => {
    mockConnectedStatusWithFailingEvents(401);
    render(<QueryClientProvider client={queryClient}>
      <CalendarReminderBanner />
      <section aria-label="calendar connection"><ProviderRow provider="google-calendar" kind="calendar" isAuthenticated /></section>
    </QueryClientProvider>);
    const row = within(screen.getByRole("region", { name: "calendar connection" }));
    // The connected account is known first, the expired-token events fetch
    // puts the banner into reconnect mode, and then the status probe itself
    // starts failing — the row must offer reconnection without touching the
    // main login.
    await screen.findByText("connections.calendar_reconnect_required");
    fetchMock.mockImplementation(() =>
      respond({ code: "unauthorized", message: "error.integrations.unauthorized" }, { status: 401 }));
    await act(async () => {
      await queryClient.invalidateQueries();
    });
    const reconnect = await row.findByRole("button", { name: "connections.reconnect" });
    fetchMock.mockImplementation((url: string) => Promise.resolve(Response.json(
      url.includes("oauth-state") ? { state: "new-calendar-state", authorization_url: "https://calendar.test/authorize" }
        : url.includes("oauth-result") ? { status: "done" }
          : url.includes("/calendar/events") ? { events: [] }
            : { connected: true, accounts: [CONNECTED_ACCOUNT] },
    )));

    fireEvent.click(reconnect);

    await row.findByText("connections.connected");
    await waitFor(() => expect(screen.queryByText("connections.calendar_reconnect_required")).toBeNull());
    expect(openExternalUrl).toHaveBeenCalledWith("https://calendar.test/authorize");
    expect(auth.getState().isAuthenticated).toBe(true);
  });

  it("stays silent and skips event polling for a user who never connected", async () => {
    fetchMock.mockImplementation((url: string) =>
      url.includes("/calendar/events")
        ? respond({ code: "unavailable", message: "Calendar unavailable" }, { status: 503 })
        : respond({ connected: false, provider: "google-calendar", accounts: [] }),
    );
    render(<QueryClientProvider client={queryClient}><CalendarReminderBanner /></QueryClientProvider>);

    await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThan(0));
    // Let the status resolution settle (and any wrongly enabled events query fire).
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(
      fetchMock.mock.calls.filter(([url]) => String(url).includes("/calendar/events")),
    ).toHaveLength(0);
  });
});
