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

export type ScriptResponse =
  | StreamResponse
  | ClarifyResponse
  | ErrorResponse
  | AbortResponse
  | HttpErrorResponse;

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
