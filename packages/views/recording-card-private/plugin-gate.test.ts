/* @vitest-environment jsdom */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { RECORDING_CARD_PLUGIN_ID } from "./plugin";

/** The sidebar's USB entry is gated by the plugin's installed+enabled state.
 * Verify the shared plugin-state predicate the sidebar gate relies on, and
 * that a build shipping the plugin brings the entry up without an install. */
describe("recording-card plugin gate", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.resetModules();
  });

  it("uses a stable plugin id across the manifest, gate and sidebar", () => {
    expect(RECORDING_CARD_PLUGIN_ID).toBe("lynse.recording-card-usb");
  });

  it("respects installed + enabled semantics from the plugin store", async () => {
    const { usePluginStore } = await import("../plugins/state");
    usePluginStore.setState({ entries: {} });
    expect(usePluginStore.getState().entries[RECORDING_CARD_PLUGIN_ID]).toBeUndefined();

    usePluginStore.getState().install(RECORDING_CARD_PLUGIN_ID);
    expect(usePluginStore.getState().entries[RECORDING_CARD_PLUGIN_ID]?.enabled).toBe(true);

    usePluginStore.getState().disable(RECORDING_CARD_PLUGIN_ID);
    expect(usePluginStore.getState().entries[RECORDING_CARD_PLUGIN_ID]?.enabled).toBe(false);

    usePluginStore.getState().uninstall(RECORDING_CARD_PLUGIN_ID);
    expect(usePluginStore.getState().entries[RECORDING_CARD_PLUGIN_ID]).toBeUndefined();
  });

  it("seeds the plugin once on profiles that predate it", async () => {
    // A public build persisted plugin state without the recording card, so
    // the migration probe never runs again there. Persist it the way the
    // store does so the seed's key check is covered as well.
    const { usePluginStore } = await import("../plugins/state");
    usePluginStore.getState().install("lynse.some-other-plugin");
    vi.resetModules();

    const { RECORDING_CARD_PLUGIN_ID, seedRecordingCardPlugin } = await import("./plugin");
    const { usePluginStore: reloaded } = await import("../plugins/state");
    expect(reloaded.getState().entries[RECORDING_CARD_PLUGIN_ID]).toBeUndefined();

    seedRecordingCardPlugin();
    expect(reloaded.getState().entries[RECORDING_CARD_PLUGIN_ID]?.enabled).toBe(true);
    expect(reloaded.getState().entries["lynse.some-other-plugin"]).toBeDefined();

    // A later uninstall must stick.
    reloaded.getState().uninstall(RECORDING_CARD_PLUGIN_ID);
    seedRecordingCardPlugin();
    expect(reloaded.getState().entries[RECORDING_CARD_PLUGIN_ID]).toBeUndefined();
  });

  it("keeps a decision the profile already made about the plugin", async () => {
    const { usePluginStore } = await import("../plugins/state");
    usePluginStore.setState({
      entries: { [RECORDING_CARD_PLUGIN_ID]: { installedAt: 1, enabled: false } },
    });
    vi.resetModules();

    const { seedRecordingCardPlugin } = await import("./plugin");
    const { usePluginStore: reloaded } = await import("../plugins/state");
    seedRecordingCardPlugin();
    expect(reloaded.getState().entries[RECORDING_CARD_PLUGIN_ID]?.enabled).toBe(false);
  });

  it("leaves a fresh profile to the migration probe", async () => {
    const { RECORDING_CARD_PLUGIN_ID, recordingCardUsbPlugin, seedRecordingCardPlugin } =
      await import("./plugin");
    const { registerPlugin } = await import("../plugins/registry");
    const { initPluginMigrations, usePluginStore } = await import("../plugins/state");
    registerPlugin(recordingCardUsbPlugin);

    // Seeding first would persist state and pre-empt the probe that installs
    // every other built-in.
    seedRecordingCardPlugin();
    expect(localStorage.getItem("lynse_plugins_state")).toBeNull();

    await initPluginMigrations();
    expect(usePluginStore.getState().entries[RECORDING_CARD_PLUGIN_ID]?.enabled).toBe(true);
  });
});
