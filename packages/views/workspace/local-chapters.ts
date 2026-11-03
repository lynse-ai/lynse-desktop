import { toast } from "sonner";
import { api, generateChapters } from "@lynse/core/api";
import { getDesktopLocalTranscriptionApi, localRecordToTranscription } from "./local-transcription";
import {
  buildChapterDocument,
  buildUtterances,
  computeTranscriptHash,
  hasManualEdits,
} from "./semantic-chapters";
import type { ChapterSegment } from "./semantic-chapters";
import type { LocalTranscriptionRecord } from "./types";

// Mirrors local-auto-summary: the completion event can fire several times
// (list refreshes, per-track retries) and must not stack chapter jobs.
const inFlight = new Set<string>();

// The chapters engine runs two model passes for long transcripts; give the
// transport more slack than a single-turn call needs (server allows 300s).
const CHAPTERS_TIMEOUT_MS = 330_000;

/** Translator shaped like useTranslation's t — passed in because this module
 *  runs outside React (event handlers, mutation callbacks). */
type Translate = (key: string, values?: Record<string, unknown>) => string;

/** AbortController + timer: AbortSignal.timeout is missing on older WebViews,
 *  and a hung generation must not pin the record forever. */
function chaptersSignal(): AbortSignal {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CHAPTERS_TIMEOUT_MS);
  controller.signal.addEventListener("abort", () => clearTimeout(timer), { once: true });
  return controller.signal;
}

/** "2026-11-02T02:30:01.989Z" → "202611021030" (local wall clock, GMT+8) —
 *  mirrors local-auto-summary's stamp that anchors relative dates. */
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

function prereqFailure(): string | null {
  const client = api();
  // The chapters endpoint lives on the agent service only — without an
  // agent endpoint the business base would just 404.
  if (!client.getAgentBaseUrl()) return "chapters.no_agent";
  if (!client.getToken()) return "chapters.logged_out";
  return null;
}

async function saveChaptersState(
  id: string,
  document: LocalTranscriptionRecord["chaptersDocument"],
  status: "idle" | "generating" | "ready" | "error" | "stale",
  error?: string | null,
): Promise<void> {
  const localApi = getDesktopLocalTranscriptionApi();
  if (!localApi) return;
  await localApi.saveChapters(id, document ?? null, status, error ?? null);
}

/**
 * Generate semantic chapters for one local record and store them.
 *
 * - `silent` (auto path after transcription): every skip is quiet by design —
 *   this runs unattended and must not nag. Failures after a real attempt
 *   toast once.
 * - Manual regeneration with existing manual edits is allowed only through
 *   the explicit `force` flag (the UI confirms with the user first).
 *
 * Resolves the stored document, or null when skipped/failed.
 */
export async function runChapterGeneration(
  recordId: string,
  options: { force?: boolean; silent?: boolean; t?: Translate } = {},
): Promise<LocalTranscriptionRecord["chaptersDocument"]> {
  const t = options.t ?? ((key: string) => key);
  const silent = options.silent ?? false;
  if (inFlight.has(recordId)) return null;

  const localApi = getDesktopLocalTranscriptionApi();
  if (!localApi) return null;

  inFlight.add(recordId);
  try {
    // Prereqs live inside the guard so an uninitialized API client (tests,
    // odd embed contexts) degrades to a quiet skip instead of an unhandled
    // rejection from an "unattended" background task.
    const prereq = prereqFailure();
    if (prereq) {
      if (!silent) toast.error(t("workspace.chapters_failed"), { description: t(prereq) });
      return null;
    }
    const sessionToken = api().getToken();
    if (!sessionToken) return null;
    const record = await localApi.get(recordId);
    if (!record) return null;
    // Canonical segments come from the same view mapping the detail panel
    // renders, so the panel's staleness hash matches this one exactly.
    const segments: ChapterSegment[] = (localRecordToTranscription(record).records ?? []).map((row) => ({
      id: row.id,
      text: row.text,
      startMs: row.beginTime,
      endMs: row.endTime,
      speaker: row.speakerName ?? null,
    }));
    const transcriptHash = await computeTranscriptHash(segments);
    const existing = record.chaptersDocument;

    // Same-hash document already stored (or a generation is mid-flight on the
    // record itself): nothing to do unless the user forced a regeneration.
    if (!options.force && existing && existing.transcriptHash === transcriptHash) return existing;

    // The transcript moved on: honor manual edits — only mark stale, never
    // silently overwrite user-authored titles/summaries.
    if (!options.force && existing && hasManualEdits(existing)) {
      if (!silent) {
        toast.info(t("workspace.chapters_stale_kept"), { description: record.title });
      }
      await saveChaptersState(recordId, existing, "stale", null);
      return null;
    }

    let utterances;
    try {
      utterances = buildUtterances(segments);
    } catch (error) {
      const message = error instanceof Error ? error.message : "chapters.invalid";
      // Out-of-bounds transcripts are a property of the recording, not a
      // failure worth a toast on the auto path — an idle state is honest.
      if (!silent) toast.error(t("workspace.chapters_failed"), { description: t(message) });
      await saveChaptersState(recordId, null, "idle", t(message));
      return null;
    }

    await saveChaptersState(recordId, null, "generating", null);
    const result = await generateChapters(
      {
        utterances,
        language: record.language || undefined,
        recordingTime: formatRecordingTime(record.startedAt),
      },
      sessionToken,
      chaptersSignal(),
    );
    const document = buildChapterDocument(result, segments, transcriptHash);
    await saveChaptersState(recordId, document, "ready", null);
    if (!silent) toast.success(t("workspace.chapters_done"), { description: record.title });
    return document;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    await saveChaptersState(recordId, null, "error", detail).catch(() => {});
    // A stale auth token (or an endpoint that predates this feature) 401/404s
    // here; the manual retry path re-checks the same prereqs.
    if (!silent) {
      toast.error(t("workspace.chapters_failed"), { description: detail });
    }
    return null;
  } finally {
    inFlight.delete(recordId);
  }
}

/**
 * Auto trigger after a local transcription completes — the chapters twin of
 * triggerLocalAutoSummary, kept independent so one task failing never blocks
 * the other. Silent skips are deliberate (see runChapterGeneration).
 *
 * Resolves true when a document was generated and stored.
 */
export async function triggerLocalAutoChapters(
  update: Pick<LocalTranscriptionRecord, "id" | "status" | "title">,
  options: { t?: Translate } = {},
): Promise<boolean> {
  if (update.status !== "completed" || !update.id) return false;
  const document = await runChapterGeneration(update.id, { silent: true, t: options.t });
  return document !== null;
}

/**
 * Persist a user edit (title/summary) onto the stored document. Regeneration
 * later detects `manuallyEdited` and asks before overwriting.
 */
export async function saveChapterEdits(
  recordId: string,
  document: LocalTranscriptionRecord["chaptersDocument"],
  options: { t?: Translate } = {},
): Promise<boolean> {
  const t = options.t ?? ((key: string) => key);
  const localApi = getDesktopLocalTranscriptionApi();
  if (!localApi || !document) return false;
  try {
    await localApi.saveChapters(recordId, document, "ready", null);
    return true;
  } catch (error) {
    toast.error(t("workspace.chapters_edit_failed"), {
      description: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}
