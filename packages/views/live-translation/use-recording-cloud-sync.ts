"use client";

import { useCallback } from "react";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "@lynse/core/i18n/react";
import { useAuthStore } from "@lynse/core/auth";
import { api } from "@lynse/core/api/client";
import { uploadFileToOSS } from "../workspace/hooks/use-files";
import { deriveFilename } from "./recording-complete-dialog";
import { getDesktopLiveTranslationApi } from "./desktop-api";
import type { CompletedLiveSession } from "./types";

// ───────────────────────────────────────────────────────────────
// Recording cloud sync.
//
// Uploads a finished local recording to the cloud and turns it into a
// regular cloud note, following the latest Lynse API flow:
//   1. read the local WAV captured by the Rust sidecar
//   2. uploadFileToOSS — POST presign/upload → OSS PUT → GET upload/notify
//   3. POST /api/business/file/trans — trigger the server-side
//      transcription + summarization pipeline (no waiting here; the file
//      list polls trans/status and shows the processing state)
//   4. finalizeLocal(sessionId, true) — mark the local record synced and
//      let Rust clean up the local WAV files
//
// On any failure the recording stays available locally.
// ───────────────────────────────────────────────────────────────

export function useRecordingCloudSync() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);

  const syncCompletedSession = useCallback(
    async (session: CompletedLiveSession) => {
      const desktopApi = getDesktopLiveTranslationApi();
      if (!desktopApi) return;
      if (!isAuthenticated) {
        toast.info(t("live_translation.sync_need_login"));
        return;
      }

      toast.info(t("live_translation.sync_uploading"));
      try {
        const response = await fetch(session.playbackUrl);
        if (!response.ok) {
          throw new Error(`failed to read local recording: ${response.status}`);
        }
        const blob = await response.blob();
        const file = new File([blob], deriveFilename(session), { type: "audio/wav" });

        const fileId = await uploadFileToOSS(file);
        await api().post("/api/business/file/trans", { fileId });
        await desktopApi.finalizeLocal(session.sessionId, true);
        await qc.invalidateQueries({ queryKey: ["files"] });
        toast.success(t("live_translation.saved"));
      } catch (error) {
        await desktopApi.finalizeLocal(session.sessionId, false).catch(() => undefined);
        toast.warning(t("live_translation.saved_locally"), { description: String(error) });
      }
    },
    [isAuthenticated, qc, t],
  );

  return { syncCompletedSession };
}
