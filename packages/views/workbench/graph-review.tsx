"use client";
import { useState } from "react";
import { useTranslation } from "@lynse/core/i18n/react";
import { Button } from "@lynse/ui/components/ui/button";
import { useNavigation } from "../navigation";
import { useWiki } from "./wiki";
import { graphModalityKey, graphStatusKey } from "./graph-vocabulary";
import type { GraphNode, GraphStatus } from "./types";
export function GraphReview({ node }: { node: GraphNode }) {
  const { t } = useTranslation();
  const wiki = useWiki();
  const navigation = useNavigation();
  const [description, setDescription] = useState(node.description);
  const [status, setStatus] = useState(node.status);
  const [modality, setModality] = useState(node.modality ?? "uncertain");
  const states: GraphStatus[] = ["unknown", "proposed", "active", "blocked", "completed", "cancelled", "unresolved"];
  return <div className="space-y-2 rounded-lg border border-border p-3 text-xs">
    <p>{t(node.review === "confirmed" ? "workbench.graph_confirmed" : "workbench.graph_unreviewed")}{node.userEdited ? ` · ${t("workbench.graph_user_corrected")}` : ""}</p>
    {node.confidence != null && <p className="text-muted-foreground">{t("workbench.graph_confidence", { value: Math.round(node.confidence * 100) })}</p>}
    <div className="flex flex-wrap gap-2"><Button size="sm" variant="outline" disabled={wiki.busy || node.review === "confirmed"} onClick={() => void wiki.mutate({ action: "tracking_review", id: node.id, review: "confirmed" }).catch(() => undefined)}>{t("workbench.graph_confirm")}</Button>
      {(node.review === "confirmed" || node.userEdited) && <Button size="sm" variant="ghost" disabled={wiki.busy} onClick={() => void wiki.mutate({ action: "tracking_reset", id: node.id }).catch(() => undefined)}>{t("workbench.graph_reset_review")}</Button>}</div>
    <details><summary className="cursor-pointer">{t("workbench.graph_correct")}</summary><form className="mt-2 space-y-2" onSubmit={event => { event.preventDefault(); void wiki.mutate({ action: "tracking_review", id: node.id, review: "confirmed", description, status, modality }).catch(() => undefined); }}>
      <label className="block space-y-1"><span>{t("workbench.graph_statement")}</span><textarea required maxLength={1000} className="min-h-20 w-full rounded-md border border-input bg-background p-2" value={description} onChange={event => setDescription(event.target.value)} /></label>
      <label className="flex flex-wrap items-center gap-2"><span>{t("workbench.graph_reported_status")}</span><select className="max-w-full rounded border border-input bg-background p-2" value={status} onChange={event => setStatus(event.target.value as GraphStatus)}>{states.map(value => <option key={value} value={value}>{t(graphStatusKey[value])}</option>)}</select></label>
      <label className="flex flex-wrap items-center gap-2"><span>{t("workbench.graph_modality")}</span><select className="max-w-full rounded border border-input bg-background p-2" value={modality} onChange={event => setModality(event.target.value as typeof modality)}>{Object.entries(graphModalityKey).map(([value, key]) => <option key={value} value={value}>{t(key)}</option>)}</select></label>
      <Button type="submit" size="sm" disabled={wiki.busy || !description.trim()}>{t("workbench.save")}</Button>
    </form></details>
    {node.linkedTodo ? <div className="space-y-1"><p>{t("workbench.graph_todo_status", { status: t(node.linkedTodo.completed ? "workbench.graph_completed" : "workbench.graph_todo_open") })}</p><Button size="sm" variant="outline" onClick={() => navigation.push("/todo")}>{t("workbench.graph_view_todo")}</Button></div> : node.kind === "event" && ["task", "commitment"].includes(node.subtype ?? "") && node.modality !== "negated" && !["completed", "cancelled"].includes(node.status) && <Button size="sm" variant="outline" disabled={wiki.busy} onClick={() => void wiki.mutate({ action: "tracking_todo", id: node.id }).catch(() => undefined)}>{t("workbench.graph_create_todo")}</Button>}
    <p className="text-muted-foreground">{t("workbench.graph_review_hint")}</p>
  </div>;
}
