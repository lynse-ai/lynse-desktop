"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ComponentType, type ReactNode } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import {
  ArrowDown,
  ArrowUp,
  BookOpen,
  CalendarDays,
  Check,
  ChevronLeft,
  ChevronRight,
  Copy,
  FileText,
  Globe,
  Headphones,
  Image,
  Layers,
  ListChecks,
  ListOrdered,
  Loader2,
  Mic,
  NotePlus,
  Pencil,
  Plus,
  RefreshCw,
  ScrollText,
  Sparkles,
  Square,
  WorkBuddy,
} from "../icons";
import { Button } from "@lynse/ui/components/ui/button";
import { Textarea } from "@lynse/ui/components/ui/textarea";
import { ChatReplyBody } from "./chat-reply-body";
import { toast } from "sonner";
import { AssistantAvatar } from "../assistant";
import { useTranslation } from "@lynse/core/i18n/react";
import {
  getWorkBuddyToken,
  isWorkBuddyNotBoundError,
  runWorkBuddyAuthorization,
  workbuddyErrorCopy,
} from "@lynse/core/auth/workbuddy";
import { openExternalUrl, getDesktopAppApi } from "../app-update";
import { useNavigation } from "../navigation";
import { useChat } from "../workspace/hooks/use-chat";
import { extractSkillMarker, stripSkillMarker, type SkillMarker } from "../workspace/chat-skill-ref";
import { ChatModelPicker } from "../workspace/model-picker";
import { isBetaFeaturesUnlocked } from "../feature-flags";
import { useInsertConclusion, useNotes, fetchFileDetail } from "../workspace/hooks/use-files";
import { useFolders } from "../workspace/hooks/use-folders";
import { getWorkspaceState } from "../workspace/store";
import {
  getDesktopLocalTranscriptionApi,
  isLocalFileId,
  LOCAL_TRANSCRIPTION_FOLDER_ID,
} from "../workspace/local-transcription";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@lynse/ui/components/ui/popover";
import { WaitingText } from "../workspace/hooks/waiting-text";
import { ConfirmCard } from "../workspace/confirm-card";
import { hasWorkBuddyAcpBridge, hasWorkBuddyCloudScopes } from "@lynse/core/workbuddy";
import { isFreshlyRevealed } from "../workspace/chat-reveal";
import { ChatAttachments } from "./chat-attachments";
import { ChatConnectionCards } from "./chat-connection-cards";
import { ThinkingBlock, ToolActivity } from "./chat-reasoning";
import {
  mergeContextFileIds,
  type AttachmentDraft,
} from "./chat-attachment-upload";
import { ChatHistorySidebar } from "./chat-history-sidebar";
import { AssistantSwitcher } from "./assistant-switcher";
import { TitleBarSlot } from "../layout/app-title-bar";
import { MentionChips, MentionPicker } from "./chat-mention-picker";
import {
  activeMentions,
  collectMentionFileIds,
  detectMentionTrigger,
  filterMentionOptions,
  insertMentionText,
  removeMentionText,
  type ChatMention,
  type MentionDetection,
  type MentionOption,
  type MentionTrigger,
} from "./chat-mentions";
import { filterWorkspaceFilesByFolder } from "../workspace/middle-panel/file-list-filter";
import type { WorkspaceItem } from "../workspace/types";

/**
 * Rotating "what the assistant is doing right now" captions shown while the
 * model is thinking. WorkBuddy-style: instead of a static spinner, the wait
 * is made legible (and a little playful) by cycling through the steps a reply
 * usually goes through. Picked by UI locale, falls back to zh.
 */
const THINKING_STEPS: Record<string, string[]> = {
  zh: [
    "正在理解你的问题…",
    "检索相关资料…",
    "梳理关键信息…",
    "组织回答思路…",
    "润色一下表述…",
  ],
  en: [
    "Understanding your question…",
    "Retrieving relevant material…",
    "Highlighting key points…",
    "Organizing the response…",
    "Polishing the wording…",
  ],
  ja: [
    "質問を理解しています…",
    "関連資料を検索中…",
    "重要なポイントを整理中…",
    "回答を構成中…",
    "表現を整えています…",
  ],
};

function ThinkingIndicator() {
  const { t, i18n } = useTranslation();
  const steps: string[] =
    THINKING_STEPS[i18n.language?.split("-")[0] ?? "zh"] ?? THINKING_STEPS.zh ?? [];
  const [stepIndex, setStepIndex] = useState(0);

  useEffect(() => {
    setStepIndex(0);
    const id = setInterval(() => {
      setStepIndex((prev) => (prev + 1) % steps.length);
    }, 1600);
    return () => clearInterval(id);
  }, [steps.length]);

  return (
    <div
      className="flex h-6 items-center gap-2 text-muted-foreground"
      aria-label={t("chat.thinking")}
    >
      <span className="flex items-center gap-1" aria-hidden="true">
        <span className="size-1.5 animate-bounce rounded-full bg-primary [animation-delay:0ms]" />
        <span className="size-1.5 animate-bounce rounded-full bg-primary [animation-delay:150ms]" />
        <span className="size-1.5 animate-bounce rounded-full bg-primary [animation-delay:300ms]" />
      </span>
      <span key={stepIndex} className="text-13 animate-in fade-in duration-300">
        {steps[stepIndex]}
      </span>
    </div>
  );
}

export function ChatPage() {
  const [input, setInput] = useState("");
  // Skill quick prompts hide their `skill://` marker from the composer: the
  // chip drops only the prompt body and the marker waits here until the send
  // re-attaches it, so the backend agent still receives the skill reference.
  // The chip above the composer shows the marker's label while it is pending.
  const [pendingSkillMarker, setPendingSkillMarker] = useState<SkillMarker | null>(null);
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null);
  const [insertingMessageId, setInsertingMessageId] = useState<string | null>(null);
  const [insertedMessageId, setInsertedMessageId] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const reduceMotion = useReducedMotion();
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const { t } = useTranslation();
  const { push } = useNavigation();
  const {
    messages,
    isLoading,
    conversations,
    activeConversationId,
    activeAssistant,
    workingConversationIds,
    sendMessage,
    clearMessages,
    selectConversation,
    stopStreaming,
    answerConfirm,
    dismissConfirm,
    setActiveAssistant,
  } = useChat({ persistHistory: true });
  const isWorkBuddy = activeAssistant === "workbuddy";
  const isWorkBuddyCloud = isWorkBuddy && hasWorkBuddyAcpBridge();
  const showHistory = historyOpen && (!isWorkBuddy || isWorkBuddyCloud);
  const activeConversation = conversations.find((conversation) => conversation.id === activeConversationId);
  const isLegacyWorkBuddy = isWorkBuddyCloud && activeConversation?.provider === "workbuddy" && !activeConversation.workbuddySession;
  // Active conversation's provider drives the per-message label/avatar (one
  // conversation never mixes providers, so a single lookup covers the buffer).
  const activeProvider = useMemo(
    () => conversations.find((c) => c.id === activeConversationId)?.provider,
    [conversations, activeConversationId],
  );
  const streamingMessageId = isLoading ? messages[messages.length - 1]?.id : undefined;

  // ── WorkBuddy authorization state ───────────────────────
  // The thread needs an authorized ticket; the chat page offers the same
  // browser authorization flow the settings card runs, inline.
  const [wbAuth, setWbAuth] = useState<"unknown" | "ok" | "no">("unknown");
  const [wbAuthorizing, setWbAuthorizing] = useState(false);
  const wbAuthorizeAttemptRef = useRef(0);

  const checkWorkBuddyAuth = useCallback(() => {
    let cancelled = false;
    getWorkBuddyToken()
      .then((info) => {
        if (!cancelled) setWbAuth(info.authorized && !info.expired && (!isWorkBuddyCloud || hasWorkBuddyCloudScopes(info.scope)) ? "ok" : "no");
      })
      .catch((error: unknown) => {
        // Unbound is the normal first-run state, not an error.
        if (!cancelled && !isWorkBuddyNotBoundError(error)) console.warn("[workbuddy-chat] auth check failed", error);
        if (!cancelled) setWbAuth("no");
      });
    return () => {
      cancelled = true;
    };
  }, [isWorkBuddyCloud]);

  useEffect(() => {
    if (activeAssistant !== "workbuddy") return;
    return checkWorkBuddyAuth();
  }, [activeAssistant, checkWorkBuddyAuth]);

  // A turn that failed on authorization flips the banner on immediately.
  useEffect(() => {
    if (isWorkBuddy && messages.findLast((message) => message.role === "assistant")?.workbuddyAuthRequired) setWbAuth("no");
  }, [messages, isWorkBuddy]);

  // Leaving the page cancels a running authorization poll.
  useEffect(
    () => () => {
      wbAuthorizeAttemptRef.current += 1;
    },
    [],
  );

  const startWorkBuddyAuthorize = useCallback(async () => {
    if (wbAuthorizing) return;
    setWbAuthorizing(true);
    const attempt = ++wbAuthorizeAttemptRef.current;
    try {
      // Shared runner (same loop the settings card uses): the poll only
      // resolves once the stored binding actually moves, so the banner flips
      // to "ok" on a real consent, not on a stale pre-existing grant.
      const grant = await runWorkBuddyAuthorization({
        cloud: isWorkBuddyCloud,
        openUrl: (url) => {
          if (getDesktopAppApi()) openExternalUrl(url);
          else window.open(url, "_blank", "noopener");
        },
        isCancelled: () => wbAuthorizeAttemptRef.current !== attempt,
      });
      if (wbAuthorizeAttemptRef.current !== attempt) return;
      if (isWorkBuddyCloud && !hasWorkBuddyCloudScopes(grant.scope)) {
        toast.error(t("workbuddy.cloud_scope_required"));
        setWbAuth("no");
      } else setWbAuth("ok");
    } catch (error) {
      if (wbAuthorizeAttemptRef.current === attempt) {
        console.warn("[workbuddy-chat] authorization did not complete", error);
        // The banner alone used to swallow the reason; surface it like the
        // settings card does.
        const copy = workbuddyErrorCopy(error, "workbuddy.err_failed");
        toast.error(t(copy.key, copy.params));
        setWbAuth("no");
      }
    } finally {
      if (wbAuthorizeAttemptRef.current === attempt) setWbAuthorizing(false);
    }
  }, [wbAuthorizing, isWorkBuddyCloud, t]);

  const cancelWorkBuddyAuthorize = useCallback(() => {
    wbAuthorizeAttemptRef.current += 1;
    setWbAuthorizing(false);
  }, []);

  // Floating quick prompts above the composer: each chip shows a short label
  // but drops the full prompt into the composer for editing before sending —
  // skill prompts carry a `skill://` marker the backend agent picks up and
  // executes, held out of the composer and re-attached at send. The
  // first/third/fifth entries are the cards that used to sit
  // in the middle of the empty state — moved down here.
  const quickPrompts = (
    [
      { key: "chat.suggestion_summary", icon: Sparkles, label: t("chat.suggestion_summary"), prompt: t("chat.prompt_summary") },
      { key: "chat.quick_minutes", icon: FileText, label: t("chat.quick_minutes"), prompt: t("chat.prompt_minutes") },
      { key: "chat.quick_visual_summary", icon: Image, label: t("chat.quick_visual_summary"), prompt: t("chat.prompt_visual_summary") },
      { key: "chat.quick_html_report", icon: ScrollText, label: t("chat.quick_html_report"), prompt: t("chat.prompt_html_report") },
      { key: "chat.suggestion_actions", icon: ListChecks, label: t("chat.suggestion_actions"), prompt: t("chat.prompt_actions") },
      { key: "chat.quick_todos", icon: ListOrdered, label: t("chat.quick_todos"), prompt: t("chat.prompt_todos") },
      { key: "chat.suggestion_notes", icon: BookOpen, label: t("chat.suggestion_notes"), prompt: t("chat.prompt_notes") },
      { key: "chat.quick_plan", icon: CalendarDays, label: t("chat.quick_plan"), prompt: t("chat.prompt_plan") },
      { key: "chat.quick_translate", icon: Globe, label: t("chat.quick_translate"), prompt: t("chat.prompt_translate") },
      { key: "chat.quick_rewrite", icon: Pencil, label: t("chat.quick_rewrite"), prompt: t("chat.prompt_rewrite") },
    ] as QuickPrompt[]
  ).map((prompt) => {
    // Skill chips surface the marker's label + body: the label renders as the
    // accent-colored skill name, the body as the instruction preview.
    const marker = extractSkillMarker(prompt.prompt);
    return marker
      ? { ...prompt, skill: { label: marker.label, body: marker.body } }
      : prompt;
  });

  // ── @ note / # group mentions ───────────────────────────
  // Stable "end of today" so the notes query key doesn't churn per render
  // (same pattern as the Notes page, which shares this cached query).
  const mentionRangeEnd = useMemo(() => {
    const d = new Date();
    d.setHours(23, 59, 59, 0);
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(
      d.getHours(),
    )}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }, []);
  const { data: notes } = useNotes({ startTime: "2020-01-01T00:00:00", endTime: mentionRangeEnd });
  const { data: folders } = useFolders();
  const noteList: WorkspaceItem[] = useMemo(() => (Array.isArray(notes) ? notes : []), [notes]);

  // Citation sources from the poll payload are meeting IDs/titles (or, from
  // older builds, empty placeholders rescued via the reply's meeting table).
  // Resolve each against the note list and open it preselected in the notes
  // module — same flow as global search.
  const notesPath = getDesktopLocalTranscriptionApi() ? "/notes" : "/recordings";
  const findSourceNote = useCallback(
    (source: string): WorkspaceItem | undefined => {
      const key = source.trim();
      if (!key) return undefined;
      return (
        noteList.find((note) => note.id === key) ??
        noteList.find((note) => note.title === key) ??
        noteList.find((note) => note.title.includes(key) || key.includes(note.title))
      );
    },
    [noteList],
  );
  // Display label: prefer the matched note's own title — it carries the date
  // prefix titles show everywhere else in the app (e.g. "09-28 需求评审会…").
  const resolveSourceLabel = useCallback(
    (source: string) => findSourceNote(source)?.title ?? source,
    [findSourceNote],
  );
  const handleOpenSource = useCallback(
    (source: string) => {
      const target = findSourceNote(source);
      if (!target) {
        toast(t("chat.source_not_found"));
        return;
      }
      getWorkspaceState().selectItem(target.id, "file", target.title);
      push(notesPath);
    },
    [findSourceNote, notesPath, push, t],
  );

  // ── "Insert reply into notes" targets ───────────────────
  // Each assistant reply can be filed as the summary of the note its turn was
  // about: the target is the single cloud file the user's turn referenced
  // (mentions / attachments, recorded on the user message at send time). No
  // context, several files at once, or a local transcription — none of those
  // resolve to exactly one insertable note, so no button is shown.
  const insertConclusion = useInsertConclusion();
  const insertTargets = useMemo(() => {
    const targets = new Map<string, { fileId: string; teamId?: string }>();
    let contextFileIds: string[] = [];
    for (const message of messages) {
      if (message.role === "user") {
        contextFileIds = message.fileIds ?? [];
        continue;
      }
      if (contextFileIds.length !== 1) continue;
      const fileId = contextFileIds[0]!;
      if (isLocalFileId(fileId)) continue;
      targets.set(message.id, {
        fileId,
        teamId: noteList.find((note) => note.id === fileId)?.teamId,
      });
    }
    return targets;
  }, [messages, noteList]);

  const [mentions, setMentions] = useState<ChatMention[]>([]);
  const [mentionState, setMentionState] = useState<{
    detection: MentionDetection | null;
    index: number;
    /** Token spot dismissed with Esc; stays closed until the typed query changes. */
    dismissed: { trigger: MentionTrigger; start: number; query: string } | null;
  }>({ detection: null, index: 0, dismissed: null });
  const mentionDetection = mentionState.detection;

  const mentionNoteOptions: MentionOption[] = useMemo(
    () =>
      [...noteList]
        .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
        .filter((note) => note.title.trim())
        .map((note) => ({ kind: "note" as const, id: note.id, title: note.title })),
    [noteList],
  );

  const mentionGroupOptions: MentionOption[] = useMemo(() => {
    const folderList = Array.isArray(folders) ? folders : [];
    const countIn = (folderId: string) => filterWorkspaceFilesByFolder(noteList, folderId).length;
    return [
      ...folderList.map((folder) => ({
        kind: "group" as const,
        id: String(folder.id),
        title: folder.folderName,
        count: countIn(String(folder.id)),
      })),
      // Virtual groups from the notes page filter, so every reachable
      // grouping can be referenced. Trash is excluded on purpose.
      { kind: "group" as const, id: "__uncategorized__", title: t("layout.uncategorized"), count: countIn("__uncategorized__") },
      { kind: "group" as const, id: LOCAL_TRANSCRIPTION_FOLDER_ID, title: t("layout.local_transcriptions"), count: countIn(LOCAL_TRANSCRIPTION_FOLDER_ID) },
    ].filter((group) => group.title.trim());
  }, [folders, noteList, t]);

  const mentionOptions = useMemo(() => {
    if (!mentionDetection) return [];
    const source =
      mentionDetection.trigger === "@" ? mentionNoteOptions : mentionGroupOptions;
    return filterMentionOptions(source, mentionDetection.query).slice(0, 50);
  }, [mentionDetection, mentionNoteOptions, mentionGroupOptions]);

  // Chips follow the text: deleting the `@Title` token by hand removes the
  // reference, so the tray never shows something the message no longer has.
  const activeChips = useMemo(() => activeMentions(mentions, input), [mentions, input]);

  /** Esc-dismissal: reopen only when the query changes or the token is gone. */
  const closeMentionPicker = () =>
    setMentionState((prev) => ({
      detection: null,
      index: 0,
      dismissed: prev.detection
        ? { trigger: prev.detection.trigger, start: prev.detection.start, query: prev.detection.query }
        : prev.dismissed,
    }));

  /** Full reset — used when the picker is retired for good (pick, send). */
  const resetMentionState = () =>
    setMentionState({ detection: null, index: 0, dismissed: null });

  /**
   * Re-evaluate the in-progress `@`/`#` token after caret/input changes.
   * Note: React re-emits `select` after keyboard events, so an Esc dismissal
   * must survive a re-detection of the very same token (see `dismissed`).
   */
  const syncMentionDetection = (value: string, caret: number) => {
    // The WorkBuddy thread has no local note/group context to mention.
    if (isWorkBuddy) return;
    const detection = detectMentionTrigger(value, caret);
    setMentionState((prev) => {
      if (!detection) {
        // Token gone (caret left / trigger deleted): the dismissal no longer
        // applies to anything, so drop it.
        return prev.detection || prev.dismissed
          ? { detection: null, index: 0, dismissed: null }
          : prev;
      }
      const isDismissed =
        prev.dismissed?.trigger === detection.trigger &&
        prev.dismissed.start === detection.start &&
        prev.dismissed.query === detection.query;
      if (isDismissed) {
        return prev.detection ? { detection: null, index: 0, dismissed: prev.dismissed } : prev;
      }
      const sameSpot =
        prev.detection?.trigger === detection.trigger && prev.detection?.start === detection.start;
      return { detection, index: sameSpot ? prev.index : 0, dismissed: null };
    });
  };

  const pickMention = (option: MentionOption) => {
    if (!mentionDetection) return;
    const { text, caret } = insertMentionText({
      text: input,
      detection: mentionDetection,
      title: option.title,
    });
    setInput(text);
    setMentions((prev) =>
      prev.some((m) => m.kind === option.kind && m.id === option.id)
        ? prev
        : [...prev, { kind: option.kind, id: option.id, title: option.title }],
    );
    resetMentionState();
    // Restore focus + caret right after the inserted token; its trailing
    // space keeps the picker from immediately reopening.
    requestAnimationFrame(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(caret, caret);
    });
  };

  const removeMention = (mention: ChatMention) => {
    setInput((prev) => removeMentionText(prev, mention));
    setMentions((prev) => prev.filter((m) => !(m.kind === mention.kind && m.id === mention.id)));
    requestAnimationFrame(() => textareaRef.current?.focus());
  };

  // ── "+" attachment uploads ──────────────────────────────
  // Hidden from the UI until upload is implemented; handlers kept for reuse.
  const [attachmentDrafts, setAttachmentDrafts] = useState<AttachmentDraft[]>([]);
  const hasUploadingAttachments = attachmentDrafts.some((d) => d.status === "uploading");

  const clearAttachmentDrafts = () => {
    setAttachmentDrafts((prev) => {
      for (const draft of prev) {
        if (draft.previewUrl) URL.revokeObjectURL(draft.previewUrl);
      }
      return [];
    });
  };

  // Stick-to-bottom: follow the newest message (including streaming tokens)
  // only while the user is parked near the bottom — never yank the view if
  // they scrolled up to re-read mid-answer.
  const stickToBottomRef = useRef(true);
  const [pinnedToBottom, setPinnedToBottom] = useState(true);

  useEffect(() => {
    const el = scrollRef.current;
    if (el && stickToBottomRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages, isLoading]);

  const handleListScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const pinned = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
    stickToBottomRef.current = pinned;
    setPinnedToBottom((prev) => (prev === pinned ? prev : pinned));
  };

  const scrollToBottom = () => {
    const el = scrollRef.current;
    if (!el) return;
    stickToBottomRef.current = true;
    setPinnedToBottom(true);
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  };

  // Switching conversations always lands on the newest message.
  useEffect(() => {
    stickToBottomRef.current = true;
    setPinnedToBottom(true);
  }, [activeConversationId]);

  const handleSend = (content = input) => {
    const trimmedContent = content.trim();
    if (!trimmedContent || isLoading) return;
    if (isWorkBuddy) {
      // The WorkBuddy thread has no local context channel (mentions, files):
      // the turn is plain text, authorization is a precondition.
      if (wbAuth !== "ok" || wbAuthorizing || isLegacyWorkBuddy) return;
      sendMessage(trimmedContent);
      setInput("");
      setPendingSkillMarker(null);
      return;
    }
    // Wait for in-flight uploads — sending without their fileIds would lose
    // the attachment context silently.
    if (hasUploadingAttachments) return;

    // Referenced notes/groups (still present in the input) become fileIds so
    // the backend scopes its retrieval — groups expand to their member notes.
    // Uploaded attachments join the same context channel.
    const readyAttachments = attachmentDrafts.filter((d) => d.status === "ready" && d.fileId);
    const fileIds = mergeContextFileIds([
      collectMentionFileIds(activeMentions(mentions, input), noteList),
      readyAttachments.map((d) => d.fileId!),
    ]);
    const attachmentMeta = attachmentDrafts
      .filter((d) => d.status !== "error")
      .map((d) => ({ id: d.fileId, name: d.name, type: d.kind }));
    // The composer only ever held the prompt body; the skill marker rides
    // along here so the outgoing message still carries the skill reference.
    const outgoing = pendingSkillMarker
      ? `${pendingSkillMarker.marker} ${trimmedContent}`
      : trimmedContent;
    if (fileIds.length > 0 || attachmentMeta.length > 0) {
      sendMessage(
        outgoing,
        fileIds.length > 0 ? fileIds : undefined,
        fileIds.length > 0,
        attachmentMeta.length > 0 ? attachmentMeta : undefined,
      );
    } else {
      sendMessage(outgoing);
    }
    setInput("");
    setPendingSkillMarker(null);
    setMentions([]);
    resetMentionState();
    clearAttachmentDrafts();
  };

  const handleNewChat = () => {
    clearMessages();
    setInput("");
    setPendingSkillMarker(null);
    setMentions([]);
    resetMentionState();
    clearAttachmentDrafts();
    setCopiedMessageId(null);
    setInsertedMessageId(null);
    setInsertingMessageId(null);
    requestAnimationFrame(() => textareaRef.current?.focus());
  };

  const handleCopy = async (messageId: string, content: string) => {
    if (!navigator.clipboard) return;
    try {
      await navigator.clipboard.writeText(content);
      setCopiedMessageId(messageId);
    } catch {
      // Clipboard permission errors should not interrupt the conversation.
    }
  };

  /** File an assistant reply into the referenced note as a new conclusion. */
  const handleInsertToNote = async (
    messageId: string,
    content: string,
    target: { fileId: string; teamId?: string },
  ) => {
    if (insertingMessageId) return;
    setInsertingMessageId(messageId);
    try {
      // File ids are minted per environment, so a mention captured on another
      // server can look valid here while pointing nowhere — verify the target
      // exists on the signed-in backend before filing, or the insert would
      // "succeed" into an invisible orphan.
      const detail = await fetchFileDetail(target.fileId);
      if (!detail) {
        toast.error(t("chat.insert_target_missing"));
        return;
      }
      await insertConclusion.mutateAsync({
        fileId: target.fileId,
        teamId: target.teamId,
        conclusionText: content,
      });
      setInsertedMessageId(messageId);
      // Naming the target in the toast makes a wrong-environment insert
      // visible at a glance instead of a plain success.
      const title = String(
        detail.originalFilename ?? detail.name ?? detail.filename ?? "",
      ).trim();
      toast.success(
        title ? t("chat.inserted_to_note_title", { title }) : t("chat.inserted_to_note"),
      );
    } catch (error) {
      // Surface the backend's own message (e.g. permission/ownership errors)
      // when it has one; otherwise fall back to the generic locale string.
      const backendMessage = error instanceof Error && error.message ? error.message : "";
      toast.error(backendMessage || t("chat.insert_to_note_failed"));
    } finally {
      setInsertingMessageId(null);
    }
  };

  return (
    <div className="relative flex h-full min-h-0 flex-col overflow-hidden bg-background">
      {/* Page chrome lives in the unified app title bar via the slot:
          assistant switcher centered (like the original chat header), the
          history-drawer toggle on the left of the bar, new-chat on the right. */}
      <TitleBarSlot
        title={
          <>
            <AssistantSwitcher
              activeAssistant={activeAssistant}
              onSelect={setActiveAssistant}
              disabled={isLoading}
            />
            {isLoading && (
              <span className="size-1.5 animate-pulse rounded-full bg-primary" aria-hidden="true" />
            )}
          </>
        }
        titleAlign="center"
        middleToggle={
          (!isWorkBuddy || isWorkBuddyCloud)
            ? {
                collapsed: !historyOpen,
                onToggle: () => setHistoryOpen((open) => !open),
                label: t("chat.history"),
                panelWidth: 224, // w-56 history drawer
              }
            : undefined
        }
        actions={
          (!isWorkBuddy || isWorkBuddyCloud) ? (
            <Button
              variant="ghost"
              size="icon"
              className="size-8 border border-transparent text-muted-foreground transition-colors hover:border-border hover:bg-card hover:text-foreground"
              onClick={handleNewChat}
              title={t("chat.new_chat")}
              aria-label={t("chat.new_chat")}
            >
              <Plus className="size-4" />
            </Button>
          ) : undefined
        }
      />

      <AnimatePresence initial={false}>
        {showHistory && (
          <motion.aside
            key="history"
            initial={reduceMotion ? false : { x: "-100%" }}
            animate={{ x: 0 }}
            exit={reduceMotion ? { opacity: 0 } : { x: "-100%" }}
            transition={{ duration: 0.18, ease: "easeOut" }}
            className="absolute bottom-0 left-0 top-0 z-20 flex w-56 flex-col border-r border-border/60"
          >
            <ChatHistorySidebar
              conversations={conversations.filter((c) => isWorkBuddy ? c.provider === "workbuddy" : c.provider !== "workbuddy")}
              activeConversationId={activeConversationId}
              workingConversationIds={workingConversationIds}
              onSelect={selectConversation}
              onClose={() => setHistoryOpen(false)}
            />
          </motion.aside>
        )}
      </AnimatePresence>

      <div className="relative min-h-0 flex-1">
        <main
          ref={scrollRef}
          onScroll={handleListScroll}
          className={`${showHistory ? "ml-56" : "ml-0"} h-full overflow-y-auto overscroll-contain transition-[margin] duration-150`}
        >
        {isLegacyWorkBuddy && <p className="mx-auto max-w-4xl px-6 py-3 text-sm text-muted-foreground">{t("workbuddy.cloud_legacy_history")}</p>}
        {isWorkBuddy && wbAuth !== "ok" && (
          <div className="mx-auto w-full max-w-4xl px-6 pt-6">
            <div className="flex items-start gap-3 rounded-xl border border-border bg-card px-4 py-3.5">
              <span className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-full bg-primary/10">
                <WorkBuddy className="size-4 text-primary" />
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-foreground">
                  {t("chat.assistant_workbuddy")}
                </p>
                <p className="mt-0.5 text-xs leading-5 text-muted-foreground">
                  {t("chat.workbuddy_not_authorized")}
                </p>
                <div className="mt-2.5 flex items-center gap-2">
                  {wbAuthorizing ? (
                    <>
                      <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                        <Loader2 className="size-3 animate-spin" />
                        {t("chat.workbuddy_authorize_waiting")}
                      </span>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 px-2 text-xs text-muted-foreground"
                        onClick={cancelWorkBuddyAuthorize}
                      >
                        {t("workbuddy.authorize_cancel")}
                      </Button>
                    </>
                  ) : (
                    <>
                      <Button size="sm" className="h-7 px-3 text-xs" onClick={() => void startWorkBuddyAuthorize()}>
                        {t("chat.workbuddy_authorize")}
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 px-2 text-xs text-muted-foreground"
                        onClick={checkWorkBuddyAuth}
                      >
                        <RefreshCw className="size-3" />
                        {t("chat.workbuddy_recheck")}
                      </Button>
                    </>
                  )}
                </div>
              </div>
            </div>
          </div>
        )}
        {messages.length === 0 && !isLoading ? (
          isWorkBuddy ? (
            <EmptyChat
              icon={<WorkBuddy className="size-10 text-primary/70" />}
              title={t("chat.assistant_workbuddy")}
              hint={t(isWorkBuddyCloud ? "workbuddy.cloud_history_hint" : "chat.workbuddy_history_hint")}
            />
          ) : (
            <EmptyChat />
          )
        ) : (
          <div className="lyse-chat-column mx-auto w-full max-w-4xl space-y-6 px-6 py-6">
            {messages.map((message) =>
              message.role === "user" ? (
                <div key={message.id} className="flex justify-end">
                  <div className="flex max-w-[78%] flex-col items-end gap-1.5">
                    {(message.attachments?.length ?? 0) > 0 && (
                      <div className="flex flex-wrap justify-end gap-1">
                        {message.attachments!.map((attachment, index) => (
                          <span
                            key={attachment.id ?? `${attachment.name}-${index}`}
                            className="flex max-w-44 items-center gap-1 rounded-full border border-background/30 bg-background/15 px-2 py-0.5 text-3xs text-primary-foreground"
                            title={attachment.name}
                          >
                            {attachment.type === "image" ? (
                              <Image className="size-3 shrink-0" />
                            ) : (
                              <FileText className="size-3 shrink-0" />
                            )}
                            <span className="min-w-0 truncate">{attachment.name}</span>
                          </span>
                        ))}
                      </div>
                    )}
                    <div className="whitespace-pre-wrap break-words rounded-2xl rounded-br-md bg-primary px-4 py-2.5 text-sm leading-6 text-primary-foreground shadow-sm">
                      {stripSkillMarker(message.content)}
                    </div>
                  </div>
                </div>
              ) : (
                <article key={message.id} className="group flex items-start gap-3">
                  {activeProvider === "workbuddy" ? (
                    <span className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-full bg-primary/10">
                      <WorkBuddy className="size-4 text-primary" />
                    </span>
                  ) : (
                    <AssistantAvatar size={36} className="mt-0.5 shrink-0" />
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="mb-1.5 text-2xs font-semibold uppercase tracking-[0.12em] text-muted-foreground/80">
                      {activeProvider === "workbuddy"
                        ? t("chat.assistant_workbuddy")
                        : t("chat.assistant_lynse")}
                    </div>
                    <AssistantMessage
                      message={message}
                      isStreaming={message.id === streamingMessageId}
                      copied={copiedMessageId === message.id}
                      onCopy={() => handleCopy(message.id, message.content)}
                      insertTarget={insertTargets.get(message.id)}
                      insertState={
                        insertingMessageId === message.id
                          ? "inserting"
                          : insertedMessageId === message.id
                            ? "inserted"
                            : "idle"
                      }
                      onInsertToNote={
                        insertTargets.has(message.id)
                          ? () =>
                              void handleInsertToNote(
                                message.id,
                                message.content,
                                insertTargets.get(message.id)!,
                              )
                          : undefined
                      }
                      onAuthorizeWorkBuddy={() => void startWorkBuddyAuthorize()}
                      onConfirmSelect={answerConfirm}
                      onConfirmDismiss={dismissConfirm}
                      resolveSourceLabel={resolveSourceLabel}
                      onOpenSource={handleOpenSource}
                    />
                  </div>
                </article>
              ),
            )}
          </div>
        )}
      </main>

        <AnimatePresence>
          {!pinnedToBottom && (
            <motion.button
              type="button"
              onClick={scrollToBottom}
              initial={{ opacity: 0, y: 8, x: "-50%" }}
              animate={{ opacity: 1, y: 0, x: "-50%" }}
              exit={{ opacity: 0, y: 8, x: "-50%" }}
              transition={{ duration: 0.15, ease: "easeOut" }}
              className="absolute bottom-4 left-1/2 z-10 flex size-8 items-center justify-center rounded-full border border-border/70 bg-background/95 text-muted-foreground shadow-md backdrop-blur transition-colors hover:border-primary/30 hover:text-foreground"
              aria-label={t("chat.scroll_to_bottom")}
            >
              <ArrowDown className="size-4" />
            </motion.button>
          )}
        </AnimatePresence>
      </div>

      <div
        className={`${showHistory ? "ml-56" : "ml-0"} pointer-events-none shrink-0 bg-background/95 pb-3 pt-2 transition-[margin] duration-150 dark:bg-background/75 dark:backdrop-blur-xl`}
      >
        <div className="lyse-chat-column pointer-events-auto mx-auto w-full max-w-4xl px-6">
          {!isWorkBuddy && (
            <QuickPromptStrip
              prompts={quickPrompts}
              onSelect={(prompt) => {
                const marker = extractSkillMarker(prompt);
                setPendingSkillMarker(marker);
                const body = marker?.body ?? prompt;
                setInput(body);
                requestAnimationFrame(() => {
                  textareaRef.current?.focus();
                  textareaRef.current?.setSelectionRange(body.length, body.length);
                });
              }}
              disabled={isLoading}
            />
          )}
          <div className="relative rounded-xl border border-input bg-white p-2 shadow-[0_1px_2px_rgba(0,0,0,0.04),0_4px_14px_rgba(0,0,0,0.035)] transition-[border-color,box-shadow] duration-150 focus-within:border-neutral-400 focus-within:shadow-[0_1px_2px_rgba(0,0,0,0.04),0_0_0_3px_rgba(0,0,0,0.04)] dark:bg-card dark:shadow-[0_10px_35px_rgba(0,0,0,0.28)] dark:focus-within:border-white/20 dark:focus-within:shadow-[0_10px_35px_rgba(0,0,0,0.28),0_0_0_3px_rgba(255,255,255,0.05)]">
            {!isWorkBuddy && mentionDetection && (
              <div className="absolute bottom-full left-0 right-0 z-30 mb-2">
                <MentionPicker
                  trigger={mentionDetection.trigger}
                  options={mentionOptions}
                  activeIndex={mentionState.index}
                  onPick={pickMention}
                  onHover={(index) => setMentionState((prev) => ({ ...prev, index }))}
                />
              </div>
            )}
            {!isWorkBuddy && (
              <MentionChips
                mentions={activeChips}
                onRemove={removeMention}
                skill={pendingSkillMarker ? { label: pendingSkillMarker.label } : undefined}
                onRemoveSkill={() => setPendingSkillMarker(null)}
              />
            )}
            {/* Attachment upload is not implemented yet; entry points hidden until it ships. */}
            <Textarea
              ref={textareaRef}
              value={input}
              onChange={(event) => {
                const value = event.target.value;
                setInput(value);
                // Wiping the draft drops the pending skill marker with it.
                if (!value.trim()) setPendingSkillMarker(null);
                syncMentionDetection(value, event.target.selectionStart ?? value.length);
              }}
              onSelect={(event) => {
                const target = event.currentTarget;
                syncMentionDetection(target.value, target.selectionStart ?? target.value.length);
              }}
              onKeyDown={(event) => {
                if (mentionDetection && mentionOptions.length > 0) {
                  if (event.key === "ArrowDown") {
                    event.preventDefault();
                    setMentionState((prev) => ({
                      ...prev,
                      index: (prev.index + 1) % mentionOptions.length,
                    }));
                    return;
                  }
                  if (event.key === "ArrowUp") {
                    event.preventDefault();
                    setMentionState((prev) => ({
                      ...prev,
                      index: (prev.index - 1 + mentionOptions.length) % mentionOptions.length,
                    }));
                    return;
                  }
                  if (event.key === "Enter" || event.key === "Tab") {
                    event.preventDefault();
                    pickMention(mentionOptions[mentionState.index] ?? mentionOptions[0]!);
                    return;
                  }
                  if (event.key === "Escape") {
                    event.preventDefault();
                    closeMentionPicker();
                    return;
                  }
                }
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  handleSend();
                }
              }}
              placeholder={t("chat.page_placeholder")}
              className="max-h-40 min-h-12 resize-none border-0 bg-transparent px-2.5 py-2 text-13 text-foreground shadow-none placeholder:text-muted-foreground/70 focus-visible:border-transparent focus-visible:ring-0 dark:bg-transparent"
              // Stays editable while a response streams so the user can
              // pre-type; sending is what's blocked (button + handleSend).
              rows={1}
              autoFocus
            />
            <div className="flex items-center gap-1 px-0.5 pb-0.5 pt-1">
              <div className="flex items-center gap-0.5">
                {/* Attachment "+" button hidden: upload not implemented yet. */}
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="size-8 border-0 bg-transparent text-muted-foreground shadow-none transition-colors hover:bg-muted hover:text-foreground dark:hover:bg-white/[0.06]"
                  title={t("chat.microphone")}
                  aria-label={t("chat.microphone")}
                >
                  <Mic className="size-4" strokeWidth={1.8} />
                </Button>
              </div>
              <span className="ml-1 min-w-0 flex-1 truncate text-2xs text-muted-foreground/55 dark:text-muted-foreground/65">
                {isLoading
                  ? t("chat.responding")
                  : hasUploadingAttachments
                    ? t("chat.attachment_uploading")
                    : isWorkBuddy
                      ? t("chat.input_hint_workbuddy")
                      : t("chat.input_hint")}
              </span>
              {/* Beta surface: hidden in official builds (feature-flags). */}
              {!isWorkBuddy && isBetaFeaturesUnlocked() && <ChatModelPicker />}
              {isLoading ? (
                <Button
                  type="button"
                  size="icon"
                  variant="outline"
                  className="size-8 border-border bg-background text-foreground shadow-none transition-colors hover:bg-muted"
                  onClick={stopStreaming}
                  title={t("chat.stop")}
                  aria-label={t("chat.stop")}
                >
                  <Square className="size-3 fill-current" />
                </Button>
              ) : (
                <Button
                  type="button"
                  size="icon"
                  className="size-8 bg-foreground text-background shadow-[0_1px_2px_rgba(0,0,0,0.12)] transition-[background-color,box-shadow] hover:bg-foreground/85 hover:shadow-[0_2px_7px_rgba(0,0,0,0.12)] disabled:bg-muted disabled:text-muted-foreground disabled:shadow-none dark:bg-primary dark:text-primary-foreground dark:hover:bg-primary/90"
                  onClick={() => handleSend()}
                  disabled={
                    !input.trim() ||
                    hasUploadingAttachments ||
                    (isWorkBuddy && (wbAuth !== "ok" || wbAuthorizing || isLegacyWorkBuddy))
                  }
                  title={t("chat.send")}
                  aria-label={t("chat.send")}
                >
                  <ArrowUp className="size-4" strokeWidth={2} />
                </Button>
              )}
            </div>
          </div>
          <p className="mt-2 text-center text-3xs text-muted-foreground">
            {t("chat.disclaimer")}
          </p>
        </div>
      </div>
    </div>
  );
}

interface QuickPrompt {
  key: string;
  icon: ComponentType<{ className?: string }>;
  /** Short chip text shown in the strip. */
  label: string;
  /** Full text source for the chip; skill prompts carry a `skill://` marker that is stripped before the composer shows it and re-attached on send. */
  prompt: string;
  /** Marker label + body for skill chips: rendered as accent skill name + instruction preview. */
  skill?: { label: string; body: string };
}

/**
 * Floating quick-prompt chips anchored right above the composer: one row,
 * horizontally scrollable, each dropping a frequently typed question into
 * the composer for editing before sending. Dims (without collapsing) while
 * a reply is streaming so the composer height stays stable. The row hides
 * its scrollbar, so chevron buttons on each overflowing edge do the
 * scrolling with the mouse; each button only shows while that side actually
 * has more content.
 */
function QuickPromptStrip({
  prompts,
  onSelect,
  disabled,
}: {
  prompts: QuickPrompt[];
  onSelect: (prompt: string) => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const stripRef = useRef<HTMLDivElement>(null);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);

  const updateScrollState = useCallback(() => {
    const el = stripRef.current;
    if (!el) return;
    const maxScroll = el.scrollWidth - el.clientWidth;
    setCanScrollLeft(el.scrollLeft > 1);
    setCanScrollRight(el.scrollLeft < maxScroll - 1);
  }, []);

  useEffect(() => {
    const el = stripRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(updateScrollState);
    observer.observe(el);
    return () => observer.disconnect();
  }, [updateScrollState]);

  // Re-check after every render: locale switches and container resizes swap
  // chip widths without firing the observer's initial snapshot again.
  useEffect(updateScrollState);

  const scrollStrip = (direction: 1 | -1) => {
    stripRef.current?.scrollBy({
      left: direction * Math.max(stripRef.current.clientWidth * 0.75, 180),
      behavior: "smooth",
    });
  };

  // Fade only the edges that hide overflow, so the mask follows the arrows.
  const maskImage = canScrollLeft
    ? canScrollRight
      ? "linear-gradient(to right, transparent, black 6%, black 94%, transparent)"
      : "linear-gradient(to right, transparent, black 6%)"
    : canScrollRight
      ? "linear-gradient(to right, black 92%, transparent)"
      : undefined;

  return (
    <div
      className={`mb-2 flex items-center gap-1 transition-opacity duration-200 ${
        disabled ? "pointer-events-none opacity-40" : "opacity-100"
      }`}
    >
      {canScrollLeft && (
        <button
          type="button"
          onClick={() => scrollStrip(-1)}
          className="flex size-6 shrink-0 items-center justify-center rounded-full border border-border/70 bg-card text-muted-foreground shadow-sm transition-[border-color,background-color,color] hover:border-primary/25 hover:bg-accent/50 hover:text-foreground"
          title={t("chat.prompts_previous")}
          aria-label={t("chat.prompts_previous")}
        >
          <ChevronLeft className="size-3.5" />
        </button>
      )}
      <div
        ref={stripRef}
        onScroll={updateScrollState}
        className="no-scrollbar -mx-1 flex min-w-0 flex-1 gap-1.5 overflow-x-auto px-1 pb-0.5"
        style={maskImage ? { maskImage, WebkitMaskImage: maskImage } : undefined}
      >
        {prompts.map((prompt) => (
          <button
            key={prompt.key}
            type="button"
            onClick={() => onSelect(prompt.prompt)}
            className="flex shrink-0 items-center gap-1.5 rounded-full border border-border/70 bg-card px-3 py-1.5 text-xs text-muted-foreground shadow-sm transition-[border-color,background-color,color] hover:border-primary/25 hover:bg-accent/50 hover:text-foreground"
          >
            {prompt.skill ? (
              // Skill chip: layered-skill glyph + accent skill name + plain
              // instruction preview, mirroring the reference recommendation
              // cards (icon and name carry the accent, body stays neutral).
              <>
                <Layers className="size-3.5 shrink-0 text-primary" />
                <span className="whitespace-nowrap font-medium text-primary">
                  {prompt.skill.label}
                </span>
                <span className="max-w-48 truncate whitespace-nowrap text-foreground/75">
                  {prompt.skill.body}
                </span>
              </>
            ) : (
              <>
                <prompt.icon className="size-3.5 shrink-0 text-primary/70" />
                <span className="whitespace-nowrap">{prompt.label}</span>
              </>
            )}
          </button>
        ))}
      </div>
      {canScrollRight && (
        <button
          type="button"
          onClick={() => scrollStrip(1)}
          className="flex size-6 shrink-0 items-center justify-center rounded-full border border-border/70 bg-card text-muted-foreground shadow-sm transition-[border-color,background-color,color] hover:border-primary/25 hover:bg-accent/50 hover:text-foreground"
          title={t("chat.prompts_next")}
          aria-label={t("chat.prompts_next")}
        >
          <ChevronRight className="size-3.5" />
        </button>
      )}
    </div>
  );
}

function EmptyChat({
  icon,
  title,
  hint,
}: {
  icon?: ReactNode;
  title?: string;
  hint?: string;
} = {}) {
  const { t } = useTranslation();

  return (
    <div className="relative mx-auto flex min-h-full w-full max-w-4xl flex-col items-center justify-center overflow-hidden px-6 py-8 text-center">
      {icon ?? <AssistantAvatar size={72} className="relative mb-4" />}
      <h1 className="relative text-xl font-semibold tracking-tight text-foreground">
        {title ?? t("chat.welcome_title")}
      </h1>
      <p className="relative mt-2 max-w-md text-sm leading-6 text-muted-foreground">
        {hint ?? t("chat.page_description")}
      </p>
    </div>
  );
}

/**
 * Meeting titles from the reply's own markdown table (`| # | 日期 | 时长 |
 * 分类 | 主题 |`). Older lynclaw builds emit one empty string per meeting in
 * `sources`, so on those turns the table's topic column is the only
 * client-side source for row labels.
 */
function meetingTitlesFromReply(content: string): string[] {
  const titles: string[] = [];
  for (const line of content.split("\n")) {
    const cells = line.split("|").map((cell) => cell.trim());
    if (cells.length < 7) continue;
    // Only rows whose second cell is a MM-DD date count as meeting rows;
    // header and separator rows fail this check.
    if (!/^\d{1,2}-\d{1,2}$/.test(cells[2] ?? "")) continue;
    const title = cells[cells.length - 2] ?? "";
    if (title) titles.push(title);
  }
  return titles;
}

/**
 * Collapsed citation strip: one icon chip carrying the source count, which
 * opens a popover listing the cited meetings. The poll payload may carry
 * meeting IDs/titles (resolved via `resolveLabel`) or, from older backends,
 * empty placeholders — those fall back to titles parsed from the reply's
 * meeting table. `onOpen` receives the best key available for the jump.
 */
function ChatSources({
  sources,
  resolveLabel,
  content,
  onOpen,
}: {
  sources: string[];
  resolveLabel: (source: string) => string;
  content?: string;
  onOpen?: (source: string) => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const rescuedTitles = useMemo(
    () => (content ? meetingTitlesFromReply(content) : []),
    [content],
  );

  return (
    <div className="flex items-center gap-1.5">
      <span className="text-2xs uppercase tracking-[0.08em] text-muted-foreground/70">
        {t("chat.sources")}
      </span>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          className="inline-flex items-center gap-1 rounded-full border border-border bg-muted/60 px-2 py-0.5 text-3xs text-foreground transition-colors hover:border-primary/30 hover:bg-accent data-popup-open:border-primary/30 data-popup-open:bg-accent"
          aria-label={t("chat.sources")}
        >
          <FileText className="size-3 shrink-0 text-primary/70" />
          <span>{sources.length}</span>
        </PopoverTrigger>
        <PopoverContent
          side="bottom"
          align="start"
          sideOffset={6}
          className="w-[360px] gap-0 p-1"
        >
          <div className="max-h-64 overflow-y-auto">
            {sources.map((source, index) => {
              // Empty placeholders fall back to the reply-table topic, then
              // resolveLabel upgrades it to the full note title (with its
              // date prefix) when the matching note exists.
              const label = source.trim()
                ? resolveLabel(source)
                : rescuedTitles[index]
                  ? resolveLabel(rescuedTitles[index])
                  : source;
              return (
                <button
                  key={`${source}-${index}`}
                  type="button"
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-foreground transition-colors hover:bg-accent"
                  title={label}
                  onClick={() => {
                    setOpen(false);
                    onOpen?.(source.trim() || label);
                  }}
                >
                  <FileText className="size-3.5 shrink-0 text-primary/70" />
                  <span className="min-w-0 flex-1 truncate">{label}</span>
                  <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
                </button>
              );
            })}
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}

interface AssistantMessageProps {
  message: ReturnType<typeof useChat>["messages"][number];
  isStreaming: boolean;
  copied: boolean;
  onCopy: () => void;
  /**
   * The note this reply can be filed under (single cloud file the turn
   * referenced). When absent the insert button is not rendered — a summary
   * must belong to exactly one note, so multi-file or context-less turns
   * offer nothing to insert into.
   */
  insertTarget?: { fileId: string; teamId?: string };
  insertState?: "idle" | "inserting" | "inserted";
  onInsertToNote?: () => void;
  /** Shown on a WorkBuddy auth-failure bubble instead of the error text. */
  onAuthorizeWorkBuddy?: () => void;
  /** Answers the inline confirmation card on this message (store action). */
  onConfirmSelect?: (messageId: string, value: string) => void;
  /** Dismisses the inline confirmation card on this message (store action). */
  onConfirmDismiss?: (messageId: string) => void;
  /** Resolves a raw citation source (meeting ID or title) to a display label. */
  resolveSourceLabel: (source: string) => string;
  /** Opens a cited source's note. */
  onOpenSource?: (source: string) => void;
}

function AssistantMessage({
  message,
  isStreaming,
  copied,
  onCopy,
  insertTarget,
  insertState = "idle",
  onInsertToNote,
  onAuthorizeWorkBuddy,
  onConfirmSelect,
  onConfirmDismiss,
  resolveSourceLabel,
  onOpenSource,
}: AssistantMessageProps) {
  const { t } = useTranslation();
  // The poll transport types the answer out itself; `revealedAt` only drives
  // the staggered entrance of attachments / support link after the text lands.
  const revealed = isFreshlyRevealed(message);

  // Per-message actions (insert into note, copy). They render inline ahead of
  // the citation strip when one exists, else on their own row below.
  const messageActions = (
    <>
      {insertTarget && onInsertToNote && (
        <Button
          variant="ghost"
          size="icon-xs"
          className="text-muted-foreground"
          disabled={insertState === "inserting"}
          onClick={onInsertToNote}
          title={
            insertState === "inserted" ? t("chat.inserted_to_note") : t("chat.insert_to_note")
          }
          aria-label={
            insertState === "inserted" ? t("chat.inserted_to_note") : t("chat.insert_to_note")
          }
        >
          {insertState === "inserting" ? (
            <Loader2 className="size-3 animate-spin" />
          ) : insertState === "inserted" ? (
            <Check className="size-3" />
          ) : (
            <NotePlus className="size-3" />
          )}
        </Button>
      )}
      <Button
        variant="ghost"
        size="icon-xs"
        className="text-muted-foreground"
        onClick={onCopy}
        title={copied ? t("chat.copied") : t("chat.copy")}
        aria-label={copied ? t("chat.copied") : t("chat.copy")}
      >
        {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
      </Button>
    </>
  );

  return (
    <>
      {message.workbuddyAuthRequired ? (
        <div className="rounded-xl border border-border bg-card px-4 py-3">
          <p className="text-sm font-medium text-foreground">{t("chat.assistant_workbuddy")}</p>
          <p className="mt-0.5 text-xs leading-5 text-muted-foreground">
            {message.workbuddyAuthReason || t("chat.workbuddy_not_authorized")}
          </p>
          {onAuthorizeWorkBuddy && (
            <Button
              size="sm"
              className="mt-2.5 h-7 px-3 text-xs"
              onClick={onAuthorizeWorkBuddy}
            >
              {t("chat.workbuddy_authorize")}
            </Button>
          )}
        </div>
      ) : (
        <>
          {message.thinking && (
            <div className="mb-2">
              <ThinkingBlock text={message.thinking} active={message.thinkingActive} />
            </div>
          )}

          {!!message.toolUses?.length && (
            <div className="mb-2">
              <ToolActivity tools={message.toolUses} />
            </div>
          )}

          {message.content || message.error ? (
            <ChatReplyBody
              message={message}
              isStreaming={isStreaming}
              className="rounded-2xl rounded-tl-md border border-border bg-card px-4 py-3.5 text-sm leading-6 text-foreground shadow-sm"
            />
          ) : message.attachments?.length || message.sources?.length || message.humanSupportLink?.url || message.connectionRequests?.length || message.workbuddyStopReason ? (
            // Attachment-only reply: the report-PDF turn empties the body
            // server-side and speaks through attachment cards, which render
            // below — keep the bubble body empty instead of spinning forever.
            null
          ) : message.status ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <span className="size-1.5 animate-pulse rounded-full bg-current" />
              <WaitingText status={message.status} startedAt={message.timestamp} />
            </div>
          ) : (
            <ThinkingIndicator />
          )}

          {message.content && message.status && (
            <div className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground">
              <span className="size-1.5 animate-pulse rounded-full bg-current" />
              <WaitingText status={message.status} startedAt={message.timestamp} />
            </div>
          )}

          {message.confirm && (
            <div className="mt-2 max-w-md">
              <ConfirmCard
                confirm={message.confirm}
                onSelect={(value) => onConfirmSelect?.(message.id, value)}
                onDismiss={() => onConfirmDismiss?.(message.id)}
              />
            </div>
          )}
        </>
      )}

      {message.workbuddyStopReason && message.workbuddyStopReason !== "end_turn" && (
        <p className="mt-2 text-xs text-muted-foreground">{t(`workbuddy.cloud_stop_${
          ["max_tokens", "max_turn_requests", "refusal", "cancelled"].includes(message.workbuddyStopReason)
            ? message.workbuddyStopReason : "unknown"
        }`)}</p>
      )}

      <div
        className={revealed ? "animate-in fade-in duration-300 delay-[350ms] fill-mode-backwards" : undefined}
      >
        {!!message.sources?.length && (
          <div className="mt-2 flex items-center gap-1.5">
            {message.content && !message.error && <>{messageActions}</>}
            <ChatSources
              sources={message.sources}
              resolveLabel={resolveSourceLabel}
              content={message.content}
              onOpen={onOpenSource}
            />
          </div>
        )}
        <ChatAttachments attachments={message.attachments} />
        {!!message.connectionRequests?.length && <ChatConnectionCards requests={message.connectionRequests} messageId={message.id} />}
      </div>

      {message.humanSupportLink?.url && (
        <a
          href={message.humanSupportLink.url}
          target="_blank"
          rel="noreferrer"
          className={`mt-2 inline-flex w-fit items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-1.5 text-xs text-foreground shadow-sm transition-colors hover:border-primary/30 hover:bg-accent ${
            revealed ? "animate-in fade-in duration-300 delay-[350ms] fill-mode-backwards" : ""
          }`}
        >
          <Headphones className="size-3.5 shrink-0 text-primary/70" />
          {message.humanSupportLink.label?.trim() || t("chat.contact_support")}
        </a>
      )}

      {message.content && !message.error && !message.sources?.length && (
        <div className="mt-2 flex items-center">{messageActions}</div>
      )}
    </>
  );
}
