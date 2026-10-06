/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, fireEvent, waitFor } from "@testing-library/react";
import type { SttModelInfo, TranscribeConfig } from "../workspace/local-transcription";
import type { PluginManifest } from "./types";

/**
 * Runtime wiring tests for the plugin lifecycle and community surfaces
 * (PRD P3/P4 acceptance, headless-verification layer): the same calls the UI
 * makes, asserted against a mocked desktop bridge — feishu disable must
 * persist enabled=false and stop the WS; the model card must block
 * uninstalling a referenced model.
 */

const feishuApi = {
  getConfig: vi.fn(),
  saveConfig: vi.fn(),
  start: vi.fn(),
  stop: vi.fn(),
};

const localApi = {
  listSttModels: vi.fn(),
  downloadSttModel: vi.fn(),
  deleteSttModel: vi.fn(),
  getSttConfig: vi.fn(),
  onSttDownloadProgress: vi.fn(),
};

vi.mock("@lynse/core/i18n/react", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

// The model catalog renders the full lineup only on macOS; off macOS just the
// whisper tiers survive (visibleModelCatalog). The existing card tests run as
// mac, the Windows-hide test flips the flag — hence a getter, not a constant.
const sttPlatform = vi.hoisted(() => ({ mac: true }));
vi.mock("../layout/use-maximized", () => ({
  isTauri: true,
  useMaximized: () => false,
  get isMacDesktop() {
    return sttPlatform.mac;
  },
}));

import { toast } from "sonner";
import { feishuBotPlugin } from "./builtin/feishu-bot";
import { PluginHost } from "./plugin-host";
import { PluginCommunitySection } from "./plugin-community-section";
import { registerPlugin, definePlugin } from "./registry";
import { usePluginStore } from "./state";

function seedEntry(id: string, enabled: boolean) {
  usePluginStore.setState((s) => ({
    entries: { ...s.entries, [id]: { installedAt: 1, enabled } },
  }));
}

function stubDesktopApi(api: Record<string, unknown>) {
  (window as unknown as { desktopAPI?: unknown }).desktopAPI = api;
}

/**
 * First hit of a `getAllBy*` query. Catalog rows are ordered, so tests reach
 * for index 0; `noUncheckedIndexedAccess` types that as possibly undefined,
 * and a missing element is a failed expectation rather than something to
 * cast away.
 */
function firstMatch(elements: HTMLElement[]): HTMLElement {
  const element = elements[0];
  if (!element) throw new Error("expected at least one matching element");
  return element;
}

beforeEach(() => {
  vi.clearAllMocks();
  sttPlatform.mac = true;
  usePluginStore.setState({ entries: {} });
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

describe("feishu plugin lifecycle (P3)", () => {
  beforeEach(() => {
    stubDesktopApi({ feishu: feishuApi });
  });

  it("disable persists enabled=false into config and stops the WS session", async () => {
    feishuApi.getConfig.mockResolvedValue({
      appId: "cli_x",
      targetChatId: "oc_1",
      enabled: true,
      pushSummary: true,
      hasSecret: true,
    });
    feishuApi.saveConfig.mockResolvedValue({});
    feishuApi.stop.mockResolvedValue({ state: "disabled" });

    await feishuBotPlugin.lifecycle!.onDisable!();

    // The persisted flag is what suppresses the Rust auto-start on the next
    // launch — it must flip off before/independently of stopping the socket.
    expect(feishuApi.saveConfig).toHaveBeenCalledTimes(1);
    expect(feishuApi.saveConfig).toHaveBeenCalledWith(expect.objectContaining({ enabled: false }));
    expect(feishuApi.stop).toHaveBeenCalledTimes(1);
  });

  it("enable without credentials keeps the flag off and never starts", async () => {
    feishuApi.getConfig.mockResolvedValue({
      appId: "",
      targetChatId: "",
      enabled: false,
      pushSummary: false,
      hasSecret: false,
    });
    await feishuBotPlugin.lifecycle!.onEnable!();
    expect(feishuApi.saveConfig).not.toHaveBeenCalled();
    expect(feishuApi.start).not.toHaveBeenCalled();
  });

  it("enable with credentials flips the flag on and starts", async () => {
    feishuApi.getConfig.mockResolvedValue({
      appId: "cli_x",
      targetChatId: "",
      enabled: false,
      pushSummary: false,
      hasSecret: true,
    });
    feishuApi.saveConfig.mockResolvedValue({});
    feishuApi.start.mockResolvedValue({ state: "connecting" });
    await feishuBotPlugin.lifecycle!.onEnable!();
    expect(feishuApi.saveConfig).toHaveBeenCalledWith(expect.objectContaining({ enabled: true }));
    expect(feishuApi.start).toHaveBeenCalledTimes(1);
  });

  it("migrate probes the stored config (configured → seeded, fresh → skipped)", async () => {
    feishuApi.getConfig.mockResolvedValue({
      appId: "cli_x",
      targetChatId: "",
      enabled: true,
      pushSummary: false,
      hasSecret: true,
    });
    await expect(feishuBotPlugin.migrate!()).resolves.toBe(true);

    feishuApi.getConfig.mockRejectedValue(new Error("no config"));
    await expect(feishuBotPlugin.migrate!()).resolves.toBe(false);
  });
});

describe("PluginHost subscriber gating (P3)", () => {
  it("mounts the subscriber only while the plugin is installed + enabled", () => {
    registerPlugin(
      definePlugin({
        id: "test.subscriber",
        kind: "app",
        version: "1.0.0",
        minAppVersion: "1.0.0",
        nameKey: "plugins.test.name",
        descriptionKey: "plugins.test.description",
        icon: (() => null) as unknown as PluginManifest["icon"],
        category: "tool",
        platforms: ["web", "desktop"],
        permissions: [],
        contributions: {
          eventSubscriptions: ["transcription-completed"],
          subscriberComponent: () => <div>subscriber-active</div>,
        },
      }),
    );

    seedEntry("test.subscriber", true);
    const view = render(<PluginHost />);
    expect(screen.getByText("subscriber-active")).toBeTruthy();

    seedEntry("test.subscriber", false);
    view.rerender(<PluginHost />);
    expect(screen.queryByText("subscriber-active")).toBeNull();
  });
});

describe("community model card uninstall guard (P4)", () => {
  const modelInfo: SttModelInfo = {
    provider: "funasr",
    id: "funasr-paraformer",
    label: "FunASR",
    sizeBytes: 0,
    status: "installed",
    modelDir: "/models/funasr",
  };

  function mockLocalApi(config: TranscribeConfig, status: SttModelInfo["status"] = "installed") {
    localApi.listSttModels.mockResolvedValue({ models: [{ ...modelInfo, status }] });
    localApi.getSttConfig.mockResolvedValue(config);
    localApi.deleteSttModel.mockResolvedValue({ models: [] });
    localApi.downloadSttModel.mockResolvedValue({ models: [{ ...modelInfo, status }] });
    localApi.onSttDownloadProgress.mockResolvedValue(() => undefined);
    stubDesktopApi({ localTranscription: localApi });
  }

  it("blocks deleting a model referenced by the default engine", async () => {
    mockLocalApi({ default: { provider: "funasr" }, per_language: {} });
    seedEntry("lynse.model.funasr-latest", true);
    render(<PluginCommunitySection />);

    // Model statuses load asynchronously; wait until the funasr row shows
    // installed so its delete button is enabled (the other rows stay
    // "not installed" and their buttons disabled).
    await screen.findByText("settings.stt_status_installed");

    // Two clicks: arm the destructive confirm, then confirm. The funasr row
    // is first in the catalog, hence firstMatch(getAllByText(...)).
    fireEvent.click(firstMatch(screen.getAllByText("settings.stt_delete_model")));
    fireEvent.click(screen.getByText("plugins.action.uninstall_confirm"));

    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(localApi.deleteSttModel).not.toHaveBeenCalled();
  });

  it("deletes when nothing references the model", async () => {
    mockLocalApi({
      default: { provider: "qwen3", model: "qwen3-asr-1.7b-8bit" },
      per_language: {},
    });
    seedEntry("lynse.model.funasr-latest", true);
    render(<PluginCommunitySection />);

    await screen.findByText("settings.stt_status_installed");
    fireEvent.click(firstMatch(screen.getAllByText("settings.stt_delete_model")));
    fireEvent.click(screen.getByText("plugins.action.uninstall_confirm"));

    await waitFor(() => expect(localApi.deleteSttModel).toHaveBeenCalledTimes(1));
    expect(localApi.deleteSttModel).toHaveBeenCalledWith("funasr", "funasr-paraformer");
  });

  it("routes the download button to the existing model-download command", async () => {
    mockLocalApi(
      { default: { provider: "qwen3", model: "qwen3-asr-1.7b-8bit" }, per_language: {} },
      "not_installed",
    );
    seedEntry("lynse.model.funasr-latest", true);
    render(<PluginCommunitySection />);

    await screen.findAllByText("settings.stt_status_not_installed");
    fireEvent.click(firstMatch(screen.getAllByText("settings.stt_download_model")));
    await waitFor(() =>
      expect(localApi.downloadSttModel).toHaveBeenCalledWith("funasr", "funasr-paraformer"),
    );
  });

  it("hides the MLX/venv-bound engine cards off macOS (Windows build)", async () => {
    sttPlatform.mac = false;
    mockLocalApi(
      { default: { provider: "whisper", model: "large-v3-turbo-q5_0" }, per_language: {} },
      "not_installed",
    );
    seedEntry("lynse.model.funasr-latest", true);
    render(<PluginCommunitySection />);

    // Only the sidecar engines (whisper tiers + VibeVoice) are listed;
    // funasr/qwen3/whisperx cannot even create their venvs on Windows, so
    // their cards must not offer downloads.
    expect(screen.queryByText("plugins.models.funasr.name")).toBeNull();
    expect(screen.queryByText("plugins.models.qwen3Large.name")).toBeNull();
    expect(screen.queryByText("plugins.models.whisperx.name")).toBeNull();
    expect(await screen.findByText("plugins.models.whisperTurbo.name")).toBeTruthy();
    expect(screen.getByText("plugins.models.whisperMedium.name")).toBeTruthy();
    expect(screen.getByText("plugins.models.whisperSmall.name")).toBeTruthy();
    expect(screen.getByText("plugins.models.vibevoice.name")).toBeTruthy();
  });
});
