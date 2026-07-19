import type { ChatProvider, ChatStreamEvent } from "./types";
import { api } from "@lynse/core/api";

export interface SendChatOptions {
  query: string;
  sessionId: string;
  userId: string;
  fileIds: string[];
  userSpecifiedFile: boolean;
  token?: string | null;
  onEvent: (event: ChatStreamEvent) => void;
  signal?: AbortSignal;
}

/**
 * A chat backend. Implementations forward a single user turn and stream
 * typed ChatStreamEvents back through `onEvent`. `cancel()` stops the stream
 * and (where supported) aborts the upstream model request.
 */
export interface ChatTransport {
  readonly provider: ChatProvider;
  send(opts: SendChatOptions): Promise<void>;
  cancel(): void;
}

const CHAT_STREAM_PATH = "/api/business/ai/chat/stream";

/**
 * Map one SSE `data:` payload (without the `data:` prefix) onto a
 * ChatStreamEvent. Tolerant of the cloud backend shapes
 * ({content,text,delta,choices[].delta.content}) and the older forms.
 */
export function parseChatChunk(payload: string): ChatStreamEvent | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return { type: "content", delta: payload };
  }
  if (parsed == null || typeof parsed !== "object") return null;
  const p = parsed as Record<string, any>;

  if (p.type === "content" && typeof p.content === "string") return { type: "content", delta: p.content };
  if (p.type === "round_start" && typeof p.content === "string") return { type: "status", text: p.content };
  if (p.type === "status" && typeof p.text === "string") return { type: "status", text: p.text };
  if (p.type === "meta") return { type: "meta", sources: p.sources ?? [], attachments: p.attachments ?? [] };
  if (p.type === "done")
    return { type: "done", text: p.text, sources: p.sources, attachments: p.attachments };
  if (p.type === "error") return { type: "error", message: p.message || p.error || "error" };

  if (typeof p.content === "string") return { type: "content", delta: p.content };
  if (typeof p.text === "string") return { type: "content", delta: p.text };
  if (typeof p.delta === "string") return { type: "content", delta: p.delta };
  const choice = p.choices?.[0]?.delta?.content;
  if (typeof choice === "string") return { type: "content", delta: choice };
  return null;
}

export class CloudChatTransport implements ChatTransport {
  readonly provider = "cloud" as const;
  private controller: AbortController | null = null;

  async send(opts: SendChatOptions): Promise<void> {
    const { query, sessionId, fileIds, userSpecifiedFile, token, onEvent } = opts;
    const body: Record<string, unknown> = { query };
    if (fileIds.length && userSpecifiedFile) body.fileIds = fileIds;
    if (sessionId) body.sessionId = sessionId;
    if (token) body.token = token;
    await new Promise<void>((resolve) => {
      this.controller = api().stream(
        CHAT_STREAM_PATH,
        body,
        (data) => {
          const evt = parseChatChunk(data);
          if (evt) onEvent(evt);
        },
        (err) => {
          onEvent({ type: "error", message: err.message });
          resolve();
        },
        resolve,
      );
    });
    this.controller = null;
  }

  cancel(): void {
    this.controller?.abort();
    this.controller = null;
  }
}
