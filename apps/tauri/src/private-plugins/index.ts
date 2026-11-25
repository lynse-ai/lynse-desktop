import { registerPlugin } from "@lynse/views/plugins";
import {
  recordingCardLocales,
  recordingCardUsbPlugin,
  seedRecordingCardPlugin,
} from "@lynse/views/private-recording-card/desktop";
import { recordingCardUsbApi } from "./recording-card-bridge";

type Resources = Record<string, { translation: Record<string, unknown> }>;

export function installPrivatePlugins(): void {
  const desktopApi = (window as Window & { desktopAPI?: object }).desktopAPI;
  if (!desktopApi) return;
  Object.assign(desktopApi, { recordingCardUsb: recordingCardUsbApi });
  registerPlugin(recordingCardUsbPlugin);
  seedRecordingCardPlugin();
}

export function withPrivatePluginLocales(resources: Resources): Resources {
  const cardLocales: Record<string, (typeof recordingCardLocales)["en"]> = recordingCardLocales;
  return Object.fromEntries(
    Object.entries(resources).map(([locale, { translation }]) => [
      locale, { translation: { ...translation, recordingCard: cardLocales[locale] ?? cardLocales.en } },
    ]),
  );
}
