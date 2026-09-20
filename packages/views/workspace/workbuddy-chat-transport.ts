import type { ChatAttachment } from "./types";
import {
  callWorkBuddyOpenApi,
  WORKBUDDY_ERROR,
} from "@lynse/core/auth/workbuddy";
import type { ChatTransport, SendChatOptions } from "./chat-transport";
import { chatPollTiming } from "./chat-transport";

/**
 * WorkBuddy local-assistant chat transport (OpenAPI v2).
 *
 * The local assistant exposes no push channel and no per-turn task id —
 * a turn is: `POST /localassistant/message`, then short-poll the shared
 * `GET /localassistant/message` history until the assistant's reply lands.
 * The history stream is continuous across turns (and devices), so the turn
 * snapshots the newest server message ids BEFORE posting and only considers
 * messages past that baseline.
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
};

const HISTORY_PATH = "/localassistant/message";

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

/** True when the error means "send the user through WorkBuddy authorization". */
export function isWorkBuddyAuthError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return (
    message === WORKBUDDY_ERROR.NOT_BOUND || message === WORKBUDDY_ERROR.TOKEN_EXPIRED
  );
}

const AUTH_ERROR_EVENT = {
  type: "error",
  message: "Work buddy 尚未授权，请先完成授权",
  workbuddyAuthRequired: true,
} as const;

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
  for (let at = from; at < fullText.length; at += sliceSize) {
    if (cancelled()) return;
    onEvent({ type: "content", delta: fullText.slice(at, at + sliceSize) });
    if (at + sliceSize < fullText.length) await sleep(tickMs, cancelled);
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

    // Baseline: everything already in the thread predates this turn. One GET
    // per turn is enough — replies during the turn are new ids by definition.
    let baselineIds = new Set<string>();
    try {
      const before = await callWorkBuddyOpenApi<WorkBuddyEnvelope>(
        `${HISTORY_PATH}?limit=50`,
      );
      baselineIds = new Set(
        extractWorkBuddyMessages(before)
          .map(workbuddyMessageId)
          .filter((id): id is string => !!id),
      );
    } catch (error) {
      if (isWorkBuddyAuthError(error)) {
        onEvent({ ...AUTH_ERROR_EVENT });
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
        onEvent({ type: "error", message: "发送失败，请稍后重试" });
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
            ? { ...AUTH_ERROR_EVENT }
            : { type: "error", message: "发送失败，请稍后重试" },
        );
      }
      return;
    }
    if (this.cancelled) return;

    await this.pollReplies(query, baselineIds, onEvent);
  }

  cancel(): void {
    this.cancelled = true;
  }

  /**
   * Poll the shared history until the quiet gap closes the turn. Messages
   * past the baseline are mirrored onto the local bubble; the user's own
   * echo only donates its server id. Renders in posting order so
   * multi-message turns (text, then a document) read sequentially.
   */
  private async pollReplies(
    query: string,
    baselineIds: Set<string>,
    onEvent: SendChatOptions["onEvent"],
  ): Promise<void> {
    const startedAt = Date.now();
    const seen = new Set(baselineIds);
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

      let messages: WorkBuddyServerMessage[] = [];
      let networkError: unknown;
      try {
        const body = await callWorkBuddyOpenApi<WorkBuddyEnvelope>(
          `${HISTORY_PATH}?limit=50`,
        );
        messages = extractWorkBuddyMessages(body);
      } catch (error) {
        networkError = error;
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
        if (message.metadata) {
          // Permission prompts and other structured payloads are not
          // interpreted yet — log for later contract work.
          console.debug("[workbuddy-chat] message metadata", message.metadata);
        }

        const text = workbuddyContentToText(message.content);
        const newAttachments = normalizeWorkBuddyAttachments(message.attachments);
        const knownLength = renderedLengths.get(id) ?? 0;
        if (!text && newAttachments.length === 0) continue;
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
          ? "Work buddy 回复超时，请稍后重试"
          : "Work buddy 没有返回内容，请稍后重试",
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
