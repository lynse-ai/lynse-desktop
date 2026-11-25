import { api } from "@lynse/core/api";
import { defaultStorage } from "@lynse/core/platform";
import { lazy } from "react";
import { MergeUp } from "../icons";
import { definePlugin } from "../plugins/registry";
import { usePluginStore } from "../plugins/state";
import { buildRecordingCardManageUrl } from "./manage-url";

export { recordingCardLocales } from "./locales";
export { getRecordingCardAccess } from "./ownership";
export const RECORDING_CARD_PLUGIN_ID = "lynse.recording-card-usb";

/** Persisted plugin state key; must match `STORAGE_KEY` in `plugins/state.ts`. */
const PLUGIN_STATE_KEY = "lynse_plugins_state";
/** Marks profiles whose plugin state already received the card manager. */
const SEED_MARKER_KEY = "lynse_recording_card_plugin_seeded";

/**
 * The devices entry is the point of a build that ships this plugin, so it must
 * not wait for a manual trip through Settings → Plugins. Fresh profiles are
 * seeded by `migrate` together with the other built-ins; this covers profiles
 * whose plugin state was persisted before the plugin was compiled in (public
 * builds), where that probe never runs again. One-shot per profile, so an
 * uninstall afterwards sticks.
 */
export function seedRecordingCardPlugin(): void {
  try {
    // Writing plugin state here would pre-empt the migration probe that
    // installs every other built-in on a fresh profile.
    if (defaultStorage.getItem(PLUGIN_STATE_KEY) === null) return;
    if (defaultStorage.getItem(SEED_MARKER_KEY) !== null) return;
    defaultStorage.setItem(SEED_MARKER_KEY, "1");
  } catch {
    // Without the marker the next launch would resurrect an uninstall.
    return;
  }
  const { entries, install } = usePluginStore.getState();
  if (!entries[RECORDING_CARD_PLUGIN_ID]) install(RECORDING_CARD_PLUGIN_ID);
}

const RecordingCardDesktopPage = lazy(() =>
  import("./recording-card-desktop-page").then((module) => ({ default: module.RecordingCardDesktopPage })),
);

export const recordingCardUsbPlugin = definePlugin({
  id: RECORDING_CARD_PLUGIN_ID,
  kind: "app",
  version: "1.0.0",
  minAppVersion: "1.2.11",
  nameKey: "recordingCard.plugin_name",
  descriptionKey: "recordingCard.plugin_description",
  icon: MergeUp,
  category: "tool",
  platforms: ["desktop"],
  permissions: [],
  contributions: {
    sidebarItem: {
      key: "devices",
      labelKey: "nav.devices",
      icon: MergeUp,
      path: "/devices",
      component: RecordingCardDesktopPage,
    },
  },
  manageUrl: () => buildRecordingCardManageUrl(api().getBaseUrl()),
  // Ships installed + enabled: see `seedRecordingCardPlugin`.
  migrate: () => true,
});
