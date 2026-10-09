import i18next from "i18next";
import type { ChatAttachment } from "./types";
import {
  callWorkBuddyOpenApi,
  getWorkBuddyOnlineStatus,
  WORKBUDDY_ERROR,
  WorkBuddyRateLimitError,
} from "@lynse/core/auth/workbuddy";
import type { ChatTransport, SendChatOptions } from "./chat-transport";
import { chatPollTiming, safeSliceEnd } from "./chat-transport";

/**
 * WorkBuddy local-assistant chat transport (OpenAPI v2).
 *
 * The local assistant exposes no push channel and no per-turn task id —
 * a turn is: `POST /localassistant/message`, then poll the shared
 * `GET /localassistant/message` history until the assistant's reply lands.
 * Polls use the documented incremental mode (`?message_id=<cursor>` returns
 * only later messages) so a turn costs one small request per tick instead of
 * re-downloading the whole window; the full-window `?limit=50` shape remains
 * the fallback while no cursor is known (baseline read failed). The history
 * stream is continuous across turns (and devices), so the turn snapshots the
 * newest server message id BEFORE posting and only considers messages past
 * that cursor — the id set stays as a second dedup line for servers that
 * ignore the parameter.
 *
 * Before posting, the assistant's online status is probed (`GET
 * /localassistant`): a message to an offline desktop client is never
 * answered, so the user would poll to the deadline for nothing.
 *
 * Server message ids are mirrored onto the local messages through
 * `workbuddy_seen` events: the later thread catch-up dedupes against them,
 * so a reply that a live turn already rendered is never appended twice.
 *
 * Replies arrive as complete messages, so each one is replayed through the
 * same client-side typewriter the poll transport uses, and the turn ends
 * after a quiet gap (assistant messages may come in bursts — a text plus a
 * requested document). Attachments ride the message's `attachments` array;
 * that is the "WorkBuddy sends you the missing document" channel.
 */

/** Poll timing, readable at send-time so tests can shrink the waits. */
export const workbuddyChatTiming = {
  intervalMs: 1_500,
  /** Overall turn budget, mirroring the cloud poll deadline. */
  deadlineMs: 190_000,
  /** Quiet gap after the last reply fragment before the turn is "done". */
  graceMs: 4_000,
  maxNetworkFailures: 5,
  /** Extra backoff after a rate-limited poll (not counted as a failure). */
  rateLimitWaitMs: 4_000,
};

const HISTORY_PATH = "/localassistant/message";

/** Localize at emit time; falls back to the zh copy when i18next has not
 *  been initialized yet (bare unit tests, pre-init windows). */
function wt(key: string, fallback: string): string {
  return i18next.isInitialized ? i18next.t(key) : fallback;
}

export interface WorkBuddyServerMessage {
  message_id?: string;
  id?: string;
  role?: string;
  msg_type?: string;
  content?: unknown;
  created_at?: string;
  attachments?: unknown;
  metadata?: unknown;
}

interface WorkBuddyEnvelope {
  code?: number;
  msg?: string;
  data?: unknown;
  messages?: unknown;
}

/** Flatten the WorkBuddy reply envelope into the message array. */
export function extractWorkBuddyMessages(
  body: WorkBuddyEnvelope | null | undefined,
): WorkBuddyServerMessage[] {
  if (!body || typeof body !== "object") return [];
  // Nonzero envelope code means the call itself failed.
  if (typeof body.code === "number" && body.code !== 0) return [];
  const candidates = [
    (body.data as WorkBuddyEnvelope | undefined)?.messages,
    Array.isArray(body.data) ? body.data : undefined,
    body.messages,
  ];
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) return candidate as WorkBuddyServerMessage[];
  }
  return [];
}

export function workbuddyMessageId(message: WorkBuddyServerMessage): string | null {
  if (typeof message.message_id === "string" && message.message_id) return message.message_id;
  if (typeof message.id === "string" && message.id) return message.id;
  return null;
}

/** Message `content` is documented as an array; accept strings and text blocks too. */
export function workbuddyContentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (part && typeof part === "object") {
        const r = part as Record<string, unknown>;
        if (typeof r.text === "string") return r.text;
        if (typeof r.content === "string") return r.content;
      }
      return "";
    })
    .join("");
}

const firstString = (...values: unknown[]): string | null => {
  for (const value of values) {
    if (typeof value === "string" && value) return value;
  }
  return null;
};

/** Normalize a history `attachments[]` entry into the UI's ChatAttachment. */
export function normalizeWorkBuddyAttachment(raw: unknown): ChatAttachment | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const url = firstString(r.download_url, r.downloadUrl, r.file_url, r.fileUrl, r.url, r.link);
  const name = firstString(r.filename, r.name, r.title);
  if (!url && !name) return null;
  return {
    id: firstString(r.id, r.file_id, r.fileId) ?? undefined,
    name: name ?? undefined,
    type: firstString(r.kind, r.type) ?? undefined,
    url: url ?? undefined,
    downloadUrl: url ?? undefined,
  };
}

export function normalizeWorkBuddyAttachments(raw: unknown): ChatAttachment[] {
  return (Array.isArray(raw) ? raw : [])
    .map(normalizeWorkBuddyAttachment)
    .filter((a): a is ChatAttachment => a != null);
}

/**
 * Heuristic permission-request marker: the documented `permission_response`
 * answer format is keyed by `requestId`, and the incoming request metadata
 * carries the same field. Textless assistant messages with such metadata are
 * surfaced instead of silently skipped — the previous behavior let the turn
 * sit out its whole deadline with nothing on screen.
 */
export function looksLikePermissionRequest(metadata: unknown): boolean {
  if (metadata == null) return false;
  const text = typeof metadata === "string" ? metadata : JSON.stringify(metadata);
  return !!text && text.includes("requestId");
}

/** Newest message by `created_at`; falls back to the raw-first (newest-first
 *  history order) entry when timestamps are missing or unparseable. */
export function newestWorkBuddyMessageId(messages: WorkBuddyServerMessage[]): string | null {
  let newest: WorkBuddyServerMessage | null = null;
  let newestAt = Number.NaN;
  for (const message of messages) {
    if (!workbuddyMessageId(message)) continue;
    if (!newest) {
      newest = message;
      newestAt = Date.parse(message.created_at ?? "");
      continue;
    }
    const at = Date.parse(message.created_at ?? "");
    if (!Number.isNaN(at) && (Number.isNaN(newestAt) || at >= newestAt)) {
      newest = message;
      newestAt = at;
    }
  }
  return newest ? workbuddyMessageId(newest) : null;
}

/** True when the error means "send the user through WorkBuddy authorization". */
export function isWorkBuddyAuthError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return (
    message === WORKBUDDY_ERROR.NOT_BOUND || message === WORKBUDDY_ERROR.TOKEN_EXPIRED
  );
}

function authErrorEvent() {
  return {
    type: "error",
    message: wt("workbuddy.chat_not_authorized", "WorkBuddy 尚未授权，请先完成授权"),
    workbuddyAuthRequired: true,
  } as const;
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
 * Replay finished text through the typewriter from `from` so a reply that
 * grew between polls only types its new tail.
 */
async function typewriter(
  fullText: string,
  from: number,
  onEvent: SendChatOptions["onEvent"],
  cancelled: () => boolean,
): Promise<void> {
  if (fullText.length <= from) return;
  const tickMs = Math.max(1, chatPollTiming.typewriterTickMs);
  const steps = Math.min(
    fullText.length - from,
    Math.max(1, Math.floor(chatPollTiming.typewriterMaxMs / tickMs)),
  );
  const sliceSize = Math.ceil((fullText.length - from) / steps);
  let at = from;
  while (at < fullText.length) {
    if (cancelled()) return;
    const end = safeSliceEnd(fullText, Math.min(at + sliceSize, fullText.length));
    onEvent({ type: "content", delta: fullText.slice(at, end) });
    at = end;
    if (at < fullText.length) await sleep(tickMs, cancelled);
  }
}

export class WorkBuddyChatTransport implements ChatTransport {
  readonly provider = "workbuddy" as const;
  private cancelled = false;

  async send(opts: SendChatOptions): Promise<void> {
    this.cancelled = false;
    opts.signal?.addEventListener("abort", () => this.cancel(), { once: true });
    const { query, onEvent, signal } = opts;
    onEvent({ type: "status", text: "thinking" });

    // A message to an offline desktop client is never answered — say so up
    // front instead of polling to the deadline. A failed probe is "unknown",
    // not "offline", and must not block the send.
    try {
      if (!(await getWorkBuddyOnlineStatus())) {
        onEvent({
          type: "error",
          message: wt(
            "workbuddy.chat_offline",
            "WorkBuddy 桌面端当前不在线，请打开 WorkBuddy 后重试",
          ),
        });
        return;
      }
    } catch (error) {
      console.warn(
        "[workbuddy-chat] online preflight failed, continuing:",
        error instanceof Error ? error.message : String(error),
      );
    }
    if (this.cancelled || signal?.aborted) return;

    // Baseline: everything already in the thread predates this turn. One GET
    // per turn is enough — replies during the turn are past the cursor by
    // definition. The newest baseline id seeds the incremental cursor.
    let baselineIds = new Set<string>();
    let cursor: string | null = null;
    try {
      const before = await callWorkBuddyOpenApi<WorkBuddyEnvelope>(
        `${HISTORY_PATH}?limit=50`,
      );
      const beforeMessages = extractWorkBuddyMessages(before);
      baselineIds = new Set(
        beforeMessages.map(workbuddyMessageId).filter((id): id is string => !!id),
      );
      cursor = newestWorkBuddyMessageId(beforeMessages);
    } catch (error) {
      if (isWorkBuddyAuthError(error)) {
        onEvent({ ...authErrorEvent() });
        return;
      }
      // A failed baseline read must not block the send; the echo matcher
      // below still keeps a concurrent foreign reply from being replayed.
      console.warn(
        "[workbuddy-chat] baseline read failed, continuing:",
        error instanceof Error ? error.message : String(error),
      );
    }
    if (this.cancelled || signal?.aborted) return;

    try {
      const post = await callWorkBuddyOpenApi<WorkBuddyEnvelope>(HISTORY_PATH, {
        method: "POST",
        body: { content: query, msg_type: "text" },
      });
      if (typeof post?.code === "number" && post.code !== 0) {
        onEvent({
          type: "error",
          message: wt("workbuddy.chat_send_failed", "发送失败，请稍后重试"),
        });
        return;
      }
    } catch (error) {
      console.error(
        "[workbuddy-chat] send failed:",
        error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error),
      );
      if (!this.cancelled) {
        onEvent(
          isWorkBuddyAuthError(error)
            ? { ...authErrorEvent() }
            : error instanceof WorkBuddyRateLimitError
              ? {
                  type: "error",
                  message: wt(
                    "workbuddy.chat_rate_limited",
                    "WorkBuddy 请求过于频繁，请稍后再试",
                  ),
                }
              : {
                  type: "error",
                  message: wt("workbuddy.chat_send_failed", "发送失败，请稍后重试"),
                },
        );
      }
      return;
    }
    if (this.cancelled) return;

    await this.pollReplies(query, baselineIds, cursor, onEvent);
  }

  cancel(): void {
    this.cancelled = true;
  }

  /**
   * Poll the shared history until the quiet gap closes the turn. Each poll
   * fetches incrementally past the cursor (`?message_id=…`); messages past
   * the baseline are mirrored onto the local bubble; the user's own echo
   * only donates its server id. Renders in posting order so multi-message
   * turns (text, then a document) read sequentially.
   */
  private async pollReplies(
    query: string,
    baselineIds: Set<string>,
    initialCursor: string | null,
    onEvent: SendChatOptions["onEvent"],
  ): Promise<void> {
    const startedAt = Date.now();
    const seen = new Set(baselineIds);
    let cursor = initialCursor;
    /** Rendered turn text so far, and how much of it the typewriter finished. */
    let accumulated = "";
    let typedCount = 0;
    /** server message id → rendered text length, for growth detection. */
    const renderedLengths = new Map<string, number>();
    const attachments: ChatAttachment[] = [];
    let networkFailures = 0;
    let firstReplyAt: number | null = null;
    let lastActivityAt = Date.now();

    while (!this.cancelled) {
      if (Date.now() - startedAt >= workbuddyChatTiming.deadlineMs) {
        this.finish(accumulated, attachments, onEvent, true);
        return;
      }
      const quietFor = Date.now() - lastActivityAt;
      if (firstReplyAt != null && quietFor >= workbuddyChatTiming.graceMs) {
        this.finish(accumulated, attachments, onEvent, false);
        return;
      }
      // Next wake-up: the interval, or the remaining grace, whichever ends first.
      const waitMs =
        firstReplyAt != null
          ? Math.min(workbuddyChatTiming.intervalMs, workbuddyChatTiming.graceMs - quietFor)
          : workbuddyChatTiming.intervalMs;
      await sleep(Math.max(50, waitMs), () => this.cancelled);
      if (this.cancelled) return;

      // Incremental past the cursor; full window while no cursor is known.
      const path = cursor
        ? `${HISTORY_PATH}?message_id=${encodeURIComponent(cursor)}`
        : `${HISTORY_PATH}?limit=50`;
      let messages: WorkBuddyServerMessage[] = [];
      let rateLimited = false;
      let networkError: unknown;
      try {
        const body = await callWorkBuddyOpenApi<WorkBuddyEnvelope>(path);
        messages = extractWorkBuddyMessages(body);
      } catch (error) {
        if (error instanceof WorkBuddyRateLimitError) {
          // Throttling is not a transport failure: keep the failure counter
          // at zero and back off longer before the next tick.
          rateLimited = true;
        } else {
          networkError = error;
        }
      }

      if (rateLimited) {
        await sleep(workbuddyChatTiming.rateLimitWaitMs, () => this.cancelled);
        continue;
      }
      if (networkError) {
        networkFailures += 1;
        console.error(
          `[workbuddy-chat] history GET failed (${networkFailures}/${workbuddyChatTiming.maxNetworkFailures})`,
          networkError,
        );
        if (networkFailures >= workbuddyChatTiming.maxNetworkFailures) {
          this.finish(accumulated, attachments, onEvent, true);
          return;
        }
        continue;
      }
      networkFailures = 0;

      for (const message of [...messages].reverse()) {
        const id = workbuddyMessageId(message);
        if (!id || seen.has(id)) continue;
        seen.add(id);

        if (message.role !== "assistant") {
          // The composer already rendered the user's own message locally —
          // record its server id so thread catch-ups skip the echo.
          if (workbuddyContentToText(message.content).trim() === query.trim()) {
            onEvent({ type: "workbuddy_seen", serverId: id, role: "user" });
          }
          continue;
        }
        const text = workbuddyContentToText(message.content);
        const newAttachments = normalizeWorkBuddyAttachments(message.attachments);
        if (!text && newAttachments.length === 0) {
          // A textless structured message (e.g. a permission prompt) used to
          // be dropped silently, stalling the turn with nothing on screen.
          // Surface it so the user knows to confirm on the WorkBuddy side,
          // and keep polling for the reply that follows the confirmation.
          if (message.metadata && looksLikePermissionRequest(message.metadata)) {
            lastActivityAt = Date.now();
            firstReplyAt ??= lastActivityAt;
            onEvent({ type: "workbuddy_seen", serverId: id, role: "assistant" });
            const notice = wt(
              "workbuddy.chat_permission_wait",
              "WorkBuddy 请求确认一项操作，请在 WorkBuddy 应用中完成确认",
            );
            accumulated += accumulated ? `\n\n${notice}` : notice;
            await typewriter(accumulated, typedCount, onEvent, () => this.cancelled);
            typedCount = accumulated.length;
          } else {
            console.debug("[workbuddy-chat] textless message", message.metadata);
          }
          continue;
        }

        const knownLength = renderedLengths.get(id) ?? 0;
        if (text.length <= knownLength && newAttachments.length === 0) continue;

        lastActivityAt = Date.now();
        firstReplyAt ??= lastActivityAt;
        onEvent({ type: "workbuddy_seen", serverId: id, role: "assistant" });

        if (text.length > knownLength) {
          const tail = text.slice(knownLength);
          if (accumulated.length > 0) accumulated += "\n\n";
          accumulated += tail;
          renderedLengths.set(id, text.length);
          await typewriter(accumulated, typedCount, onEvent, () => this.cancelled);
          typedCount = accumulated.length;
        }
        if (newAttachments.length > 0) {
          attachments.push(...newAttachments);
          onEvent({ type: "meta", sources: [], attachments: [...attachments] });
        }
      }

      // Advance the incremental cursor to the newest id in the batch, even
      // when the batch carried nothing renderable.
      const batchNewest = newestWorkBuddyMessageId(messages);
      if (batchNewest) cursor = batchNewest;
    }
  }

  private finish(
    text: string,
    attachments: ChatAttachment[],
    onEvent: SendChatOptions["onEvent"],
    interrupted: boolean,
  ): void {
    const finalText = text.trim();
    if (!finalText && attachments.length === 0) {
      onEvent({
        type: "error",
        message: interrupted
          ? wt("workbuddy.chat_timeout", "WorkBuddy 回复超时，请稍后重试")
          : wt("workbuddy.chat_empty_reply", "WorkBuddy 没有返回内容，请稍后重试"),
      });
      return;
    }
    onEvent({ type: "done", text: finalText, sources: [], attachments });
  }
}

/** One mapped history message for the thread catch-up. */
export interface WorkBuddyThreadEntry {
  serverId: string;
  role: "user" | "assistant";
  content: string;
  timestamp: number;
  attachments: ChatAttachment[];
}

/**
 * Read-only catch-up: pull the newest history slice for the WorkBuddy thread.
 * Used when the thread becomes active so replies that landed while the chat
 * was closed (or on another device) show up. Callers dedupe against local
 * messages via `serverId`.
 */
export async function fetchWorkBuddyThreadSlice(): Promise<WorkBuddyThreadEntry[]> {
  const body = await callWorkBuddyOpenApi<WorkBuddyEnvelope>(`${HISTORY_PATH}?limit=50`);
  return extractWorkBuddyMessages(body)
    .map((message) => {
      const serverId = workbuddyMessageId(message);
      if (!serverId) return null;
      const content = workbuddyContentToText(message.content);
      const attachments = normalizeWorkBuddyAttachments(message.attachments);
      if (!content && attachments.length === 0) return null;
      const parsedAt = message.created_at ? Date.parse(message.created_at) : NaN;
      return {
        serverId,
        role: message.role === "assistant" ? ("assistant" as const) : ("user" as const),
        content,
        timestamp: Number.isNaN(parsedAt) ? Date.now() : parsedAt,
        attachments,
      };
    })
    .filter((entry): entry is WorkBuddyThreadEntry => entry != null)
    .reverse(); // posting order
}
