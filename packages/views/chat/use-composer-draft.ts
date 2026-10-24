"use client";

import type { Dispatch, SetStateAction } from "react";
import { useChatStore } from "../workspace/hooks/use-chat-store";

/** In-memory composer state survives management navigation, never account switches. */
export function useComposerDraft(conversationId: string | null, assistant: string): [string, Dispatch<SetStateAction<string>>] {
  const key = `${assistant}:${conversationId ?? "new"}`;
  const value = useChatStore(state => state.composerDrafts[key] ?? "");
  const owner = useChatStore(state => state.userId);
  return [value, next => {
    const state = useChatStore.getState();
    if (state.userId !== owner) return;
    state.setComposerDraft(key, typeof next === "function" ? next(state.composerDrafts[key] ?? "") : next);
  }];
}
