import { api } from "./client";

/** Structured live meeting notes (lynclaw /api/notes). Shapes mirror the
 *  server contract: every claim cites transcript line ids as evidence, and
 *  millisecond timestamps plus support counts are computed server-side —
 *  the model never emits times, so unknown ids never reach the client. */

export interface NotePoint {
  text: string;
  /** Transcript line ids backing this point (already validated server-side). */
  evidence: string[];
  /** First evidence line's start time in ms; null when lines carry no times. */
  t: number | null;
  /** Number of valid evidence lines; 0 renders as a weak claim in the UI. */
  support: number;
}

export interface NoteFishboneBranch {
  label: string;
  detail: string;
  evidence: string[];
  t: number | null;
  support: number;
}

export interface NoteFishbone {
  question: string;
  branches: NoteFishboneBranch[];
}

export interface NoteTopic {
  /** Transcript line id the topic starts at (server re-anchors to start_ms). */
  start_line_id: string;
  title: string;
  summary: string;
  start_ms: number | null;
  points: NotePoint[];
  /** Present only on topics discussing why something happened. */
  fishbone: NoteFishbone | null;
}

export interface NoteItem {
  text: string;
  owner: string | null;
  evidence: string[];
  t: number | null;
  support: number;
}

export interface NoteTerm {
  /** Correct spelling; deliberately keeps the transcript's original script. */
  name: string;
  note: string;
  /** Misrecognized forms seen in the transcript. */
  heard: string[];
}

export interface MeetingNotes {
  title: string;
  summary: string;
  topics: NoteTopic[];
  conclusions: NoteItem[];
  todos: NoteItem[];
  terms: NoteTerm[];
}

export interface NotesUpdateInput {
  /** NEW transcript lines since the last covered position (the caller may
   *  include a couple of overlap lines for continuity). Ids must be stable. */
  lines: Array<{
    id: string;
    text: string;
    start_ms?: number | null;
    end_ms?: number | null;
    speaker?: string | null;
  }>;
  /** The notes returned by the previous call; ignored by the server on the
   *  final pass (draft notes make long bilingual meetings drift language). */
  currentNotes?: MeetingNotes | null;
  /** true = final pass: regenerate from all lines, ignore currentNotes. */
  final?: boolean;
  language?: string;
}

export interface NotesUpdateResult {
  model: string | null;
  promptVersion: string;
  notes: MeetingNotes;
}

/** Raw agent-service payload (snake_case) before client-side normalization. */
interface NotesResponseRaw {
  model?: string | null;
  prompt_version?: string;
  notes?: unknown;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function asStringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map(asString).filter((item) => item.length > 0)
    : [];
}

function asTime(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? Math.round(value) : null;
}

function normalizePoints(raw: unknown): NotePoint[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((entry): entry is Record<string, unknown> => typeof entry === "object" && entry !== null)
    .map((entry) => ({
      text: asString(entry.text),
      evidence: asStringList(entry.evidence),
      t: asTime(entry.t),
      support: typeof entry.support === "number" ? entry.support : 0,
    }))
    .filter((point) => point.text.length > 0);
}

function normalizeFishbone(raw: unknown): NoteFishbone | null {
  if (typeof raw !== "object" || raw === null) return null;
  const entry = raw as Record<string, unknown>;
  const question = asString(entry.question);
  const branches = Array.isArray(entry.branches)
    ? entry.branches
        .filter((branch): branch is Record<string, unknown> => typeof branch === "object" && branch !== null)
        .map((branch) => ({
          label: asString(branch.label),
          detail: asString(branch.detail),
          evidence: asStringList(branch.evidence),
          t: asTime(branch.t),
          support: typeof branch.support === "number" ? branch.support : 0,
        }))
        .filter((branch) => branch.label.length > 0)
    : [];
  if (!question || branches.length === 0) return null;
  return { question, branches };
}

function normalizeItems(raw: unknown): NoteItem[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((entry): entry is Record<string, unknown> => typeof entry === "object" && entry !== null)
    .map((entry) => ({
      text: asString(entry.text),
      owner: asString(entry.owner) || null,
      evidence: asStringList(entry.evidence),
      t: asTime(entry.t),
      support: typeof entry.support === "number" ? entry.support : 0,
    }))
    .filter((item) => item.text.length > 0);
}

/** Lenient normalization: a server shape drift (or an older build reading a
 *  newer payload) must degrade to fewer entries, never throw in the UI. */
export function normalizeMeetingNotes(raw: unknown): MeetingNotes | null {
  if (typeof raw !== "object" || raw === null) return null;
  const entry = raw as Record<string, unknown>;
  const topics = Array.isArray(entry.topics)
    ? entry.topics
        .filter((topic): topic is Record<string, unknown> => typeof topic === "object" && topic !== null)
        .map((topic) => ({
          start_line_id: asString(topic.start_line_id),
          title: asString(topic.title),
          summary: asString(topic.summary),
          start_ms: asTime(topic.start_ms),
          points: normalizePoints(topic.points),
          fishbone: normalizeFishbone(topic.fishbone),
        }))
        .filter((topic) => topic.title.length > 0)
    : [];
  const terms = Array.isArray(entry.terms)
    ? entry.terms
        .filter((term): term is Record<string, unknown> => typeof term === "object" && term !== null)
        .map((term) => ({
          name: asString(term.name),
          note: asString(term.note),
          heard: asStringList(term.heard),
        }))
        .filter((term) => term.name.length > 0)
    : [];
  const notes: MeetingNotes = {
    title: asString(entry.title),
    summary: asString(entry.summary),
    topics,
    conclusions: normalizeItems(entry.conclusions),
    todos: normalizeItems(entry.todos),
    terms,
  };
  // An all-empty payload would wipe the client's current notes; callers treat
  // null as "keep the previous notes".
  if (!notes.title && !notes.summary && notes.topics.length === 0) return null;
  return notes;
}

/**
 * Incremental structured-notes update served by the agent service under the
 * current login token. Stateless on the server: the caller tracks which lines
 * are covered and merges the returned notes into its own state.
 */
export async function updateMeetingNotes(
  input: NotesUpdateInput,
  sessionToken: string,
  signal?: AbortSignal,
): Promise<NotesUpdateResult> {
  if (!input.lines.length) throw new Error("Transcript lines are empty");
  const client = api();
  const response = await client.post<NotesResponseRaw>(
    "/api/notes",
    {
      lines: input.lines,
      ...(input.currentNotes ? { current_notes: input.currentNotes } : {}),
      final: input.final === true,
      ...(input.language ? { language: input.language } : {}),
    },
    { baseUrl: client.getAgentBaseUrl() ?? client.getBaseUrl(), tokenOnly: true, sessionToken, signal },
  );
  const notes = normalizeMeetingNotes(response?.notes);
  if (!notes) throw new Error("Notes unavailable");
  return { model: response?.model ?? null, promptVersion: response?.prompt_version ?? "", notes };
}
