/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { ApiClient, setApiInstance, setApiTransportMode } from "@lynse/core/api/client";
import { createAuthStore, registerAuthStore } from "@lynse/core/auth";
import { useUserCredits, resolveCreditsBalance } from "./use-user-credits";
import { getContextInboxEnabled, setContextInboxEnabled } from "../notifications/context-inbox-preferences";

let client: ApiClient;
let auth: ReturnType<typeof createAuthStore>;
let queryClient: QueryClient;
let fetchMock: ReturnType<typeof vi.fn>;
function wrapper({ children }: { children: ReactNode }) { return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>; }

beforeEach(() => {
  window.localStorage.clear();
  client = new ApiClient("https://business.invalid");
  client.setToken("session-u1");
  setApiInstance(client);
  setApiTransportMode("direct");
  auth = createAuthStore({ api: client, storage: { getItem: () => null, setItem: () => {}, removeItem: () => {} } });
  registerAuthStore(auth);
  auth.setState({ isLoading: false, isAuthenticated: true, user: null });
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  fetchMock = vi.fn(async () => Response.json({ code: 200, data: { id: "u1", nickname: "Alice" } }));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  queryClient.clear();
  window.localStorage.clear();
  vi.unstubAllGlobals();
  setApiTransportMode("proxy");
});

describe("restored account identity without the optional inbox", () => {
  it.each([null, { id: "", name: "", email: "" }])("binds the business-verified account and restores its saved suggestion choice (%j)", async (user) => {
    auth.setState({ user });
    setContextInboxEnabled("u1", true);
    renderHook(() => useUserCredits(), { wrapper });
    await waitFor(() => expect(auth.getState().user?.id).toBe("u1"));
    expect(getContextInboxEnabled(auth.getState().user!.id)).toBe(true);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/api/business/customer/current");
    expect(JSON.stringify(queryClient.getQueryCache().getAll().map((query) => query.queryKey))).not.toContain("session-u1");
  });

  it("does not reuse cached profile data when a new account logs in", async () => {
    const view = renderHook(() => useUserCredits(), { wrapper });
    await waitFor(() => expect(auth.getState().user?.id).toBe("u1"));
    fetchMock.mockResolvedValueOnce(Response.json({ code: 200, data: { id: "u2", nickname: "Other" } }));
    await act(async () => {
      client.setToken("session-u2");
      auth.setState({ user: null });
      view.rerender();
    });
    await waitFor(() => expect(auth.getState().user?.id).toBe("u2"));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(getContextInboxEnabled("u2")).toBe(false);
  });

  it("ignores a late old account's profile after its token changes", async () => {
    let resolve!: (response: Response) => void;
    fetchMock.mockImplementationOnce(() => new Promise<Response>((done) => { resolve = done; }));
    const view = renderHook(() => useUserCredits(), { wrapper });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    fetchMock.mockResolvedValueOnce(Response.json({ code: 200, data: { id: "u2", nickname: "Other" } }));
    await act(async () => {
      client.setToken("session-u2");
      auth.setState({ user: null });
      view.rerender();
      resolve(Response.json({ code: 200, data: { id: "u1", nickname: "Old" } }));
    });
    expect(auth.getState().user?.id).not.toBe("u1");
  });
});

describe("resolveCreditsBalance", () => {
  it("reads the membership minute quota (intl shape: legacy points always 0)", () => {
    const balance = resolveCreditsBalance(
      { pointsAmount: 0, usedPointsAmount: 0 } as never,
      { allRemainingMinutes: 766, totalMinutes: 1000, paidPackageRemainingMinutes: 100 },
    );
    expect(balance).toEqual({ remaining: 766, total: 1000, packRemaining: 100, minutesBased: true });
  });

  it("falls back to remainingMinutes when allRemainingMinutes is absent", () => {
    const balance = resolveCreditsBalance(undefined, { remainingMinutes: 42 });
    expect(balance).toMatchObject({ remaining: 42, minutesBased: true, packRemaining: 0 });
  });

  it("omits the total when the quota carries no totalMinutes", () => {
    expect(resolveCreditsBalance(undefined, { allRemainingMinutes: 5 }).total).toBeNull();
  });

  it("uses legacy points only when no minute quota exists", () => {
    const balance = resolveCreditsBalance({ pointsAmount: 300, usedPointsAmount: 80 } as never);
    expect(balance).toEqual({ remaining: 220, total: 300, packRemaining: 0, minutesBased: false });
  });

  it("prefers the quota even when legacy points are positive", () => {
    const balance = resolveCreditsBalance(
      { pointsAmount: 300, usedPointsAmount: 80 } as never,
      { allRemainingMinutes: 10, totalMinutes: 1000 },
    );
    expect(balance).toMatchObject({ remaining: 10, minutesBased: true });
  });

  it("clamps negatives and treats a quota without numeric minutes as legacy points", () => {
    expect(resolveCreditsBalance({ pointsAmount: 10, usedPointsAmount: 99 } as never).remaining).toBe(0);
    const balance = resolveCreditsBalance({ pointsAmount: 50, usedPointsAmount: 20 } as never, {});
    expect(balance).toEqual({ remaining: 30, total: 50, packRemaining: 0, minutesBased: false });
  });
});
