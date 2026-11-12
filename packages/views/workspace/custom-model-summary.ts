/**
 * Fully off-cloud summary for LOCAL recordings: the user's own template
 * (prompt) plus their own custom model, called directly from the desktop —
 * no transcript, prompt, or result ever touches Lynse servers. The outcome
 * is stored on the local record like the other local summaries.
 */

import {
  getDesktopLocalTranscriptionApi,
  localRecordToTranscription,
} from "./local-transcription";
import type { LocalTranscriptionRecord } from "./types";
import {
  formatSummaryRecordingTime,
  formatTimedSummaryTranscript,
  isPlaybackTime,
  MAX_SUMMARY_TRANSCRIPT_CHARS,
  MIN_SUMMARY_TRANSCRIPT_CHARS,
} from "./lynclaw-summary";
import { getCustomModelsApi, getCustomModel, toCompletionBase } from "../custom-models";
import { customModelConnectionErrorKey } from "../custom-models/connection-errors";

export interface CustomModelSummaryOptions {
  profileId: string;
  /** The user's template — sent verbatim as the system message. */
  prompt: string;
  /** Fallback title when the model returns no heading. */
  templateName: string;
}

/** First markdown heading of the output, else the template's own name. */
function extractTitle(markdown: string, fallback: string): string {
  const heading = markdown.split("\n").find((line) => line.startsWith("# "));
  const title = heading?.replace(/^#\s+/, "").trim();
  return title || fallback;
}

function formatMarkTime(ms: number): string {
  const total = Math.floor(ms / 1000);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(Math.floor(total / 3600))}:${pad(Math.floor((total % 3600) / 60))}:${pad(total % 60)}`;
}

function buildTranscript(record: LocalTranscriptionRecord): string {
  const transcript = record.transcriptText?.trim() ?? "";
  const marks: { timeoffset?: number; outline: string }[] = [];
  for (const marker of Array.isArray(record.markers) ? record.markers : []) {
    if (typeof marker?.note !== "string" || !marker.note.trim()) continue;
    marks.push({
      timeoffset: isPlaybackTime(marker.startMs) ? marker.startMs : undefined,
      outline: marker.note.trim(),
    });
  }
  const rows = (marks.length && record.segments?.length
    ? (localRecordToTranscription(record).records ?? []).map((row) => ({
      text: row.text,
      translatedText: row.translatedText,
      speaker: row.speakerName,
      startMs: row.beginTime,
      endMs: row.endTime,
    }))
    : []);
  // A retry updates startedAt. The live record's creation time still refers to the recording itself.
  const recordingStart = record.liveSessionId ? record.createdAt : record.startedAt;
  const recordingTime = formatSummaryRecordingTime(recordingStart);
  const body = formatTimedSummaryTranscript(rows, transcript);
  // The user's own highlights travel with the transcript so the template can
  // lean on them, mirroring the marks the cloud summarizer receives.
  const highlights = marks
    .map((mark) => `- ${mark.timeoffset !== undefined ? `[${formatMarkTime(mark.timeoffset)}] ` : ""}${mark.outline}`)
    .join("\n");
  return (recordingTime ? `Recording date: ${recordingTime}\n\n` : "") + body
    + (highlights ? `\n\nMarked moments:\n${highlights}` : "");
}

/**
 * Generate the summary with the user's own model and store it on the local
 * record (it renders as the recording's local summary tab). Returns the
 * saved markdown.
 */
export async function generateCustomModelSummary(
  fileId: string,
  options: CustomModelSummaryOptions,
): Promise<string> {
  const bridge = getCustomModelsApi();
  if (!bridge) throw new Error("customModels.summary_failed");
  const profile = getCustomModel(options.profileId);
  if (!profile) throw new Error("customModels.summary_no_profile");

  const localApi = getDesktopLocalTranscriptionApi();
  const record = await localApi?.get(fileId);
  const transcript = record?.transcriptText?.trim() ?? "";
  if (!record || record.id !== fileId || record.status !== "completed" || transcript.length < MIN_SUMMARY_TRANSCRIPT_CHARS) {
    throw new Error("customModels.summary_needs_transcript");
  }
  if (transcript.length > MAX_SUMMARY_TRANSCRIPT_CHARS) {
    throw new Error("customModels.summary_too_long");
  }

  const transcriptBlock = buildTranscript(record);
  const output = await bridge.complete({
    ...toCompletionBase(profile),
    messages: [
      { role: "system", content: options.prompt },
      { role: "user", content: transcriptBlock },
    ],
    maxTokens: 8000,
    temperature: 0.3,
  }).catch((error: unknown) => {
    throw new Error(customModelConnectionErrorKey(error));
  });
  const markdown = output.trim();
  if (!markdown) throw new Error("customModels.summary_empty");
  await localApi?.saveSummary(fileId, extractTitle(markdown, options.templateName), markdown);
  return markdown;
}
