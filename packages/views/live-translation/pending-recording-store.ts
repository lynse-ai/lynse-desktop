"use client";

import { create } from "zustand";
import type { QueryClient } from "@tanstack/react-query";

/**
 * Optimistic card for a recording that has started but whose local
 * transcription record has not landed yet (stop acks immediately; the Rust
 * side drains the sidecar and persists in the background). The notes list
 * renders a placeholder from here and refreshes until the real record shows.
 */
export interface PendingRecording {
  /** Live session id; the persisted record id will be `local:live:<sessionId>`. */
  sessionId: string;
  title: string;
  startedAt: string;
  phase: "recording" | "saving";
}

/** Record id a live session will get once persisted. */
export function pendingRecordingRecordId(sessionId: string): string {
  return `local:live:${sessionId}`;
}

/** Longest background persist (sidecar drain + WAV mixdown) is expected to
 *  finish well within this window; past it the card is dropped so a crashed
 *  persist cannot leave a phantom entry until restart. */
const SAVE_TIMEOUT_MS = 5 * 60 * 1000;

interface PendingRecordingState {
  pending: PendingRecording[];
  add: (entry: PendingRecording) => void;
  markSaving: (sessionId: string) => void;
  remove: (sessionId: string) => void;
}

export const usePendingRecordingStore = create<PendingRecordingState>((set) => ({
  pending: [],
  add: (entry) =>
    set((state) => ({
      pending: [...state.pending.filter((p) => p.sessionId !== entry.sessionId), entry],
    })),
  markSaving: (sessionId) => {
    set((state) => ({
      pending: state.pending.map((p) =>
        p.sessionId === sessionId ? { ...p, phase: "saving" as const } : p,
      ),
    }));
    // Safety net: if neither `completed` nor an error ever arrives (persist
    // crashed), stop advertising the card after the timeout. A normal removal
    // makes this a no-op.
    setTimeout(() => {
      usePendingRecordingStore.getState().remove(sessionId);
    }, SAVE_TIMEOUT_MS);
  },
  remove: (sessionId) =>
    set((state) => ({
      pending: state.pending.filter((p) => p.sessionId !== sessionId),
    })),
}));

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

/**
 * Refresh the notes lists until the freshly persisted record shows up (or a
 * bounded number of attempts passes). The `completed` event fires after the
 * Rust side wrote the record, so the first refetch normally finds it — the
 * loop is insurance against an in-flight fetch carrying stale data.
 */
export async function refreshUntilRecordingVisible(queryClient: QueryClient, sessionId: string) {
  const recordId = pendingRecordingRecordId(sessionId);
  const isVisible = () =>
    queryClient
      .getQueryCache()
      .findAll({ queryKey: ["files"] })
      .some((query) => {
        const data = query.state.data as { localRecords?: { id: string }[] } | undefined;
        return data?.localRecords?.some((record) => record.id === recordId) ?? false;
      });

  for (let attempt = 0; attempt < 8; attempt++) {
    void queryClient.invalidateQueries({ queryKey: ["files"] });
    void queryClient.invalidateQueries({ queryKey: ["notes"] });
    await sleep(1500);
    if (isVisible()) return;
  }
}
