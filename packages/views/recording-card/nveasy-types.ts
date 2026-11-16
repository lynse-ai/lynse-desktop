/**
 * Structural types for the vendor NvEasy WebUSB SDK (`@nveasy/webusb`).
 *
 * The SDK ships as an obfuscated ESM bundle without a license, so it is NOT
 * vendored into this public repository. The bundle is loaded at runtime from
 * Lynse-hosted static storage (see nveasy-loader.ts) and cast to these local
 * interfaces — the declarations mirror the vendor `index.d.ts` (interface
 * definitions only, no vendor code). Keep them in sync when the SDK version
 * bumps.
 */

/** One recording on the card, as returned by `getFileList()`. */
export interface NvEasyDeviceFile {
  /** File index used for download. */
  sn: number;
  name: string;
  /** Bytes. */
  size: number;
  scene: number;
  /** Unix seconds, as reported by the device RTC. */
  startTime: number;
  endTime: number;
  crc: string;
  frameSize: number;
}

export interface NvEasyStorageInfo {
  freeSpace: number;
  totalSpace: number;
}

export interface NvEasyDeviceVersion {
  firmwareVersion: string;
  hardwareVersion: string;
}

export interface NvEasyDeviceInfo {
  name: string;
  vendorId: number;
  productId: number;
  serialNumber?: string;
  authenticated: boolean;
}

export interface NvEasyActionResult {
  result: number;
  detail: string[];
}

/** Error thrown by every SDK failure path; `partial` carries contiguous
 * bytes already received when a download is paused or interrupted. */
export interface NvEasyErrorShape extends Error {
  name: string;
  readonly partial?: Uint8Array;
}

/** The subset of `NvEasyClient` the management page actually drives. The
 * real instance is structurally assignable (its `connect` accepts an optional
 * pre-picked device, which this page never uses). */
export interface NvEasyClientLike {
  readonly isAuthenticated: boolean;
  connect(): Promise<NvEasyDeviceInfo>;
  disconnect(): Promise<void>;
  getFileList(): Promise<NvEasyDeviceFile[]>;
  getStorage(): Promise<NvEasyStorageInfo>;
  getVersion(): Promise<NvEasyDeviceVersion>;
  deleteFile(name: string): Promise<NvEasyActionResult>;
  downloadFile(
    file: NvEasyDeviceFile,
    onProgress?: (loaded: number, total: number) => void,
    offset?: number,
  ): Promise<Uint8Array>;
  /** Stop the in-flight transfer at the next protocol wait point. Used to
   * bound each download chunk's memory footprint. */
  pauseDownload(): void;
  /** Tell the device to stop sending and drop buffered packets. */
  stopTransfer(): Promise<void>;
  /** DeviceRTC sync (Unix seconds). */
  setTime(timestamp: number): Promise<{ result: number; timestamp: number }>;
}

export interface NvEasyClientOptionsLike {
  /** Firmware pairing password (8–64 chars, no `#`). */
  password: string;
  vendorId?: number;
  productId?: number;
  timeout?: number;
  debug?: boolean;
  onDisconnect?: () => void;
}

/** The `NvEasyClient` export of the runtime bundle. */
export interface NvEasyClientConstructor {
  prototype: object;
  new (options: NvEasyClientOptionsLike): NvEasyClientLike;
  isSupported(): boolean;
}

/** True when the current context can use WebUSB at all: Chromium-based
 * browser exposing `navigator.usb`, on a secure origin (https, or
 * localhost/127.0.0.1). Safari/WKWebView fail the first check. */
export function isWebUsbAvailable(): boolean {
  if (typeof window === "undefined") return false;
  if (!window.isSecureContext) return false;
  return typeof (navigator as { usb?: unknown }).usb !== "undefined";
}
