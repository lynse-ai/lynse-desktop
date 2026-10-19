/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import { clearMocks, mockConvertFileSrc, mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import type { DesktopDiagnosticsApi } from "@lynse/views/diagnostics";
import { installTauriBridge } from "./tauri-bridge";

vi.mock("./secure-storage", () => ({
  hydrateSecrets: vi.fn(), refreshSecret: vi.fn(), registerSecretKeys: vi.fn(),
  removeSecret: vi.fn(), setSecret: vi.fn(), secureStorage: { getItem: vi.fn() },
}));
vi.mock("./workbuddy-bridge", () => ({ installWorkBuddyBridge: vi.fn() }));
vi.mock("./mcp-bridge", () => ({ desktopMcpApi: {}, installDesktopMcpBridge: vi.fn() }));
vi.mock("@lynse/core/api/client", () => ({ setApiTransportMode: vi.fn() }));
vi.mock("@lynse/views/live-translation", () => ({
  listSecretVaultKeys: () => [], listProviders: () => [], getProvider: vi.fn(),
  collectLegacyLiveTranslationSnapshot: vi.fn(), migrateLegacyProviderSettings: vi.fn(),
  parsePersistedSettings: vi.fn(), secretVaultKey: vi.fn(), LEGACY_VOLC_APP_KEY: "legacy",
}));

function diagnostics(): DesktopDiagnosticsApi {
  return (window as Window & { desktopAPI?: { app: DesktopDiagnosticsApi } }).desktopAPI!.app;
}

afterEach(() => {
  clearMocks();
  Reflect.deleteProperty(window, "desktopAPI");
});

describe("report screenshot desktop bridge", () => {
  it.each([
    ["windows", "http://local-media.localhost/"],
    ["macos", "local-media://localhost/"],
    ["linux", "local-media://localhost/"],
  ])("returns a loadable JPEG preview on %s without changing the attachment", async (platform, prefix) => {
    const assetId = "staging:report-example.jpg";
    const path = platform === "windows"
      ? "C:\\Users\\Example\\AppData\\Roaming\\Lynse\\inspirations\\staging\\report-example.jpg"
      : "/tmp/Lynse/inspirations/staging/report-example.jpg";
    const nativeScreenshot = {
      path,
      url: "local-media://localhost/staging%3Areport%2Dexample%2Ejpg",
    };
    const ipc = vi.fn((command: string) => {
      if (command === "report_capture_main_screenshot") return nativeScreenshot;
      if (command === "get_app_info") return { version: "test", platform };
      throw new Error(`Unexpected command: ${command}`);
    });
    mockWindows("main");
    mockConvertFileSrc(platform);
    mockIPC(ipc, { shouldMockEvents: true });
    await installTauriBridge();

    const shot = await diagnostics().captureScreenshot!();

    expect(shot.path).toBe(path);
    expect(shot.url).toBe(`${prefix}${encodeURIComponent(assetId)}`);
    expect(decodeURIComponent(new URL(shot.url).pathname.slice(1))).toBe(assetId);
    expect(ipc).toHaveBeenCalledWith("report_capture_main_screenshot", {});
    expect(nativeScreenshot.url).toContain("%2Ejpg");
  });

  it("propagates native capture errors to the report form", async () => {
    mockWindows("main");
    mockConvertFileSrc("windows");
    mockIPC((command) => {
      if (command === "get_app_info") return { version: "test", platform: "win32" };
      throw new Error("PrintWindow failed for the main window");
    }, { shouldMockEvents: true });
    await installTauriBridge();

    await expect(diagnostics().captureScreenshot!()).rejects.toThrow("PrintWindow failed");
  });
});
