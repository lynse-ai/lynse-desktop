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

/** Translation keys for the in-flight / failed states, rendered as a pill in the
 *  note's detail header and as the list row's spinner tooltip. A completed
 *  transcription gets no pill — completion is evident from the content. A
 *  `recorded` (audio-only) record gets none either: there is nothing
 *  transcribing to report.
 *
 *  Keys, not literals: these strings render in two components and had been
 *  hardcoded Chinese, so they never reached the other four locales. */
export const LOCAL_STATUS_LABEL_KEY: Record<
  Exclude<LocalTranscriptionStatus, "completed" | "recorded">,
  string
> = {
  queued: "workspace.local_status_queued",
  transcribing: "workspace.local_status_transcribing",
  failed: "workspace.local_status_failed",
  recording: "workspace.local_status_recording",
  saving: "workspace.local_status_saving",
};
