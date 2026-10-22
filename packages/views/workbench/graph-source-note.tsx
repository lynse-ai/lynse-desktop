"use client";

import { useEffect, useRef } from "react";
import { AudioPlayer, type AudioPlayerHandle } from "../workspace/audio-player";
import { stripVaultFrontmatter } from "../workspace/note-vault";
import { useFileAudioUrl } from "../workspace/hooks/use-files";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "@lynse/core/i18n/react";
import { Button } from "@lynse/ui/components/ui/button";
import { Markdown } from "@lynse/ui/markdown";
import { getWorkbenchApi, useWorkbench } from "./api";
import { useWiki } from "./wiki";
import type { SourceRef } from "./types";

export function GraphSourceNote({ source }: { source: SourceRef }) {
  const { t } = useTranslation();
  const wiki = useWiki();
  const api = getWorkbenchApi();
  const result = useQuery({
    queryKey: ["wiki-source-note", wiki.status?.scope, source.id, source.revision],
    queryFn: () => api!.read(source.id),
    enabled: !!api && !!wiki.status?.scope,
    networkMode: "always",
  });
  const player = useRef<AudioPlayerHandle>(null);
  const fromSummary = source.kind === "meeting_summary";
  const current = result.data?.document.revision === source.revision;
  const audio = useFileAudioUrl(!fromSummary && current && result.data?.document.kind === "meeting" ? source.id : null);
  const summaries = result.data ? [
    ...result.data.document.conclusions.map(summary => summary.conclusionText),
    ...(result.data.artifacts?.summaries ?? []).filter(summary => summary.sourceRevision === result.data!.document.revision).map(summary => summary.markdown),
  ].filter((text, index, items) => text.trim() && items.indexOf(text) === index).join("\n\n") : "";
  useEffect(() => { if (audio.data && source.startMs != null) player.current?.seekTo(source.startMs / 1000); }, [audio.data, source.startMs]);
  return <article className="min-w-0 space-y-4 rounded-lg border border-border p-4" aria-label={t("workbench.wiki_source_note")}>
    <div className="space-y-2"><p className="text-xs text-muted-foreground">{t(fromSummary ? "workbench.graph_summary_source" : "workbench.graph_source")}</p><h3 className="break-words text-base font-semibold">{result.data?.document.title ?? source.id}</h3></div>
    {fromSummary && <p className="text-xs text-muted-foreground">{t("workbench.graph_summary_evidence_hint")}</p>}
    {result.data && !current && <p role="status" className="text-xs text-muted-foreground">{t("workbench.graph_source_changed")}</p>}
    {audio.data && <AudioPlayer ref={player} src={audio.data} />}
    {result.data && <Button size="sm" variant="outline" onClick={() => useWorkbench.getState().showSource(source)}>{t("workbench.graph_open_recording")}</Button>}
    {source.quote && <blockquote className="border-s-2 border-border ps-3 text-sm text-muted-foreground">{source.quote}</blockquote>}
    {result.isPending && <p role="status" className="text-sm text-muted-foreground">{t("workbench.wiki_loading_note")}</p>}
    {result.error && <div className="space-y-2"><p role="alert" className="break-words text-xs text-destructive">{String(result.error)}</p><Button size="sm" variant="outline" onClick={() => void result.refetch()}>{t("workbench.retry")}</Button></div>}
    {result.data && <Markdown mode="full">{fromSummary ? summaries : stripVaultFrontmatter(result.data.markdown)}</Markdown>}
  </article>;
}
