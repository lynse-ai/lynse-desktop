import { Channel, invoke } from "@tauri-apps/api/core";
import type { DesktopRecordingCardUsbApi, RecordingCardDownloadProgress } from "@lynse/views/private-recording-card";
import { getRecordingCardAccess } from "@lynse/views/private-recording-card/desktop";

export const recordingCardUsbApi: DesktopRecordingCardUsbApi = {
  connect: async (password, vendorId, productId) =>
    invoke("recording_card_usb_connect", { password, vendorId, productId, access: getRecordingCardAccess() }),
  disconnect: () => invoke("recording_card_usb_disconnect"),
  state: () => invoke("recording_card_usb_state"),
  listFiles: async () => invoke("recording_card_usb_list_files", { access: getRecordingCardAccess() }),
  storage: () => invoke("recording_card_usb_storage"),
  deleteFile: async (name) => invoke("recording_card_usb_delete_file", { name, access: getRecordingCardAccess() }),
  getAutoOff: () => invoke<number>("recording_card_usb_get_auto_off"),
  setAutoOff: (minutes) => invoke("recording_card_usb_set_auto_off", { minutes }),
  getMicGain: (mode) => invoke("recording_card_usb_get_mic_gain", { mode }),
  setMicGain: (mode, mic1, mic2) =>
    invoke("recording_card_usb_set_mic_gain", { mode, mic1, mic2 }),
  setBound: async (bound) => invoke("recording_card_usb_set_bound", { bound, access: getRecordingCardAccess() }),
  unbind: async (format) => invoke("recording_card_usb_unbind", { format, access: getRecordingCardAccess() }),
  factoryReset: async () => invoke("recording_card_usb_factory_reset", { access: getRecordingCardAccess() }),
  formatStorage: async () => invoke("recording_card_usb_format_storage", { access: getRecordingCardAccess() }),
  download: async (file, onProgress) => {
    const channel = new Channel<RecordingCardDownloadProgress>();
    channel.onmessage = (progress) => {
      onProgress.onmessage?.(progress);
    };
    return invoke<string | null>("recording_card_usb_download", {
      file, onProgress: channel, access: getRecordingCardAccess(),
    });
  },
  cancelDownload: () => invoke("recording_card_usb_cancel_download"),
};
