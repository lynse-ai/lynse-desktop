"use client";
import { useMemo, useState } from "react";
import { useTranslation } from "@lynse/core/i18n/react";
import { Button } from "@lynse/ui/components/ui/button";
import { graphAnswers, type GraphQuestion } from "./graph-queries";
import { graphModalityKey, graphNodeKindKey, graphStatusKey } from "./graph-vocabulary";
import { GraphCitations } from "./graph-evidence";
import type { KnowledgeGraph, SourceRef } from "./types";
export function GraphQuestions({ graph, onSelect, onSource, compact = false }: { graph: KnowledgeGraph; compact?: boolean; onSelect: (id: string) => void; onSource: (ref: SourceRef) => void }) {
  const { t } = useTranslation();
  const [question, setQuestion] = useState<GraphQuestion>("responsibility");
  const [project, setProject] = useState("");
  const projectId = graph.nodes.some(node => node.id === project && node.subtype === "project") ? project : "";
  const answers = useMemo(() => graphAnswers(graph, question, projectId), [graph, question, projectId]);
  return <details className="rounded-lg border border-border p-3" open={!compact}><summary className="cursor-pointer text-sm font-medium">{t("workbench.graph_questions")}</summary>
    <div className="mt-3 space-y-3"><div className="flex flex-wrap gap-1" role="group" aria-label={t("workbench.graph_questions")}>{(["responsibility", "tasks", "decisions"] as const).map(value => <Button key={value} size="sm" variant={question === value ? "secondary" : "ghost"} aria-pressed={question === value} onClick={() => setQuestion(value)}>{t(`workbench.graph_question_${value}`)}</Button>)}</div>
      <label className="flex flex-wrap items-center gap-2 text-xs"><span>{t("workbench.graph_project_scope")}</span><select className="max-w-full rounded-md border border-input bg-background p-2" value={projectId} onChange={event => setProject(event.target.value)}><option value="">{t("workbench.graph_all_projects")}</option>{graph.nodes.filter(node => node.subtype === "project").map(node => <option key={node.id} value={node.id}>{node.title} · {graph.nodes.find(source => source.id === `source:${node.sourceId}`)?.title ?? t("workbench.graph_source")}</option>)}</select></label>
      <p className="text-xs leading-relaxed text-muted-foreground">{t(question === "tasks" ? "workbench.graph_tasks_hint" : "workbench.graph_queries_hint")}</p>
      <div className="max-h-80 space-y-3 overflow-y-auto">{answers.map(({ node, relation, target, needsConfirmation }) => <article key={relation?.id ?? node.id} className="space-y-2 rounded-md border border-border p-3 text-xs">
        <button type="button" className="text-start font-medium hover:underline" onClick={() => onSelect(node.id)}>{node.title}{target ? ` → ${target.title}` : ""}</button><p className="text-muted-foreground">{t(graphNodeKindKey(node))} · {t(needsConfirmation ? "workbench.graph_unreviewed" : "workbench.graph_confirmed")}{(relation?.modality ?? node.modality) ? ` · ${t(graphModalityKey[(relation?.modality ?? node.modality)!])}` : ""}{!relation ? ` · ${t(graphStatusKey[node.status])}` : ""}</p>
        {node.linkedTodo && <p>{t("workbench.graph_todo_status", { status: t(node.linkedTodo.completed ? "workbench.graph_completed" : "workbench.graph_todo_open") })}</p>}
        {node.dueText && <p>{t("workbench.graph_due_literal", { time: node.dueText })}</p>}
        <GraphCitations citations={relation?.citations ?? node.citations} graph={graph} onSource={onSource} />
      </article>)}</div>
      {!answers.length && <p className="text-xs text-muted-foreground">{t("workbench.graph_no_answers")}</p>}
    </div>
  </details>;
}
