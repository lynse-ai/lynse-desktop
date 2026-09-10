import type {
  ChatProvider,
  ChatStreamEvent,
  ChatConfirm,
  ChatConfirmOption,
  ChatAttachment,
  ChatHumanSupportLink,
} from "./types";
import { api, ApiError } from "@lynse/core/api";

export interface SendChatOptions {
  query: string;
  sessionId: string;
  userId: string;
  fileIds: string[];
  userSpecifiedFile: boolean;
  token?: string | null;
  /** `confirmation.confirmToken` of the card this turn answers, if any. */
  confirmToken?: string | null;
  onEvent: (event: ChatStreamEvent) => void;
  signal?: AbortSignal;
}

/**
 * A chat backend. Implementations forward a single user turn and emit typed
 * ChatStreamEvents through `onEvent`. `cancel()` stops the turn and (where
 * supported) aborts the upstream model request.
 */
export interface ChatTransport {
  readonly provider: ChatProvider;
  send(opts: SendChatOptions): Promise<void>;
  cancel(): void;
}

/**
 * The lynclaw agent service exposes `POST /api/chat/poll` plus
 * `GET /api/chat/poll/{task_id}` (submit, then short-poll until the full
 * answer is ready — no SSE). The Lynse gateway fronts that service under
 * `/api/business/ai`, the same prefix the old stream endpoint used.
 */
const CHAT_POLL_PATH = "/api/business/ai/chat/poll";

/** Native lynclaw HTTP API path (no gateway prefix). */
const DIRECT_CHAT_POLL_PATH = "/api/chat/poll";

/**
 * Optional direct-lynclaw base URL (e.g. `http://host:8003`). When set, chat
 * bypasses the Java gateway's `/api/business/ai` routes and talks to the
 * lynclaw HTTP API with its native snake_case contract (JWT in the body,
 * raw JSON responses, `{detail}` errors). Desktop builds set this from
 * `VITE_AI_BASE_URL`; unset keeps the historical gateway routing.
 */
let chatDirectBaseUrl: string | null = null;

export function setChatDirectBaseUrl(url: string | null | undefined): void {
  const trimmed = url?.trim();
  chatDirectBaseUrl = trimmed ? trimmed.replace(/\/+$/, "") : null;
}

const chatPollTaskPath = (taskId: string) =>
  `${chatDirectBaseUrl ? DIRECT_CHAT_POLL_PATH : CHAT_POLL_PATH}/${encodeURIComponent(taskId)}`;

/**
 * Raw JSON request against the direct lynclaw base. Non-2xx responses become
 * `ApiError`s carrying the raw body so the shared submit/poll error handling
 * (busy retry on 503/429, `{detail}` extraction) applies unchanged.
 */
async function directJsonRequest<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const text = await res.text().catch(() => "");
  if (!res.ok) throw new ApiError(res.status, text || res.statusText);
  if (!text) return undefined as T;
  return JSON.parse(text) as T;
}

/**
 * Poll timing, readable at send-time so tests can shrink the waits. The
 * standard advises a 500–1000ms interval (never below 200ms) and an overall
 * wait above the server's turn timeout (180s by default) plus headroom.
 */
export const chatPollTiming = {
  intervalMs: 800,
  deadlineMs: 190_000,
  maxNetworkFailures: 5,
  maxSubmitRetries: 2,
  submitRetryDelayMs: 2_000,
  /** Gap between typewriter slices replayed over the finished answer. */
  typewriterTickMs: 24,
  /** Cap on the whole typewriter playback so long answers don't crawl. */
  typewriterMaxMs: 4_800,
  /** Elapsed-turn thresholds (ms) that advance the pending stage caption. */
  pendingStageMs: [0, 6_000, 15_000],
};

interface ChatPollSubmitResponse {
  /** lynclaw replies `task_id`; a Java-gateway DTO may camel-case it to `taskId`. */
  task_id?: string;
  taskId?: string;
  status?: string;
  session_id?: string;
  user_id?: string;
}

interface ChatPollTaskResponse {
  status?: "pending" | "done" | "error" | string;
  text?: string | null;
  sources?: unknown;
  attachments?: unknown;
  human_support_link?: unknown;
  humanSupportLink?: unknown;
  confirmation?: unknown;
  error?: string | null;
}

const firstString = (...values: unknown[]): string | null => {
  for (const value of values) {
    if (typeof value === "string" && value) return value;
  }
  return null;
};

/** Normalize a `done.attachments[]` entry into the UI's ChatAttachment. */
export function normalizePollAttachment(raw: unknown): ChatAttachment | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const url = firstString(r.download_url, r.downloadUrl, r.url);
  const name = firstString(r.filename, r.name);
  if (!url && !name) return null;
  return {
    id: firstString(r.id, r.artifact_id, r.artifactId) ?? undefined,
    name: name ?? undefined,
    type: firstString(r.kind, r.type) ?? undefined,
    url: url ?? undefined,
    downloadUrl: url ?? undefined,
  };
}

/** Normalize `human_support_link` into a displayable link (null when absent). */
export function normalizeHumanSupportLink(raw: unknown): ChatHumanSupportLink | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  const url = firstString(r.url, r.download_url, r.downloadUrl);
  if (!url) return undefined;
  return { url, label: firstString(r.label, r.title) ?? undefined };
}

/**
 * Validate / normalize a poll `confirmation` card into a ChatConfirm the
 * ConfirmDialog can render. The cloud card shape is
 * `{type,kind,title,confirmToken,riskLevel,actions[]}` where each action
 * carries the `value` sent back as the next query; the legacy a2UI shape
 * (`{question,options[{label,value}]}`) is accepted too. Returns null when
 * there is nothing usable to show.
 */
export function normalizePollConfirmation(raw: unknown): ChatConfirm | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const question = firstString(r.title, r.question)?.trim() ?? "";
  const actionsRaw = Array.isArray(r.actions) ? r.actions : Array.isArray(r.options) ? r.options : [];
  const options: ChatConfirmOption[] = [];
  for (const o of actionsRaw) {
    if (!o || typeof o !== "object") continue;
    const or = o as Record<string, unknown>;
    const value = firstString(or.value, or.action, or.id) ?? "";
    const label = firstString(or.label, or.text, or.title) ?? "";
    if (!value && !label) continue;
    options.push({ label: label || value, value: value || label });
  }
  if (!question && options.length === 0) return null;
  return {
    question,
    options,
    kind: firstString(r.kind) ?? undefined,
    confirmToken: firstString(r.confirmToken, r.confirm_token) ?? undefined,
    riskLevel: firstString(r.riskLevel, r.risk_level) ?? undefined,
  };
}

const CIRCLED: Record<string, string> = {
  "①": "1", "②": "2", "③": "3", "④": "4", "⑤": "5",
  "⑥": "6", "⑦": "7", "⑧": "8", "⑨": "9",
};

/**
 * Heuristic detector: when the assistant replies with a choice menu like
 *
 *   A) 重启设备
 *   B) 暂不处理
 *   C) 咨询人工
 *
 * synthesize a ChatConfirm so the UI can pop a clickable dialog instead of
 * forcing the user to type "A/B/C". Works on the finished assistant text.
 *
 * Returns null when no clean, sequential option list (A,B,C… or 1,2,3…) is found.
 */
export function extractConfirmFromText(text: string): ChatConfirm | null {
  if (!text || text.length < 6) return null;
  const OPTION_RE =
    /^\s*(?:(?:[\(（]([A-Za-z0-9])[\)）])|(?:[\[【]([A-Za-z0-9])[\]】])|([①②③④⑤⑥⑦⑧⑨])|([A-Za-z])|([0-9]{1,2}))[.、)）、．。:]?\s*(.+?)\s*$/;

  const options: { key: string; text: string }[] = [];
  const questionLines: string[] = [];
  let seenOptions = false;

  for (const line of text.split(/\r?\n/)) {
    const m = OPTION_RE.exec(line);
    if (m) {
      const circled = m[3];
      const key = circled
        ? CIRCLED[circled] ?? circled
        : (m[1] || m[2] || m[4] || m[5] || "").toString();
      const content = (m[6] || "").trim();
      if (content) {
        options.push({ key: key.toUpperCase(), text: content });
        seenOptions = true;
      }
    } else if (!seenOptions) {
      questionLines.push(line);
    }
  }

  if (options.length < 2 || options.length > 8) return null;

  const first = options[0]!;
  const isLetter = /^[A-Z]$/.test(first.key);
  const expectedKey = (i: number) =>
    isLetter ? String.fromCharCode(65 + i) : String(i + 1);
  // Require the detected keys to be sequential (A,B,C… or 1,2,3…) so that
  // ordinary bullet lists don't get mistaken for a confirmation menu.
  const sequential = options.every((o, i) => o.key === expectedKey(i));
  if (!sequential) return null;

  const question = questionLines.join(" ").replace(/\s+/g, " ").trim();
  return {
    question,
    options: options.map((o) => {
      const label = `${isLetter ? o.key : o.key + "."} ${o.text}`;
      return { label, value: o.text };
    }),
  };
}

/** Pull a readable message out of an error body: FastAPI `{"detail": ...}`,
 *  Lynse-gateway `{code, msg, data}` envelopes, or the raw text. */
function detailText(error: unknown): string | null {
  if (error instanceof ApiError) {
    try {
      const parsed = JSON.parse(error.message);
      if (parsed && typeof parsed === "object") {
        if (typeof parsed.detail === "string" && parsed.detail) return parsed.detail;
        if (typeof parsed.msg === "string" && parsed.msg) return parsed.msg;
      }
    } catch {
      /* body was not JSON — fall through to the raw message */
    }
    return error.message || null;
  }
  if (error instanceof Error && error.message) return error.message;
  return null;
}

/**
 * The gateway reports some failures as raw i18n keys instead of copy (the
 * busy signal arrives as `system.error.busy`). Map the known ones to readable
 * text, and never show a bare dotted key to the user.
 */
const BACKEND_ERROR_TEXT: Record<string, string> = {
  "system.error.busy": "当前使用人数较多，请稍后再试",
};

function humanizeBackendError(message: string | null | undefined): string | null {
  if (!message) return null;
  const key = message.trim().toLowerCase();
  const mapped = BACKEND_ERROR_TEXT[key];
  if (mapped) return mapped;
  // A dotted lowercase key with no spaces is a server code, not user copy.
  if (/^[a-z0-9_-]+(\.[a-z0-9_-]+)+$/.test(key)) return "生成失败，请稍后重试";
  return message;
}

const BUSY_ERROR_KEY = "system.error.busy";

/** True when a submit failure means "server busy" and is worth retrying. */
function isBusySubmitError(error: unknown): boolean {
  if (!(error instanceof ApiError)) return false;
  if (error.status === 503 || error.status === 429) return true;
  const detail = detailText(error);
  return !!detail && detail.trim().toLowerCase() === BUSY_ERROR_KEY;
}

function submitErrorMessage(error: unknown): string {
  const detail = humanizeBackendError(detailText(error));
  const status = error instanceof ApiError ? error.status : undefined;
  if (status === 400) return detail || "登录状态已失效，请重新登录后再试";
  if (status === 401 || status === 403) return detail || "身份验证未通过，请重新登录";
  if (status === 503 || status === 429) return "当前使用人数较多，请稍后再试";
  return detail || "发送失败，请稍后重试";
}

function sleep(ms: number, cancelled: () => boolean): Promise<void> {
  return new Promise((resolve) => {
    const started = Date.now();
    const tick = () => {
      if (cancelled() || Date.now() - started >= ms) resolve();
      else setTimeout(tick, Math.min(50, ms));
    };
    tick();
  });
}

/**
 * lynclaw's own HTTP API is snake_case; the gateway DTO camelCases fields.
 * `fileIds` implies the user pinned files, so the doc's
 * `user_specified_file: true` flag is set alongside it.
 */
function snakeCaseTurnBody(body: Record<string, unknown>, userId?: string): Record<string, unknown> {
  const out: Record<string, unknown> = { ...body };
  if ("sessionId" in out) {
    out.session_id = out.sessionId;
    delete out.sessionId;
  }
  if ("fileIds" in out) {
    out.file_ids = out.fileIds;
    out.user_specified_file = true;
    delete out.fileIds;
  }
  delete out.confirmToken; // the doc's field is `confirm_token`
  if (userId) out.user_id = userId;
  return out;
}

/**
 * Stage captions emitted while a poll turn is still pending. The poll
 * protocol carries no per-step progress, so elapsed turn time drives these
 * stable keys and the UI rotates localized WAITING_POOL phrases per key
 * (each key has a matching entry in use-chat-store's WAITING_POOL).
 */
export const CHAT_PENDING_STAGE_KEYS = ["thinking", "researching", "composing"] as const;

/**
 * HTTP-polling chat transport (the lynclaw poll standard): submit the turn
 * with `POST /api/chat/poll`, receive a `task_id`, then short-poll
 * `GET /api/chat/poll/{task_id}` until the complete answer arrives. There are
 * no incremental events — the `done` payload carries the full text plus
 * sources / attachments / human-support link / confirmation card, so this
 * transport replays the text as client-side typewriter deltas before `done`
 * and stages pending captions while polling.
 */
export class PollChatTransport implements ChatTransport {
  readonly provider = "cloud" as const;
  private cancelled = false;

  async send(opts: SendChatOptions): Promise<void> {
    this.cancelled = false;
    opts.signal?.addEventListener("abort", () => this.cancel(), { once: true });

    const { query, sessionId, userId, fileIds, userSpecifiedFile, token, confirmToken, onEvent } =
      opts;
    // The gateway's poll route keeps the stream endpoint's request contract —
    // same camelCase fields, same auth — only the URL and the two-step
    // submit/poll flow differ. The server derives the user from the token.
    const body: Record<string, unknown> = { query };
    if (sessionId) body.sessionId = sessionId;
    if (token) body.token = token;
    if (fileIds.length && userSpecifiedFile) body.fileIds = fileIds;
    if (confirmToken) {
      // The card answer is new (no legacy field name); cover both spellings —
      // the doc's `confirm_token` and the card's camelCase `confirmToken`.
      body.confirm_token = confirmToken;
      body.confirmToken = confirmToken;
    }
    const turnBody = chatDirectBaseUrl ? snakeCaseTurnBody(body, userId) : body;

    const startedAt = Date.now();
    // Show the first pending caption right away (submit itself can take
    // seconds on busy retries) — the bubble reads as "working" from the click.
    let stage = this.emitPendingStages(startedAt, -1, onEvent);
    if (this.cancelled) return;

    let taskId: string;
    try {
      taskId = await this.submit(turnBody);
    } catch (error) {
      console.error("[chat-poll] submit failed", CHAT_POLL_PATH, error);
      if (!this.cancelled) onEvent({ type: "error", message: submitErrorMessage(error) });
      return;
    }
    if (this.cancelled) return;

    await this.pollUntilDone(taskId, startedAt, stage, onEvent);
  }

  cancel(): void {
    this.cancelled = true;
  }

  /**
   * Emit every pending stage the elapsed turn time has reached (skipping
   * ahead, never repeating) and return the now-current stage index.
   */
  private emitPendingStages(
    startedAt: number,
    emittedThrough: number,
    onEvent: SendChatOptions["onEvent"],
  ): number {
    const elapsed = Date.now() - startedAt;
    const thresholds = chatPollTiming.pendingStageMs;
    let reached = emittedThrough;
    for (let i = reached + 1; i < CHAT_PENDING_STAGE_KEYS.length; i += 1) {
      const threshold = thresholds[i];
      // A stage with no threshold (shorter array) never fires.
      if (threshold == null || elapsed < threshold) break;
      reached = i;
      onEvent({ type: "status", text: CHAT_PENDING_STAGE_KEYS[i]! });
    }
    return reached;
  }

  /** POST one turn — direct fetch against lynclaw when a base URL is set,
   *  otherwise the gateway route through the shared API client. */
  private postTurn(body: Record<string, unknown>): Promise<ChatPollSubmitResponse> {
    if (chatDirectBaseUrl) {
      return directJsonRequest<ChatPollSubmitResponse>(
        `${chatDirectBaseUrl}${DIRECT_CHAT_POLL_PATH}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
      );
    }
    return api().post<ChatPollSubmitResponse>(CHAT_POLL_PATH, body);
  }

  /** GET one task result — same direct/gateway split as `postTurn`. */
  private getTask(path: string): Promise<ChatPollTaskResponse> {
    if (chatDirectBaseUrl) {
      return directJsonRequest<ChatPollTaskResponse>(`${chatDirectBaseUrl}${path}`);
    }
    return api().get<ChatPollTaskResponse>(path);
  }

  /** POST the turn; on busy (503/429 or the gateway busy key) retry with backoff. */
  private async submit(body: Record<string, unknown>): Promise<string> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        const res = await this.postTurn(body);
        const taskId = res?.task_id ?? res?.taskId;
        if (!taskId) throw new Error("提交失败：服务端未返回任务 ID");
        return taskId;
      } catch (error) {
        const retryable =
          isBusySubmitError(error) &&
          attempt < chatPollTiming.maxSubmitRetries &&
          !this.cancelled;
        if (!retryable) throw error;
        await sleep(chatPollTiming.submitRetryDelayMs * 2 ** attempt, () => this.cancelled);
      }
    }
  }

  private async pollUntilDone(
    taskId: string,
    startedAt: number,
    stage: number,
    onEvent: SendChatOptions["onEvent"],
  ): Promise<void> {
    let emittedStage = stage;
    let networkFailures = 0;
    // The first GET fires immediately; later ones wait out the interval.
    let wait = false;

    while (!this.cancelled) {
      if (Date.now() - startedAt >= chatPollTiming.deadlineMs) {
        onEvent({ type: "error", message: "回复生成超时，请重新发送" });
        return;
      }
      emittedStage = this.emitPendingStages(startedAt, emittedStage, onEvent);
      if (wait) await sleep(chatPollTiming.intervalMs, () => this.cancelled);
      wait = true;
      if (this.cancelled) return;

      let data: ChatPollTaskResponse | null = null;
      let notFound = false;
      let networkError: unknown;
      try {
        data = await this.getTask(chatPollTaskPath(taskId));
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) notFound = true;
        else networkError = error;
      }

      if (networkError) {
        // A dropped GET is not fatal; give the network a few chances.
        networkFailures += 1;
        console.error(
          `[chat-poll] GET failed (${networkFailures}/${chatPollTiming.maxNetworkFailures})`,
          networkError,
        );
        if (networkFailures >= chatPollTiming.maxNetworkFailures) {
          onEvent({ type: "error", message: "网络连接不稳定，请稍后重试" });
          return;
        }
        continue;
      }
      networkFailures = 0;

      if (notFound) {
        // The task expired (TTL, restart, or bad id) — polling cannot recover.
        onEvent({ type: "error", message: "结果已过期，请重新发送" });
        return;
      }
      if (data?.status === "done") {
        await this.emitDone(data, onEvent);
        return;
      }
      if (data?.status === "error") {
        onEvent({ type: "error", message: humanizeBackendError(data.error) || "生成失败，请稍后重试" });
        return;
      }
      // "pending" (or an unknown status): keep the placeholder spinning.
    }
  }

  /**
   * Poll delivers the whole answer at once, so restore the streaming feel
   * client-side: replay the finished text as content deltas on a timer
   * (playback capped by `typewriterMaxMs` so long answers don't crawl).
   * Cancel stops mid-play and the partial text stays — same as an aborted
   * SSE stream.
   */
  private async playTypewriter(text: string, onEvent: SendChatOptions["onEvent"]): Promise<void> {
    if (!text) return;
    const tickMs = Math.max(1, chatPollTiming.typewriterTickMs);
    const steps = Math.min(
      text.length,
      Math.max(1, Math.floor(chatPollTiming.typewriterMaxMs / tickMs)),
    );
    const sliceSize = Math.ceil(text.length / steps);
    for (let at = 0; at < text.length; at += sliceSize) {
      if (this.cancelled) return;
      onEvent({ type: "content", delta: text.slice(at, at + sliceSize) });
      if (at + sliceSize < text.length) await sleep(tickMs, () => this.cancelled);
    }
  }

  private async emitDone(data: ChatPollTaskResponse, onEvent: SendChatOptions["onEvent"]): Promise<void> {
    const text = typeof data.text === "string" ? data.text : "";
    await this.playTypewriter(text, onEvent);
    if (this.cancelled) return;
    const attachments = (Array.isArray(data.attachments) ? data.attachments : [])
      .map(normalizePollAttachment)
      .filter((a): a is ChatAttachment => a != null);
    onEvent({
      type: "done",
      text,
      sources: Array.isArray(data.sources)
        ? data.sources.filter((s): s is string => typeof s === "string" && !!s)
        : [],
      attachments,
      humanSupportLink: normalizeHumanSupportLink(
        data.human_support_link ?? data.humanSupportLink,
      ),
    });
    const confirm = normalizePollConfirmation(data.confirmation);
    if (confirm) onEvent({ type: "confirm", confirm });
  }
}
