import type { DesktopLiveTranslationApi } from "../live-translation";

/** Snapshot of the recording-card manager; mirrors the Rust
 * `recording_card::CardStateSnapshot` (camelCase serde). */
export interface CardStateSnapshot {
  bluetoothReady: boolean;
  bluetoothError?: string | null;
  connected: boolean;
  scanning: boolean;
  discovered: DiscoveredCardDevice[];
  device: CardDeviceInfo;
  battery?: CardBattery | null;
  memory?: CardMemory | null;
  recording?: CardRecordingState | null;
  files: CardFile[];
  transfer?: CardTransferProgress | null;
  liveFeedEnabled: boolean;
  manufacturerCodeSet: boolean;
  savedDevice?: SavedCardDevice | null;
}

export interface DiscoveredCardDevice {
  id: string;
  name: string;
  rssi?: number | null;
  deviceCode: string;
  protocolVersion: number;
  sku?: string | null;
  hasStorage: boolean;
  hasMeetingRecording: boolean;
}

export interface CardDeviceInfo {
  id: string;
  name: string;
  mac?: string | null;
  protocolVersion?: number | null;
  sku?: string | null;
  softwareVersion?: string | null;
  hardwareVersion?: string | null;
}

export interface CardBattery {
  left: number;
  right: number;
  main: number;
}

export interface CardMemory {
  freeKb: number;
  totalKb: number;
}

export interface CardRecordingState {
  status: "idle" | "recording" | "paused";
  mode?: "meeting" | "call" | "media" | null;
  durationMs?: number | null;
  fileSn?: number | null;
  fileName?: string | null;
  sampleRateHz?: number | null;
  channels?: number | null;
}

export interface CardFile {
  sn: number;
  name: string;
  size: number;
  scene: number;
  startTimestamp?: number | null;
  endTimestamp?: number | null;
  crc?: string | null;
  frameBytes: number;
}

export interface CardTransferProgress {
  sn: number;
  name: string;
  receivedBytes: number;
  totalBytes: number;
  autoDelete: boolean;
  finished: boolean;
  error?: string | null;
  wavPath?: string | null;
  opusPath?: string | null;
}

export interface SavedCardDevice {
  id: string;
  name: string;
}

export type RecordingCardRecordAction =
  | "start"
  | "stop"
  | "pause"
  | "resume"
  | "mark";

export type RecordingCardEvent =
  | { type: "scan"; device: DiscoveredCardDevice }
  | { type: "scan-state"; scanning: boolean }
  | { type: "connection"; connected: boolean; reason?: string; device?: CardDeviceInfo }
  | { type: "record"; recording: CardRecordingState }
  | { type: "files"; files: CardFile[] }
  | { type: "transfer"; transfer: CardTransferProgress }
  | { type: "level"; level: number; elapsedMs: number }
  | { type: "settings"; manufacturerCodeSet?: boolean; liveFeed?: boolean }
  | { type: "mark" }
  | { type: "connected"; deviceId: string }
  | { type: "error"; message: string };

/** Desktop-only bridge surface implemented in `apps/tauri/src/tauri-bridge.ts`
 * and attached to `window.desktopAPI.recordingCard`. */
export interface DesktopRecordingCardApi {
  state: () => Promise<CardStateSnapshot>;
  scanStart: () => Promise<void>;
  scanStop: () => Promise<void>;
  setManufacturerCode: (code: string) => Promise<void>;
  setLiveFeed: (enabled: boolean) => Promise<void>;
  connect: (device: DiscoveredCardDevice) => Promise<CardStateSnapshot>;
  disconnect: () => Promise<void>;
  query: (kind: "battery" | "version" | "memory") => Promise<void>;
  record: (action: RecordingCardRecordAction, mode?: "meeting" | "call" | "media") => Promise<void>;
  listFiles: () => Promise<CardFile[]>;
  download: (
    file: { sn: number; name: string; size: number; frameBytes: number },
    autoDelete: boolean,
  ) => Promise<void>;
  cancelDownload: () => Promise<void>;
  deleteFile: (sn: number, name: string) => Promise<void>;
  /** Decode a transferred Opus artifact to WAV; returns the absolute path. */
  transcribeSource: (name: string, sn: number, frameBytes: number) => Promise<string>;
  onEvent: (callback: (event: RecordingCardEvent) => void) => Promise<() => void>;
}

/** Full desktop API shape with the recording-card extension applied. */
export type DesktopApiWithRecordingCard = {
  desktopAPI?: {
    recordingCard?: DesktopRecordingCardApi;
    liveTranslation?: DesktopLiveTranslationApi;
    localTranscription?: {
      transcribe: (
        audioPath: string,
        options?: unknown,
      ) => Promise<unknown>;
    };
  };
};

export function getRecordingCardApi(): DesktopRecordingCardApi | null {
  return (window as DesktopApiWithRecordingCard).desktopAPI?.recordingCard ?? null;
}

export function getLocalTranscribeApi(): DesktopApiWithRecordingCard["desktopAPI"] | null {
  return (window as DesktopApiWithRecordingCard).desktopAPI ?? null;
}
