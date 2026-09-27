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
 * `/api/business/ai`, while the service itself serves the native
 * `/api/chat/*` routes — so a direct agent connection (route B) uses the
 * unprefixed paths and the main backend keeps the gateway ones.
 */
const GATEWAY_CHAT_POLL_PATH = "/api/business/ai/chat/poll";
const GATEWAY_CHAT_STREAM_PATH = "/api/business/ai/chat/stream";
const AGENT_CHAT_POLL_PATH = "/api/chat/poll";
const AGENT_CHAT_STREAM_PATH = "/api/chat/stream";

const chatPollPath = () => (chatAgentBaseUrl() ? AGENT_CHAT_POLL_PATH : GATEWAY_CHAT_POLL_PATH);
const chatStreamPath = () =>
  chatAgentBaseUrl() ? AGENT_CHAT_STREAM_PATH : GATEWAY_CHAT_STREAM_PATH;

const chatPollTaskPath = (taskId: string) =>
  `${chatPollPath()}/${encodeURIComponent(taskId)}`;

/**
 * Route B: the assistant can be pointed at a dedicated agent backend
 * (lynse_agent_api_url, set in Settings → AI Assistant) and connect straight
 * to it — typically the CloudRun-hosted lynclaw service, bypassing the Lynse
 * gateway. Undefined = ride the main backend like every other business API.
 * Chat always uses the poll contract; the direct service supports it natively.
 */
function chatAgentBaseUrl(): string | undefined {
  try {
    return api().getAgentBaseUrl() ?? undefined;
  } catch {
    return undefined; // client not initialized — main backend
  }
}

/**
 * Poll timing, readable at send-time so tests can shrink the waits. The
 * standard advises a 500–1000ms interval (never below 200ms) and an overall
 * wait above the server's turn timeout (180s by default) plus headroom.
 */
export const chatPollTiming = {
  intervalMs: 800,
  /**
   * Hot-window cadence used right after submit: tool activity and (when the
   * backend sends it) partial text concentrate in the first seconds of a
   * turn, so a tighter 500ms loop makes progress rows and text land sooner.
   * Still inside the poll standard's advised 500–1000ms band.
   */
  intervalFastMs: 500,
  /** How long (ms) after submit the fast cadence applies before settling. */
  fastWindowMs: 12_000,
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

/**
 * One tool-activity progress event from the poll payload (`progress_events[]`,
 * capped at the latest 40). `round_start.content` is the server-localized
 * status caption ("我去会议记录里翻一翻…"); tool events carry the localized
 * tool label. Thinking traces and content deltas never appear here.
 */
export interface ChatPollProgressEvent {
  type?: "round_start" | "tool_start" | "tool_end" | string;
  content?: string;
  tool?: string;
  label?: string;
  round?: number;
  duration_ms?: number;
  result_summary?: string;
  success?: boolean;
  /** Server-side unix timestamp (seconds). */
  at?: number;
}

interface ChatPollTaskResponse {
  status?: "pending" | "done" | "error" | string;
  /**
   * The answer text. Required at `done`; OPTIONAL while `pending` — a backend
   * that includes the answer-so-far turns the poll loop into a true stream
   * (each growth is emitted as a content delta immediately).
   */
  text?: string | null;
  /** Tool-activity progress seen so far; clients diff by list length. */
  progress_events?: ChatPollProgressEvent[] | null;
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
    expiresAt: firstString(r.expires_at, r.expiresAt) ?? undefined,
  };
}

/** lynclaw artifact ids are 32 hex chars; other backends' ids don't refresh. */
const ARTIFACT_ID_RE = /^[0-9a-f]{32}$/i;

/**
 * Re-sign an expired attachment download link. lynclaw hands out signed URLs
 * (CloudBase/OSS) that die after ~1h, while chat history keeps rendering the
 * saved ones — the refresh endpoint mints a fresh signature for the artifact.
 * Returns the new URL, or null when the attachment is not a lynclaw artifact
 * (no 32-hex id) or the endpoint is unavailable (e.g. gateway mode). The
 * caller decides what to do with a null — keep showing the old link.
 */
export async function refreshAttachmentUrl(
  attachment: ChatAttachment,
  opts: { userId?: string | null; token?: string | null } = {},
): Promise<string | null> {
  const artifactId = attachment.id;
  if (!artifactId || !ARTIFACT_ID_RE.test(artifactId)) return null;

  let token = opts.token ?? null;
  if (!token) {
    try {
      token = api().getToken() ?? null;
    } catch {
      token = null; // client not initialized — go without
    }
  }
  const body: Record<string, unknown> = {};
  if (opts.userId) body.user_id = opts.userId;
  if (token) body.token = token;

  try {
    const res = await api().post<Record<string, unknown>>(
      `/api/attachments/${encodeURIComponent(artifactId)}/download-url`,
      body,
      { baseUrl: chatAgentBaseUrl() },
    );
    return firstString(res?.download_url, res?.downloadUrl, res?.url);
  } catch {
    return null;
  }
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

/** How far past a cut we look for a word end before giving up on the snap. */
const WORD_SNAP_LOOKAHEAD = 8;

/**
 * Move a slice end onto a character-safe boundary. A cut between the halves of
 * a surrogate pair flashes a broken glyph every tick, and a cut inside a Latin
 * word reads as stutter; CJK has no word ends so only the surrogate rule
 * applies there. `end` is exclusive and below `text.length`.
 */
export function safeSliceEnd(text: string, end: number): number {
  if (end <= 0 || end >= text.length) return end;
  // Trailing high surrogate: its pair belongs in this slice.
  if (/[\uD800-\uDBFF]$/.test(text.slice(end - 1, end))) end += 1;
  // Inside a word/number run: carry it to the next break, if nearby.
  if (/[A-Za-z0-9_]$/.test(text.slice(end - 1, end)) && /[A-Za-z0-9_]/.test(text[end] ?? "")) {
    const rest = text.slice(end, end + WORD_SNAP_LOOKAHEAD);
    const breakAt = rest.search(/[^\w]/);
    if (breakAt >= 0) end += breakAt + 1;
  }
  return Math.min(end, text.length);
}

/**
 * In-flight poll waits that may be cut short. When the app returns to the
 * foreground mid-turn, mobile/webview runtimes have frozen timers and may
 * have dropped the socket; waking the current wait makes the next GET —
 * which carries everything that accumulated while backgrounded — fire
 * immediately instead of up to one interval late. Only the poll loop's wait
 * registers here: submit backoff must be respected and the typewriter should
 * keep its pace.
 */
const foregroundWakers = new Set<() => void>();

if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") return;
    for (const wake of [...foregroundWakers]) wake();
  });
}

function sleep(ms: number, cancelled: () => boolean, wakeOnForeground = false): Promise<void> {
  return new Promise((resolve) => {
    const started = Date.now();
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      foregroundWakers.delete(finish);
      resolve();
    };
    if (wakeOnForeground) foregroundWakers.add(finish);
    const tick = () => {
      if (cancelled() || Date.now() - started >= ms) finish();
      else setTimeout(tick, Math.min(50, ms));
    };
    tick();
  });
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
 * `GET /api/chat/poll/{task_id}` until the complete answer arrives. While
 * pending, each payload carries `progress_events[]` — tool-activity states
 * ("正在调用…") surfaced live as status ticks and tool rows — and MAY carry a
 * partial `text`, which is streamed out as content deltas the moment it
 * grows. The `done` payload carries the full text plus sources / attachments
 * / human-support link / confirmation card; only text not already streamed
 * is replayed as client-side typewriter deltas.
 */
export class PollChatTransport implements ChatTransport {
  readonly provider = "cloud" as const;
  private cancelled = false;

  async send(opts: SendChatOptions): Promise<void> {
    this.cancelled = false;
    opts.signal?.addEventListener("abort", () => this.cancel(), { once: true });

    const { query, sessionId, fileIds, userSpecifiedFile, token, confirmToken, onEvent } =
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

    const startedAt = Date.now();
    // Show the first pending caption right away (submit itself can take
    // seconds on busy retries) — the bubble reads as "working" from the click.
    const stage = this.emitPendingStages(startedAt, -1, onEvent);
    if (this.cancelled) return;

    let taskId: string;
    try {
      taskId = await this.submit(body);
    } catch (error) {
      console.error("[chat-poll] submit failed", chatPollPath(), error);
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

  private postTurn(body: Record<string, unknown>): Promise<ChatPollSubmitResponse> {
    return api().post<ChatPollSubmitResponse>(chatPollPath(), body, {
      baseUrl: chatAgentBaseUrl(),
    });
  }

  private getTask(path: string): Promise<ChatPollTaskResponse> {
    return api().get<ChatPollTaskResponse>(path, { baseUrl: chatAgentBaseUrl() });
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
    // Progress events arrive as a full list each poll; this cursor counts how
    // many have been surfaced so each one emits exactly once.
    let seenProgress = 0;
    // How many answer characters have already been streamed from pending
    // payloads' partial `text`; the done replay only types the remainder.
    let streamedChars = 0;
    // The first GET fires immediately; later ones wait out the interval.
    let wait = false;

    while (!this.cancelled) {
      if (Date.now() - startedAt >= chatPollTiming.deadlineMs) {
        onEvent({ type: "error", message: "回复生成超时，请重新发送" });
        return;
      }
      emittedStage = this.emitPendingStages(startedAt, emittedStage, onEvent);
      if (wait) {
        const elapsed = Date.now() - startedAt;
        const interval =
          elapsed < chatPollTiming.fastWindowMs
            ? chatPollTiming.intervalFastMs
            : chatPollTiming.intervalMs;
        // Foreground return cuts this wait short: the immediate re-GET is
        // what recovers a turn that kept generating while backgrounded.
        await sleep(interval, () => this.cancelled, true);
      }
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
        seenProgress = this.emitProgressEvents(data, seenProgress, onEvent);
        await this.emitDone(data, onEvent, streamedChars);
        return;
      }
      if (data?.status === "error") {
        seenProgress = this.emitProgressEvents(data, seenProgress, onEvent);
        onEvent({ type: "error", message: humanizeBackendError(data.error) || "生成失败，请稍后重试" });
        return;
      }
      seenProgress = this.emitProgressEvents(data, seenProgress, onEvent);
      streamedChars = this.emitPendingText(data, streamedChars, onEvent);
      // "pending" (or an unknown status): keep the placeholder spinning.
    }
  }

  /**
   * Stream a pending payload's partial `text` the moment it grows. The poll
   * contract only REQUIRES the full text at `done`; a backend that includes
   * the answer-so-far while pending gets true streaming behavior here with no
   * client change (absent field → this is a no-op and the turn stays
   * caption-only until done, exactly as before). The returned cursor only
   * ever moves forward so a payload that shrinks can't re-emit old text.
   */
  private emitPendingText(
    data: ChatPollTaskResponse | null,
    streamed: number,
    onEvent: SendChatOptions["onEvent"],
  ): number {
    const text = typeof data?.text === "string" ? data.text : "";
    if (text.length <= streamed) return streamed;
    // A payload cut between a surrogate pair would paint half an emoji; hold
    // the lone high surrogate back so the next poll emits it with its pair.
    let end = text.length;
    if (/[\uD800-\uDBFF]$/.test(text)) end -= 1;
    if (end <= streamed) return streamed;
    onEvent({ type: "content", delta: text.slice(streamed, end) });
    return end;
  }

  /**
   * Surface new tool-activity progress events as live status ticks and tool
   * rows — the poll counterpart of the stream contract's status ticks. Each
   * poll returns the full event list, so emitting everything past `seen`
   * makes the replay incremental and idempotent.
   */
  private emitProgressEvents(
    data: ChatPollTaskResponse | null,
    seen: number,
    onEvent: SendChatOptions["onEvent"],
  ): number {
    const events = Array.isArray(data?.progress_events) ? data!.progress_events! : [];
    for (let i = seen; i < events.length; i += 1) {
      const event = events[i]!;
      const label = firstString(event.label, event.tool);
      if (event.type === "round_start") {
        const caption = (event.content ?? "").trim();
        if (caption) onEvent({ type: "status", text: caption });
      } else if (event.type === "tool_start" && label) {
        onEvent({ type: "tool", name: label, state: "running" });
      } else if (event.type === "tool_end" && label) {
        onEvent({ type: "tool", name: label, state: "done" });
      }
    }
    return events.length;
  }

  /**
   * Poll delivers the whole turn at once, so restore the streaming feel
   * client-side: replay finished text as deltas on a timer (playback capped
   * by `maxMs` so long passages don't crawl). Cancel stops mid-play and the
   * partial text stays — same as an aborted SSE stream.
   */
  private async replayText(
    text: string,
    maxMs: number,
    emit: (delta: string) => ChatStreamEvent,
    onEvent: SendChatOptions["onEvent"],
  ): Promise<void> {
    if (!text) return;
    const tickMs = Math.max(1, chatPollTiming.typewriterTickMs);
    const steps = Math.min(text.length, Math.max(1, Math.floor(maxMs / tickMs)));
    const sliceSize = Math.ceil(text.length / steps);
    let at = 0;
    while (at < text.length) {
      if (this.cancelled) return;
      const end = safeSliceEnd(text, Math.min(at + sliceSize, text.length));
      onEvent(emit(text.slice(at, end)));
      at = end;
      if (at < text.length) await sleep(tickMs, () => this.cancelled);
    }
  }

  private async emitDone(
    data: ChatPollTaskResponse,
    onEvent: SendChatOptions["onEvent"],
    streamedChars = 0,
  ): Promise<void> {
    const text = typeof data.text === "string" ? data.text : "";
    // Text already streamed from pending payloads is skipped — only the
    // not-yet-seen tail plays through the typewriter (all of it when the
    // backend sent no partial text, the common case today).
    await this.replayText(
      text.slice(streamedChars),
      chatPollTiming.typewriterMaxMs,
      (delta) => ({ type: "content", delta }),
      onEvent,
    );
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

/**
 * Map one SSE `data:` payload (the lynclaw stream contract, e.g.
 * `{"type":"content","content":"你好老"}`) onto ChatStreamEvents. Returns an
 * array because one frame can carry two events: `done` with a non-null
 * `confirmation` also produces the trailing `confirm` event, mirroring how
 * the poll transport emits them.
 *
 * Tolerant of the camelCase fields the gateway DTO passes through
 * (`humanSupportLink`) and the lynclaw-native snake_case (`human_support_link`).
 */
export function parseChatStreamData(payload: string): ChatStreamEvent[] {
  let p: Record<string, unknown>;
  try {
    p = JSON.parse(payload) as Record<string, unknown>;
  } catch {
    // Non-JSON frame — some relays stream raw text deltas.
    return payload ? [{ type: "content", delta: payload }] : [];
  }
  if (p == null || typeof p !== "object") return [];

  const str = (...values: unknown[]): string | null => {
    for (const value of values) {
      if (typeof value === "string" && value) return value;
    }
    return null;
  };

  switch (p.type) {
    case "round_start":
      return [{ type: "status", text: str(p.content, p.text) ?? "正在思考…" }];
    case "status": {
      const text = str(p.text, p.content);
      return text ? [{ type: "status", text }] : [];
    }
    case "thinking":
    case "reasoning":
      return [{ type: "thinking", delta: str(p.content, p.text, p.delta) ?? "" }];
    case "thinking_end":
    case "reasoning_end":
      return [{ type: "thinking", delta: "" }]; // closes the reasoning trace
    case "content":
      return [{ type: "content", delta: str(p.content, p.text, p.delta) ?? "" }];
    case "meta":
      return [
        {
          type: "meta",
          sources: Array.isArray(p.sources) ? (p.sources as string[]) : [],
          attachments: Array.isArray(p.attachments)
            ? (p.attachments as unknown[]).map(normalizePollAttachment).filter(
                (a): a is ChatAttachment => a != null,
              )
            : [],
        },
      ];
    case "tool":
    case "tool_use":
    case "tool_start": {
      const name = str(p.name, p.tool, p.tool_name);
      return name
        ? [
            {
              type: "tool",
              name,
              id: str(p.id, p.tool_call_id) ?? undefined,
              state: p.state === "done" || p.state === "result" ? "done" : "running",
            },
          ]
        : [];
    }
    case "tool_result":
    case "tool_end":
    case "tool_done":
      return [
        {
          type: "tool",
          name: str(p.name, p.tool, p.tool_name) ?? "",
          id: str(p.id, p.tool_call_id) ?? undefined,
          state: "done",
        },
      ];
    case "error":
      return [
        {
          type: "error",
          message:
            humanizeBackendError(str(p.message, p.error, p.detail)) ?? "生成失败，请稍后重试",
        },
      ];
    case "confirmation": {
      const confirm = normalizePollConfirmation(p.confirmation ?? p);
      return confirm ? [{ type: "confirm", confirm }] : [];
    }
    case "confirm": {
      const confirm = normalizePollConfirmation(p.confirm ?? p);
      return confirm ? [{ type: "confirm", confirm }] : [];
    }
    case "done": {
      const text = str(p.text, p.content) ?? "";
      const attachments = (Array.isArray(p.attachments) ? p.attachments : [])
        .map(normalizePollAttachment)
        .filter((a): a is ChatAttachment => a != null);
      const events: ChatStreamEvent[] = [
        {
          type: "done",
          text,
          sources: Array.isArray(p.sources)
            ? (p.sources as unknown[]).filter((s): s is string => typeof s === "string")
            : [],
          attachments,
          humanSupportLink: normalizeHumanSupportLink(p.human_support_link ?? p.humanSupportLink),
        },
      ];
      const confirm = normalizePollConfirmation(p.confirmation);
      if (confirm) events.push({ type: "confirm", confirm });
      return events;
    }
    default:
      return [];
  }
}

/**
 * SSE transport over the pre-poll stream contract (`POST /api/chat/stream`).
 * Not on the chat hot path — the poll transport is the only production
 * transport — but kept as a complete implementation of the stream contract
 * (covered by tests) for backends that only expose it.
 */
export class StreamChatTransport implements ChatTransport {
  readonly provider = "cloud" as const;
  private controller: AbortController | null = null;

  async send(opts: SendChatOptions): Promise<void> {
    const { query, sessionId, fileIds, userSpecifiedFile, token, confirmToken, onEvent } = opts;
    const body: Record<string, unknown> = { query };
    if (sessionId) body.sessionId = sessionId;
    if (token) body.token = token;
    if (fileIds.length && userSpecifiedFile) body.fileIds = fileIds;
    if (confirmToken) {
      body.confirm_token = confirmToken;
      body.confirmToken = confirmToken;
    }
    await new Promise<void>((resolve) => {
      this.controller = api().stream(
        chatStreamPath(),
        body,
        (data) => {
          for (const event of parseChatStreamData(data)) onEvent(event);
        },
        (err) => {
          if (!opts.signal?.aborted) {
            onEvent({ type: "error", message: submitErrorMessage(err) });
          }
          resolve();
        },
        () => resolve(),
        { baseUrl: chatAgentBaseUrl() },
      );
    });
    this.controller = null;
  }

  cancel(): void {
    this.controller?.abort();
    this.controller = null;
  }


}
