import { api } from "@lynse/core/api";
import { definePlugin } from "../registry";
import { buildRecordingCardManageUrl } from "../../recording-card/manage-url";
import { Usb } from "../../icons";

/**
 * Recording card USB — a thin entry point, not a feature plugin: the
 * community row's manage button opens the Lynse Web management page
 * (/app/plugins/recording-card) in the user's system browser, where the
 * card is linked over WebUSB (the desktop WKWebView has no WebUSB). No
 * local state, no lifecycle, no permissions — everything happens in the
 * browser session.
 */
export const recordingCardUsbPlugin = definePlugin({
  id: "lynse.recording-card-usb",
  kind: "app",
  version: "1.0.0",
  minAppVersion: "1.2.11",
  nameKey: "plugins.recordingCardUsb.name",
  descriptionKey: "plugins.recordingCardUsb.description",
  icon: Usb,
  category: "tool",
  platforms: ["desktop"],
  permissions: [],
  // Open the deployment fronting the same account system the desktop is
  // signed into, so the browser session already exists or pairs cleanly.
  manageUrl: () => buildRecordingCardManageUrl(api().getBaseUrl()),
});
