"use client";

import { useRef, useLayoutEffect, useState, useMemo } from "react";
import { X, Send, FileText, Plus, Square, Clock, Image as ImageIcon, Headphones } from "../../icons";
import { Button } from "@lynse/ui/components/ui/button";
import { Input } from "@lynse/ui/components/ui/input";
import { useAutoScroll } from "@lynse/ui/hooks/use-auto-scroll";
import { ChatReplyBody } from "../../chat/chat-reply-body";
import { AssistantAvatar } from "../../assistant";
import { useTranslation } from "@lynse/core/i18n/react";

import { getWorkspaceState, useWorkspaceStore } from "../store";
import { useChat } from "../hooks/use-chat";
import { ChatModelPicker } from "../model-picker";
import { isBetaFeaturesUnlocked } from "../../feature-flags";
import { useChatStore } from "../hooks/use-chat-store";
import { ChatActivity } from "../../chat/chat-activity";
import { useFiles } from "../hooks/use-files";
import { ConfirmCard } from "../confirm-card";
import { isFreshlyRevealed } from "../chat-reveal";
import { stripSkillMarker } from "../chat-skill-ref";
import { ChatAttachments } from "../../chat/chat-attachments";
import { ChatImagePicker, ChatImageTray, UserImagePreviews, imageAttachments, attachmentInput, imageCopy, useChatImages } from "../../chat/chat-images";
import { ChatConnectionCards } from "../../chat/chat-connection-cards";
import { ChatHistorySidebar } from "../../chat/chat-history-sidebar";
import { ThinkingBlock, ToolActivity } from "../../chat/chat-reasoning";
import { FollowUpChips } from "../../chat/chat-follow-ups";
import { ChatSources } from "../../chat/chat-sources";

export function ChatPanel() {
  const selectedItemId = useWorkspaceStore((s) => s.selectedItemId);
  const selectedItemTitle = useWorkspaceStore((s) => s.selectedItemTitle);
  const toggleChatPanel = useWorkspaceStore((s) => s.toggleChatPanel);
  const selectItem = useWorkspaceStore((s) => s.selectItem);
  const {
    messages,
    isLoading,
    activeConversationId,
    workingConversationIds,
    sendMessage,
    clearMessages,
    selectConversation,
    stopStreaming,
    answerConfirm,
    dismissConfirm,
    setActiveAssistant,
  } = useChat({ persistHistory: true });
  // The panel is the lynclaw surface: it stays on the cloud channel even
  // while the chat page (the only switcher) is parked on WorkBuddy.
  const workbuddyDetached = useChatStore((s) => s.activeAssistant === "workbuddy");
  const openFileChat = useChatStore((s) => s.openFileChat);
  // Zustand v5 compares selector output with Object.is on every snapshot
  // check: a selector that allocates (filter/sort) never stabilizes and React
  // re-renders forever. Subscribe to the raw slice, derive outside the hook.
  const conversations = useChatStore((s) => s.conversations);
  const cloudConversations = useMemo(
    () => selectedItemId
      ? conversations.filter((c) => c.provider !== "workbuddy" && c.contextFileId === selectedItemId)
      : [],
    [conversations, selectedItemId],
  );
  const viewActiveId = cloudConversations.some((c) => c.id === activeConversationId) ? activeConversationId : null;
  const viewMessages = useMemo(() => viewActiveId ? messages : [], [viewActiveId, messages]);
  const viewLoading = !!viewActiveId && isLoading;
  const [historyOpen, setHistoryOpen] = useState(false);
  const [input, setInput] = useState("");
  const images = useChatImages(`panel:${selectedItemId}:${viewActiveId ?? "new"}`);
  const scrollRef = useRef<HTMLDivElement>(null);
  const { t } = useTranslation();
  const { data: files } = useFiles({ pageSize: 200 });

  useLayoutEffect(() => {
    openFileChat(selectedItemId);
    setInput("");
    setHistoryOpen(false);
  }, [selectedItemId, openFileChat]);

  const selectedFileName = useMemo(() => {
    if (!selectedItemId) return null;
    const listedTitle = files?.find((f) => f.id === selectedItemId)?.title ?? null;
    return listedTitle || selectedItemTitle;
  }, [selectedItemId, files, selectedItemTitle]);

  useAutoScroll(scrollRef, { resetKey: viewActiveId });

  const handleSend = () => {
    if (!selectedItemId || (!input.trim() && !images.drafts.length) || images.reading || viewLoading) return;
    if (getWorkspaceState().selectedItemId !== selectedItemId) return;
    // A selected meeting scopes the assistant to that meeting. The send is
    // pinned to the cloud channel even while the page is on WorkBuddy.
    sendMessage(input.trim() || imageCopy().prompt, selectedItemId, true, images.drafts.length ? imageAttachments(images.drafts) : undefined, {
      assistant: "lynse",
      contextFileId: selectedItemId,
      ...(images.drafts.length ? attachmentInput(images.drafts) : {}),
    });
    images.clear();
    setInput("");
  };

  // Citation strip: resolve ids/titles against the loaded file list; a click
  // selects the cited note in the workspace when it resolves, no-op otherwise.
  const resolveSourceLabel = (source: string): string =>
    files?.find((f) => f.id === source)?.title ?? source;

  const handleOpenSource = (source: string) => {
    const match = files?.find((f) => f.id === source || f.title === source);
    if (match) selectItem(match.id, "file", match.title);
  };

  // Backend-suggested follow-up: sent as the next user turn, same channel and
  // file scoping as the composer.
  const sendFollowUp = (question: string) => {
    if (!selectedItemId || viewLoading) return;
    if (getWorkspaceState().selectedItemId !== selectedItemId) return;
    sendMessage(question, selectedItemId, true, undefined, {
      assistant: "lynse",
      contextFileId: selectedItemId,
    });
  };

  return (
    <aside className="relative flex h-full flex-col overflow-hidden bg-background">
      {/* Header */}
      <div className="flex shrink-0 flex-col border-b border-border" style={{ padding: "8px 12px", gap: 6 }}>
        <div className="flex items-center gap-2">
          <AssistantAvatar size={28} />
          <div className="flex flex-1 flex-col overflow-hidden">
            <span className="text-xs font-semibold text-muted-foreground">{t("chat.assistant_lynse")}</span>
            <span className="truncate text-2xs text-muted-foreground/60">{t("chat.ready")}</span>
          </div>
          <Button
            variant="ghost"
            size="icon"
            className={`size-6 p-0 ${historyOpen ? "bg-card text-foreground" : ""}`}
            onClick={() => setHistoryOpen((open) => !open)}
            title={t("chat.history")}
          >
            <Clock className="size-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-6 p-0"
            onClick={() => {
              if (workbuddyDetached) setActiveAssistant("lynse");
              clearMessages({ assistant: "lynse" });
            }}
            title={t("chat.new_chat")}
          >
            <Plus className="size-3.5" />
          </Button>
          <Button variant="ghost" size="icon" className="size-6 p-0" onClick={toggleChatPanel} title={t("chat.close")}>
            <X className="size-3.5" />
          </Button>
        </div>
      </div>

      {historyOpen && (
        <aside className="absolute inset-y-0 left-0 z-20 flex w-56 flex-col border-r border-border/60 bg-background">
          <ChatHistorySidebar
            conversations={cloudConversations}
            activeConversationId={viewActiveId}
            workingConversationIds={workingConversationIds}
            onSelect={(id) => {
              if (getWorkspaceState().selectedItemId !== selectedItemId) return;
              if (workbuddyDetached) setActiveAssistant("lynse");
              selectConversation(id);
              setHistoryOpen(false);
            }}
            onClose={() => setHistoryOpen(false)}
          />
        </aside>
      )}

      {/* Context bar */}
      {selectedItemId && (
        <div className="text-2xs flex shrink-0 items-center border-b border-border text-muted-foreground" style={{ padding: "6px 12px", gap: 6 }}>
          <FileText className="size-3 shrink-0" />
          <span className="truncate font-medium">{selectedFileName || selectedItemId}</span>
        </div>
      )}

      {/* Messages */}
      <div
        ref={scrollRef}
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain [scrollbar-gutter:stable]"
        style={{ padding: 12 }}
      >
        {viewMessages.length === 0 && !viewLoading && (
            <div className="flex flex-col items-center justify-center pt-10 text-center text-muted-foreground">
            <AssistantAvatar size={72} className="mb-2 opacity-90" />
            <p className="text-xs">{t("chat.empty_prompt")}</p>
            <p className="mt-1 text-2xs opacity-60">{t(selectedItemId ? "chat.empty_hint" : "workspace.select_file_hint")}</p>
          </div>
        )}
        <div className="space-y-3">
          {viewMessages.map((msg) => {
            // The transport types the answer out itself; `revealedAt` only
            // staggers attachments / support link in after the text lands.
            const revealed = msg.role === "assistant" && isFreshlyRevealed(msg);
            const waitingForConfirm = !!msg.confirm && msg.confirm.resolvedChoice === undefined;
            const messageIsStreaming = viewLoading && msg.id === viewMessages.at(-1)?.id;
            const showActivity = messageIsStreaming && !msg.thinkingActive && !waitingForConfirm;
            return (
            <div key={msg.id} className={msg.role === "user" ? "flex justify-end" : ""}>
              {/* The poll transport replays reasoning before the answer: the
                  block pins open as "thinking", folds when the text starts. */}
              {msg.role === "assistant" && msg.thinking && (
                <div className="mb-1.5">
                  <ThinkingBlock
                    text={msg.thinking}
                    active={messageIsStreaming && msg.thinkingActive && !waitingForConfirm}
                    startedAt={msg.thinkingStartedAt}
                  />
                </div>
              )}
              {msg.role === "assistant" && !!msg.toolUses?.length && (
                <div className="mb-1.5">
                  <ToolActivity tools={msg.toolUses} />
                </div>
              )}
              <div
                className={`max-w-[85%] rounded-lg px-3 py-2 text-xs leading-relaxed ${
                  msg.role === "user"
                    ? "bg-primary text-primary-foreground"
                    : "bg-muted text-foreground"
                }`}
              >
                {msg.role === "user" ? (
                  <>
                    <UserImagePreviews attachments={msg.attachments} />
                    {(msg.attachments?.length ?? 0) > 0 && (
                      <div className="mb-1.5 flex flex-wrap justify-end gap-1">
                        {msg.attachments!.map((attachment, index) => (
                          <span
                            key={attachment.id ?? `${attachment.name}-${index}`}
                            className="flex max-w-40 items-center gap-1 rounded-full border border-primary-foreground/20 bg-primary-foreground/10 px-1.5 py-0.5 text-3xs text-primary-foreground"
                            title={attachment.name}
                          >
                            {attachment.type === "image" ? (
                              <ImageIcon className="size-3 shrink-0" />
                            ) : (
                              <FileText className="size-3 shrink-0" />
                            )}
                            <span className="min-w-0 truncate">{attachment.name}</span>
                          </span>
                        ))}
                      </div>
                    )}
                    {msg.content ? (
                      <div className="whitespace-pre-wrap break-words">{stripSkillMarker(msg.content)}</div>
                    ) : (
                      <span className="text-muted-foreground">{msg.status || "…"}</span>
                    )}
                  </>
                ) : msg.content || msg.error ? (
                  <ChatReplyBody message={msg} isStreaming={viewLoading} />
                ) : msg.attachments?.length || msg.sources?.length || msg.humanSupportLink?.url || msg.connectionRequests?.length ? (
                  // Attachment-only reply (empty body server-side): the cards
                  // render below — don't keep "typing" forever.
                  null
                ) : showActivity ? (
                  <ChatActivity status={msg.status} startedAt={msg.timestamp} />
                ) : null}
                {msg.role === "assistant" && msg.content && msg.status && showActivity && (
                  <ChatActivity status={msg.status} startedAt={msg.timestamp} className="mt-2 text-3xs" />
                )}
                {msg.role === "assistant" && msg.humanSupportLink?.url && (
                  <a
                    href={msg.humanSupportLink.url}
                    target="_blank"
                    rel="noreferrer"
                    className={`mt-2 flex w-fit items-center gap-1 rounded-md border border-border bg-background px-2 py-1 text-3xs text-foreground transition-colors hover:border-primary/30 hover:bg-accent ${
                      revealed ? "animate-in fade-in duration-300 delay-[350ms] fill-mode-backwards" : ""
                    }`}
                  >
                    <Headphones className="size-3 shrink-0 text-primary/70" />
                    {msg.humanSupportLink.label?.trim() || t("chat.contact_support")}
                  </a>
                )}
                {msg.role === "assistant" && msg.confirm && (
                  <div className="mt-2">
                    <ConfirmCard
                      confirm={msg.confirm}
                      onSelect={(value) => answerConfirm(msg.id, value, getWorkspaceState().selectedItemId)}
                      onDismiss={() => {
                        if (getWorkspaceState().selectedItemId === selectedItemId) dismissConfirm(msg.id);
                      }}
                    />
                  </div>
                )}
                {msg.role === "assistant" ? (
                  <div
                    className={
                      revealed ? "animate-in fade-in duration-300 delay-[350ms] fill-mode-backwards" : undefined
                    }
                  >
                    <ChatAttachments attachments={msg.attachments} compact />
                    {!!msg.connectionRequests?.length && <ChatConnectionCards requests={msg.connectionRequests} messageId={msg.id} />}
                  </div>
                ) : (
                  <ChatAttachments attachments={msg.attachments} compact />
                )}
              </div>
              {msg.role === "assistant" && (
                <>
                  {!!msg.sources?.length && (
                    <div className="mt-1.5">
                      <ChatSources
                        sources={msg.sources}
                        resolveLabel={resolveSourceLabel}
                        content={msg.content}
                        onOpen={handleOpenSource}
                      />
                    </div>
                  )}
                  {!!msg.followUps?.length && (
                    <FollowUpChips
                      suggestions={msg.followUps}
                      onPick={sendFollowUp}
                      className="mt-1.5"
                    />
                  )}
                </>
              )}
            </div>
            );
          })}
        </div>
      </div>

      {/* Composer */}
      <div className="flex shrink-0 flex-col border-t border-border" style={{ padding: "8px 12px" }}>
        <ChatImageTray images={images} />
        <div className="flex w-full items-end gap-2">
          <ChatImagePicker key={images.scope} onFiles={files => { void images.add(files); }} disabled={!selectedItemId || images.reading} />
          <div className="min-w-0 flex-1">
            <Input
              value={input}
              onPaste={images.onPaste}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && handleSend()}
              placeholder={t("workspace.chat_placeholder")}
              disabled={!selectedItemId}
              className="h-8 text-xs"
            />
          </div>
          {/* Beta surface: hidden in official builds (feature-flags). */}
          {isBetaFeaturesUnlocked() && <ChatModelPicker />}
          {viewLoading ? (
            <Button size="icon" variant="destructive" className="size-8 shrink-0" onClick={stopStreaming} style={{ borderRadius: 8 }} title={t("chat.stop")}>
              <Square className="size-3.5 fill-current" />
            </Button>
          ) : (
            <Button
              size="icon"
              className="size-8 shrink-0"
              onClick={handleSend}
              disabled={!selectedItemId || (!input.trim() && !images.drafts.length) || images.reading}
              style={{
                background: input.trim() ? "var(--primary)" : "var(--muted)",
                color: input.trim() ? "var(--primary-foreground)" : "var(--muted-foreground)",
                borderRadius: 8,
              }}
            >
              <Send className="size-3.5" />
            </Button>
          )}
        </div>
      </div>

    </aside>
  );
}
