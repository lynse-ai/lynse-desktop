import { create } from "zustand";
import type {
  ChatMessage,
  ChatStreamEvent,
  ChatConfirm,
  ChatConversation,
} from "../types";
import {
  CloudChatTransport,
  extractConfirmFromText,
  type ChatTransport,
} from "../chat-transport";
import { redactMeetingIds } from "../meeting-id-redact";
import { conversationTitle, loadChatHistory, saveChatHistory } from "../chat-history";
import { toast } from "sonner";

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

function makeId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function readLynseToken(): string | null {
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
  sendMessage: (content: string, fileId?: string, userSpecifiedFile?: boolean) => void;
  answerConfirm: (messageId: string, value: string) => void;
  dismissConfirm: (messageId: string) => void;
  stopStreaming: () => void;
  clearMessages: () => void;
  selectConversation: (conversationId: string) => void;
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
      case "status":
        writeMessage((m) => ({ ...m, status: classifyStatus(evt.text) ?? evt.text }));
        break;
      case "content":
        writeMessage((m) => ({
          ...m,
          content: redactMeetingIds(m.content + evt.delta),
        }));
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
          content: redactMeetingIds(finalContent),
          status: undefined,
          sources: evt.sources ? evt.sources.map(redactMeetingIds) : m.sources,
          attachments: evt.attachments ?? m.attachments,
          confirm: detected && !m.confirm ? detected : m.confirm,
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
          if (get().chatVisible === 0) toast.success("AI 助手已完成回复");
        }
        break;
      }
      case "confirm":
        writeMessage((m) => ({ ...m, confirm: evt.confirm }));
        if (isActive()) set({ pendingConfirm: { messageId: assistantId, confirm: evt.confirm } });
        break;
      case "error":
        writeMessage((m) => ({
          ...m,
          content: m.content || `Error: ${evt.message}`,
          error: true,
          status: undefined,
        }));
        break;
    }
  };

  const runSend = (content: string, fileId?: string, userSpecifiedFile = false) => {
    if (!content.trim()) return;
    const userId = get().userId;

    let conversationId = get().activeConversationId;
    // One in-flight turn per conversation…
    if (conversationId && runs.has(conversationId)) return;
    // …and at most MAX_CONCURRENT_CHATS conversations streaming at once. Check
    // before creating a new conversation so a rejected send leaves no empty
    // conversation behind.
    if (runs.size >= MAX_CONCURRENT_CHATS) {
      toast.error(`最多同时进行 ${MAX_CONCURRENT_CHATS} 个对话，请稍候`);
      return;
    }

    if (!conversationId) {
      const now = Date.now();
      conversationId = makeId("conversation");
      const conversation: ChatConversation = {
        id: conversationId,
        title: conversationTitle(content),
        messages: [],
        provider: "cloud",
        createdAt: now,
        updatedAt: now,
      };
      set((s) => ({
        activeConversationId: conversationId,
        conversations: [conversation, ...s.conversations],
      }));
    }

    const assistantId = makeId("assistant");
    const userMsg: ChatMessage = {
      id: makeId("user"),
      role: "user",
      content,
      timestamp: Date.now(),
    };
    const assistantMsg: ChatMessage = {
      id: assistantId,
      role: "assistant",
      content: "",
      timestamp: Date.now(),
    };
    setMessages((prev) => [...prev, userMsg, assistantMsg]);
    set({ isLoading: true });

    const transport = new CloudChatTransport();
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
        fileIds: fileId ? [fileId] : [],
        userSpecifiedFile,
        token: readLynseToken(),
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
        }
      }
    },

    sendMessage: (content, fileId, userSpecifiedFile) => {
      if (!content.trim()) return;
      runSend(content, fileId, userSpecifiedFile);
    },

    answerConfirm: (messageId, value) => {
      setMessages((prev) => prev.map((m) => (m.id === messageId ? { ...m, confirm: undefined } : m)));
      set({ pendingConfirm: null });
      runSend(value);
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
      // composer after switching back to that conversation.
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
