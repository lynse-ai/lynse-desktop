/** Minimal structural type for the Tauri IPC progress channel. Declared here
 * so shared views never import Tauri packages directly (web build safety). */
export interface ProgressChannel<T> {
  onmessage: ((message: T) => void) | null;
}

/** One recording visible on the USB card (mirrors Rust CardFile). */
export interface RecordingCardFile {
  sn: number;
  name: string;
  size: number;
  scene: number;
  startTime: number;
  endTime: number;
  crc: string;
  frameSize: number;
}

export interface RecordingCardStorage {
  freeSpace: number;
  totalSpace: number;
}

export interface RecordingCardConnectResult {
  vendorId: number;
  productId: number;
  /** Card serial from the authsn command; null when the device skipped it. */
  deviceSn: string | null;
  storage: RecordingCardStorage | null;
  /** Whether the RTC sync during connect was acknowledged by the card. */
  clockSynced: boolean;
}

/** Two-channel gain for one scene (0 = meeting, 1 = call). */
export type RecordingCardMicMode = 0 | 1;

export interface RecordingCardMicGain {
  result: number;
  mode: number;
  mic1: number;
  mic2: number;
}

export interface RecordingCardActionResult {
  result: number;
  detail: string[];
}

export interface RecordingCardDownloadProgress {
  fileName: string;
  loaded: number;
  total: number;
}

/**
 * Desktop-only USB backend exposed by the Rust side through the Tauri bridge.
 * The password comes from the authenticated web session at connect time and
 * is never stored or logged by the Rust process.
 */
export interface DesktopRecordingCardUsbApi {
  connect(
    password: string,
    vendorId?: number,
    productId?: number,
  ): Promise<RecordingCardConnectResult>;
  disconnect(): Promise<void>;
  state(): Promise<boolean>;
  listFiles(): Promise<RecordingCardFile[]>;
  storage(): Promise<RecordingCardStorage>;
  deleteFile(name: string): Promise<void>;
  getAutoOff(): Promise<number>;
  setAutoOff(minutes: number): Promise<void>;
  getMicGain(mode: RecordingCardMicMode): Promise<RecordingCardMicGain>;
  setMicGain(
    mode: RecordingCardMicMode,
    mic1: number,
    mic2: number,
  ): Promise<RecordingCardMicGain>;
  setBound(bound: boolean): Promise<void>;
  unbind(format: boolean): Promise<void>;
  factoryReset(): Promise<void>;
  formatStorage(): Promise<void>;
  /** Download to a caller-chosen local path; progress via a Tauri Channel. */
  download(
    file: RecordingCardFile,
    onProgress: ProgressChannel<RecordingCardDownloadProgress>,
  ): Promise<string | null>;
  cancelDownload(): Promise<void>;
}

/** Return the desktop USB backend when running inside the Tauri host. */
export function getRecordingCardUsbApi(): DesktopRecordingCardUsbApi | null {
  if (typeof window === "undefined") return null;
  const desktopWindow = window as Window & {
    desktopAPI?: { recordingCardUsb?: DesktopRecordingCardUsbApi };
  };
  return desktopWindow.desktopAPI?.recordingCardUsb ?? null;
}

/** View-model returned by both the WebUSB and the desktop USB session hooks. */
export interface RecordingCardSessionView {
  phase: "off" | "connecting" | "connected" | "error";
  errorMessage: string | null;
  deviceName: string | null;
  /** Serial reported by authsn/getIdentity; falls back to deviceName. */
  deviceSn: string | null;
  /** RTC sync acknowledgement from the most recent connect. */
  clockSynced: boolean | null;
  files: RecordingCardFile[];
  storage: RecordingCardStorage | null;
  listError: boolean;
  autoOffMinutes: number | null;
  micGain: RecordingCardMicGain | null;
  settingsLoading: boolean;
  download: RecordingCardDownloadProgress | null;
  actionError: string | null;
  supported: boolean;
  connect: () => void;
  /** Release the USB link and return to the idle (off) state. */
  disconnect: () => void;
  refreshFiles: () => void;
  refreshSettings: () => void;
  refreshMicGain: (mode: RecordingCardMicMode) => Promise<void>;
  deleteFile: (name: string) => void;
  deleteFiles: (names: string[]) => Promise<boolean>;
  setAutoOff: (minutes: number) => Promise<boolean>;
  setMicGain: (mode: RecordingCardMicMode, mic1: number, mic2: number) => Promise<boolean>;
  setBound: (bound: boolean) => Promise<boolean>;
  unbind: (format?: boolean) => Promise<boolean>;
  factoryReset: () => Promise<boolean>;
  formatStorage: () => Promise<boolean>;
  downloadFile: (file: RecordingCardFile) => void;
  downloading: boolean;
}
