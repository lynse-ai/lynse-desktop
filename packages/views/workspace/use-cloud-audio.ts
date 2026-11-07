"use client";

import { useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@lynse/core/api/client";
import { getAuthStore, useAuthStore } from "@lynse/core/auth";
import { getDesktopAudioEditorApi, type CloudAudioKey } from "../audio-editor/api";
import { fetchCloudAudioUrl } from "./hooks/use-files";

interface AudioDownloadState {
  pending: boolean;
  percent: number | null;
  failed: boolean;
}

export function useCloudAudio(fileId: string | null, revision: string, filename?: string, metadataPending = false) {
  const desktop = getDesktopAudioEditorApi();
  const userId = useAuthStore(state => state.isAuthenticated ? state.user?.id : undefined);
  const managed = !!fileId && !!desktop?.downloadCloudAudio && !!desktop.getCloudAudio;
  const scope = userId ? `${api().getBaseUrl()}\n${userId}` : null;
  const request: CloudAudioKey | null = managed && fileId && scope ? {
    scope,
    fileId,
    revision,
    extension: /\.([A-Za-z0-9]+)$/.exec(filename ?? "")?.[1]?.toLowerCase() ?? null,
  } : null;
  const queryKey = ["cloud-audio", request] as const;
  const ready = !!request && !metadataPending;
  const queryClient = useQueryClient();
  const cached = useQuery({
    queryKey,
    enabled: ready,
    queryFn: () => desktop!.getCloudAudio(request!),
    networkMode: "always",
    retry: false,
  });
  const jobKey = JSON.stringify(request);
  const active = useRef(new Set<string>());
  const [jobs, setJobs] = useState<Record<string, AudioDownloadState>>({});
  const job = jobs[jobKey];
  const checking = !ready || cached.isPending;

  async function download() {
    if (!request || !desktop || checking || cached.data || active.current.has(jobKey)) return;
    active.current.add(jobKey);
    const update = (state: AudioDownloadState) => setJobs(current => ({ ...current, [jobKey]: state }));
    update({ pending: true, percent: null, failed: false });
    try {
      const url = await fetchCloudAudioUrl(request.fileId);
      const auth = getAuthStore()?.getState();
      if (!url || !auth?.isAuthenticated || request.scope !== `${api().getBaseUrl()}\n${auth.user?.id}`) {
        throw new Error("Cloud audio URL unavailable");
      }
      const audio = await desktop.downloadCloudAudio(request, url, ({ receivedBytes, totalBytes }) => {
        if (!active.current.has(jobKey)) return;
        // Reserve the fully lit waveform for a usable local copy.
        const percent = totalBytes && totalBytes > 0 ? Math.min(99, Math.floor(receivedBytes / totalBytes * 100)) : null;
        update({ pending: true, percent, failed: false });
      });
      queryClient.setQueryData(queryKey, audio);
      setJobs(current => {
        const next = { ...current };
        delete next[jobKey];
        return next;
      });
    } catch {
      update({ pending: false, percent: null, failed: true });
    } finally {
      active.current.delete(jobKey);
    }
  }

  return { managed, cacheKey: jobKey, audio: ready ? cached.data : null, checking, job, download };
}
