import { api } from "@lynse/core/api";

// ── Bot channel contracts (channel-agnostic) ────────────────────────────────

/** Channels the frontend iterates (settings UI, auth supervisor). Keep in
 *  sync with the Rust `bots.rs` registry. */
export const BOT_CHANNELS = ["feishu"] as const;

export type BotChannelId = (typeof BOT_CHANNELS)[number];

/** Unified inbound message: every channel normalizes to this shape in its
 *  Rust layer before emitting on the `bot-event` webview event. */
export interface BotIncomingMessage {
  /** "feishu" | "dingtalk" | … */
  channel: string;
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

export type BotChannelState =
  | "disabled"
  | "connecting"
  | "online"
  | "reconnecting"
  | "error";

/** Connection snapshot; `reason` explains supervisor-driven pauses
 *  (`logged_out`) so the UI can show "paused, not broken". */
export interface BotChannelStatus {
  state: BotChannelState;
  error?: string | null;
  reason?: string | null;
  updatedAt: string;
}

/** Per-channel config shape. Only `enabled` is universal; the rest belongs
 *  to the channel's own settings surface. */
export interface BotChannelConfig {
  enabled: boolean;
  [key: string]: unknown;
}

/** Outbound actions the answering agent needs from a channel. Implementations
 *  bridge to per-channel Rust commands. */
export interface BotOutboundApi {
  replyText(messageId: string, text: string): Promise<unknown>;
  replyMarkdown(messageId: string, markdown: string): Promise<unknown>;
  streamStart(
    replyTo: string,
    markdown: string,
  ): Promise<{ cardId: string; messageId: string }>;
  streamPush(cardId: string, markdown: string, sequence: number): Promise<void>;
  streamFinish(cardId: string, markdown: string, sequence: number): Promise<void>;
  /** Fallback typewriter for channels without streaming: PATCH a sent card
   *  in place. Absent → the agent degrades to one-shot replies. */
  updateMarkdownCard?(messageId: string, markdown: string): Promise<unknown>;
}

/** Bridge surface every desktop app exposes as `window.desktopAPI.bots`. */
export interface DesktopBotsApi {
  config(channel: string): Promise<BotChannelConfig>;
  save(
    channel: string,
    config: BotChannelConfig,
    secret?: string | null,
  ): Promise<BotChannelConfig>;
  reset(channel: string): Promise<BotChannelConfig>;
  start(channel: string): Promise<BotChannelStatus>;
  stop(channel: string, reason?: string): Promise<BotChannelStatus>;
  state(channel: string): Promise<BotChannelStatus>;
  /** Per-channel outbound actions; null for unknown channels. */
  outbound(channel: string): BotOutboundApi | null;
  onEvent(callback: (event: BotIncomingMessage) => void): Promise<() => void>;
}

export function getDesktopBotsApi(): DesktopBotsApi | null {
  if (typeof window === "undefined") return null;
  const desktopWindow = window as Window & {
    desktopAPI?: { bots?: DesktopBotsApi };
  };
  return desktopWindow.desktopAPI?.bots ?? null;
}

// ── Auth provider seam ──────────────────────────────────────────────────────

/**
 * Step one of the bot-auth plan: the bot answers with the logged-in user's
 * token — null while logged out, and the supervisor pauses channels then.
 * Step two, once the backend ships a bot-scoped (session-independent) token:
 * replace this function's body and the whole answering pipeline keeps
 * working across logout / device swaps with zero other changes.
 */
export function getBotToken(): string | null {
  return api().getToken();
}
