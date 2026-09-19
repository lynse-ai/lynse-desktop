"use client";

import { useEffect, useRef } from "react";
import { isTranscriptionCompleted } from "../workspace/hooks/use-files";
import type { TransStatusMap } from "../workspace/types";
import { emitPluginEvent } from "./events";

/**
 * Headless counterpart of the notes page's trans-status poll: emits the
 * host-owned `transcription-completed` domain event whenever a cloud file's
 * transcription flips to completed while the page is open. The first observed
 * snapshot is baseline — only fresh transitions emit, so a mount never
 * replays old completions to subscribers.
 *
 * Decoupled from Feishu in PRD P3: pages emit host events and never import
 * plugins; the Feishu subscriber lives behind its plugin manifest.
 */
export function useEmitTranscriptionCompleted(
  transStatus: TransStatusMap | undefined,
  getTitle: (fileId: string) => string | undefined,
): void {
  const emittedRef = useRef<Set<string>>(new Set());
  const primedRef = useRef(false);
  const getTitleRef = useRef(getTitle);
  getTitleRef.current = getTitle;

  useEffect(() => {
    if (!transStatus) return;
    for (const [fileId, status] of Object.entries(transStatus)) {
      if (!isTranscriptionCompleted(status)) continue;
      if (!primedRef.current) {
        // Baseline pass: mark what was already done before we looked.
        emittedRef.current.add(fileId);
        continue;
      }
      if (emittedRef.current.has(fileId)) continue;
      emittedRef.current.add(fileId);
      emitPluginEvent("transcription-completed", {
        recordId: fileId,
        source: "cloud",
        title: getTitleRef.current(fileId),
      });
    }
    primedRef.current = true;
  }, [transStatus]);
}
