/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, fireEvent } from "@testing-library/react";
import { PluginCommunitySection } from "./plugin-community-section";
import { registerPlugin } from "./registry";
import { usePluginStore } from "./state";
import { Settings } from "../icons";

/**
 * The manage-url row action: an installed + enabled plugin with manageUrl
 * shows a manage button that hands the URL to the system browser via the
 * desktop opener bridge.
 */

const openExternal = vi.fn();
const pluginId = "lynse.example-managed";
const managementUrl = "https://example.com/manage";

vi.mock("@lynse/core/i18n/react", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
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
  registerPlugin({
    id: pluginId,
    kind: "app",
    version: "1.0.0",
    minAppVersion: "1.2.11",
    nameKey: "plugins.test.name",
    descriptionKey: "plugins.test.description",
    icon: Settings,
    category: "tool",
    platforms: ["desktop"],
    permissions: [],
    manageUrl: () => managementUrl,
  });
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
        [pluginId]: { installedAt: 1, enabled: true },
      },
    }));

    render(<PluginCommunitySection />);
    const button = screen.getByText("plugins.action.manage");
    fireEvent.click(button);

    expect(openExternal).toHaveBeenCalledTimes(1);
    expect(openExternal).toHaveBeenCalledWith(managementUrl);
  });

  it("shows no manage button before the plugin is installed", () => {
    render(<PluginCommunitySection />);
    expect(screen.queryByText("plugins.action.manage")).toBeNull();
  });
});
