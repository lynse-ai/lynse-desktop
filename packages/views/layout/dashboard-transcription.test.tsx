/* @vitest-environment jsdom */
import type { ReactNode } from "react";
import { act, cleanup, render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DashboardLayout } from "./dashboard-layout";
import type { LocalTranscriptionUpdate } from "../workspace/local-transcription";
const mocks = vi.hoisted(() => ({
  subscribe: vi.fn(), unlisten: vi.fn(), success: vi.fn(), error: vi.fn(),
  t: (key: string) => key, callbacks: [] as Array<(update: LocalTranscriptionUpdate) => void>,
}));
vi.mock("@lynse/core/i18n/react", () => ({ useTranslation: () => ({ t: mocks.t }) }));
vi.mock("sonner", () => ({ toast: { success: mocks.success, error: mocks.error } }));
vi.mock("../workspace/local-transcription", async (original) => ({
  ...await original<typeof import("../workspace/local-transcription")>(),
  getDesktopLocalTranscriptionApi: () => ({ onTranscriptionUpdate: mocks.subscribe }),
}));
vi.mock("./lynse-sidebar", () => ({ LynseSidebar: () => null }));
vi.mock("./app-title-bar", () => ({ AppTitleBar: () => null }));
vi.mock("../connections", () => ({ CalendarReminderBanner: () => null }));
vi.mock("../about/about-dialog", () => ({ AboutDialog: () => null }));
vi.mock("../workspace/dnd-provider", () => ({ DndProvider: ({ children }: { children: ReactNode }) => children }));
beforeEach(() => {
  vi.clearAllMocks(); mocks.callbacks.length = 0;
  mocks.subscribe.mockImplementation((callback: (update: LocalTranscriptionUpdate) => void) => {
    mocks.callbacks.push(callback); return Promise.resolve(mocks.unlisten);
  });
});
afterEach(cleanup);
function shell(client: QueryClient, page: string) {
  return <QueryClientProvider client={client}><DashboardLayout><div>{page}</div></DashboardLayout></QueryClientProvider>;
}
describe("dashboard background transcription updates", () => {
  it("keeps one listener across page navigation, refreshes cached results and reports completion", async () => {
    const client = new QueryClient();
    const keys = [["files"], ["notes"], ["file-transcription", "local:one"]];
    for (const key of keys) client.setQueryData(key, { status: "transcribing" });
    const view = render(shell(client, "notes"));
    view.rerender(shell(client, "chat"));
    expect(mocks.subscribe).toHaveBeenCalledTimes(1);
    act(() => mocks.callbacks[0]!({ id: "local:one", title: "meeting.wav", status: "completed" }));
    for (const key of keys) expect(client.getQueryState(key)?.isInvalidated).toBe(true);
    expect(mocks.success).toHaveBeenCalledTimes(1);
    await act(async () => {});
    view.unmount();
    expect(mocks.unlisten).toHaveBeenCalledTimes(1);
  });
  it("announces failures but keeps in-flight updates quiet", () => {
    render(shell(new QueryClient(), "home"));
    act(() => mocks.callbacks[0]!({ id: "local:one", title: "meeting.wav", status: "transcribing" }));
    expect(mocks.success).not.toHaveBeenCalled(); expect(mocks.error).not.toHaveBeenCalled();
    act(() => mocks.callbacks[0]!({ id: "local:one", title: "meeting.wav", status: "failed", error: "model unavailable" }));
    expect(mocks.error).toHaveBeenCalledWith("workspace.local_transcribe_failed", { description: "model unavailable" });
  });
  it("ignores late events and disposes a subscription that resolves after unmount", async () => {
    let resolve!: (unlisten: () => void) => void;
    mocks.subscribe.mockImplementation((callback: (update: LocalTranscriptionUpdate) => void) => {
      mocks.callbacks.push(callback); return new Promise((done) => { resolve = done; });
    });
    const view = render(shell(new QueryClient(), "notes"));
    view.unmount();
    act(() => mocks.callbacks[0]!({ id: "local:one", title: "meeting.wav", status: "completed" }));
    expect(mocks.success).not.toHaveBeenCalled();
    await act(async () => resolve(mocks.unlisten));
    expect(mocks.unlisten).toHaveBeenCalledTimes(1);
  });
});
