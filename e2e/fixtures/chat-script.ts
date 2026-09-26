/**
 * Structured chat script types.
 *
 * A script is a plain JSON file under e2e/scripts/ that anyone can edit.
 * Each turn = one user message plus a scripted assistant response. The mock
 * server replays the turns in order, per conversation (sessionId).
 *
 * The chat backend is the HTTP-poll API: the mock turns each scripted
 * response into a pending task on submit and returns the complete result
 * once its delay elapses. Chunk lists keep their shape from the streaming
 * days — `chunks.join("")` is the full answer text and `chunkDelayMs` only
 * scales how long the task stays `pending`.
 */

export interface ScriptSource {
  title: string;
  url?: string;
}

export interface StreamResponse {
  type: "stream";
  /** The complete answer text, split into chunks purely for legibility. */
  chunks: string[];
  /** Scales the pending time: chunks × chunkDelayMs (default 60). */
  chunkDelayMs?: number;
  /** Optional initial status tick (accepted, unused under poll). */
  status?: string;
  /** Optional knowledge-retrieval sources rendered as chips. */
  sources?: ScriptSource[];
}

export interface ClarifyResponse {
  type: "clarify";
  question: string;
  options: { label: string; value: string }[];
}

export interface ErrorResponse {
  type: "error";
  /** Business failure surfaced from the task's `error` field. */
  message: string;
}

export interface AbortResponse {
  /**
   * Stays `pending` for `holdOpenMs` and never finishes while the test is
   * watching — the client must hit Stop (cancel the poll) to move on.
   */
  type: "stream-abort";
  chunks: string[];
  chunkDelayMs?: number;
  /** How long the task stays pending before it would complete. */
  holdOpenMs?: number;
}

export interface HttpErrorResponse {
  /** Fails at the HTTP level on submit (non-2xx) instead of via a task. */
  type: "http-error";
  status: number;
  message: string;
}

/** One `attachments[]` entry in a scripted done payload (lynclaw shape). */
export interface MockAttachment {
  /** lynclaw artifact id (32 hex) — what the client re-signs expired links with. */
  artifact_id?: string;
  kind: "pdf" | "image" | "html" | "file" | string;
  filename: string;
  mime?: string;
  /**
   * Signed download URL. `{{mock}}` is rewritten to the running mock
   * server's origin, so `/mock-assets/*` points at bytes the browser
   * can actually load.
   */
  download_url: string;
  /**
   * Lazy-signing contract (CloudBase storage backend): the poll payload
   * ships `download_url: ""` and the client must mint the URL via
   * `POST /api/attachments/{artifact_id}/download-url`, which answers
   * with this `{{mock}}` URL.
   */
  mint_url?: string;
}

export interface AttachmentsResponse {
  /**
   * A reply that arrives as attachment cards — the visual-summary image and
   * the weekly-report PDF turns. Mirrors lynclaw: a pdf-only turn sends an
   * empty `text` and speaks through `attachments[]` alone.
   */
  type: "attachments";
  text: string;
  attachments: MockAttachment[];
  sources?: ScriptSource[];
}

export type ScriptResponse =
  | StreamResponse
  | ClarifyResponse
  | ErrorResponse
  | AbortResponse
  | HttpErrorResponse
  | AttachmentsResponse;

export interface ScriptTurn {
  /** Text typed into the composer. */
  user: string;
  /**
   * Optional: instead of typing, click the quick-prompt chip with this i18n key
   * (e.g. "chat.suggestion_summary"). The test harness resolves the label.
   */
  quickPrompt?: string;
  response: ScriptResponse;
}

export interface ChatScript {
  /** File name / test id. */
  name: string;
  /** Which spec suites replay this script: "multiturn" | "core" | "mentions" ... */
  suite: string;
  locale?: "en" | "zh";
  description: string;
  /** All turns are replayed in order. Multiturn scripts must have >= 5. */
  turns: ScriptTurn[];
}

export function isMultiturnEligible(script: ChatScript): boolean {
  return script.suite === "multiturn" && script.turns.length >= 5;
}
