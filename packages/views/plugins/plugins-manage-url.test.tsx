/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, fireEvent } from "@testing-library/react";
import { PluginCommunitySection } from "./plugin-community-section";
import { registerPlugin } from "./registry";
import { usePluginStore } from "./state";
import { recordingCardUsbPlugin } from "./builtin/recording-card-usb";

/**
 * The manage-url row action: an installed + enabled plugin with manageUrl
 * shows a manage button that hands the URL to the system browser via the
 * desktop opener bridge.
 */

const openExternal = vi.fn();

vi.mock("@lynse/core/i18n/react", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("@lynse/core/api", () => ({
  api: () => ({ getBaseUrl: () => "https://api.lynse.cn" }),
}));

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

vi.mock("../layout/use-maximized", () => ({
  isTauri: true,
  useMaximized: () => false,
  get isMacDesktop() {
    return true;
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
  registerPlugin(recordingCardUsbPlugin);
  usePluginStore.setState({ entries: {} });
  (window as unknown as { desktopAPI?: unknown }).desktopAPI = { openExternal };
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("offline");
    }),
  );
});

afterEach(() => {
  cleanup();
  usePluginStore.setState({ entries: {} });
  delete (window as unknown as { desktopAPI?: unknown }).desktopAPI;
  vi.unstubAllGlobals();
});

describe("plugin manage-url row action", () => {
  it("opens the web management page for an installed, enabled plugin", () => {
    usePluginStore.setState((s) => ({
      entries: {
        ...s.entries,
        "lynse.recording-card-usb": { installedAt: 1, enabled: true },
      },
    }));

    render(<PluginCommunitySection />);
    const button = screen.getByText("plugins.action.manage");
    fireEvent.click(button);

    expect(openExternal).toHaveBeenCalledTimes(1);
    expect(openExternal).toHaveBeenCalledWith(
      "https://www.lynse.cn/app/plugins/recording-card",
    );
  });

  it("shows no manage button before the plugin is installed", () => {
    render(<PluginCommunitySection />);
    expect(screen.queryByText("plugins.action.manage")).toBeNull();
  });
});
