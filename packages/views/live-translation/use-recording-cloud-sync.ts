"use client";

import { useCallback } from "react";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "@lynse/core/i18n/react";
import { useAuthStore } from "@lynse/core/auth";
import { api } from "@lynse/core/api/client";
import {
  formatRecordStartTime,
  generateSyncFileId,
  uploadAudioViaSyncChain,
} from "../workspace/sync-upload";
import { deriveFilename } from "./recording-complete-dialog";
import { getDesktopLiveTranslationApi } from "./desktop-api";
import { useNotificationStore } from "../notifications/use-notification-store";
import type { CompletedLiveSession } from "./types";

// ───────────────────────────────────────────────────────────────
// Recording cloud sync.
//
// Uploads a finished local recording to the cloud via the direct-upload
// sync chain (the server never relays the bytes) and turns it into a
// regular cloud note:
//   1. read the local WAV captured by the Rust sidecar
//   2. uploadAudioViaSyncChain — POST sync/pre/create (placeholder) →
//      POST sync/pre/sts (objectKey + STS credentials) → client-direct
//      OSS PUT → GET sync/pre/notify (idempotent completion notice)
//   3. POST /api/business/file/trans — trigger the server-side
//      transcription + summarization pipeline (no waiting here; the file
//      list polls trans/status and shows the processing state)
//   4. finalizeLocal(sessionId, true) — mark the local record synced and
//      let Rust clean up the local WAV files
//
// The client-generated fileId is persisted on the local record before the
// first upload attempt: create upserts the placeholder by fileId, so a
// retry re-runs the chain against the same record instead of duplicating
// it. On any failure the recording stays available locally.
// ───────────────────────────────────────────────────────────────

interface SyncTarget {
  sessionId: string;
  filename: string;
  audioUrl: string;
  durationMs: number;
  startedAt?: string;
  /** fileId from an earlier attempt — reuse it across retries. */
  existingFileId?: string;
}

async function readRecordingBlob(audioUrl: string): Promise<Blob> {
  const response = await fetch(audioUrl);
  if (!response.ok) {
    throw new Error(`failed to read local recording: ${response.status}`);
  }
  return response.blob();
}

async function runCloudSync(target: SyncTarget): Promise<void> {
  const desktopApi = getDesktopLiveTranslationApi();
  if (!desktopApi) throw new Error("desktop live translation api unavailable");

  const blob = await readRecordingBlob(target.audioUrl);
  const fileId = target.existingFileId ?? generateSyncFileId();
  // Persist before uploading: a mid-flight failure leaves the id on the
  // record so the retry upserts the same placeholder (dting_file row).
  await desktopApi.setCloudFileId(target.sessionId, fileId);

  await uploadAudioViaSyncChain({
    file: blob,
    saveFilename: target.filename,
    contentType: "audio/wav",
    fileId,
    bizDuration: Math.max(1, Math.round(target.durationMs / 1000)),
    recordStartTime: target.startedAt
      ? formatRecordStartTime(target.startedAt)
      : undefined,
  });

  // Trigger the server-side transcription + summarization pipeline.
  await api().post("/api/business/file/trans", { fileId });
  await desktopApi.finalizeLocal(target.sessionId, true);
}

export function useRecordingCloudSync() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);

  const syncTarget = useCallback(
    async (target: SyncTarget, options: { rethrow?: boolean } = {}) => {
      const desktopApi = getDesktopLiveTranslationApi();
      if (!desktopApi) return;
      if (!isAuthenticated) {
        toast.info(t("live_translation.sync_need_login"));
        return;
      }

      toast.info(t("live_translation.sync_uploading"));
      try {
        await runCloudSync(target);
        await qc.invalidateQueries({ queryKey: ["files"] });
        toast.success(t("live_translation.saved"));
        // Persist into the unified notification center (the toast is ephemeral).
        useNotificationStore.getState().add({
          id: `transcription:${target.sessionId}`,
          type: "transcription",
          title: "",
          href: "/notes",
        });
      } catch (error) {
        await desktopApi.finalizeLocal(target.sessionId, false).catch(() => undefined);
        toast.warning(t("live_translation.saved_locally"), { description: String(error) });
        useNotificationStore.getState().add({
          id: `sync:${target.sessionId}`,
          type: "sync",
          title: "",
          href: "/notes",
        });
        if (options.rethrow) throw error;
      }
    },
    [isAuthenticated, qc, t],
  );

  const syncCompletedSession = useCallback(
    (session: CompletedLiveSession) =>
      syncTarget({
        sessionId: session.sessionId,
        filename: deriveFilename(session),
        audioUrl: session.playbackUrl,
        durationMs: session.durationMs,
        startedAt: session.startedAt,
      }),
    [syncTarget],
  );

  return { syncCompletedSession };
}
