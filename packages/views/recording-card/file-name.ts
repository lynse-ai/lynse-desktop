import type { RecordingCardFile } from "./transport";

type TimestampedFile = Pick<RecordingCardFile, "name" | "startTime">;

/**
 * Card files are named with random hex strings (`c84714.raw`), so show the
 * recording's RTC start time instead. Keep the device name as a fallback for
 * corrupt or unset timestamps.
 */
export function recordingCardDisplayName(file: TimestampedFile): string {
  return formatTimestamp(file.startTime) ?? file.name;
}

/** Suggested download name; the extension is preserved unless overridden. */
export function recordingCardDownloadName(
  file: TimestampedFile,
  extension?: string,
): string {
  const originalExtension = /\.[^./\\]+$/.exec(file.name)?.[0] ?? "";
  const originalBase = originalExtension
    ? file.name.slice(0, -originalExtension.length)
    : file.name;
  const base = formatTimestamp(file.startTime) ?? originalBase;
  const suffix = extension ? `.${extension.replace(/^\./, "")}` : originalExtension;
  return `${base}${suffix}`;
}

function formatTimestamp(unixSeconds: number): string | null {
  if (!Number.isFinite(unixSeconds) || unixSeconds <= 0) return null;
  const date = new Date(unixSeconds * 1000);
  if (Number.isNaN(date.getTime())) return null;
  const pad = (value: number) => String(value).padStart(2, "0");
  // Half-width colons are what the user sees on the card's clock display.
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** Recording length from the card's start/end timestamps, as HH:MM:SS or MM:SS. */
export function recordingCardDuration(
  file: Pick<RecordingCardFile, "startTime" | "endTime">,
): string | null {
  const { startTime, endTime } = file;
  if (
    !Number.isFinite(startTime) ||
    !Number.isFinite(endTime) ||
    startTime <= 0 ||
    endTime < startTime
  ) {
    return null;
  }
  const seconds = Math.floor(endTime - startTime);
  const pad = (value: number) => String(value).padStart(2, "0");
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  return hours > 0
    ? `${pad(hours)}:${pad(minutes)}:${pad(rest)}`
    : `${pad(minutes)}:${pad(rest)}`;
}

/**
 * Rough recordable time from the free space and the bitrate observed in the
 * card's own files. The firmware stores 40 ms Opus frames, so `frameSize`
 * gives a fallback bitrate before any recording exists. Bounds keep a corrupt
 * timestamp or frame size from producing a nonsensical estimate.
 */
export function recordingCardRecordableTime(
  freeBytes: number,
  files: ReadonlyArray<Pick<RecordingCardFile, "size" | "startTime" | "endTime" | "frameSize">>,
): { hours: number; minutes: number } | null {
  if (!Number.isFinite(freeBytes) || freeBytes <= 0) return null;

  let totalBytes = 0;
  let totalSeconds = 0;
  for (const file of files) {
    const seconds = file.endTime - file.startTime;
    if (file.size > 0 && Number.isFinite(seconds) && seconds > 0) {
      totalBytes += file.size;
      totalSeconds += seconds;
    }
  }

  const fallbackBytesPerSecond = files[0]?.frameSize
    ? files[0].frameSize * 25
    : 2000;
  const observed = totalSeconds > 0 ? totalBytes / totalSeconds : fallbackBytesPerSecond;
  const bytesPerSecond = Math.min(20_000, Math.max(200, observed || fallbackBytesPerSecond));
  const minutes = Math.floor(freeBytes / bytesPerSecond / 60);
  return { hours: Math.floor(minutes / 60), minutes: minutes % 60 };
}
