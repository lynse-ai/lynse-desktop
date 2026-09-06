import type {
  DesktopRecordingCardApi,
} from "./types";

export function getRecordingCardApi(): DesktopRecordingCardApi | null {
  return (window as unknown as {
    desktopAPI?: { recordingCard?: DesktopRecordingCardApi };
  }).desktopAPI?.recordingCard ?? null;
}
