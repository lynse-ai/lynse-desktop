/* @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkBuddyTokenInfo } from "@lynse/core/auth/workbuddy";

const mocks = vi.hoisted(() => ({ token: vi.fn(), profile: vi.fn(), authorize: vi.fn(), clear: vi.fn() }));
vi.mock("@lynse/core/i18n/react", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@lynse/core/auth/workbuddy", () => ({
  getWorkBuddyToken: mocks.token, getWorkBuddyProfile: mocks.profile,
  runWorkBuddyAuthorization: mocks.authorize, clearWorkBuddyTokenCache: mocks.clear,
  isWorkBuddyNotBoundError: () => false, workbuddyErrorCopy: () => ({ key: "error" }),
}));
vi.mock("../app-update", () => ({ getDesktopAppApi: () => ({}), openExternalUrl: vi.fn() }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
import { WorkBuddyConfigCard } from "./workbuddy-config-card";

const OLD_GRANT: WorkBuddyTokenInfo = { authorized: true, openId: "old-account", scope: "user.profile.readable" };
beforeEach(() => {
  vi.resetAllMocks();
  mocks.token.mockResolvedValue(OLD_GRANT);
  mocks.profile.mockResolvedValue({ nickname: "Old user" });
});
afterEach(() => cleanup());

describe("WorkBuddy connection reset", () => {
  it("shows that an existing profile grant still needs cloud authorization", async () => {
    render(<WorkBuddyConfigCard />);
    expect(await screen.findByText("workbuddy.status_scope_required")).toBeTruthy();
    expect(screen.queryByText("workbuddy.status_bound")).toBeNull();
  });

  it("clears local state and prevents a cancelled authorization from restoring it", async () => {
    let resolve!: (value: WorkBuddyTokenInfo) => void;
    mocks.authorize.mockImplementation(() => new Promise<WorkBuddyTokenInfo>((done) => { resolve = done; }));
    render(<WorkBuddyConfigCard />);
    await screen.findByText("Old user");
    fireEvent.click(screen.getByRole("button", { name: "workbuddy.reauthorize" }));
    expect(mocks.authorize.mock.calls[0]![0].cloud).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "workbuddy.reset_state" }));
    expect(mocks.authorize.mock.calls[0]![0].isCancelled()).toBe(true);
    await act(async () => { resolve({ ...OLD_GRANT, scope: "user.task.readable user.task.invokable" }); });
    expect(screen.getByText("workbuddy.status_reset")).toBeTruthy();
    expect(screen.queryByText("old-account")).toBeNull();
    expect(screen.queryByText("Old user")).toBeNull();
    expect(mocks.clear).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: "workbuddy.authorize" }).hasAttribute("disabled")).toBe(false);
  });

  it("does not let a delayed status refresh overwrite a reset", async () => {
    render(<WorkBuddyConfigCard />);
    await screen.findByText("old-account");
    let resolve!: (value: WorkBuddyTokenInfo) => void;
    mocks.token.mockImplementationOnce(() => new Promise<WorkBuddyTokenInfo>((done) => { resolve = done; }));
    fireEvent.click(screen.getByRole("button", { name: "workbuddy.refresh" }));
    fireEvent.click(screen.getByRole("button", { name: "workbuddy.reset_state" }));
    await act(async () => { resolve(OLD_GRANT); });
    expect(screen.getByText("workbuddy.status_reset")).toBeTruthy();
    expect(screen.queryByText("old-account")).toBeNull();
  });
});
