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
  storage: RecordingCardStorage | null;
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
  usbEnabled: boolean;
  setAccess: (enabled: boolean) => void;
  phase: "off" | "connecting" | "connected" | "error";
  errorMessage: string | null;
  deviceName: string | null;
  files: RecordingCardFile[];
  storage: RecordingCardStorage | null;
  listError: boolean;
  download: RecordingCardDownloadProgress | null;
  actionError: string | null;
  supported: boolean;
  connect: (descriptor?: { vendorId: number; productId: number }) => void;
  refreshFiles: () => void;
  deleteFile: (name: string) => void;
  downloadFile: (file: RecordingCardFile) => void;
  downloading: boolean;
}
