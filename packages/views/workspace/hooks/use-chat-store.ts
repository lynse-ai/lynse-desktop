import { create } from "zustand";
import { api } from "@lynse/core/api";
import type {
  ChatAssistant,
  ChatMessage,
  ChatStreamEvent,
  ChatConfirm,
  ChatConversation,
  ChatAttachment,
  ChatToolUse,
} from "../types";
import {
  PollChatTransport,
  extractConfirmFromText,
  type ChatTransport,
} from "../chat-transport";
import {
  WorkBuddyChatTransport,
  fetchWorkBuddyThreadSlice,
  isWorkBuddyAuthError,
} from "../workbuddy-chat-transport";
import { redactMeetingIds } from "../meeting-id-redact";
import {
  isEmptyAssistantPlaceholder,
  stripAttachmentDuplicateImages,
} from "../chat-message-utils";
import {
  conversationTitle,
  loadAssistantChoice,
  loadChatHistory,
  saveAssistantChoice,
  saveChatHistory,
} from "../chat-history";
import { toast } from "sonner";
import { useNotificationStore } from "../../notifications/use-notification-store";

/**
 * Waiting-word pool for the assistant's tool calls. The backend sends a raw
 * "status" tick (e.g. "正在调用工具：search_meetings"); we map it to a tool
 * key and then cycle through a few scene-flavoured captions per locale while
 * the tool runs, so the wait feels alive instead of a frozen line.
 */
export const WAITING_POOL: Record<string, { zh: string; en: string; ja: string }[]> = {
  search_meetings: [
    { zh: "去翻翻你最近的会议记录…", en: "Flipping through your recent meetings…", ja: "最近の会議記録を探しています…" },
    { zh: "按关键词筛一遍…", en: "Filtering by keywords…", ja: "キーワードで絞り込み中…" },
    { zh: "把相关的会议挑出来…", en: "Picking out the relevant ones…", ja: "関連する会議を選び出しています…" },
  ],
  list_meetings: [
    { zh: "看看你都开了哪些会…", en: "Checking the meetings you've had…", ja: "これまでの会議を確認中…" },
    { zh: "按时间排个序…", en: "Sorting by time…", ja: "日時順に並べています…" },
    { zh: "整理成清单给你…", en: "Lining them up for you…", ja: "一覧にまとめています…" },
  ],
  get_meeting: [
    { zh: "把那场会议调出来看看…", en: "Pulling up that meeting…", ja: "その会議を表示中…" },
    { zh: "打开录音和纪要…", en: "Opening the recording and notes…", ja: "録音と議事録を開いています…" },
    { zh: "马上就好…", en: "Almost there…", ja: "もう少しです…" },
  ],
  search_notes: [
    { zh: "翻一下你的笔记宝库…", en: "Digging into your notes…", ja: "ノートを探しています…" },
    { zh: "按关键词捞一捞…", en: "Fishing out by keywords…", ja: "キーワードで引っ張り出しています…" },
    { zh: "把沾边的笔记都找来…", en: "Gathering the matching ones…", ja: "関連するノートを集めています…" },
  ],
  list_notes: [
    { zh: "理一理你的笔记…", en: "Going through your notes…", ja: "ノートを整理中…" },
    { zh: "按文件夹归个类…", en: "Grouping by folder…", ja: "フォルダごとに分けています…" },
    { zh: "列成清单给你看…", en: "Listing them out for you…", ja: "一覧にしてお見せします…" },
  ],
  get_note: [
    { zh: "把那条笔记翻出来…", en: "Pulling up that note…", ja: "そのノートを表示中…" },
    { zh: "打开内容看看…", en: "Opening its content…", ja: "内容を開いています…" },
    { zh: "这就来…", en: "Coming right up…", ja: "すぐです…" },
  ],
  create_note: [
    { zh: "帮你记一笔…", en: "Jotting that down…", ja: "メモを作成中…" },
    { zh: "把要点写进去…", en: "Writing in the key points…", ja: "要点を書き込んでいます…" },
    { zh: "存好了告诉你…", en: "I'll let you know once saved…", ja: "保存したらお知らせします…" },
  ],
  search_recordings: [
    { zh: "在录音库里扒拉扒拉…", en: "Rummaging through your recordings…", ja: "録音ライブラリを探しています…" },
    { zh: "按关键词翻一遍…", en: "Scanning by keywords…", ja: "キーワードで見て回っています…" },
    { zh: "把相关的录音揪出来…", en: "Pulling out the matching ones…", ja: "関連する録音を引き出しています…" },
  ],
  list_recordings: [
    { zh: "看看你都录了些啥…", en: "Checking what you've recorded…", ja: "録音一覧を確認中…" },
    { zh: "按日期排个序…", en: "Sorting by date…", ja: "日付順に並べています…" },
    { zh: "整理成清单…", en: "Tidying into a list…", ja: "一覧にまとめています…" },
  ],
  get_recording: [
    { zh: "把那段录音找出来…", en: "Locating that recording…", ja: "その録音を特定中…" },
    { zh: "定位到时间点…", en: "Pinpointing the timestamp…", ja: "位置を特定しています…" },
    { zh: "这就打开…", en: "Opening it up…", ja: "今開いています…" },
  ],
  transcribe: [
    { zh: "把声音变成文字…", en: "Turning speech into text…", ja: "音声を文字に変換中…" },
    { zh: "一句句听写中…", en: "Transcribing line by line…", ja: "一文ずつ書き起こしています…" },
    { zh: "快转完了…", en: "Almost done transcribing…", ja: "書き起こしもうすぐ終わりです…" },
  ],
  summarize: [
    { zh: "帮你理一理重点…", en: "Pulling out the key points…", ja: "要点をまとめています…" },
    { zh: "把长话短说…", en: "Condensing the long bits…", ja: "長い話を短くしています…" },
    { zh: "提炼成要点…", en: "Distilling into bullets…", ja: "箇条書きに絞り込んでいます…" },
  ],
  // Pending-stage captions emitted by the poll transport while a turn runs
  // (CHAT_PENDING_STAGE_KEYS in chat-transport.ts). Poll carries no per-tool
  // progress, so these elapsed-time stages stand in for the old tool pools.
  thinking: [
    { zh: "正在思考你的问题…", en: "Thinking about your question…", ja: "質問について考えています…" },
    { zh: "理一理思路…", en: "Getting thoughts in order…", ja: "思考を整理しています…" },
    { zh: "答案马上就来…", en: "Answer coming right up…", ja: "もうすぐ回答します…" },
  ],
  researching: [
    { zh: "翻翻你的会议和笔记…", en: "Digging through meetings and notes…", ja: "会議とノートを調べています…" },
    { zh: "把相关内容捞出来…", en: "Pulling up relevant content…", ja: "関連する内容を探しています…" },
    { zh: "比对几份资料…", en: "Cross-checking the material…", ja: "資料を照らし合わせています…" },
  ],
  composing: [
    { zh: "把答案组织成一段话…", en: "Putting the answer into words…", ja: "回答をまとめています…" },
    { zh: "润色一下表述…", en: "Polishing the wording…", ja: "表現を整えています…" },
    { zh: "这就来…", en: "Almost there…", ja: "もう少しです…" },
  ],
  // Unknown tool, or a generic "calling tool" status without a known name.
  __unknown__: [
    { zh: "搬个小工具帮你查查…", en: "Using a little tool to look it up…", ja: "小さなツールで調べています…" },
    { zh: "翻箱倒柜找资料中…", en: "Rummaging for the info…", ja: "情報をかき集めています…" },
    { zh: "马上就好，稍等…", en: "Almost there, one sec…", ja: "もう少しお待ちを…" },
  ],
};

/** Fallback used when a status isn't a recognized tool call at all. */
const STATUS_FALLBACK = "__unknown__";

/**
 * Map the raw backend "status" tick to a stable tool key (one of the keys in
 * WAITING_POOL) so the UI can rotate through the waiting words. Returns null
 * when the text is not a tool-call status, in which case the raw text is kept.
 */
export function classifyStatus(raw: string): string | null {
  if (!raw) return null;
  const match =
    raw.match(/[:：]\s*([a-z_][a-z0-9_]*)/i) ??
    raw.match(/calling tool\s+([a-z_][a-z0-9_]*)/i);
  const tool = match?.[1]?.toLowerCase();
  if (tool && WAITING_POOL[tool]) return tool;
  if (tool || /调用工具|calling tool|tool_call/i.test(raw)) return STATUS_FALLBACK;
  return null;
}

/**
 * Fold a tool event into the running list. A newly announced call closes any
 * still-spinning predecessor (the backend works sequentially), and done events
 * close the matching entry — by id when present, else the last running call
 * with the same name, else every running call.
 */
export function upsertToolUse(
  uses: ChatToolUse[] | undefined,
  name: string,
  id: string | undefined,
  state: "running" | "done",
): ChatToolUse[] {
  const list = uses ? [...uses] : [];
  const key = id || name;
  const index = list.findIndex((t) => t.id === key);

  if (state === "running") {
    const closed = list.map((t) => (t.state === "running" ? { ...t, state: "done" as const } : t));
    if (index >= 0) closed[index] = { ...closed[index]!, name, state: "running" };
    else closed.push({ id: key, name, state: "running" });
    return closed;
  }

  if (index >= 0) {
    list[index] = { ...list[index]!, state: "done" };
    return list;
  }
  return list.map((t) =>
    t.state === "running" && (!name || t.name === name) ? { ...t, state: "done" as const } : t,
  );
}

/** Mark every running tool done (used when the answer or the turn completes). */
export function closeRunningTools(uses: ChatToolUse[] | undefined): ChatToolUse[] | undefined {
  if (!uses?.some((t) => t.state === "running")) return uses;
  return uses.map((t) => (t.state === "running" ? { ...t, state: "done" as const } : t));
}

function makeId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** The single continuous WorkBuddy thread (locally: newest one wins). */
function latestWorkBuddyConversation(conversations: ChatConversation[]): ChatConversation | undefined {
  return conversations
    .filter((c) => c.provider === "workbuddy")
    .sort((a, b) => b.updatedAt - a.updatedAt)[0];
}

/** Newest cloud conversation, for restoring the panel/page's cloud view. */
function latestCloudConversation(conversations: ChatConversation[]): ChatConversation | undefined {
  return conversations
    .filter((c) => c.provider !== "workbuddy")
    .sort((a, b) => b.updatedAt - a.updatedAt)[0];
}

function readLynseToken(): string | null {
  // The shared client holds the live session token — on desktop the token
  // lives in the OS keychain, so localStorage is only a web fallback.
  try {
    const token = api().getToken();
    if (token) return token;
  } catch {
    /* client not initialized yet */
  }
  try {
    if (typeof localStorage !== "undefined") return localStorage.getItem("lynse_token");
  } catch {
    /* ignore */
  }
  return null;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string" && error) return error;
  if (error && typeof error === "object") {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message) return message;
    try {
      return JSON.stringify(error);
    } catch {
      /* fall through */
    }
  }
  return "Unknown error";
}

/**
 * How many conversations may stream an assistant reply at the same time.
 */
export const MAX_CONCURRENT_CHATS = 3;

/**
 * Global, module-level chat store.
 *
 * The store supports several conversations streaming at once (up to
 * `MAX_CONCURRENT_CHATS`): each turn gets its own transport/abort controller
 * registered in `runs` under its conversation id, so switching or starting
 * conversations never interrupts the others. The active conversation renders
 * through the `messages` buffer; background conversations stream straight
 * into their stored copy inside `conversations`.
 */
interface ChatStoreState {
  messages: ChatMessage[];
  /** True while the ACTIVE conversation is streaming a reply. */
  isLoading: boolean;
  conversations: ChatConversation[];
  activeConversationId: string | null;
  /** Which assistant the chat page is talking to ("小灵助手" or WorkBuddy). */
  activeAssistant: ChatAssistant;
  /** Cloud conversation to restore when switching back from WorkBuddy. */
  lastCloudConversationId: string | null;
  pendingConfirm: { messageId: string; confirm: ChatConfirm } | null;
  /** Conversations with a reply currently streaming (active + background). */
  workingConversationIds: string[];
  /** Completed-but-unseen replies per conversation id (drives the badge). */
  unreadCounts: Record<string, number>;
  /** Number of mounted chat UIs (chat page + right-panel). 0 = backgrounded. */
  chatVisible: number;
  /** Current user id, pushed in from React so non-React callbacks can persist. */
  userId: string;
  setUserId: (userId: string) => void;
  hydrate: () => void;
  setChatVisible: (visible: boolean) => void;
  setActiveAssistant: (assistant: ChatAssistant) => void;
  /** Pull newer WorkBuddy thread messages from the server into local history. */
  syncWorkBuddyThread: () => Promise<void>;
  sendMessage: (
    content: string,
    fileIds?: string | string[],
    userSpecifiedFile?: boolean,
    attachments?: ChatAttachment[],
    opts?: { assistant?: ChatAssistant },
  ) => void;
  answerConfirm: (messageId: string, value: string) => void;
  dismissConfirm: (messageId: string) => void;
  stopStreaming: () => void;
  clearMessages: () => void;
  selectConversation: (conversationId: string) => void;
  /** Jump to the conversation the badge points at: latest unread, else latest. */
  openLatestUnread: (preferredConversationId?: string) => void;
}

/** One in-flight assistant turn, owned by a single conversation. */
interface ChatRun {
  conversationId: string;
  assistantId: string;
  transport: ChatTransport;
  controller: AbortController;
}

// Engine state that doesn't need to trigger re-renders — kept at module scope.
const runs = new Map<string, ChatRun>();
let hydrated = false;

/**
 * Per-turn latency samples (in-memory only, reset on reload). Each turn logs
 * one `[chat-perf]` console line and feeds the `window.__lynseChatPerf()`
 * summary so first-token latency can be measured on real sessions:
 *
 *   首字     send → first visible content delta (what the user perceives)
 *   首个事件 send → first SSE event of any kind (status/meta/…)
 *   整轮     send → done (or abort/error)
 */
interface ChatPerfSample {
  at: number;
  firstEventMs?: number;
  firstContentMs?: number;
  totalMs: number;
  ok: boolean;
}

interface ChatPerfStats {
  count: number;
  mean: number;
  p50: number;
  p95: number;
  max: number;
}

const PERF_SAMPLES_MAX = 100;
const perfSamples: ChatPerfSample[] = [];

function perfStats(field: "firstEventMs" | "firstContentMs" | "totalMs"): ChatPerfStats | null {
  const values = perfSamples
    .map((sample) => sample[field])
    .filter((value): value is number => value != null)
    .sort((a, b) => a - b);
  if (!values.length) return null;
  return {
    count: values.length,
    mean: Math.round(values.reduce((sum, value) => sum + value, 0) / values.length),
    p50: values[Math.min(values.length - 1, Math.floor(values.length * 0.5))]!,
    p95: values[Math.min(values.length - 1, Math.floor(values.length * 0.95))]!,
    max: values[values.length - 1]!,
  };
}

if (typeof window !== "undefined") {
  const perfWindow = window as Window & { __lynseChatPerf?: () => unknown };
  if (!perfWindow.__lynseChatPerf) {
    perfWindow.__lynseChatPerf = () => ({
      samples: perfSamples.length,
      firstEvent: perfStats("firstEventMs"),
      firstContent: perfStats("firstContentMs"),
      total: perfStats("totalMs"),
    });
  }
}

export const useChatStore = create<ChatStoreState>((set, get) => {
  const setMessages = (updater: (prev: ChatMessage[]) => ChatMessage[]) =>
    set((s) => ({ messages: updater(s.messages) }));
  const setConversations = (updater: (prev: ChatConversation[]) => ChatConversation[]) =>
    set((s) => ({ conversations: updater(s.conversations) }));

  /** Mirror the run registry into store state (drives UI flags). */
  const syncRunState = () => {
    const workingIds = [...runs.keys()];
    set((s) => ({
      workingConversationIds: workingIds,
      isLoading: s.activeConversationId != null && workingIds.includes(s.activeConversationId),
    }));
  };

  const handleEvent = (evt: ChatStreamEvent, conversationId: string, assistantId: string) => {
    const isActive = () => get().activeConversationId === conversationId;

    // The active conversation renders through the `messages` buffer (the
    // persist subscription merges it back into `conversations`); background
    // conversations write straight into their stored copy.
    const writeMessage = (updater: (message: ChatMessage) => ChatMessage) => {
      if (isActive()) {
        setMessages((prev) => prev.map((m) => (m.id === assistantId ? updater(m) : m)));
        return;
      }
      setConversations((prev) =>
        prev.map((c) =>
          c.id === conversationId
            ? {
                ...c,
                updatedAt: Date.now(),
                messages: c.messages.map((m) => (m.id === assistantId ? updater(m) : m)),
              }
            : c,
        ),
      );
    };
    const findMessage = (): ChatMessage | undefined =>
      isActive()
        ? get().messages.find((m) => m.id === assistantId)
        : get()
            .conversations.find((c) => c.id === conversationId)
            ?.messages.find((m) => m.id === assistantId);

    switch (evt.type) {
      case "status": {
        // Status ticks double as tool announcements ("调用工具: search_meetings"),
        // so a classified status also opens/refreshes a ZCode-style tool row.
        const toolKey = classifyStatus(evt.text);
        writeMessage((m) => ({
          ...m,
          status: toolKey ?? evt.text,
          toolUses: toolKey ? upsertToolUse(m.toolUses, toolKey, undefined, "running") : m.toolUses,
        }));
        break;
      }
      case "content":
        writeMessage((m) => ({
          ...m,
          content: redactMeetingIds(m.content + evt.delta),
          // The answer is streaming: reasoning is over and pending tools finished.
          thinkingActive: false,
          toolUses: closeRunningTools(m.toolUses),
        }));
        break;
      case "thinking":
        writeMessage((m) => ({
          ...m,
          thinking: evt.delta ? (m.thinking ?? "") + evt.delta : m.thinking,
          thinkingActive: evt.delta ? true : false,
        }));
        break;
      case "tool":
        if (evt.name) {
          writeMessage((m) => ({
            ...m,
            toolUses: upsertToolUse(m.toolUses, evt.name, evt.id, evt.state ?? "running"),
          }));
        }
        break;
      case "meta":
        writeMessage((m) => ({
          ...m,
          sources: evt.sources ? evt.sources.map(redactMeetingIds) : m.sources,
          attachments: evt.attachments,
        }));
        break;
      case "done": {
        const current = findMessage();
        const finalContent = evt.text ?? current?.content ?? "";
        const detected = extractConfirmFromText(finalContent);
        writeMessage((m) => ({
          ...m,
          // Images the attachment cards already render (same signed URL) are
          // stripped from the body so the picture never shows twice.
          content: redactMeetingIds(
            stripAttachmentDuplicateImages(finalContent, evt.attachments),
          ),
          status: undefined,
          thinkingActive: false,
          toolUses: closeRunningTools(m.toolUses),
          sources: evt.sources ? evt.sources.map(redactMeetingIds) : m.sources,
          attachments: evt.attachments ?? m.attachments,
          humanSupportLink: evt.humanSupportLink,
          confirm: detected && !m.confirm ? detected : m.confirm,
          // Poll delivers the whole answer at once — let the UI play its
          // two-phase reveal (text first, attachments/cards after).
          revealedAt: Date.now(),
        }));
        // Confirm dialogs only pop for the conversation on screen; a
        // background conversation's choice menu stays as plain text until
        // that conversation is opened.
        if (detected && !current?.confirm && isActive()) {
          set({ pendingConfirm: { messageId: assistantId, confirm: detected } });
        }
        // A completed reply the user cannot see right now counts as unread:
        // either another conversation is on screen, or no chat UI at all.
        const seen = isActive() && get().chatVisible > 0;
        if (!seen) {
          set((s) => ({
            unreadCounts: {
              ...s.unreadCounts,
              [conversationId]: (s.unreadCounts[conversationId] ?? 0) + 1,
            },
          }));
          if (get().chatVisible === 0) {
            const doneProvider = get().conversations.find((c) => c.id === conversationId)?.provider;
            toast.success(doneProvider === "workbuddy" ? "Work buddy 已完成回复" : "小灵助手已完成回复");
          }
          // Mirror into the unified notification center (drives the Bell badge).
          const convTitle = (get().conversations.find((c) => c.id === conversationId)?.title ?? "").trim();
          const unread = get().unreadCounts[conversationId] ?? 1;
          useNotificationStore.getState().upsert({
            id: `chat:${conversationId}`,
            type: "chat",
            title: convTitle,
            count: unread,
            href: "/chat",
            read: false,
            createdAt: Date.now(),
          });
        }
        break;
      }
      case "confirm":
        writeMessage((m) => ({ ...m, confirm: evt.confirm }));
        if (isActive()) set({ pendingConfirm: { messageId: assistantId, confirm: evt.confirm } });
        break;
      case "workbuddy_seen": {
        // Mirror the server message id onto the local message so thread
        // catch-ups skip what a live turn already rendered.
        if (evt.role === "assistant") {
          writeMessage((m) => ({ ...m, serverId: evt.serverId }));
          break;
        }
        const markLastUser = (list: ChatMessage[]) => {
          for (let i = list.length - 1; i >= 0; i -= 1) {
            if (list[i]!.role === "user") {
              return list.map((m, index) =>
                index === i && !m.serverId ? { ...m, serverId: evt.serverId } : m,
              );
            }
          }
          return list;
        };
        if (isActive()) setMessages(markLastUser);
        else {
          setConversations((prev) =>
            prev.map((c) =>
              c.id === conversationId ? { ...c, messages: markLastUser(c.messages) } : c,
            ),
          );
        }
        break;
      }
      case "error":
        writeMessage((m) => ({
          ...m,
          // An authorization failure renders its own inline authorize card —
          // keep the placeholder content clean instead of "Error: <key>".
          content: evt.workbuddyAuthRequired ? m.content : m.content || `Error: ${evt.message}`,
          error: true,
          workbuddyAuthRequired: evt.workbuddyAuthRequired || m.workbuddyAuthRequired,
          status: undefined,
        }));
        break;
    }
  };

  const runSend = (
    content: string,
    fileIdsInput?: string | string[],
    userSpecifiedFile = false,
    attachments?: ChatAttachment[],
    confirmToken?: string | null,
    opts?: { assistant?: ChatAssistant },
  ) => {
    if (!content.trim()) return;
    const userId = get().userId;
    const assistant = opts?.assistant ?? get().activeAssistant;
    const fileIds = Array.isArray(fileIdsInput) ? fileIdsInput : fileIdsInput ? [fileIdsInput] : [];
    // Mentioned notes/groups scope retrieval just like a selected file does.
    const hasContextFiles = userSpecifiedFile || fileIds.length > 0;

    // One in-flight turn per conversation…
    if (get().activeConversationId && runs.has(get().activeConversationId!)) return;
    // …and at most MAX_CONCURRENT_CHATS conversations streaming at once. Check
    // before creating a new conversation so a rejected send leaves no empty
    // conversation behind.
    if (runs.size >= MAX_CONCURRENT_CHATS) {
      toast.error(`最多同时进行 ${MAX_CONCURRENT_CHATS} 个对话，请稍候`);
      return;
    }

    // Resolve the turn's conversation. WorkBuddy is a single continuous
    // thread: reuse it when it exists instead of starting a new conversation.
    let conversationId = get().activeConversationId;
    const currentConv = get().conversations.find((c) => c.id === conversationId);
    const currentMatches =
      assistant === "workbuddy"
        ? currentConv?.provider === "workbuddy"
        : currentConv != null && currentConv.provider !== "workbuddy";
    if (conversationId && currentMatches) {
      // keep the current conversation
    } else {
      // A null active id means "new chat" — always start a fresh conversation.
      // A non-null id whose provider belongs to the OTHER assistant (the
      // right-panel stays pinned to the cloud channel) resolves that side's
      // thread instead.
      const existing = conversationId
        ? assistant === "workbuddy"
          ? latestWorkBuddyConversation(get().conversations)
          : (get().lastCloudConversationId != null
              ? get().conversations.find(
                  (c) => c.id === get().lastCloudConversationId && c.provider !== "workbuddy",
                )
              : undefined) ?? latestCloudConversation(get().conversations)
        : undefined;
      if (existing) {
        conversationId = existing.id;
        set({ activeConversationId: conversationId, messages: existing.messages });
      } else {
        const now = Date.now();
        conversationId = makeId("conversation");
        const conversation: ChatConversation = {
          id: conversationId,
          title: conversationTitle(content),
          messages: [],
          provider: assistant === "workbuddy" ? "workbuddy" : "cloud",
          createdAt: now,
          updatedAt: now,
        };
        set((s) => ({
          activeConversationId: conversationId,
          conversations: [conversation, ...s.conversations],
        }));
      }
    }

    const assistantId = makeId("assistant");
    const userMsg: ChatMessage = {
      id: makeId("user"),
      role: "user",
      content,
      timestamp: Date.now(),
      // Remember the turn's context files so reply actions (e.g. filing the
      // assistant reply as a note summary) can resolve the target note.
      fileIds: fileIds.length > 0 ? fileIds : undefined,
      // Composer attachments (name/kind only — no hosted URL yet) so the sent
      // bubble shows what was attached.
      attachments: attachments?.length ? attachments : undefined,
    };
    const assistantMsg: ChatMessage = {
      id: assistantId,
      role: "assistant",
      content: "",
      timestamp: Date.now(),
    };
    setMessages((prev) => [...prev, userMsg, assistantMsg]);
    set({ isLoading: true });

    const transport: ChatTransport =
      assistant === "workbuddy" ? new WorkBuddyChatTransport() : new PollChatTransport();
    const controller = new AbortController();
    runs.set(conversationId, { conversationId, assistantId, transport, controller });
    syncRunState();

    const timing = {
      sentAt: performance.now(),
      firstEventAt: null as number | null,
      firstContentAt: null as number | null,
      completed: false,
      recorded: false,
    };
    const recordPerf = (ok: boolean) => {
      if (timing.recorded) return;
      timing.recorded = true;
      const sample: ChatPerfSample = {
        at: Date.now(),
        firstEventMs:
          timing.firstEventAt != null
            ? Math.round(timing.firstEventAt - timing.sentAt)
            : undefined,
        firstContentMs:
          timing.firstContentAt != null
            ? Math.round(timing.firstContentAt - timing.sentAt)
            : undefined,
        totalMs: Math.round(performance.now() - timing.sentAt),
        ok,
      };
      perfSamples.push(sample);
      if (perfSamples.length > PERF_SAMPLES_MAX) perfSamples.shift();
      const seconds = (ms?: number) => (ms == null ? "—" : `${(ms / 1000).toFixed(2)}s`);
      console.info(
        `[chat-perf] 首字 ${seconds(sample.firstContentMs)} · 首个事件 ${seconds(sample.firstEventMs)} · 整轮 ${seconds(sample.totalMs)} · ${ok ? "完成" : "中断"}`,
      );
    };

    transport
      .send({
        query: content,
        sessionId: conversationId,
        userId,
        fileIds,
        userSpecifiedFile: hasContextFiles,
        token: readLynseToken(),
        confirmToken,
        signal: controller.signal,
        onEvent: (evt) => {
          if (timing.firstEventAt == null) timing.firstEventAt = performance.now();
          if (evt.type === "content" && timing.firstContentAt == null) {
            timing.firstContentAt = performance.now();
          }
          if (evt.type === "done") {
            timing.completed = true;
            recordPerf(true);
          }
          handleEvent(evt, conversationId, assistantId);
        },
      })
      .then(() => {
        // A turn that resolves without `done` was aborted or cut short.
        recordPerf(timing.completed);
        // Poll has no partial content: a stopped turn leaves an empty
        // placeholder bubble that would otherwise spin "thinking" forever —
        // drop it. Anything renderable (error text, an attachment-only reply
        // like the weekly-report PDF whose body is empty server-side, the
        // WorkBuddy authorize card) keeps the message.
        const emptyPlaceholder = (m: ChatMessage) =>
          m.id === assistantId && isEmptyAssistantPlaceholder(m);
        setMessages((prev) => prev.filter((m) => !emptyPlaceholder(m)));
        setConversations((prev) =>
          prev.map((c) =>
            c.id === conversationId
              ? { ...c, messages: c.messages.filter((m) => !emptyPlaceholder(m)) }
              : c,
          ),
        );
        if (runs.get(conversationId)?.controller === controller) {
          runs.delete(conversationId);
          syncRunState();
        }
      })
      .catch((error: unknown) => {
        recordPerf(false);
        handleEvent({ type: "error", message: errorMessage(error) }, conversationId, assistantId);
        if (runs.get(conversationId)?.controller === controller) {
          runs.delete(conversationId);
          syncRunState();
        }
      });
  };

  return {
    messages: [],
    isLoading: false,
    conversations: [],
    activeConversationId: null,
    activeAssistant: "lynse",
    lastCloudConversationId: null,
    pendingConfirm: null,
    workingConversationIds: [],
    unreadCounts: {},
    chatVisible: 0,
    userId: "user",

    setUserId: (userId) => set({ userId }),

    hydrate: () => {
      if (hydrated) return;
      hydrated = true;
      const userId = get().userId;
      const history = loadChatHistory(userId);
      const active = history.conversations.find((c) => c.id === history.activeConversationId);
      set({
        conversations: history.conversations,
        activeConversationId: history.activeConversationId,
        messages: active?.messages ?? [],
      });
      // Restore the persisted assistant choice; WorkBuddy comes back with its
      // own thread on screen and a background catch-up for missed replies.
      const assistant = loadAssistantChoice(userId);
      if (assistant === "workbuddy") {
        const wb = latestWorkBuddyConversation(history.conversations);
        set({
          activeAssistant: "workbuddy",
          lastCloudConversationId: history.activeConversationId,
          activeConversationId: wb?.id ?? null,
          messages: wb?.messages ?? [],
        });
        void get().syncWorkBuddyThread();
      }
    },

    setActiveAssistant: (assistant) => {
      if (assistant === get().activeAssistant) return;
      saveAssistantChoice(get().userId, assistant);
      if (assistant === "workbuddy") {
        // Remember where the cloud view was so switching back restores it.
        const currentConv = get().conversations.find((c) => c.id === get().activeConversationId);
        const lastCloudId =
          currentConv && currentConv.provider !== "workbuddy"
            ? currentConv.id
            : get().lastCloudConversationId;
        const wb = latestWorkBuddyConversation(get().conversations);
        set({
          activeAssistant: "workbuddy",
          lastCloudConversationId: lastCloudId,
          activeConversationId: wb?.id ?? null,
          messages: wb?.messages ?? [],
          pendingConfirm: null,
        });
        void get().syncWorkBuddyThread();
      } else {
        const cloudId = get().lastCloudConversationId;
        const conv = cloudId
          ? get().conversations.find((c) => c.id === cloudId && c.provider !== "workbuddy")
          : undefined;
        set({
          activeAssistant: "lynse",
          activeConversationId: conv?.id ?? null,
          messages: conv?.messages ?? [],
          pendingConfirm: null,
        });
      }
    },

    syncWorkBuddyThread: async () => {
      if (get().activeAssistant !== "workbuddy") return;
      // A live turn owns the thread view; its own polling covers new messages.
      const inFlight = latestWorkBuddyConversation(get().conversations);
      if (inFlight && runs.has(inFlight.id)) return;
      let entries;
      try {
        entries = await fetchWorkBuddyThreadSlice();
      } catch (error) {
        if (!isWorkBuddyAuthError(error)) {
          console.warn("[workbuddy-chat] thread sync failed", error);
        }
        return;
      }
      if (entries.length === 0) return;
      const current = get();
      if (current.activeAssistant !== "workbuddy") return;
      let conv = latestWorkBuddyConversation(current.conversations);
      const known = new Set((conv?.messages ?? []).map((m) => m.serverId));
      const fresh = entries.filter((entry) => {
        if (known.has(entry.serverId)) return false;
        // User messages sent from this app before server ids were mirrored
        // carry none — match by identical content so they don't double up.
        if (
          entry.role === "user" &&
          (conv?.messages ?? []).some(
            (m) => m.role === "user" && !m.serverId && m.content.trim() === entry.content.trim(),
          )
        ) {
          return false;
        }
        return true;
      });
      if (fresh.length === 0) return;
      if (!conv) {
        const now = Date.now();
        const firstUser = entries.find((entry) => entry.role === "user");
        conv = {
          id: makeId("conversation"),
          title: conversationTitle(firstUser?.content || "Work buddy"),
          messages: [],
          provider: "workbuddy",
          createdAt: now,
          updatedAt: now,
        };
        set((s) => ({ conversations: [conv!, ...s.conversations] }));
      }
      const mapped: ChatMessage[] = fresh.map((entry) => ({
        id: makeId("wb"),
        role: entry.role,
        content: entry.content,
        timestamp: entry.timestamp,
        serverId: entry.serverId,
        attachments: entry.attachments.length ? entry.attachments : undefined,
      }));
      const merged = [...(conv.messages ?? []), ...mapped].sort((a, b) => a.timestamp - b.timestamp);
      const convId = conv.id;
      // When the thread is on screen the `messages` buffer must move too —
      // the persist subscriber would otherwise overwrite the merge. A null
      // active id (no local thread yet) activates the recovered one.
      const shouldActivate = get().activeConversationId == null;
      set((s) => ({
        activeConversationId: shouldActivate ? convId : s.activeConversationId,
        messages: shouldActivate || s.activeConversationId === convId ? merged : s.messages,
        conversations: s.conversations.map((c) =>
          c.id === convId ? { ...c, messages: merged, updatedAt: Date.now() } : c,
        ),
      }));
    },

    setChatVisible: (visible) => {
      set((s) => ({ chatVisible: Math.max(0, s.chatVisible + (visible ? 1 : -1)) }));
      // The active conversation is back on screen — mark its replies read.
      if (visible) {
        const id = get().activeConversationId;
        if (id && get().unreadCounts[id]) {
          set((s) => {
            const unreadCounts = { ...s.unreadCounts };
            delete unreadCounts[id];
            return { unreadCounts };
          });
          useNotificationStore.getState().markRead(`chat:${id}`);
        }
      }
    },

    sendMessage: (content, fileIds, userSpecifiedFile, attachments, opts) => {
      if (!content.trim()) return;
      runSend(content, fileIds, userSpecifiedFile, attachments, undefined, opts);
    },

    answerConfirm: (messageId, value) => {
      // The card's confirmToken must ride along as `confirm_token`, or the
      // backend treats the tap as a fresh question instead of a card answer.
      const confirmToken =
        get().messages.find((m) => m.id === messageId)?.confirm?.confirmToken ?? null;
      setMessages((prev) => prev.map((m) => (m.id === messageId ? { ...m, confirm: undefined } : m)));
      set({ pendingConfirm: null });
      runSend(value, undefined, false, undefined, confirmToken);
    },

    dismissConfirm: (messageId) => {
      setMessages((prev) => prev.map((m) => (m.id === messageId ? { ...m, confirm: undefined } : m)));
      set({ pendingConfirm: null });
    },

    stopStreaming: () => {
      // Stops only the ACTIVE conversation's turn; background chats keep going.
      const activeId = get().activeConversationId;
      const run = activeId ? runs.get(activeId) : undefined;
      if (!run) return;
      run.transport.cancel();
      run.controller.abort();
    },

    clearMessages: () => {
      // Start a new chat. Any running turn keeps streaming in the background
      // and writes into its own conversation — the user can stop it from the
      // composer after switching back to that conversation. WorkBuddy has a
      // single continuous server thread, so "new chat" does not apply there.
      if (get().activeAssistant === "workbuddy") return;
      set({
        activeConversationId: null,
        messages: [],
        pendingConfirm: null,
        isLoading: false,
      });
      const userId = get().userId;
      saveChatHistory(userId, { activeConversationId: null, conversations: get().conversations });
    },

    selectConversation: (conversationId) => {
      if (conversationId === get().activeConversationId) return;
      const conversation = get().conversations.find((c) => c.id === conversationId);
      if (!conversation) return;
      // Picking the WorkBuddy thread is an assistant switch, not a
      // conversation switch — it carries its own provider everywhere.
      if (conversation.provider === "workbuddy") {
        get().setActiveAssistant("workbuddy");
        return;
      }
      // Opening a conversation marks its replies read. Switching never
      // interrupts streams — every run writes into its own conversation.
      set((s) => {
        const unreadCounts = { ...s.unreadCounts };
        delete unreadCounts[conversationId];
        return {
          activeConversationId: conversationId,
          messages: conversation.messages,
          pendingConfirm: null,
          unreadCounts,
          isLoading: s.workingConversationIds.includes(conversationId),
        };
      });
      useNotificationStore.getState().markRead(`chat:${conversationId}`);
    },

    openLatestUnread: (preferredConversationId) => {
      get().hydrate();
      const { conversations, unreadCounts, selectConversation } = get();
      const preferred = preferredConversationId
        ? conversations.find((c) => c.id === preferredConversationId)
        : undefined;
      const byLatest = [...conversations].sort((a, b) => b.updatedAt - a.updatedAt);
      const target = preferred ?? byLatest.find((c) => unreadCounts[c.id]) ?? byLatest[0];
      if (target) selectConversation(target.id);
    },
  };
});

// Persist the active conversation (and history) whenever messages, the
// active conversation, or any conversation's stored copy changes (background
// streams write directly into `conversations`).
//
// Two stages with different timing needs:
//  - merging the `messages` buffer back into its conversation must happen
//    immediately on every change, or switching/starting conversations while a
//    turn streams would lose buffered messages;
//  - serializing everything to localStorage is the expensive part (~10x/s
//    while streaming), so that alone is debounced while any run is active.
const PERSIST_DEBOUNCE_MS = 800;
let persistTimer: ReturnType<typeof setTimeout> | null = null;
let syncing = false;

function syncActiveConversation(): void {
  // The merge's setState re-enters this subscriber synchronously (`map`
  // always yields a fresh array); guard against that.
  if (syncing) return;
  syncing = true;
  try {
    const { activeConversationId, conversations, messages } = useChatStore.getState();
    if (!activeConversationId) return;
    const updatedAt = messages.at(-1)?.timestamp ?? Date.now();
    useChatStore.setState({
      conversations: conversations.map((c) =>
        c.id === activeConversationId ? { ...c, messages, updatedAt } : c,
      ),
    });
  } finally {
    syncing = false;
  }
}

function saveChatHistoryNow(): void {
  const userId = useChatStore.getState().userId;
  const { activeConversationId, conversations } = useChatStore.getState();
  saveChatHistory(userId, { activeConversationId, conversations });
}

/** Selector: total unseen assistant replies across every conversation (drives the chat-icon badge). */
export const selectChatUnreadCount = (s: ChatStoreState): number =>
  Object.values(s.unreadCounts).reduce((acc, n) => acc + (n || 0), 0);

useChatStore.subscribe((state, prev) => {
  const messagesChanged = state.messages !== prev.messages;
  const activeChanged = state.activeConversationId !== prev.activeConversationId;
  const conversationsChanged = state.conversations !== prev.conversations;
  if (!messagesChanged && !activeChanged && !conversationsChanged) return;

  syncActiveConversation();

  if (state.workingConversationIds.length === 0) {
    if (persistTimer) {
      clearTimeout(persistTimer);
      persistTimer = null;
    }
    saveChatHistoryNow();
    return;
  }
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    syncActiveConversation();
    saveChatHistoryNow();
  }, PERSIST_DEBOUNCE_MS);
});
