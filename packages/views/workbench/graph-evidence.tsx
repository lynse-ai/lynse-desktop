"use client";
import { useTranslation } from "@lynse/core/i18n/react";
import { useWorkbench } from "./api";
import type { GraphEvidence, KnowledgeGraph, SourceRef } from "./types";
export function GraphCitations({ citations, graph, onSource }: { citations: GraphEvidence[]; graph: KnowledgeGraph; onSource?: (source: SourceRef) => void }) {
  const { t } = useTranslation();
  const open = (ref: SourceRef) => onSource ? onSource(ref) : useWorkbench.getState().showSource(ref);
  const time = (ms: number) => `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, "0")}`;
  return <div className="space-y-2">{citations.map((ref, index) => <div key={`${ref.id}:${index}`} className="rounded-md border border-border p-2 text-xs">
    <button type="button" className="block w-full space-y-1 text-start hover:underline focus-visible:outline-2 focus-visible:outline-ring" onClick={() => open(ref)}><span className="block font-medium">{graph.nodes.find(node => node.id === `source:${ref.id}`)?.title ?? t("workbench.source")}{ref.kind === "meeting_summary" ? ` · ${t("workbench.graph_summary_source")}` : ref.startMs != null ? ` · ${time(ref.startMs)}` : ""}{ref.speaker ? ` · ${ref.speaker}` : ""}</span><span className="block whitespace-pre-wrap break-words text-muted-foreground">{ref.quote}</span></button>
    {!!ref.positions && ref.positions.length > 1 && <div className="mt-2 space-y-1"><p className="text-muted-foreground">{t("workbench.graph_multiple_positions")}</p><div className="flex flex-wrap gap-2">{ref.positions.map((position, i) => <button key={i} type="button" className="rounded border border-border px-2 py-1 hover:bg-muted" onClick={() => open({ ...ref, ...position })}>{position.startMs == null ? t("workbench.graph_position_unknown") : time(position.startMs)}{position.speaker ? ` · ${position.speaker}` : ""}</button>)}</div></div>}
    {ref.startMs == null && !ref.positions?.length && <p className="mt-1 text-muted-foreground">{t(ref.kind === "meeting_summary" ? "workbench.graph_summary_evidence_hint" : "workbench.graph_position_unknown")}</p>}
  </div>)}</div>;
}
