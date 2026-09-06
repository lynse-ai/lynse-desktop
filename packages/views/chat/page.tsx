"use client";

import { useEffect, useMemo, useRef, useState, type ComponentType } from "react";
import {
  ArrowUp,
  BookOpen,
  CalendarDays,
  Check,
  Copy,
  Clock,
  FileText,
  Globe,
  Image,
  ListChecks,
  ListOrdered,
  Mic,
  Pencil,
  Plus,
  Sparkles,
  Square,
} from "../icons";
import { Button } from "@lynse/ui/components/ui/button";
import { Textarea } from "@lynse/ui/components/ui/textarea";
import { StreamingMarkdown } from "@lynse/ui/markdown";
import { toast } from "sonner";
import { AssistantAvatar } from "../assistant";
import { useTranslation } from "@lynse/core/i18n/react";
import { useChat } from "../workspace/hooks/use-chat";
import { useNotes } from "../workspace/hooks/use-files";
import { useFolders } from "../workspace/hooks/use-folders";
import { LOCAL_TRANSCRIPTION_FOLDER_ID } from "../workspace/local-transcription";
import { WaitingText } from "../workspace/hooks/waiting-text";
import { ConfirmDialog } from "../workspace/ConfirmDialog";
import { ChatAttachmentTray, ChatAttachments } from "./chat-attachments";
import {
  ATTACHMENT_ACCEPT_ATTR,
  attachmentKind,
  isAcceptedAttachment,
  isAttachmentTooLarge,
  makeLocalId,
  mergeContextFileIds,
  uploadChatAttachment,
  type AttachmentDraft,
} from "./chat-attachment-upload";
import { ChatHistorySidebar } from "./chat-history-sidebar";
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
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const { t } = useTranslation();
  const {
    messages,
    isLoading,
    conversations,
    activeConversationId,
    workingConversationIds,
    sendMessage,
    clearMessages,
    selectConversation,
    stopStreaming,
    pendingConfirm,
    answerConfirm,
    dismissConfirm,
  } = useChat({ persistHistory: true });
  const streamingMessageId = isLoading ? messages[messages.length - 1]?.id : undefined;
  // Floating quick prompts above the composer: the prompts users type most
  // often, one click to send. The first/third/fifth entries are the cards
  // that used to sit in the middle of the empty state — moved down here.
  const quickPrompts = [
    { key: "chat.suggestion_summary", icon: Sparkles, label: t("chat.suggestion_summary") },
    { key: "chat.quick_minutes", icon: FileText, label: t("chat.quick_minutes") },
    { key: "chat.suggestion_actions", icon: ListChecks, label: t("chat.suggestion_actions") },
    { key: "chat.quick_todos", icon: ListOrdered, label: t("chat.quick_todos") },
    { key: "chat.suggestion_notes", icon: BookOpen, label: t("chat.suggestion_notes") },
    { key: "chat.quick_plan", icon: CalendarDays, label: t("chat.quick_plan") },
    { key: "chat.quick_translate", icon: Globe, label: t("chat.quick_translate") },
    { key: "chat.quick_rewrite", icon: Pencil, label: t("chat.quick_rewrite") },
  ];

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
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [attachmentDrafts, setAttachmentDrafts] = useState<AttachmentDraft[]>([]);
  const hasUploadingAttachments = attachmentDrafts.some((d) => d.status === "uploading");

  const removeAttachmentDraft = (draft: AttachmentDraft) => {
    if (draft.previewUrl) URL.revokeObjectURL(draft.previewUrl);
    setAttachmentDrafts((prev) => prev.filter((d) => d.localId !== draft.localId));
  };

  const clearAttachmentDrafts = () => {
    setAttachmentDrafts((prev) => {
      for (const draft of prev) {
        if (draft.previewUrl) URL.revokeObjectURL(draft.previewUrl);
      }
      return [];
    });
  };

  /** Validate picked files, start their uploads immediately and track progress. */
  const handleFilesChosen = (files: FileList | null) => {
    if (!files) return;
    for (const file of Array.from(files)) {
      if (!isAcceptedAttachment(file)) {
        toast.error(t("chat.attachment_rejected"), { description: file.name });
        continue;
      }
      if (isAttachmentTooLarge(file)) {
        toast.error(t("chat.attachment_too_large"), { description: file.name });
        continue;
      }
      const kind = attachmentKind(file.name, file.type);
      const localId = makeLocalId();
      const previewUrl =
        kind === "image" && typeof URL.createObjectURL === "function"
          ? URL.createObjectURL(file)
          : undefined;
      setAttachmentDrafts((prev) => [
        ...prev,
        {
          localId,
          file,
          name: file.name,
          size: file.size,
          kind,
          previewUrl,
          status: "uploading",
          progress: 0,
        },
      ]);
      uploadChatAttachment(file, (pct) =>
        setAttachmentDrafts((prev) =>
          prev.map((d) => (d.localId === localId ? { ...d, progress: pct } : d)),
        ),
      )
        .then((fileId) =>
          setAttachmentDrafts((prev) =>
            prev.map((d) => (d.localId === localId ? { ...d, status: "ready", fileId } : d)),
          ),
        )
        .catch(() => {
          setAttachmentDrafts((prev) =>
            prev.map((d) => (d.localId === localId ? { ...d, status: "error" } : d)),
          );
          toast.error(t("chat.attachment_failed"), { description: file.name });
        });
    }
  };

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, isLoading]);

  const handleSend = (content = input) => {
    const trimmedContent = content.trim();
    if (!trimmedContent || isLoading) return;
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
    if (fileIds.length > 0 || attachmentMeta.length > 0) {
      sendMessage(
        trimmedContent,
        fileIds.length > 0 ? fileIds : undefined,
        fileIds.length > 0,
        attachmentMeta.length > 0 ? attachmentMeta : undefined,
      );
    } else {
      sendMessage(trimmedContent);
    }
    setInput("");
    setMentions([]);
    resetMentionState();
    clearAttachmentDrafts();
  };

  const handleNewChat = () => {
    clearMessages();
    setInput("");
    setMentions([]);
    resetMentionState();
    clearAttachmentDrafts();
    setCopiedMessageId(null);
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

  return (
    <div className="relative flex h-full min-h-0 flex-col overflow-hidden bg-background">
      <header
        className="flex h-14 shrink-0 items-center border-b border-border/50 bg-background/80 px-4 backdrop-blur-xl select-none"
        data-tauri-drag-region
      >
        <div className="flex min-w-0 flex-1 items-center justify-center gap-2 pl-24" data-tauri-drag-region>
          <span className="truncate text-13 font-semibold tracking-tight text-foreground">
            {t("chat.page_title")}
          </span>
          {isLoading && (
            <span className="size-1.5 animate-pulse rounded-full bg-primary" aria-hidden="true" />
          )}
        </div>
        <div className="flex items-center gap-1" data-tauri-drag-region={false}>
          <Button
            variant="ghost"
            size="icon"
            className={`size-8 rounded-lg border transition-colors ${
              historyOpen
                ? "border-border bg-card text-foreground"
                : "border-transparent text-muted-foreground hover:border-border hover:bg-card hover:text-foreground"
            }`}
            onClick={() => setHistoryOpen((open) => !open)}
            title={t("chat.history")}
            aria-label={t("chat.history")}
            aria-pressed={historyOpen}
          >
            <Clock className="size-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-8 rounded-lg border border-transparent text-xs text-muted-foreground transition-colors hover:border-border hover:bg-card hover:text-foreground"
            onClick={handleNewChat}
            title={t("chat.new_chat")}
          >
            <Plus className="size-3.5" />
            {t("chat.new_chat")}
          </Button>
        </div>
      </header>

      {historyOpen && (
        <aside className="absolute bottom-0 left-0 top-14 flex w-56 flex-col border-r border-border/60">
          <ChatHistorySidebar
            conversations={conversations}
            activeConversationId={activeConversationId}
            workingConversationIds={workingConversationIds}
            onSelect={selectConversation}
            onClose={() => setHistoryOpen(false)}
          />
        </aside>
      )}

      <main
        ref={scrollRef}
        className={`${historyOpen ? "ml-56" : "ml-0"} min-h-0 flex-1 overflow-y-auto transition-[margin] duration-150`}
      >
        {messages.length === 0 && !isLoading ? (
          <EmptyChat />
        ) : (
          <div className="lyse-chat-column mx-auto w-full max-w-3xl space-y-6 px-6 py-8">
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
                      {message.content}
                    </div>
                  </div>
                </div>
              ) : (
                <article key={message.id} className="group flex items-start gap-3">
                  <AssistantAvatar size={36} className="mt-0.5 shrink-0" />
                  <div className="min-w-0 flex-1">
                    <div className="mb-1.5 text-2xs font-semibold uppercase tracking-[0.12em] text-muted-foreground/80">
                      {t("chat.ai_assistant")}
                    </div>
                    <AssistantMessage
                      message={message}
                      isStreaming={message.id === streamingMessageId}
                      copied={copiedMessageId === message.id}
                      onCopy={() => handleCopy(message.id, message.content)}
                    />
                  </div>
                </article>
              ),
            )}
          </div>
        )}
      </main>

      <div
        className={`${historyOpen ? "ml-56" : "ml-0"} pointer-events-none shrink-0 bg-background/95 px-4 pb-4 pt-3 transition-[margin] duration-150 dark:bg-background/75 dark:backdrop-blur-xl`}
      >
        <div className="lyse-chat-column pointer-events-auto mx-auto max-w-3xl">
          <QuickPromptStrip
            prompts={quickPrompts}
            onSelect={(prompt) => handleSend(prompt)}
            disabled={isLoading}
          />
          <div className="relative rounded-xl border border-input bg-white p-2 shadow-[0_1px_2px_rgba(0,0,0,0.04),0_4px_14px_rgba(0,0,0,0.035)] transition-[border-color,box-shadow] duration-150 focus-within:border-neutral-400 focus-within:shadow-[0_1px_2px_rgba(0,0,0,0.04),0_0_0_3px_rgba(0,0,0,0.04)] dark:bg-card dark:shadow-[0_10px_35px_rgba(0,0,0,0.28)] dark:focus-within:border-white/20 dark:focus-within:shadow-[0_10px_35px_rgba(0,0,0,0.28),0_0_0_3px_rgba(255,255,255,0.05)]">
            {mentionDetection && (
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
            <MentionChips mentions={activeChips} onRemove={removeMention} />
            <ChatAttachmentTray drafts={attachmentDrafts} onRemove={removeAttachmentDraft} />
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept={ATTACHMENT_ACCEPT_ATTR}
              className="hidden"
              onChange={(event) => {
                handleFilesChosen(event.target.files);
                // Allow picking the same file again after a re-select.
                event.target.value = "";
              }}
            />
            <Textarea
              ref={textareaRef}
              value={input}
              onChange={(event) => {
                const value = event.target.value;
                setInput(value);
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
              disabled={isLoading}
              rows={1}
              autoFocus
            />
            <div className="flex items-center gap-1 px-0.5 pb-0.5 pt-1">
              <div className="flex items-center gap-0.5">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="size-8 rounded-lg border-0 bg-transparent text-muted-foreground shadow-none transition-colors hover:bg-muted hover:text-foreground dark:hover:bg-white/[0.06]"
                  title={t("chat.attach_files")}
                  aria-label={t("chat.attach_files")}
                  onClick={() => fileInputRef.current?.click()}
                >
                  <Plus className="size-4" strokeWidth={1.8} />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="size-8 rounded-lg border-0 bg-transparent text-muted-foreground shadow-none transition-colors hover:bg-muted hover:text-foreground dark:hover:bg-white/[0.06]"
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
                    : t("chat.input_hint")}
              </span>
              {isLoading ? (
                <Button
                  type="button"
                  size="icon"
                  variant="outline"
                  className="size-8 rounded-lg border-border bg-background text-foreground shadow-none transition-colors hover:bg-muted"
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
                  className="size-8 rounded-lg bg-foreground text-background shadow-[0_1px_2px_rgba(0,0,0,0.12)] transition-all hover:bg-foreground/85 hover:shadow-[0_2px_7px_rgba(0,0,0,0.12)] disabled:bg-muted disabled:text-muted-foreground disabled:shadow-none dark:bg-primary dark:text-primary-foreground dark:hover:bg-primary/90"
                  onClick={() => handleSend()}
                  disabled={!input.trim() || hasUploadingAttachments}
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

      <ConfirmDialog
        confirm={pendingConfirm?.confirm ?? null}
        onSelect={(value) => {
          if (pendingConfirm) answerConfirm(pendingConfirm.messageId, value);
        }}
        onDismiss={() => {
          if (pendingConfirm) dismissConfirm(pendingConfirm.messageId);
        }}
      />
    </div>
  );
}

interface QuickPrompt {
  key: string;
  icon: ComponentType<{ className?: string }>;
  label: string;
}

/**
 * Floating quick-prompt chips anchored right above the composer: one row,
 * horizontally scrollable, each a one-click send of a frequently typed
 * question. Dims (without collapsing) while a reply is streaming so the
 * composer height stays stable.
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
  return (
    <div
      className={`no-scrollbar -mx-1 mb-2 flex gap-1.5 overflow-x-auto px-1 pb-0.5 transition-opacity duration-200 [mask-image:linear-gradient(to_right,black_92%,transparent)] ${
        disabled ? "pointer-events-none opacity-40" : "opacity-100"
      }`}
    >
      {prompts.map((prompt) => (
        <button
          key={prompt.key}
          type="button"
          onClick={() => onSelect(prompt.label)}
          className="flex shrink-0 items-center gap-1.5 rounded-full border border-border/70 bg-card px-3 py-1.5 text-xs text-muted-foreground shadow-sm transition-[border-color,background-color,color] hover:border-primary/25 hover:bg-accent/50 hover:text-foreground"
        >
          <prompt.icon className="size-3.5 shrink-0 text-primary/70" />
          <span className="whitespace-nowrap">{prompt.label}</span>
        </button>
      ))}
    </div>
  );
}

function EmptyChat() {
  const { t } = useTranslation();

  return (
    <div className="relative mx-auto flex min-h-full w-full max-w-3xl flex-col items-center justify-center overflow-hidden px-6 py-12 text-center">
      <AssistantAvatar size={148} className="relative mb-4" />
      <h1 className="relative text-xl font-semibold tracking-tight text-foreground">
        {t("chat.welcome_title")}
      </h1>
      <p className="relative mt-2 max-w-md text-sm leading-6 text-muted-foreground">
        {t("chat.page_description")}
      </p>
    </div>
  );
}

interface AssistantMessageProps {
  message: ReturnType<typeof useChat>["messages"][number];
  isStreaming: boolean;
  copied: boolean;
  onCopy: () => void;
}

function AssistantMessage({ message, isStreaming, copied, onCopy }: AssistantMessageProps) {
  const { t } = useTranslation();

  return (
    <>
      {message.error ? (
        <div className="rounded-xl border border-destructive/30 bg-destructive/10 px-3 py-2.5 text-sm leading-6 text-destructive">
          {message.content}
        </div>
      ) : message.content ? (
        <div className="rounded-2xl rounded-tl-md border border-border bg-card px-4 py-3.5 text-sm leading-6 text-foreground shadow-sm">
          <StreamingMarkdown content={message.content} isStreaming={isStreaming} mode="minimal" />
        </div>
      ) : message.status ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <span className="size-1.5 animate-pulse rounded-full bg-current" />
          <WaitingText status={message.status} />
        </div>
      ) : (
        <ThinkingIndicator />
      )}

      {message.content && message.status && (
        <div className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground">
          <span className="size-1.5 animate-pulse rounded-full bg-current" />
          <WaitingText status={message.status} />
        </div>
      )}

      {message.sources && message.sources.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {message.sources.map((source, index) => (
            <span
              key={`${source}-${index}`}
              className="rounded-full border border-primary/20 bg-primary/10 px-2 py-0.5 text-3xs text-accent-brand-text"
            >
              {source}
            </span>
          ))}
        </div>
      )}

      <ChatAttachments attachments={message.attachments} />

      {message.content && !message.error && (
        <div className="mt-2 flex items-center opacity-100 transition-opacity sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100">
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
        </div>
      )}
    </>
  );
}
