import type { LocalTranscriptionStatus } from "./types";

export function isLocalTranscriptionActive({
  status,
  retrying,
}: {
  status?: LocalTranscriptionStatus;
  retrying: boolean;
}): boolean {
  return (
    retrying ||
    status === "queued" ||
    status === "transcribing" ||
    status === "recording" ||
    status === "saving"
  );
}

/** Detail-panel pill labels for the in-flight / failed states. A completed
 *  transcription gets no pill — completion is evident from the content. A
 *  `recorded` (audio-only) record gets none either: there is nothing
 *  transcribing to report. */
export const LOCAL_STATUS_LABEL: Record<
  Exclude<LocalTranscriptionStatus, "completed" | "recorded">,
  string
> = {
  queued: "排队中",
  transcribing: "转写中",
  failed: "失败",
  recording: "录音中",
  saving: "保存中",
};
