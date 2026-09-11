"use client";

import { useEffect, useRef } from "react";
import { api } from "@lynse/core/api";
import { useTranslation } from "@lynse/core/i18n/react";
import { PollChatTransport } from "../workspace/chat-transport";
import { getDesktopFeishuApi, type FeishuIncomingMessage } from "./feishu";

/** One unanswered Feishu question must not hang forever — the poll transport
 *  has its own 190s deadline, this is the user-facing budget. */
const TURN_TIMEOUT_MS = 120_000;
/** Cap on stored event ids (dedup across redeliveries). */
const SEEN_LIMIT = 512;
/** Feishu interactive-card markdown soft limit (Rust truncates too). */
const ANSWER_MARKDOWN_LIMIT = 9_000;

/** Strip "@bot" mention tokens ("@_user_1") so the model sees only the
 *  actual question, then trim the leftover punctuation/whitespace. */
function stripMentionTokens(text: string, mentions: FeishuIncomingMessage["mentions"]): string {
  let result = text;
  for (const mention of mentions) {
    if (mention.key) result = result.split(mention.key).join(" ");
  }
  return result.replace(/^[\s:：,，]+/u, "").trim();
}

/**
 * Headless agent: relays Feishu chat messages to the existing cloud AI
 * (the same PollChatTransport the in-app chat uses, with the logged-in
 * user's token) and replies in-thread. Mounted once inside the AuthGate in
 * App.tsx — it renders nothing and answers no matter which page is open.
 *
 * Rules: single chats always get an answer; groups only when the message
 * @-mentions the bot. Multi-turn continuity maps (chat, sender) → lynclaw
 * sessionId. Questions in the same chat are serialized (group QPS limits).
 */
export function FeishuAgent() {
  const { t } = useTranslation();
  // Latest translator without resubscribing the Rust event listener.
  const translateRef = useRef(t);
  translateRef.current = t;
  const feishu = getDesktopFeishuApi();

  useEffect(() => {
    if (!feishu) return;

    /** (chat, sender) → lynclaw session id for multi-turn conversations. */
    const sessions = new Map<string, string>();
    /** Per-chat turn queue — replies to one group never interleave. */
    const queues = new Map<string, Promise<void>>();
    const seen = new Set<string>();

    const remember = (id: string): boolean => {
      if (!id) return true;
      if (seen.has(id)) return false;
      seen.add(id);
      if (seen.size > SEEN_LIMIT) {
        const oldest = seen.values().next().value;
        if (oldest) seen.delete(oldest);
      }
      return true;
    };

    const enqueue = (chatId: string, task: () => Promise<void>) => {
      const tail = (queues.get(chatId) ?? Promise.resolve()).catch(() => undefined);
      const next = tail.then(task);
      queues.set(chatId, next);
      void next.finally(() => {
        if (queues.get(chatId) === next) queues.delete(chatId);
      });
    };

    const answer = async (event: FeishuIncomingMessage) => {
      const translate = translateRef.current;
      const question = stripMentionTokens(event.text, event.mentions);
      if (!question) return;

      const conversationKey =
        event.chatType === "p2p"
          ? `p2p:${event.chatId}`
          : `group:${event.chatId}:${event.senderId}`;
      let sessionId = sessions.get(conversationKey);
      if (!sessionId) {
        sessionId = `feishu-${crypto.randomUUID()}`;
        sessions.set(conversationKey, sessionId);
      }

      // Acknowledge right away so the asker knows the bot picked it up —
      // the answer itself can take a minute.
      await feishu.replyText(event.messageId, translate("feishu.agent_ack")).catch(() => undefined);

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), TURN_TIMEOUT_MS);
      let answerText: string | null = null;
      let errorMessage: string | null = null;
      try {
        await new PollChatTransport().send({
          query: question,
          sessionId,
          userId: event.senderId || "feishu",
          fileIds: [],
          userSpecifiedFile: false,
          token: api().getToken(),
          signal: controller.signal,
          onEvent: (chatEvent) => {
            if (chatEvent.type === "done") answerText = chatEvent.text ?? "";
            else if (chatEvent.type === "error") errorMessage = chatEvent.message;
          },
        });
      } catch (error) {
        errorMessage = error instanceof Error ? error.message : String(error);
      } finally {
        clearTimeout(timeout);
      }

      const text = (answerText ?? "").trim();
      try {
        if (text) {
          await feishu.replyMarkdown(event.messageId, text.slice(0, ANSWER_MARKDOWN_LIMIT));
        } else {
          await feishu.replyText(
            event.messageId,
            translate("feishu.agent_failed", { error: errorMessage ?? "timeout" }),
          );
        }
      } catch (error) {
        console.error("[feishu-agent] failed to deliver answer", error);
      }
    };

    let disposed = false;
    let unlisten: (() => void) | null = null;
    void feishu.onEvent((event) => {
      if (event.eventType !== "im.message.receive_v1") return;
      if (event.senderType !== "user") return;
      if (event.messageType !== "text") return;
      if (!event.text.trim()) return;
      // Groups: only answer when the message @-mentions the bot.
      if (event.chatType === "group" && !event.mentionedBot) return;
      if (!remember(event.eventId || event.messageId)) return;
      enqueue(event.chatId, () => answer(event));
    }).then((dispose) => {
      if (disposed) dispose();
      else unlisten = dispose;
    });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [feishu]);

  return null;
}
