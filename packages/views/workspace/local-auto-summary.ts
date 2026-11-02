import { toast } from "sonner";
import { api, summarizeTranscript } from "@lynse/core/api";
import { getDesktopLocalTranscriptionApi } from "./local-transcription";
import type { LocalTranscriptionUpdate } from "./local-transcription";

// Server-side limits mirrored from lynclaw runtime/http_summarize.py —
// shorter transcripts are rejected as "too short", longer ones as "too long".
const MIN_TRANSCRIPT_CHARS = 100;
const MAX_TRANSCRIPT_CHARS = 500_000;
// The server allows 300s per generation; give the transport a little slack.
const SUMMARY_TIMEOUT_MS = 330_000;

/** Tab id under which the local deep summary renders in the detail panel —
 *  edits and deletes on this id are routed to the record store, not the
 *  cloud conclusion endpoints. */
export const LOCAL_SUMMARY_TAB_ID = "local-deep-summary";

/** Records with a generation already running — the completion event can fire
 *  several times (list refreshes, per-track retries) and must not stack jobs. */
const inFlight = new Set<string>();

/** Translator shaped like useTranslation's t — passed in because this module
 *  runs outside React (event handlers, mutation callbacks). */
type Translate = (key: string, values?: Record<string, unknown>) => string;

/** "2026-11-02T02:30:01.989Z" → "202611021030" (local wall clock, GMT+8) —
 *  the agent service's recording_time stamp that anchors relative dates. */
function formatRecordingTime(startedAt: string | undefined): string | undefined {
  if (!startedAt) return undefined;
  const date = new Date(startedAt);
  if (Number.isNaN(date.getTime())) return undefined;
  const pad = (value: number) => String(value).padStart(2, "0");
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `${pad(date.getHours())}${pad(date.getMinutes())}`
  );
}

/** AbortController + timer: AbortSignal.timeout is missing on older
 *  WebViews, and a hung generation must not pin the record forever. */
function summarySignal(): AbortSignal {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SUMMARY_TIMEOUT_MS);
  controller.signal.addEventListener("abort", () => clearTimeout(timer), { once: true });
  return controller.signal;
}

/**
 * After a local transcription completes, generate its deep summary through
 * the agent service (lynclaw meeting-pipeline) and store it on the record.
 *
 * Silent skips (no agent endpoint, logged out, transcript missing/too short)
 * are by design: this runs unattended in the background and must not nag.
 * Failures after a real attempt toast once; the detail page's 重新总结
 * button re-runs the generation on demand ({ force: true } to overwrite).
 *
 * Resolves true when a summary was generated and stored.
 */
export async function triggerLocalAutoSummary(
  update: Pick<LocalTranscriptionUpdate, "id" | "status" | "title">,
  options: { force?: boolean; t?: Translate } = {},
): Promise<boolean> {
  const t = options.t ?? ((key: string) => key);
  if (update.status !== "completed" || !update.id) return false;
  if (inFlight.has(update.id)) return false;

  const localApi = getDesktopLocalTranscriptionApi();
  if (!localApi) return false;
  const client = api();
  // The summarize endpoint lives on the agent service only — without an
  // agent endpoint the business base would just 404.
  if (!client.getAgentBaseUrl()) return false;
  const sessionToken = client.getToken();
  if (!sessionToken) return false;

  inFlight.add(update.id);
  try {
    const record = await localApi.get(update.id);
    if (!record) return false;
    const transcript = (record.transcriptText ?? "").trim();
    if (!options.force && record.summaryMarkdown) return false;
    if (transcript.length < MIN_TRANSCRIPT_CHARS || transcript.length > MAX_TRANSCRIPT_CHARS) return false;

    const result = await summarizeTranscript(
      {
        transcriptionText: transcript,
        recordingTime: formatRecordingTime(record.startedAt),
        language: record.language || undefined,
      },
      sessionToken,
      summarySignal(),
    );
    await localApi.saveSummary(update.id, result.title, result.content);
    toast.success(t("workspace.local_summary_done"), { description: update.title });
    return true;
  } catch (error) {
    toast.error(t("workspace.local_summary_failed"), {
      description: `${update.title}：${error instanceof Error ? error.message : String(error)}`,
    });
    return false;
  } finally {
    inFlight.delete(update.id);
  }
}
