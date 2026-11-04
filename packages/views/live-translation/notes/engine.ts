"use client";

import { useEffect, useMemo, useSyncExternalStore } from "react";
import {
  updateMeetingNotes,
  normalizeMeetingNotes,
  type MeetingNotes,
} from "@lynse/core/api";
import { api as coreApi } from "@lynse/core/api";
import { getDesktopLiveTranslationApi } from "../desktop-api";
import { getDesktopLocalTranscriptionApi } from "../../workspace/local-transcription";

/** Incremental structured-notes engine for a live recording session.

 * Mirrors the Cicada cadence: the first update fires as soon as there is
 * something to say (≥3 final lines), then every 45s while new lines exist
 * beyond `covered`. Each call sends the new lines plus two overlap lines and
 * the previous notes; the whole updated notes come back as JSON and are
 * checkpointed into the live session directory (crash safety). When the
 * session completes, one final pass regenerates from ALL lines — without
 * conditioning on the draft notes — and attaches the result to the record.
 *
 * Runs outside React (timers + event handlers); the hook subscribes via
 * useSyncExternalStore. Every failure keeps the previous notes and backs off. */

export type LiveNotesStatus = "idle" | "waiting" | "updating" | "error" | "finalizing" | "done";

export interface LiveNotesState {
  sessionId: string | null;
  notes: MeetingNotes | null;
  status: LiveNotesStatus;
  /** Topics present in `notes` but not in the previous revision — cleared 60s
   *  after they appeared, so the panel can badge them with "新". */
  freshTopicIds: string[];
  error: string | null;
  updatedAt: number | null;
}

const UPDATE_INTERVAL_MS = 45_000;
const FIRST_RUN_LINES = 3;
const OVERLAP_LINES = 2;
const ERROR_BACKOFF_MS = 15_000;
const FRESH_TTL_MS = 60_000;
const TICK_MS = 5_000;
const NOTES_TIMEOUT_MS = 150_000;
/** The final pass lands right after the `completed` event; the record is
 *  persisted before that event, but one retry papers over a close race. */
const FINAL_ATTACH_RETRIES = 2;

interface LineInput {
  id: string;
  text: string;
  startMs: number | null;
  speaker: string | null;
}

interface SessionEngine {
  sessionId: string;
  notes: MeetingNotes | null;
  /** Number of final lines already folded into `notes`. */
  covered: number;
  lastRunAt: number;
  /** Failed attempts also count as "run" for the interval gate, but with a
   *  shorter backoff so a transient server hiccup doesn't stall notes for 45s. */
  lastFailureAt: number;
  inFlight: boolean;
  pendingFinal: boolean;
  finalized: boolean;
  language: string;
  lines: LineInput[];
  freshSince: Map<string, number>;
  timer: ReturnType<typeof setInterval> | null;
  listeners: Set<() => void>;
  state: LiveNotesState;
}

const engines = new Map<string, SessionEngine>();

function topicKey(topic: { start_line_id: string; title: string }): string {
  return `${topic.start_line_id}::${topic.title}`;
}

function computeFresh(previous: MeetingNotes | null, next: MeetingNotes): Map<string, number> {
  const fresh = new Map<string, number>();
  const now = Date.now();
  const previousKeys = new Set((previous?.topics ?? []).map(topicKey));
  for (const topic of next.topics) {
    if (!previousKeys.has(topicKey(topic))) fresh.set(topicKey(topic), now);
  }
  return fresh;
}

function publish(engine: SessionEngine) {
  const freshTopicIds: string[] = [];
  const now = Date.now();
  for (const [key, since] of engine.freshSince) {
    if (now - since <= FRESH_TTL_MS) freshTopicIds.push(key);
    else engine.freshSince.delete(key);
  }
  engine.state = {
    sessionId: engine.sessionId,
    notes: engine.notes,
    status: engine.inFlight
      ? engine.pendingFinal
        ? "finalizing"
        : "updating"
      : engine.notes
        ? freshTopicIds.length > 0
          ? "updating"
          : "done"
        : engine.lastFailureAt > 0
          ? "error"
          : "waiting",
    freshTopicIds,
    error: engine.state.error,
    updatedAt: engine.state.updatedAt,
  };
  for (const listener of engine.listeners) listener();
}

function engineSnapshot(engine: SessionEngine | null): LiveNotesState {
  return (
    engine?.state ?? {
      sessionId: null,
      notes: null,
      status: "idle",
      freshTopicIds: [],
      error: null,
      updatedAt: null,
    }
  );
}

function notesSignal(): AbortSignal {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), NOTES_TIMEOUT_MS);
  controller.signal.addEventListener("abort", () => clearTimeout(timer), { once: true });
  return controller.signal;
}

async function sessionToken(): Promise<string | null> {
  try {
    if (!coreApi().getAgentBaseUrl()) return null;
    return coreApi().getToken();
  } catch {
    return null;
  }
}

async function runUpdate(engine: SessionEngine, final: boolean): Promise<void> {
  if (engine.inFlight) {
    if (final) engine.pendingFinal = true;
    return;
  }
  const token = await sessionToken();
  if (!token) return;
  const lines = final ? engine.lines : engine.lines.slice(Math.max(0, engine.covered - OVERLAP_LINES));
  if (lines.length === 0) return;
  engine.inFlight = true;
  if (final) engine.pendingFinal = true;
  engine.lastRunAt = Date.now();
  publish(engine);
  try {
    const result = await updateMeetingNotes(
      {
        lines: lines.map((line) => ({
          id: line.id,
          text: line.text,
          start_ms: line.startMs,
          speaker: line.speaker,
        })),
        currentNotes: final ? null : engine.notes,
        final,
        language: engine.language,
      },
      token,
      notesSignal(),
    );
    const previous = final ? null : engine.notes;
    engine.notes = result.notes;
    if (!final) engine.covered = engine.lines.length;
    engine.lastFailureAt = 0;
    engine.state.error = null;
    engine.state.updatedAt = Date.now();
    for (const [key, since] of computeFresh(previous, result.notes)) {
      engine.freshSince.set(key, since);
    }
    // Crash checkpoint: session-dir copy during the meeting, record attachment
    // for the final pass (the record exists only after persistence).
    if (final) {
      engine.pendingFinal = false;
      engine.finalized = true;
      await attachFinalNotes(engine.sessionId, result.notes);
      engine.state.status = "done";
    } else {
      const liveApi = getDesktopLiveTranslationApi();
      await liveApi?.saveNotes?.(engine.sessionId, result.notes).catch(() => undefined);
    }
  } catch (error) {
    engine.lastFailureAt = Date.now();
    engine.state.error = error instanceof Error ? error.message : String(error);
    // A failed/odd reply must never replace good notes: `engine.notes` is
    // untouched, the panel keeps rendering the previous revision.
  } finally {
    engine.inFlight = false;
    const pendingFinal = engine.pendingFinal;
    if (final) engine.pendingFinal = false;
    publish(engine);
    // A final request queued while an interim update was running goes out now.
    if (!final && pendingFinal) void runUpdate(engine, true);
  }
}

async function attachFinalNotes(sessionId: string, notes: MeetingNotes): Promise<void> {
  const localApi = getDesktopLocalTranscriptionApi();
  if (!localApi?.saveNotes) return;
  const recordId = `local:live:${sessionId}`;
  for (let attempt = 0; attempt <= FINAL_ATTACH_RETRIES; attempt += 1) {
    try {
      await localApi.saveNotes(recordId, notes);
      return;
    } catch {
      if (attempt === FINAL_ATTACH_RETRIES) return;
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
  }
}

function ensureEngine(sessionId: string): SessionEngine {
  let engine = engines.get(sessionId);
  if (engine) return engine;
  engine = {
    sessionId,
    notes: null,
    covered: 0,
    lastRunAt: 0,
    lastFailureAt: 0,
    inFlight: false,
    pendingFinal: false,
    finalized: false,
    language: "zh",
    lines: [],
    freshSince: new Map(),
    timer: null,
    listeners: new Set(),
    state: {
      sessionId,
      notes: null,
      status: "waiting",
      freshTopicIds: [],
      error: null,
      updatedAt: null,
    },
  };
  engines.set(sessionId, engine);
  engine.timer = setInterval(() => tick(engine!), TICK_MS);
  return engine;
}

function tick(engine: SessionEngine): void {
  if (engine.pendingFinal || engine.finalized || engine.inFlight) return;
  if (engine.lines.length < FIRST_RUN_LINES) return;
  const hasNewLines = engine.lines.length > engine.covered;
  if (!hasNewLines) return;
  const now = Date.now();
  const interval = engine.covered === 0 ? 0 : engine.lastFailureAt > 0 ? ERROR_BACKOFF_MS : UPDATE_INTERVAL_MS;
  const gate = engine.lastFailureAt > 0 ? Math.max(engine.lastRunAt, engine.lastFailureAt) : engine.lastRunAt;
  if (now - gate < interval) return;
  void runUpdate(engine, false);
}

/** Feed the current final lines into the engine; starts timers on first call. */
export function feedLiveNotes(sessionId: string, lines: LineInput[], language: string): void {
  const engine = ensureEngine(sessionId);
  engine.lines = lines;
  engine.language = language || "zh";
  // A session resuming after app restart rebuilds engines empty; don't resend
  // lines already folded into a restored notes payload (none restored today —
  // covered stays 0 and the first update rebuilds from the overlap window).
}

/** Trigger the final pass (idempotent; queued behind an in-flight update). */
export function finalizeLiveNotes(sessionId: string): void {
  const engine = engines.get(sessionId);
  if (!engine || engine.finalized) return;
  void runUpdate(engine, true);
}

/** Subscribe to one session's notes state. */
export function subscribeLiveNotes(sessionId: string, listener: () => void): () => void {
  const engine = ensureEngine(sessionId);
  engine.listeners.add(listener);
  return () => engine.listeners.delete(listener);
}

export function getLiveNotesSnapshot(sessionId: string | null): LiveNotesState {
  return engineSnapshot(sessionId ? engines.get(sessionId) ?? null : null);
}

/** Tear down one session's timers (page unmount / session switch). */
export function disposeLiveNotes(sessionId: string): void {
  const engine = engines.get(sessionId);
  if (!engine) return;
  if (engine.timer) clearInterval(engine.timer);
  engines.delete(sessionId);
}

/** Restore a notes payload saved by an earlier build/session (record view). */
export function parseStoredNotes(raw: unknown): MeetingNotes | null {
  return normalizeMeetingNotes(raw);
}

function toLineInputs(
  segments: Array<{
    id: string;
    recognizedText: string;
    startMs: number;
    speaker?: number | string | null;
    isFinal: boolean;
  }>,
): LineInput[] {
  return segments
    .filter((segment) => segment.isFinal && segment.recognizedText.trim().length > 0)
    .map((segment) => ({
      id: segment.id,
      text: segment.recognizedText.trim(),
      startMs: Number.isFinite(segment.startMs) ? Math.round(segment.startMs) : null,
      speaker: segment.speaker == null ? null : String(segment.speaker),
    }));
}

export type { LineInput };

export interface UseLiveNotesArgs {
  sessionId: string | null;
  /** Live segments (finals are extracted); pass the page's visible list. */
  segments: Array<{
    id: string;
    recognizedText: string;
    startMs: number;
    speaker?: number | string | null;
    isFinal: boolean;
  }>;
  language?: string;
  /** True while the recording session is live. */
  active: boolean;
}

/** React binding: feed final lines while active, expose the notes state. */
export function useLiveNotes(args: UseLiveNotesArgs): LiveNotesState {
  const { sessionId, segments, active, language } = args;
  const snapshot = useSyncExternalStore(
    sessionId ? (listener) => subscribeLiveNotes(sessionId, listener) : () => () => undefined,
    () => getLiveNotesSnapshot(sessionId),
    () => getLiveNotesSnapshot(sessionId),
  );
  const lines = useMemo(() => toLineInputs(segments), [segments]);
  const linesKey = lines.length;
  const lang = language ?? "zh";
  useEffect(() => {
    if (!sessionId || !active) return;
    feedLiveNotes(sessionId, lines, lang);
    // Refeed only when the line count changes; the engine only needs length
    // plus stable ids, and segments mutate on every interim update.
  }, [sessionId, active, linesKey, lang]); // eslint-disable-line react-hooks/exhaustive-deps
  return snapshot;
}
