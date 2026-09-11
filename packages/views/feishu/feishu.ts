import { useQuery } from "@tanstack/react-query";

// ── Bridge types (`window.desktopAPI.feishu`, desktop only) ─────────────────

/** Non-secret bot configuration. The App Secret lives only in the OS
 *  keychain (`lynse_feishu_app_secret`); `hasSecret` mirrors its existence. */
export interface FeishuConfig {
  appId: string;
  /** Group chat that summary pushes go to (empty until picked). */
  targetChatId: string;
  /** Keep the WS long connection running (also auto-starts on launch). */
  enabled: boolean;
  /** Push a summary card when a transcription/summary finishes. */
  pushSummary: boolean;
  /** Read-only: whether a secret exists in the keychain. */
  hasSecret?: boolean;
}

export type FeishuConnectionState =
  | "disabled"
  | "connecting"
  | "online"
  | "reconnecting"
  | "error";

export interface FeishuStatus {
  state: FeishuConnectionState;
  error?: string | null;
  updatedAt: string;
}

export interface FeishuChatSummary {
  chatId: string;
  name: string;
  /** "group" | "p2p" — picker only offers groups for summary pushes. */
  chatType?: string;
}

/** Confirmation session from `registerBegin` — one device-grant flow. */
export interface FeishuRegistrationStart {
  /** Confirmation URL: rendered as a QR code and offered as a browser link. */
  url: string;
  expiresInSecs: number;
  intervalSecs: number;
}

/** One `registerPoll` outcome. Terminal statuses clear the Rust session. */
export interface FeishuRegistrationPoll {
  status: "pending" | "success" | "denied" | "expired" | "failed";
  intervalSecs: number;
  error?: string | null;
  /** Saved config on success (hasSecret true, enabled true). */
  config?: FeishuConfig | null;
}

/** One `im.message.receive_v1` event, pre-normalized by the Rust layer. */
export interface FeishuIncomingMessage {
  eventId: string;
  eventType: string;
  messageId: string;
  chatId: string;
  /** "p2p" | "group" */
  chatType: string;
  messageType: string;
  senderId: string;
  /** "user" | "app" — the agent only answers users. */
  senderType: string;
  text: string;
  mentions: { key?: string; id?: string; name?: string }[];
  mentionedBot: boolean;
}

export interface DesktopFeishuApi {
  getConfig: () => Promise<FeishuConfig>;
  /** A non-empty `secret` is written to the OS keychain before saving. */
  saveConfig: (config: FeishuConfig, secret?: string | null) => Promise<FeishuConfig>;
  /** Wipe the bot setup: stop the connection, delete the keychain secret and
   *  restore defaults, so one-click registration can run again. */
  resetConfig: () => Promise<FeishuConfig>;
  start: () => Promise<FeishuStatus>;
  stop: () => Promise<FeishuStatus>;
  state: () => Promise<FeishuStatus>;
  /** Validates App ID + Secret against the Feishu token endpoint. */
  testConnection: () => Promise<{ ok: boolean; botName: string; openId: string }>;
  listChats: () => Promise<FeishuChatSummary[]>;
  sendText: (text: string, chatId?: string) => Promise<unknown>;
  sendSummaryCard: (payload: { title: string; summary: string; fileId?: string }) => Promise<unknown>;
  /** Threaded text reply (the agent's acknowledgement). */
  replyText: (messageId: string, text: string) => Promise<unknown>;
  /** Threaded markdown-card reply (the agent's answers). The response's
   *  `data.message_id` lets the caller patch that card later. */
  replyMarkdown: (messageId: string, markdown: string) => Promise<unknown>;
  /** Replace the markdown card on a previously sent interactive message —
   *  the fallback "typewriter" when Cardkit streaming is unavailable. */
  updateMarkdownCard: (messageId: string, markdown: string) => Promise<unknown>;
  /** Official Cardkit streaming: create a streaming card entity and reply in
   *  thread with it. `sequence` numbers below must increase per card. */
  streamStart: (replyTo: string, markdown: string) => Promise<{ cardId: string; messageId: string }>;
  /** Typewriter step: push the current full text (client renders the delta). */
  streamPush: (cardId: string, markdown: string, sequence: number) => Promise<void>;
  /** Deliver the final text and close streaming mode. */
  streamFinish: (cardId: string, markdown: string, sequence: number) => Promise<void>;
  /** One-click app creation (OAuth device grant): show `url` as a QR code,
   *  then poll until the status is terminal. On success the secret is stored
   *  in the keychain, the bot is enabled and started — no manual console
   *  setup needed. */
  registerBegin: (options?: { name?: string; desc?: string }) => Promise<FeishuRegistrationStart>;
  registerPoll: () => Promise<FeishuRegistrationPoll>;
  /** Called when the registration dialog closes without success. */
  registerCancel: () => Promise<void>;
  onState: (callback: (status: FeishuStatus) => void) => Promise<() => void>;
  onEvent: (callback: (event: FeishuIncomingMessage) => void) => Promise<() => void>;
}

export function getDesktopFeishuApi(): DesktopFeishuApi | null {
  if (typeof window === "undefined") return null;
  const desktopWindow = window as Window & {
    desktopAPI?: { feishu?: DesktopFeishuApi };
  };
  return desktopWindow.desktopAPI?.feishu ?? null;
}

// ── Config query ────────────────────────────────────────────────────────────

export const FEISHU_CONFIG_QUERY_KEY = ["feishu-config"] as const;
export const FEISHU_STATUS_QUERY_KEY = ["feishu-status"] as const;

export function useFeishuConfig() {
  const api = getDesktopFeishuApi();
  return useQuery({
    queryKey: FEISHU_CONFIG_QUERY_KEY,
    queryFn: () => api!.getConfig(),
    enabled: !!api,
    staleTime: Infinity,
  });
}

export function useFeishuStatus() {
  const api = getDesktopFeishuApi();
  return useQuery({
    queryKey: FEISHU_STATUS_QUERY_KEY,
    queryFn: () => api!.state(),
    enabled: !!api,
    refetchInterval: 15_000,
  });
}
