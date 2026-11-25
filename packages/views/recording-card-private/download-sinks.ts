import { recordingCardDownloadName } from "./file-name";
import type { NvEasyDeviceFile } from "./nveasy-types";

/**
 * Download sinks for card recordings. Chromium (the only browser family with
 * WebUSB) ships the File System Access API, so downloads stream to disk via
 * `showSaveFilePicker` and stay out of memory; the Blob path is a defensive
 * fallback for environments where the picker is missing and only ever holds
 * one whole file.
 *
 * A sink is created ready-to-write (the save picker pops at creation time,
 * while the click's transient user activation is still valid).
 */

interface WritableStreamLike {
  write(data: BufferSource | Blob): Promise<void>;
  close(): Promise<void>;
}

interface SaveFileHandleLike {
  createWritable(options?: { keepExistingData?: boolean }): Promise<WritableStreamLike>;
}

type PickerWindow = Window & {
  showSaveFilePicker?: (options?: {
    suggestedName?: string;
  }) => Promise<SaveFileHandleLike>;
};

export interface RecordingCardDownloadSink {
  write(bytes: Uint8Array): Promise<void>;
  /** Finalize the download. `complete` false keeps the partial bytes on
   * disk (picker) or drops the offer (blob) — callers surface the error. */
  end(complete: boolean): Promise<void>;
}

export async function createRecordingCardDownloadSink(
  file: Pick<NvEasyDeviceFile, "name" | "startTime">,
  authorize: () => Promise<boolean>,
): Promise<RecordingCardDownloadSink | null> {
  const pickerWindow = window as PickerWindow;
  if (typeof pickerWindow.showSaveFilePicker === "function") {
    const handle = await pickerWindow.showSaveFilePicker({
      suggestedName: recordingCardDownloadName(file),
    });
    if (!await authorize()) return null;
    const writable = await handle.createWritable();
    let closed = false;
    return {
      async write(bytes) {
        // SDK bytes are Uint8Array<ArrayBufferLike>; the DOM write contract
        // wants an ArrayBuffer-backed view — always true for SDK payloads.
        await writable.write(bytes as unknown as BufferSource);
      },
      async end(complete) {
        if (closed) return;
        closed = true;
        // close() flushes. On an incomplete transfer the partial file stays
        // on disk under the chosen name; the manager surfaces the warning.
        void complete;
        await writable.close();
      },
    };
  }

  // Blob fallback: accumulate everything, then hand the browser one Blob.
  if (!await authorize()) return null;
  const chunks: BlobPart[] = [];
  return {
    async write(bytes) {
      chunks.push(bytes as unknown as BlobPart);
    },
    async end(complete) {
      if (!complete) return;
      const blob = new Blob(chunks, { type: "application/octet-stream" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = recordingCardDownloadName(file);
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    },
  };
}

/** True for the picker-cancel AbortError the save dialog throws when the
 * user backs out — treated as a quiet exit, not a failure. */
export function isUserCanceledDownload(err: unknown): boolean {
  return err instanceof DOMException && err.name === "AbortError";
}
