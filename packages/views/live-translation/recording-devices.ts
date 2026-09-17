import type { AudioDevicesSnapshot } from "./types";

/**
 * Persisted recording device selection (Windows only today). The values are
 * stable WASAPI endpoint ids — never device names, which change with
 * reconnection order. Empty/absent means "follow the OS default", which keeps
 * following default-device changes during the recording.
 */
export const RECORDING_MIC_DEVICE_KEY = "lynse_recording_mic_device";
export const RECORDING_SYSTEM_DEVICE_KEY = "lynse_recording_system_device";

export interface RecordingDeviceSelection {
  micDeviceId?: string;
  systemDeviceId?: string;
}

/** Read the persisted selection; anything absent/blank falls back to the
 * OS defaults (undefined fields are omitted from start requests). */
export function readRecordingDeviceSelection(): RecordingDeviceSelection {
  if (typeof window === "undefined") return {};
  const mic = window.localStorage.getItem(RECORDING_MIC_DEVICE_KEY) ?? "";
  const system = window.localStorage.getItem(RECORDING_SYSTEM_DEVICE_KEY) ?? "";
  const selection: RecordingDeviceSelection = {};
  if (mic.trim()) selection.micDeviceId = mic.trim();
  if (system.trim()) selection.systemDeviceId = system.trim();
  return selection;
}

export function saveRecordingDeviceSelection(selection: {
  micDeviceId?: string;
  systemDeviceId?: string;
}): void {
  if (typeof window === "undefined") return;
  const write = (key: string, value?: string) => {
    const trimmed = value?.trim() ?? "";
    if (trimmed) window.localStorage.setItem(key, trimmed);
    else window.localStorage.removeItem(key);
  };
  write(RECORDING_MIC_DEVICE_KEY, selection.micDeviceId);
  write(RECORDING_SYSTEM_DEVICE_KEY, selection.systemDeviceId);
}

/** Snapshot shape used when the platform has no device enumeration. */
export const EMPTY_AUDIO_DEVICES: AudioDevicesSnapshot = {
  inputs: [],
  outputs: [],
  defaultInput: null,
  defaultOutput: null,
};
