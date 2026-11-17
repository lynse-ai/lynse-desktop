/* @vitest-environment jsdom */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { RECORDING_CARD_PLUGIN_ID } from "./plugin-ids";

/** The sidebar's USB entry is gated by the plugin's installed+enabled state.
 * Verify the shared plugin-state predicate the sidebar gate relies on. */
describe("recording-card plugin gate", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("uses a stable plugin id across the manifest, gate and sidebar", () => {
    expect(RECORDING_CARD_PLUGIN_ID).toBe("lynse.recording-card-usb");
  });

  it("respects installed + enabled semantics from the plugin store", async () => {
    const { usePluginStore } = await import("./state");
    usePluginStore.setState({ entries: {} });
    expect(usePluginStore.getState().entries[RECORDING_CARD_PLUGIN_ID]).toBeUndefined();

    usePluginStore.getState().install(RECORDING_CARD_PLUGIN_ID);
    expect(usePluginStore.getState().entries[RECORDING_CARD_PLUGIN_ID]?.enabled).toBe(true);

    usePluginStore.getState().disable(RECORDING_CARD_PLUGIN_ID);
    expect(usePluginStore.getState().entries[RECORDING_CARD_PLUGIN_ID]?.enabled).toBe(false);

    usePluginStore.getState().uninstall(RECORDING_CARD_PLUGIN_ID);
    expect(usePluginStore.getState().entries[RECORDING_CARD_PLUGIN_ID]).toBeUndefined();
  });
});
