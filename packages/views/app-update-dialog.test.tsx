/* @vitest-environment jsdom */

import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18next from "i18next";
import { initI18n } from "@lynse/core/i18n";
import { RESOURCES } from "./locales";
import { AppUpdateDialog } from "./app-update-dialog";
import type { AppUpdateInfo, UpdateInstallState } from "./app-update";

const state = vi.hoisted(() => ({
  open: true,
  checking: false,
  error: null as string | null,
  update: null as AppUpdateInfo | null,
  installState: { phase: "idle", downloaded: 0, total: 0, error: null } as UpdateInstallState,
  setOpen: vi.fn(),
  checkForUpdate: vi.fn(),
  install: vi.fn(),
  openExternalUrl: vi.fn(),
}));

vi.mock("./app-update", () => ({
  useAppUpdate: () => state,
  useAppUpdateDialog: () => ({ open: state.open, setOpen: state.setOpen }),
  getAppInfoSync: () => ({ version: "1.2.7" }),
  getDesktopAppApi: () => null,
  isSandboxedMacApp: () => false,
  openExternalUrl: state.openExternalUrl,
}));

beforeEach(async () => {
  initI18n({ locale: "en", resources: RESOURCES });
  await i18next.changeLanguage("en");
  state.open = true;
  state.checking = false;
  state.error = null;
  state.update = {
    currentVersion: "1.2.7", latestVersion: "1.3.0", hasUpdate: true,
    releaseUrl: "https://example.com/release",
    releaseNotes: "### New features\n• Chapters\n• On-device recognition\n\n### Fixes\n• Kept the draft.",
  };
  state.installState = { phase: "idle", downloaded: 0, total: 0, error: null };
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("readable update details", () => {
  it("shows real versions and semantic category lists without claiming complete history", () => {
    render(<AppUpdateDialog />);
    expect(screen.getByRole("heading", { name: "Update to v1.3.0" })).toBeTruthy();
    expect(screen.getByText("Current version: v1.2.7")).toBeTruthy();
    expect(screen.getByText("Changes in this release")).toBeTruthy();
    const section = screen.getByRole("region", { name: "New features" });
    expect(within(section).getAllByRole("listitem")).toHaveLength(2);
    expect(screen.queryByText(/since|releases ·/i)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Later" }));
    expect(state.setOpen).toHaveBeenCalledWith(false);
  });

  it("retains a busy dialog, shows actual download progress and prevents a second install", () => {
    state.installState = { phase: "downloading", downloaded: 25, total: 100, error: null };
    render(<AppUpdateDialog />);
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("25");
    const later = screen.getByRole("button", { name: "Later" }) as HTMLButtonElement;
    const install = screen.getByRole("button", { name: "Downloading update… 25%" }) as HTMLButtonElement;
    expect(later.disabled).toBe(true);
    expect(install.disabled).toBe(true);
    fireEvent.click(install);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(state.install).not.toHaveBeenCalled();
    expect(state.setOpen).not.toHaveBeenCalled();
  });

  it("provides a real retry action on a failed update check", () => {
    state.update = null;
    state.error = "Network unavailable";
    render(<AppUpdateDialog />);
    expect(screen.queryByText("You're on the latest version")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Check for updates" }));
    expect(state.checkForUpdate).toHaveBeenCalled();
    expect(screen.getByRole("alert")).toBeTruthy();
  });

  it("states when notes are missing and keeps the update action usable", () => {
    state.update!.releaseNotes = " ";
    render(<AppUpdateDialog />);
    expect(screen.getByText("Release notes aren’t available for this version yet.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Install update" }));
    expect(state.install).toHaveBeenCalledTimes(1);
  });

  it("renders formatting as safe React text and keeps unknown content", () => {
    state.update!.releaseNotes = "## Compatibility\n- **Clearer** \u0060timestamps\u0060\n- <img src=x onerror=alert(1)>\n- [Unsafe](javascript:alert(1))";
    const view = render(<AppUpdateDialog />);
    expect(screen.getByRole("heading", { name: "Compatibility" })).toBeTruthy();
    expect(view.container.ownerDocument.querySelector("code")?.textContent).toBe("timestamps");
    expect(view.container.ownerDocument.querySelector("img[src=x]")).toBeNull();
    expect(screen.queryByRole("link", { name: "Unsafe" })).toBeNull();
    expect(screen.getByText("<img src=x onerror=alert(1)>")).toBeTruthy();
  });

  it.each(["zh-Hans", "zh-Hant", "ja", "ko"])("has translated section and version labels for %s", async (language) => {
    await act(async () => { await i18next.changeLanguage(language); });
    state.update!.releaseNotes = "### New features\n- One change";
    render(<AppUpdateDialog />);
    const dialog = screen.getByRole("dialog");
    expect(dialog.textContent).not.toContain("settings.update_");
    expect(screen.getByRole("heading", { name: /1\.3\.0/ })).toBeTruthy();
  });
});
