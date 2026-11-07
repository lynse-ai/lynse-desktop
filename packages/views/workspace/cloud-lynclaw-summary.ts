import { api, summarizeTranscript } from "@lynse/core/api";
import { matchLocale } from "@lynse/core/i18n";
import { cloudTranscriptionToChapterSegments } from "./cloud-chapters";
import { fetchCloudFileTranscription, fetchFileDetail } from "./hooks/use-files";
import {
  formatSummaryRecordingTime,
  formatTimedSummaryTranscript,
  logLynclawSummaryFailure,
  LynclawSummaryError,
  MAX_SUMMARY_TRANSCRIPT_CHARS,
  MIN_SUMMARY_TRANSCRIPT_CHARS,
  readSummaryMarks,
  summaryOutput,
  summaryTimeout,
  type LynclawSummaryFormat,
} from "./lynclaw-summary";

function prepareCloudTranscript(payload: unknown): string {
  const data = payload as Record<string, unknown> | null | undefined;
  const plain = [payload, data?.content, data?.transcriptText, data?.text]
    .find((value): value is string => typeof value === "string" && !!value.trim())?.trim() ?? "";
  let rows = cloudTranscriptionToChapterSegments(payload);
  if (!rows.length && (plain.startsWith("[") || plain.startsWith("{"))) {
    try {
      rows = cloudTranscriptionToChapterSegments(JSON.parse(plain));
    } catch {
      // A plain transcript can start with a bracketed timecode.
    }
  }
  const spoken = rows.map((row) => row.text.trim()).filter(Boolean).join("\n");
  const text = spoken || plain;
  if (text.length < MIN_SUMMARY_TRANSCRIPT_CHARS) {
    throw new LynclawSummaryError("workspace.lynclaw_summary_needs_transcript");
  }
  if (text.length > MAX_SUMMARY_TRANSCRIPT_CHARS) {
    throw new LynclawSummaryError("workspace.lynclaw_summary_too_long");
  }
  return formatTimedSummaryTranscript(rows, text);
}

function recordingStartIso(value: unknown): string | undefined {
  if (typeof value === "number" && value >= 1_000_000_000_000) {
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
  }
  if (typeof value !== "string") return undefined;
  const text = value.trim().replace(" ", "T");
  // The business API uses GMT+8 for a recording timestamp without a zone.
  const fullTime = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?$/;
  const date = new Date(fullTime.test(text) ? `${text}+08:00` : text);
  return text.includes("T") && Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}

/** Summarize the selected cloud recording under the login that authorized its reads. */
export async function generateCloudLynclawSummary(
  fileId: string,
  format: LynclawSummaryFormat,
  language?: string,
): Promise<string> {
  const client = api();
  const agentUrl = client.getAgentBaseUrl();
  const sessionToken = client.getToken();
  if (!sessionToken) throw new LynclawSummaryError("workspace.lynclaw_summary_login");
  if (!agentUrl) throw new LynclawSummaryError("workspace.lynclaw_summary_no_service");
  const baseUrl = client.getBaseUrl();
  function assertSession() {
    if (api() !== client || client.getToken() !== sessionToken
      || client.getAgentBaseUrl() !== agentUrl || client.getBaseUrl() !== baseUrl) {
      throw new LynclawSummaryError("workspace.lynclaw_summary_session_changed");
    }
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), summaryTimeout(format));
  const request = { baseUrl, sessionToken, tokenOnly: true, authScope: "assistant" as const, signal: controller.signal };
  let stage = "read-cloud-recording";
  try {
    const [detail, transcript] = await Promise.all([
      fetchFileDetail(fileId, request),
      fetchCloudFileTranscription(fileId, request),
    ]);
    if (!detail || String(detail.id) !== fileId) {
      throw new LynclawSummaryError("chat.insert_target_missing");
    }
    if (transcript?.fileId != null && String(transcript.fileId) !== fileId) {
      throw new LynclawSummaryError("chat.insert_target_missing");
    }
    assertSession();
    stage = "prepare-transcript";
    const transcriptionText = prepareCloudTranscript(transcript);
    stage = "read-markers";
    const marks = await readSummaryMarks(detail, client, request);
    assertSession();
    const recordingStart = recordingStartIso(detail.recordStartTime);
    stage = "request-summary";
    const result = await summarizeTranscript({
      transcriptionText,
      recordingTime: formatSummaryRecordingTime(recordingStart ?? detail.createdAt),
      recordingStartedAt: recordingStart,
      recordMarkResults: marks.text,
      markImages: marks.images,
      language: matchLocale(language ?? "") ?? undefined,
      html: format === "html",
    }, sessionToken, controller.signal);

    assertSession();
    stage = "read-summary-response";
    return summaryOutput(result, format);
  } catch (error) {
    logLynclawSummaryFailure(stage, format, error);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
