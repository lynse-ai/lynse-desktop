import type {
  ChatProvider,
  ChatStreamEvent,
  ChatConfirm,
  ChatConfirmOption,
  QoderChatSessionState,
} from "./types";
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

export interface QoderChatConfig {
  configured: boolean;
  source: "keychain" | null;
  agentId: string;
  environmentId: string;
  lynseApiKeyConfigured: boolean;
}

export const QODER_SHARE_LYNSE_API_KEY_STORAGE_KEY = "lynse_qoder_share_lynse_api_key";

export interface QoderSessionOptions {
  shareLynseApiKey: boolean;
  lynseApiHost: string;
}

export type QoderChatBridgeEvent = ChatStreamEvent & { requestId: string };

export interface DesktopQoderChatApi {
  getConfig(): Promise<QoderChatConfig>;
  savePat(pat: string): Promise<QoderChatConfig>;
  createSession(options: QoderSessionOptions): Promise<string>;
  sendMessage(
    sessionId: string,
    message: string,
    requestId: string,
    afterEventId?: string,
  ): Promise<{ lastEventId?: string }>;
  cancel(sessionId: string): Promise<void>;
  onEvent(callback: (event: QoderChatBridgeEvent) => void): Promise<() => void>;
}

export function getDesktopQoderChatApi(): DesktopQoderChatApi | null {
  if (typeof window === "undefined") return null;
  return (
    window as Window & { desktopAPI?: { qoderChat?: DesktopQoderChatApi } }
  ).desktopAPI?.qoderChat ?? null;
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
  if (p.type === "confirm") {
    const confirm = normalizeConfirm(p.confirm);
    if (confirm) return { type: "confirm", confirm };
  }

  if (typeof p.content === "string") return { type: "content", delta: p.content };
  if (typeof p.text === "string") return { type: "content", delta: p.text };
  if (typeof p.delta === "string") return { type: "content", delta: p.delta };
  const choice = p.choices?.[0]?.delta?.content;
  if (typeof choice === "string") return { type: "content", delta: choice };
  return null;
}

/**
 * Validate / normalize a raw `confirm` payload (from the backend or a2UI-style
 * protocol) into a ChatConfirm. Returns null if it is not a usable prompt
 * (e.g. fewer than 2 options).
 */
export function normalizeConfirm(raw: unknown): ChatConfirm | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const question = typeof r.question === "string" ? r.question : "";
  const optionsRaw = Array.isArray(r.options) ? r.options : [];
  const options: ChatConfirmOption[] = [];
  for (const o of optionsRaw) {
    if (!o || typeof o !== "object") continue;
    const or = o as Record<string, unknown>;
    const label = typeof or.label === "string" ? or.label : "";
    const value = typeof or.value === "string" ? or.value : "";
    if (!label && !value) continue;
    options.push({ label: label || value, value: value || label });
  }
  if (options.length < 2 || options.length > 8) return null;
  return { question: question.trim(), options };
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

export class QoderChatTransport implements ChatTransport {
  readonly provider = "qoder" as const;
  private sessionId: string | null = null;
  private afterEventId: string | undefined;
  private activeRequestId: string | null = null;
  private activeUnlisten: (() => void) | null = null;
  private sessionOptionsKey: string | null = null;

  constructor(
    initialState?: QoderChatSessionState,
    private readonly onSessionState?: (state: QoderChatSessionState) => void,
  ) {
    if (typeof initialState?.sessionId === "string" && initialState.sessionId.startsWith("sess_")) {
      this.sessionId = initialState.sessionId;
      this.afterEventId = initialState.afterEventId;
      this.sessionOptionsKey = initialState.sessionOptionsKey;
    }
  }

  private notifySessionState(): void {
    if (!this.sessionId || !this.sessionOptionsKey) return;
    this.onSessionState?.({
      sessionId: this.sessionId,
      afterEventId: this.afterEventId,
      sessionOptionsKey: this.sessionOptionsKey,
    });
  }

  async send(opts: SendChatOptions): Promise<void> {
    const api = getDesktopQoderChatApi();
    if (!api) throw new Error("小灵助手仅可在桌面端使用");

    const sessionOptions: QoderSessionOptions = {
      shareLynseApiKey:
        window.localStorage.getItem(QODER_SHARE_LYNSE_API_KEY_STORAGE_KEY) === "1",
      lynseApiHost:
        window.localStorage.getItem("lynse_api_url")?.trim() || "https://api.lynse.cn",
    };
    const sessionOptionsKey = JSON.stringify(sessionOptions);
    if (!this.sessionId || this.sessionOptionsKey !== sessionOptionsKey) {
      opts.onEvent({ type: "status", text: "小灵助手 · 正在创建会话" });
      this.sessionId = await api.createSession(sessionOptions);
      this.afterEventId = undefined;
      this.sessionOptionsKey = sessionOptionsKey;
      this.notifySessionState();
    }

    const requestId = `qoder-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this.activeRequestId = requestId;
    const unlisten = await api.onEvent((event) => {
      if (event.requestId !== requestId || this.activeRequestId !== requestId) return;
      const { requestId: _requestId, ...chatEvent } = event;
      opts.onEvent(chatEvent as ChatStreamEvent);
    });
    this.activeUnlisten = unlisten;

    try {
      let result: { lastEventId?: string };
      try {
        result = await api.sendMessage(
          this.sessionId,
          opts.query,
          requestId,
          this.afterEventId,
        );
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        if (!message.includes("HTTP 409 Conflict") || !message.includes("currently processing")) {
          throw error;
        }
        opts.onEvent({
          type: "status",
          text: "小灵助手 · 上一轮仍在运行，正在切换到新会话",
        });
        this.sessionId = await api.createSession(sessionOptions);
        this.afterEventId = undefined;
        this.sessionOptionsKey = sessionOptionsKey;
        this.notifySessionState();
        result = await api.sendMessage(
          this.sessionId,
          opts.query,
          requestId,
          undefined,
        );
      }
      if (this.activeRequestId === requestId) {
        this.afterEventId = result.lastEventId;
        this.notifySessionState();
      }
    } finally {
      unlisten();
      if (this.activeUnlisten === unlisten) this.activeUnlisten = null;
      if (this.activeRequestId === requestId) this.activeRequestId = null;
    }
  }

  cancel(): void {
    this.activeRequestId = null;
    this.activeUnlisten?.();
    this.activeUnlisten = null;
    if (this.sessionId) {
      void getDesktopQoderChatApi()?.cancel(this.sessionId).catch(() => undefined);
    }
  }
}
