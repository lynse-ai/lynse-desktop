import { toast } from "sonner";
import { api, summarizeTranscript } from "@lynse/core/api";
import type { ApiClient, SummaryImageMark, SummaryTextMark } from "@lynse/core/api";
import { getDesktopLocalTranscriptionApi, localRecordToTranscription } from "./local-transcription";
import type { LocalTranscriptionUpdate } from "./local-transcription";
import type { FileDetail, LocalTranscriptionRecord } from "./types";
import {
  encodeLynclawSummary,
  formatSummaryRecordingTime,
  formatTimedSummaryTranscript,
  isPlaybackTime,
  LynclawSummaryError,
  MAX_SUMMARY_TRANSCRIPT_CHARS,
  MIN_SUMMARY_TRANSCRIPT_CHARS,
  readLynclawSummary,
  readSummaryMarks,
  summaryOutput,
  summaryTimeout,
  type LynclawSummaryFormat,
} from "./lynclaw-summary";

const CLOUD_MARK_TIMEOUT_MS = 8_000;

/** Tab id for the summary stored on the local record. */
export const LOCAL_SUMMARY_TAB_ID = "local-deep-summary";

/** A completion event can fire more than once for the same record. */
const inFlight = new Set<string>();
type Translate = (key: string, values?: Record<string, unknown>) => string;

/** Linked cloud files can hold photos or notes captured by another device. */
async function readLinkedRecordingMarks(
  fileId: string,
  client: ApiClient,
  baseUrl: string,
  sessionToken: string,
): Promise<{ text: SummaryTextMark[]; images: SummaryImageMark[] }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CLOUD_MARK_TIMEOUT_MS);
  const request = { baseUrl, sessionToken, tokenOnly: true, authScope: "assistant" as const, signal: controller.signal };
  try {
    const detail = await client.getWithParams<FileDetail>("/api/business/file/info", { fileId }, request);
    if (String(detail?.id) !== fileId) return { text: [], images: [] };
    return await readSummaryMarks(detail, client, request);
  } catch {
    return { text: [], images: [] };
  } finally {
    clearTimeout(timer);
  }
}

function getSummarySession() {
  const client = api();
  const sessionToken = client.getToken();
  const agentUrl = client.getAgentBaseUrl();
  const businessUrl = client.getBaseUrl();
  if (!sessionToken) throw new LynclawSummaryError("workspace.lynclaw_summary_login");
  if (!agentUrl) throw new LynclawSummaryError("workspace.lynclaw_summary_no_service");
  const isCurrent = () => api() === client && client.getToken() === sessionToken
    && client.getAgentBaseUrl() === agentUrl && client.getBaseUrl() === businessUrl;
  return { client, sessionToken, businessUrl, isCurrent };
}

async function summarizeLocalRecording(
  record: LocalTranscriptionRecord,
  transcript: string,
  format: LynclawSummaryFormat,
  session: ReturnType<typeof getSummarySession>,
) {
  const marks: SummaryTextMark[] = [];
  for (const marker of Array.isArray(record.markers) ? record.markers : []) {
    if (typeof marker?.note !== "string" || !marker.note.trim()) continue;
    marks.push({ timeoffset: isPlaybackTime(marker.startMs) ? marker.startMs : undefined, outline: marker.note.trim() });
  }
  const cloud = record.cloudFileId
    ? await readLinkedRecordingMarks(record.cloudFileId, session.client, session.businessUrl, session.sessionToken)
    : { text: [], images: [] };
  if (!session.isCurrent()) throw new LynclawSummaryError("workspace.lynclaw_summary_session_changed");

  marks.push(...cloud.text);
  const hasMarks = marks.length > 0 || cloud.images.length > 0;
  const rows = hasMarks && record.segments?.length
    ? (localRecordToTranscription(record).records ?? []).map((row) => ({
      text: row.text,
      translatedText: row.translatedText,
      speaker: row.speakerName,
      startMs: row.beginTime,
      endMs: row.endTime,
    }))
    : [];
  // A retry updates startedAt. The live record's creation time still refers to the recording itself.
  const recordingStart = record.liveSessionId ? record.createdAt : record.startedAt;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), summaryTimeout(format));
  try {
    const result = await summarizeTranscript({
      transcriptionText: formatTimedSummaryTranscript(rows, transcript),
      recordingTime: formatSummaryRecordingTime(recordingStart),
      recordingStartedAt: cloud.images.length ? recordingStart : undefined,
      recordMarkResults: marks,
      markImages: cloud.images,
      language: record.language || undefined,
      html: format === "html",
    }, session.sessionToken, controller.signal);
    if (!session.isCurrent()) throw new LynclawSummaryError("workspace.lynclaw_summary_session_changed");
    return result;
  } finally {
    clearTimeout(timer);
  }
}

export async function generateLocalLynclawSummary(fileId: string, format: LynclawSummaryFormat): Promise<string> {
  const session = getSummarySession();
  const record = await getDesktopLocalTranscriptionApi()?.get(fileId);
  const transcript = record?.transcriptText?.trim() ?? "";
  if (!record || record.id !== fileId || record.status !== "completed" || transcript.length < MIN_SUMMARY_TRANSCRIPT_CHARS) {
    throw new LynclawSummaryError("workspace.lynclaw_summary_needs_transcript");
  }
  if (transcript.length > MAX_SUMMARY_TRANSCRIPT_CHARS) {
    throw new LynclawSummaryError("workspace.lynclaw_summary_too_long");
  }
  if (!session.isCurrent()) throw new LynclawSummaryError("workspace.lynclaw_summary_session_changed");
  return summaryOutput(await summarizeLocalRecording(record, transcript, format, session), format);
}

/** Generate and save the recording's deep summary on completion or regeneration. */
export async function triggerLocalAutoSummary(
  update: Pick<LocalTranscriptionUpdate, "id" | "status" | "title">,
  options: { force?: boolean; t?: Translate } = {},
): Promise<boolean> {
  const t = options.t ?? ((key: string) => key);
  if (update.status !== "completed" || !update.id || inFlight.has(update.id)) return false;
  const localApi = getDesktopLocalTranscriptionApi();
  if (!localApi) return false;

  let session: ReturnType<typeof getSummarySession>;
  try {
    session = getSummarySession();
  } catch {
    return false;
  }

  inFlight.add(update.id);
  try {
    const record = await localApi.get(update.id);
    if (!record || record.status !== "completed" || !session.isCurrent()
      || (!options.force && record.summaryMarkdown)) return false;
    const transcript = record.transcriptText?.trim() ?? "";
    if (transcript.length < MIN_SUMMARY_TRANSCRIPT_CHARS || transcript.length > MAX_SUMMARY_TRANSCRIPT_CHARS) return false;

    const previous = readLynclawSummary(record.summaryMarkdown ?? "");
    const format = previous?.format ?? "markdown";
    const result = await summarizeLocalRecording(record, transcript, format, session);
    if (!session.isCurrent()) return false;
    const output = summaryOutput(result, format);
    await localApi.saveSummary(update.id, result.title, previous ? encodeLynclawSummary(format, output) : output);
    toast.success(t("workspace.local_summary_done"), { description: update.title });
    return true;
  } catch (error) {
    if (session.isCurrent()) {
      toast.error(t("workspace.local_summary_failed"), {
        description: error instanceof LynclawSummaryError ? t(error.message)
          : error instanceof Error ? error.message : String(error),
      });
    }
    return false;
  } finally {
    inFlight.delete(update.id);
  }
}
