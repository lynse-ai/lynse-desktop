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
/** Min gap between pushes to the live card: each is a full HTTP round trip
 *  and the streaming card's client-side animation (70ms/char) needs room to
 *  drain before the next delta lands. */
const CARD_UPDATE_MIN_GAP_MS = 1_000;

/** Shape of the send/reply envelope used to grab the created card's id. */
interface FeishuMessageResponse {
  data?: { message_id?: string };
}

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
 * The ack reply is a live card that grows into the answer: primary path is
 * the official Cardkit streaming card (client-side 70ms/char typewriter),
 * falling back to im-card PATCHes and then to plain one-shot replies when
 * the app lacks the respective permissions.
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

      // ── Delivery strategy, best first ──
      // 1. Official Cardkit streaming card: the ack text types out into the
      //    answer client-side (70ms/char) as full-text pushes arrive.
      // 2. Patchable ack card (im PATCH): chunkier typewriter, for apps
      //    without the cardkit scope.
      // 3. Plain one-shot ack + final answer.
      let streamCardId: string | null = null;
      let seq = 0;
      let cardMessageId: string | null = null;
      try {
        const start = await feishu.streamStart(
          event.messageId,
          translate("feishu.agent_ack"),
        );
        streamCardId = start?.cardId || null;
      } catch {
        streamCardId = null;
      }
      if (!streamCardId) {
        try {
          const ackCard = await feishu.replyMarkdown(
            event.messageId,
            translate("feishu.agent_ack"),
          );
          cardMessageId =
            (ackCard as FeishuMessageResponse | null)?.data?.message_id ?? null;
        } catch {
          await feishu
            .replyText(event.messageId, translate("feishu.agent_ack"))
            .catch(() => undefined);
        }
      }

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), TURN_TIMEOUT_MS);
      let answerText: string | null = null;
      let errorMessage: string | null = null;
      // Accumulated deltas + a serialized push chain so the live card always
      // receives updates in order.
      let streamed = "";
      let lastPushAt = 0;
      let pushChain: Promise<unknown> = Promise.resolve();
      const push = (markdown: string) => {
        const step = () => {
          if (streamCardId) {
            seq += 1;
            const current = seq;
            return feishu.streamPush(streamCardId, markdown, current);
          }
          if (cardMessageId) return feishu.updateMarkdownCard(cardMessageId, markdown);
          return Promise.reject(new Error("no live card"));
        };
        pushChain = pushChain.then(step).catch(() => undefined);
      };

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
            if (chatEvent.type === "content") {
              streamed += chatEvent.delta;
              const now = Date.now();
              if (now - lastPushAt >= CARD_UPDATE_MIN_GAP_MS) {
                lastPushAt = now;
                push(streamed);
              }
            } else if (chatEvent.type === "done") {
              answerText = chatEvent.text ?? streamed;
            } else if (chatEvent.type === "error") {
              errorMessage = chatEvent.message;
            }
          },
        });
      } catch (error) {
        errorMessage = error instanceof Error ? error.message : String(error);
      } finally {
        clearTimeout(timeout);
      }
      // Let the last mid-stream push land before the final delivery.
      await pushChain.catch(() => undefined);

      const text = (answerText ?? "").trim();
      const finalText = text ? text.slice(0, ANSWER_MARKDOWN_LIMIT) : null;
      // On failure the live card gets the failure text (a streaming card must
      // also be closed, or its preview stays "[生成中...]" for 10 minutes).
      const payload =
        finalText ??
        translate("feishu.agent_failed", { error: errorMessage ?? "timeout" });
      try {
        if (streamCardId) {
          seq += 1;
          await feishu.streamFinish(streamCardId, payload, seq);
        } else if (cardMessageId) {
          // Patching may be unpermitted — the answer still goes out as a
          // fresh threaded reply then.
          await feishu.updateMarkdownCard(cardMessageId, payload).catch(() =>
            finalText
              ? feishu.replyMarkdown(event.messageId, finalText)
              : feishu.replyText(event.messageId, payload),
          );
        } else if (finalText) {
          await feishu.replyMarkdown(event.messageId, finalText);
        } else {
          await feishu.replyText(event.messageId, payload);
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
