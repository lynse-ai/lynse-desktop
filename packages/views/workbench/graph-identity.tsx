"use client";
import { useState } from "react";
import { useTranslation } from "@lynse/core/i18n/react";
import { Button } from "@lynse/ui/components/ui/button";
import { useWiki } from "./wiki";
import { useWorkbench } from "./api";
import type { GraphNode, KnowledgeGraph } from "./types";
export function GraphIdentity({ node, graph, onSelect }: { node: GraphNode; graph: KnowledgeGraph; onSelect: (id: string) => void }) {
  const { t } = useTranslation();
  const wiki = useWiki();
  const [target, setTarget] = useState("");
  const choices = graph.nodes.filter(other => other.id !== node.id && other.kind === "entity" && other.subtype === node.subtype);
  async function merge() {
    const scope = wiki.status?.scope;
    await wiki.mutate({ action: "tracking_merge", id: node.id, target });
    if (useWorkbench.getState().status?.scope === scope) onSelect(target);
  }
  return <details className="rounded-lg border border-border p-3 text-xs"><summary className="cursor-pointer">{t("workbench.graph_identity")}</summary><div className="mt-2 space-y-2">
    <p className="leading-relaxed text-muted-foreground">{t("workbench.graph_identity_hint")}</p>
    {node.members && <div className="space-y-2"><p className="font-medium">{t("workbench.graph_identity_separate")}</p>{node.members.map(member => <p key={member.id} className="whitespace-pre-wrap break-words"><strong>{member.title}</strong> · {graph.nodes.find(source => source.id === `source:${member.sourceId}`)?.title}<br />{member.description}</p>)}<Button size="sm" variant="outline" disabled={wiki.busy} onClick={() => void wiki.mutate({ action: "tracking_unmerge", id: node.id }).catch(() => undefined)}>{t("workbench.graph_unmerge")}</Button></div>}
    <label className="block space-y-1"><span>{t("workbench.graph_merge_target")}</span><select className="w-full max-w-full rounded border border-input bg-background p-2" value={choices.some(choice => choice.id === target) ? target : ""} onChange={event => setTarget(event.target.value)}><option value="">{t("workbench.graph_merge_choose")}</option>{choices.map(choice => <option key={choice.id} value={choice.id}>{choice.title} · {graph.nodes.find(source => source.id === `source:${choice.sourceId}`)?.title}</option>)}</select></label>
    <Button size="sm" variant="outline" className="h-auto whitespace-normal" disabled={wiki.busy || !choices.some(choice => choice.id === target)} onClick={() => void merge().catch(() => undefined)}>{t("workbench.graph_merge")}</Button>
  </div></details>;
}
