// ── Bridge types (`window.desktopAPI.feishu`, desktop only) ─────────────────
//
// The channel-agnostic answering pipeline lives in `@lynse/views/bots` — this
// module holds only Feishu-specific capabilities (device-grant registration,
// Cardkit streaming targets, chat listing, summary push).

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
  /** Supervisor-driven pause marker (`logged_out`), else null. */
  reason?: string | null;
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

export interface DesktopFeishuApi {
  getConfig: () => Promise<FeishuConfig>;
  /** A non-empty `secret` is written to the OS keychain before saving. */
  saveConfig: (config: FeishuConfig, secret?: string | null) => Promise<FeishuConfig>;
  start: () => Promise<FeishuStatus>;
  stop: () => Promise<FeishuStatus>;
  state: () => Promise<FeishuStatus>;
  /** Validates App ID + Secret against the Feishu token endpoint. */
  testConnection: () => Promise<{ ok: boolean; botName: string; openId: string }>;
  listChats: () => Promise<FeishuChatSummary[]>;
  sendText: (text: string, chatId?: string) => Promise<unknown>;
  sendSummaryCard: (payload: { title: string; summary: string; fileId?: string }) => Promise<unknown>;
  /** One-click app creation (OAuth device grant): show `url` as a QR code,
   *  then poll until the status is terminal. On success the secret is stored
   *  in the keychain, the bot is enabled and started — no manual console
   *  setup needed. */
  registerBegin: (options?: { name?: string; desc?: string }) => Promise<FeishuRegistrationStart>;
  registerPoll: () => Promise<FeishuRegistrationPoll>;
  /** Called when the registration dialog closes without success. */
  registerCancel: () => Promise<void>;
  onState: (callback: (status: FeishuStatus) => void) => Promise<() => void>;
}

export function getDesktopFeishuApi(): DesktopFeishuApi | null {
  if (typeof window === "undefined") return null;
  const desktopWindow = window as Window & {
    desktopAPI?: { feishu?: DesktopFeishuApi };
  };
  return desktopWindow.desktopAPI?.feishu ?? null;
}
