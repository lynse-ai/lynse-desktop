import { getWorkbenchApi, useWorkbench } from "../workbench/api";
import type { DesktopContext } from "../workbench/types";
import type {
  ChatProvider,
  ChatStreamEvent,
  ChatConfirm,
  ChatConfirmOption,
  ChatAttachment,
  ChatHumanSupportLink,
  WorkBuddyCloudSession,
} from "./types";
import { api, ApiError, normalizeConnectionRequest, type ConnectorConnectionRequest } from "@lynse/core/api";
import type { RequestModelOverride } from "./model-override";

export interface SendChatOptions {
  query: string;
  desktopContext?: DesktopContext | null;
  sessionId: string;
  userId: string;
  fileIds: string[];
  userSpecifiedFile: boolean;
  token?: string | null;
  /** Stable per-turn key shared by stream retries and poll recovery. */
  requestId?: string;
  /** Internal recovery handshake; never treated as a user-visible event. */
  onTaskId?: (taskId: string) => void;
  /** `confirmation.confirmToken` of the card this turn answers, if any. */
  confirmToken?: string | null;
  /** Per-turn model override (model selection); absent = server default. */
  modelOverride?: RequestModelOverride | null;
  workbuddySession?: WorkBuddyCloudSession;
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
  answerConfirmation?(confirm: ChatConfirm, value: string | null): Promise<void>;
}

/**
 * The lynclaw agent service exposes SSE and submit/GET polling routes.
 * The Lynse gateway fronts that service under
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
 * to it — typically the CloudBase-hosted lynclaw service, bypassing the Lynse
 * gateway. Undefined = ride the main backend like every other business API.
 * Both transports use the same request contract and route selection.
 */
function chatAgentBaseUrl(): string | undefined {
  try {
    return api().getAgentBaseUrl() ?? undefined;
  } catch {
    return undefined; // client not initialized — main backend
  }
}

/**
 * Chat timing, readable at send-time so tests can shrink the waits. The
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
  /** Cap on the whole typewriter playback so long answers do not crawl. */
  typewriterMaxMs: 4_800,
};

interface ChatPollSubmitResponse {
  /** lynclaw replies `task_id`; a Java-gateway DTO may camel-case it to `taskId`. */
  task_id?: string;
  taskId?: string;
  status?: string;
  session_id?: string;
  user_id?: string;
  timings_ms?: Record<string, number>;
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
  /** Monotonic sequence, unaffected by the server's rolling 40-event cap. */
  seq?: number;
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
  connection_requests?: unknown;
  error?: string | null;
}

/** Keep stream, busy retries and poll recovery on the same authenticated turn. */
function hydrateDesktopContext(opts: SendChatOptions): Promise<void> | undefined {
  const bridge = getWorkbenchApi();
  opts.desktopContext = null;
  const consent = useWorkbench.getState().status;
  if (!bridge || opts.signal?.aborted || !consent?.enabled || !consent.allowAi || !consent.initialComplete) return;
  const scope = consent.scope;
  return bridge.context(opts.query).then((evidence) => {
    const state = useWorkbench.getState().status;
    if (!opts.signal?.aborted && state?.enabled && state.allowAi && state.scope === scope) opts.desktopContext = evidence;
  }).catch(() => { /* Optional recall failure does not prevent assistant use. */ });
}

function chatTurnBody(opts: SendChatOptions): Record<string, unknown> {
  const { query, sessionId, fileIds, userSpecifiedFile, token, confirmToken, modelOverride } = opts;
  const body: Record<string, unknown> = { query };
  if (opts.requestId) body.requestId = opts.requestId;
  if (sessionId) body.sessionId = sessionId;
  if (token) body.token = token;
  if (fileIds.length && userSpecifiedFile) {
    body.fileIds = fileIds;
    body.userSpecifiedFile = true;
  }
  if (modelOverride) body.modelOverride = modelOverride;
  if (opts.desktopContext?.sources.length) body.desktopContext = opts.desktopContext;
  if (confirmToken) {
    body.confirm_token = confirmToken;
    body.confirmToken = confirmToken;
  }
  return body;
}

const firstString = (...values: unknown[]): string | null => {
  for (const value of values) {
    if (typeof value === "string" && value) return value;
  }
  return null;
};

function connectionRequests(raw: unknown): ConnectorConnectionRequest[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  return raw.map(normalizeConnectionRequest).filter((card): card is ConnectorConnectionRequest => card !== null);
}

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
  const kind = firstString(r.kind) ?? undefined;
  const params = r.params && typeof r.params === "object" ? r.params as Record<string, unknown> : {};
  const preview = params.preview ?? r.preview;
  return {
    question,
    options,
    kind,
    confirmToken: firstString(r.confirmToken, r.confirm_token) ?? undefined,
    riskLevel: firstString(r.riskLevel, r.risk_level) ?? undefined,
    ...(kind?.startsWith("context_") && preview && typeof preview === "object" && !Array.isArray(preview)
      ? { preview: JSON.parse(JSON.stringify(preview)) as NonNullable<ChatConfirm["preview"]> } : {}),
  };
}

const CIRCLED: Record<string, string> = {
  "①": "1", "②": "2", "③": "3", "④": "4", "⑤": "5",
  "⑥": "6", "⑦": "7", "⑧": "8", "⑨": "9",
};

/** Explicit "pick one" phrasing — an unambiguous ask for a choice. */
const CHOICE_CUE_RE =
  /请选择|请挑选|请选出|请确认|请回复|请选一|选择|选定|选一个|任选|choose|select|pick|which/i;

/** Softer second-person ask ("你想怎么处理"). */
const CHOICE_WEAK_RE =
  /你想|您想|你希望|您希望|你倾向|您倾向|要不要|是否需要|需要我|哪种|哪个|怎么处理|如何处理|怎么办/;

/** Enumeration intros — the preamble presents information, not a menu. */
const LIST_INTRO_RE =
  /以下几个方面|如下|以下内容|包括|总结|要点|结论|步骤|原因|因素|优缺点|区别|对比|注意事项/;

/** Markdown styling inside an item means formatted content, not a choice. */
const MARKDOWNISH_RE = /\*\*|__|`|\[[^\]]*\]\(/;

/**
 * Heuristic detector: when the assistant replies with a choice menu like
 *
 *   请选择操作:
 *   A) 重启设备
 *   B) 暂不处理
 *
 * synthesize a ChatConfirm so the UI can pop a clickable dialog instead of
 * forcing the user to type "A/B/C". Works on the finished assistant text.
 *
 * Structure alone (2-8 sequential keys) cannot tell a bare-number menu from
 * an ordinary markdown ordered list — the model writes most enumerations as
 * "1. … 2. …" — so beyond the structural checks the preamble must also read
 * as an ask (see CHOICE_CUE_RE / CHOICE_WEAK_RE vs LIST_INTRO_RE). Returns
 * null when any gate fails; a missed menu just stays as plain text, which is
 * strictly better than a spurious modal.
 */
export function extractConfirmFromText(text: string): ChatConfirm | null {
  if (!text || text.length < 6) return null;
  const OPTION_RE =
    /^\s*(?:(?:[\(（]([A-Za-z0-9])[\)）])|(?:[\[【]([A-Za-z0-9])[\]】])|([①②③④⑤⑥⑦⑧⑨])|([A-Za-z])|([0-9]{1,2}))[.、)）、．。:]?\s*(.+?)\s*$/;

  const options: { key: string; text: string }[] = [];
  const questionLines: string[] = [];
  let seenOptions = false;
  let tailIsOption = false;

  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
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
        tailIsOption = true;
      }
    } else {
      tailIsOption = false;
      if (!seenOptions) questionLines.push(line);
    }
  }

  if (options.length < 2 || options.length > 8) return null;

  // A menu ends with its options; a numbered list followed by more prose is
  // an enumerated answer with the list buried mid-text.
  if (!tailIsOption) return null;

  // Menu items are short and plain. Markdown styling or very long lines mean
  // formatted content, not choices (the 2026-10-02 misfire: a six-item
  // "**困难点**" list popped the dialog).
  if (options.some((o) => o.text.length > 50 || MARKDOWNISH_RE.test(o.text))) return null;

  const first = options[0]!;
  const isLetter = /^[A-Z]$/.test(first.key);
  const expectedKey = (i: number) =>
    isLetter ? String.fromCharCode(65 + i) : String(i + 1);
  // Require the detected keys to be sequential (A,B,C… or 1,2,3…).
  const sequential = options.every((o, i) => o.key === expectedKey(i));
  if (!sequential) return null;

  // Semantic gate: letter-keyed menus (A/B/C, （A）, [A]) never occur in
  // ordinary prose, but digits and circled numbers do — so those need the
  // preamble to actually ask for a choice. An explicit ask overrides an
  // enumeration intro; a soft ask does not survive one.
  if (!isLetter) {
    let strong = false;
    let weak = false;
    let intro = false;
    for (const line of questionLines) {
      if (/[?？]\s*$/.test(line.trim()) || CHOICE_CUE_RE.test(line)) strong = true;
      if (CHOICE_WEAK_RE.test(line)) weak = true;
      if (LIST_INTRO_RE.test(line)) intro = true;
    }
    if (!(strong || (weak && !intro))) return null;
  }

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

/**
 * A 503 from the agent backend is also how token/identity verification
 * failure surfaces ("身份校验失败" — expired Lynse token, or a token the
 * deployment's identity host cannot verify). Retrying it or rewriting it as
 * "busy" hides a dead login behind a phantom load problem.
 */
const IDENTITY_FAILURE_PATTERN = /身份校验失败|身份验证未通过|登录状态已失效|not logged in/i;

function isIdentityFailureError(error: unknown): boolean {
  if (!(error instanceof ApiError)) return false;
  const detail = detailText(error);
  return !!detail && IDENTITY_FAILURE_PATTERN.test(detail);
}

/** True when a submit failure means "server busy" and is worth retrying. */
function isBusySubmitError(error: unknown): boolean {
  if (!(error instanceof ApiError)) return false;
  if (isIdentityFailureError(error)) return false;
  if (error.status === 503 || error.status === 429) return true;
  const detail = detailText(error);
  return !!detail && detail.trim().toLowerCase() === BUSY_ERROR_KEY;
}

function submitErrorMessage(error: unknown): string {
  const detail = humanizeBackendError(detailText(error));
  const status = error instanceof ApiError ? error.status : undefined;
  if (status === 400) return detail || "登录状态已失效，请重新登录后再试";
  if (status === 401 || status === 403) return detail || "身份验证未通过，请重新登录";
  if (status === 503 || status === 429) {
    if (isIdentityFailureError(error)) return "登录状态已失效，请重新登录后再试";
    // Pass the backend's own copy through (saturation, identity timeout, …);
    // only a bare 503 with no detail falls back to generic busy.
    if (detail) return detail;
    return "当前使用人数较多，请稍后再试";
  }
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

interface ProgressCursor { sequence: number; at: number; length: number }

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
  private requestController: AbortController | null = null;
  private sessionToken: string | undefined;

  async send(opts: SendChatOptions): Promise<void> {
    await this.run(opts, () => this.sendTurn(opts));
  }

  /** Resume an existing task without submitting the user query a second time. */
  async resume(taskId: string, opts: SendChatOptions): Promise<void> {
    await this.run(opts, () => this.pollUntilDone(taskId, Date.now(), opts.onEvent));
  }

  private async run(opts: SendChatOptions, work: () => Promise<void>): Promise<void> {
    this.cancelled = false;
    this.sessionToken = opts.token ?? undefined;
    this.requestController = new AbortController();
    const abort = () => this.cancel();
    opts.signal?.addEventListener("abort", abort, { once: true });
    if (opts.signal?.aborted) {
      this.cancel();
      opts.signal.removeEventListener("abort", abort);
      this.requestController = null;
      return;
    }
    const requestSignal = this.requestController.signal;
    let settleAbort!: () => void;
    const aborted = new Promise<void>((resolve) => { settleAbort = resolve; });
    requestSignal.addEventListener("abort", settleAbort, { once: true });
    // Bound submission too: a stalled POST must not wait forever before
    // entering the poll loop, and cancellation aborts its network request.
    const deadline = setTimeout(() => {
      if (!this.cancelled) opts.onEvent({ type: "error", message: "回复生成超时，请重新发送" });
      this.cancel();
    }, chatPollTiming.deadlineMs);
    try { await Promise.race([work(), aborted]); }
    finally {
      clearTimeout(deadline);
      requestSignal.removeEventListener("abort", settleAbort);
      opts.signal?.removeEventListener("abort", abort);
      this.requestController = null;
    }
  }

  private async sendTurn(opts: SendChatOptions): Promise<void> {

    const { onEvent } = opts;
    const recall = hydrateDesktopContext(opts);
    if (recall) await recall;
    const body = chatTurnBody(opts);

    const startedAt = Date.now();
    // This is a client-side submission state, not a claim that the server
    // has started searching or generating an answer.
    onEvent({ type: "status", text: "submitting" });
    if (this.cancelled) return;

    let taskId: string;
    try {
      taskId = await this.submit(body, onEvent);
    } catch (error) {
      console.error("[chat-poll] submit failed", chatPollPath(), error);
      if (!this.cancelled) onEvent({ type: "error", message: submitErrorMessage(error) });
      return;
    }
    opts.onTaskId?.(taskId);
    if (this.cancelled) return;

    onEvent({ type: "status", text: "waiting" });
    await this.pollUntilDone(taskId, startedAt, onEvent);
  }

  cancel(): void {
    this.cancelled = true;
    this.requestController?.abort();
  }

  private postTurn(body: Record<string, unknown>): Promise<ChatPollSubmitResponse> {
    return api().post<ChatPollSubmitResponse>(chatPollPath(), body, {
      baseUrl: chatAgentBaseUrl(),
      signal: this.requestController?.signal,
      sessionToken: this.sessionToken,
    });
  }

  private getTask(path: string): Promise<ChatPollTaskResponse> {
    return api().get<ChatPollTaskResponse>(path, { baseUrl: chatAgentBaseUrl(), signal: this.requestController?.signal, sessionToken: this.sessionToken });
  }

  /** POST the turn; on busy (503/429 or the gateway busy key) retry with backoff. */
  private async submit(body: Record<string, unknown>, onEvent: SendChatOptions["onEvent"]): Promise<string> {
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
        onEvent({ type: "status", text: "retrying" });
        await sleep(chatPollTiming.submitRetryDelayMs * 2 ** attempt, () => this.cancelled);
        if (this.cancelled) throw error;
        onEvent({ type: "status", text: "submitting" });
      }
    }
  }

  private async pollUntilDone(
    taskId: string,
    startedAt: number,
    onEvent: SendChatOptions["onEvent"],
  ): Promise<void> {
    let networkFailures = 0;
    // Sequence/timestamp cursors survive the server's rolling event window.
    let seenProgress: ProgressCursor = { sequence: 0, at: 0, length: 0 };
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
      if (this.cancelled) return;

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
    seen: ProgressCursor,
    onEvent: SendChatOptions["onEvent"],
  ): ProgressCursor {
    const events = Array.isArray(data?.progress_events) ? data!.progress_events! : [];
    const next = { ...seen, length: events.length };
    for (let i = 0; i < events.length; i += 1) {
      const event = events[i]!;
      const seq = typeof event.seq === "number" && Number.isFinite(event.seq) ? event.seq : 0;
      const at = typeof event.at === "number" && Number.isFinite(event.at) ? event.at : 0;
      const fresh = seq > 0 ? seq > seen.sequence : at > 0 ? at > seen.at : i >= seen.length;
      next.sequence = Math.max(next.sequence, seq);
      next.at = Math.max(next.at, at);
      if (!fresh) continue;
      const label = firstString(event.label, event.tool);
      if (event.type === "round_start") {
        const caption = (event.content ?? "").trim();
        if (caption) onEvent({ type: "status", text: caption });
      } else if (event.type === "tool_start" && label) {
        onEvent({ type: "tool", name: label, state: "running" });
      } else if (event.type === "tool_end" && label) {
        onEvent({ type: "tool", name: label, state: event.success === false ? "error" : "done" });
      }
    }
    return next;
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
      connectionRequests: connectionRequests(data.connection_requests),
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
          connectionRequests: connectionRequests(p.connection_requests),
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
    case "connection_request": {
      const request = normalizeConnectionRequest(p.connection_request ?? p);
      return request ? [{ type: "connection_request", request }] : [];
    }
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
          connectionRequests: connectionRequests(p.connection_requests),
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
 * SSE is the cloud-chat default. Busy submissions retry with exponential
 * backoff; an interrupted stream recovers through polling in the same UI
 * turn. A pollable task_id/taskId frame allows true task resumption. Without
 * one, recovery uses the same requestId to let the backend deduplicate the
 * submission. Older backends may ignore that key. All attempts share the
 * original turn's deadline and abort signal.
 */
export class StreamChatTransport implements ChatTransport {
  readonly provider = "cloud" as const;
  private turnController: AbortController | null = null;
  private streamController: AbortController | null = null;

  async send(opts: SendChatOptions): Promise<void> {
    this.cancel();
    opts = { ...opts, requestId: opts.requestId ?? crypto.randomUUID() };
    const turn = new AbortController();
    this.turnController = turn;
    const abort = () => turn.abort();
    opts.signal?.addEventListener("abort", abort, { once: true });
    if (opts.signal?.aborted) abort();

    let terminal = false;
    let hasPartialText = false;
    let taskId: string | null = null;
    const cancelTask = () => {
      if (!taskId) return;
      try {
        // A dropped reader must not cancel a recoverable task; only the turn's
        // explicit abort (Stop, account switch or deadline) calls this endpoint.
        void Promise.resolve(api().post(`${chatPollTaskPath(taskId)}/cancel`, {}, {
          baseUrl: chatAgentBaseUrl(), sessionToken: opts.token ?? undefined,
        })).catch(() => {});
      } catch { /* Best effort; server timeout still bounds the worker. */ }
    };
    turn.signal.addEventListener("abort", cancelTask, { once: true });
    const emit = (event: ChatStreamEvent) => {
      if (turn.signal.aborted) return;
      if (event.type === "done" || event.type === "error") terminal = true;
      if (event.type === "content" && event.delta) hasPartialText = true;
      opts.onEvent(event);
    };
    const deadline = setTimeout(() => {
      if (!terminal) emit({ type: "error", message: "回复生成超时，请重新发送" });
      turn.abort();
    }, chatPollTiming.deadlineMs);

    try {
      if (turn.signal.aborted) return;
      const recall = hydrateDesktopContext(opts);
    if (recall) await recall;
      if (turn.signal.aborted) return;
      const body = chatTurnBody(opts);
      emit({ type: "status", text: "submitting" });
      for (let attempt = 0; !turn.signal.aborted; attempt += 1) {
        const result = await this.streamAttempt(body, turn.signal, (payload) => {
          try {
            const frame = JSON.parse(payload) as Record<string, unknown> | null;
            taskId = firstString(frame?.task_id, frame?.taskId) ?? taskId;
          } catch { /* Raw text deltas do not carry a task id. */ }
          const events = parseChatStreamData(payload);
          for (const event of events) {
            // The server may send the confirmation after done. Keep that
            // frame, but never turn a completed answer into a network error.
            if (!terminal || event.type === "confirm") emit(event);
          }
          return events.some((event) => event.type === "error");
        });
        if (turn.signal.aborted || terminal) return;

        if (!result.receivedFrame && isBusySubmitError(result.error)) {
          if (attempt >= chatPollTiming.maxSubmitRetries) {
            emit({ type: "error", message: submitErrorMessage(result.error) });
            return;
          }
          emit({ type: "status", text: "retrying" });
          await sleep(chatPollTiming.submitRetryDelayMs * 2 ** attempt, () => turn.signal.aborted);
          if (!turn.signal.aborted) emit({ type: "status", text: "submitting" });
          continue;
        }

        const error = result.error;
        if (error instanceof ApiError && (
          isIdentityFailureError(error) ||
          ![0, 404, 405, 408].includes(error.status) && error.status < 500
        )) {
          emit({ type: "error", message: submitErrorMessage(error) });
          return;
        }

        // EOF without done is also a dropped stream. Fall back once, keeping
        // the same pending message and request fields. If text already arrived,
        // leave it visible until poll's authoritative done replaces it; replaying
        // a new answer's deltas here would append duplicate or divergent text.
        emit({ type: "status", text: "retrying" });
        const poll = new PollChatTransport();
        const suppressRecoveryText = hasPartialText;
        const recoveryOpts: SendChatOptions = {
          ...opts,
          signal: turn.signal,
          onTaskId: (id) => {
            taskId = id;
            if (turn.signal.aborted) cancelTask();
          },
          onEvent: (event) => {
            if (event.type !== "content" || !suppressRecoveryText) emit(event);
          },
        };
        let settleAbort!: () => void;
        const aborted = new Promise<void>((resolve) => { settleAbort = resolve; });
        turn.signal.addEventListener("abort", settleAbort, { once: true });
        try {
          await Promise.race([
            taskId ? poll.resume(taskId, recoveryOpts) : poll.send(recoveryOpts),
            aborted,
          ]);
        } finally {
          turn.signal.removeEventListener("abort", settleAbort);
          poll.cancel();
        }
        return;
      }
    } finally {
      clearTimeout(deadline);
      turn.signal.removeEventListener("abort", cancelTask);
      opts.signal?.removeEventListener("abort", abort);
      if (this.turnController === turn) this.turnController = null;
    }
  }

  cancel(): void {
    this.turnController?.abort();
    this.streamController?.abort();
  }

  private streamAttempt(
    body: Record<string, unknown>,
    signal: AbortSignal,
    onChunk: (payload: string) => boolean,
  ): Promise<{ error?: unknown; receivedFrame: boolean }> {
    return new Promise((resolve) => {
      let settled = false;
      let receivedFrame = false;
      let controller: AbortController | null = null;
      const finish = (error?: unknown) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", abort);
        if (this.streamController === controller) this.streamController = null;
        controller?.abort();
        resolve({ error, receivedFrame });
      };
      const abort = () => finish();
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) { finish(); return; }
      try {
        controller = api().stream(
          chatStreamPath(), body,
          (payload) => {
            if (settled || signal.aborted) return;
            if (payload) receivedFrame = true;
            // Explicit backend errors are terminal even if the socket stays open.
            if (onChunk(payload)) finish();
          },
          (error) => finish(error),
          () => finish(),
          { baseUrl: chatAgentBaseUrl(), sessionToken: typeof body.token === "string" ? body.token : undefined },
        );
        // Mocks and adapters can complete synchronously before returning a controller.
        if (settled || signal.aborted) controller.abort();
        else this.streamController = controller;
      } catch (error) { finish(error); }
    });
  }
}
