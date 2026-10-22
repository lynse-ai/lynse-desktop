"use client";

import { useEffect, useRef, useState, type CSSProperties } from "react";
import { useTranslation } from "@lynse/core/i18n/react";
import { Input } from "@lynse/ui/components/ui/input";
import { BookOpen, FileText, Network } from "../icons";
import { useNavigation } from "../navigation";
import { ResizableHandle } from "../workspace/resizable-handle";
import { GraphNodeDetails, GraphRelations, KnowledgeGraphView } from "./knowledge-graph";
import { GraphSourceNote } from "./graph-source-note";
import { useWiki, WikiTopicContent, WikiTopicForm } from "./wiki";
import type { SourceRef, WikiTopic } from "./types";

export function WikiWorkspace() {
  const { t } = useTranslation();
  const navigation = useNavigation();
  const wiki = useWiki();
  const [search, setSearch] = useState("");
  const [createdTitle, setCreatedTitle] = useState("");
  const [readerShare, setReaderShare] = useState(34);
  const stage = useRef<HTMLDivElement>(null);
  const topics = wiki.data?.topics ?? [];
  const graph = wiki.data?.graph;
  const requestedTopic = navigation.searchParams.get("topic");
  const requestedNode = navigation.searchParams.get("node");
  const [evidence, setEvidence] = useState<{ scope?: string; reference: SourceRef } | null>(null);
  const sourceId = navigation.searchParams.get("source");
  const selectedNode = graph?.nodes.find((node) => node.id === requestedNode);
  const linkedWiki = graph?.edges.find((edge) => edge.source === selectedNode?.id && edge.kind === "documented_by")?.target.replace(/^wiki:/, "");
  const matches = (topic: WikiTopic, id: string | null) => topic.id === id || topic.mergedIds?.includes(id ?? "");
  const selectedTopic = topics.find((topic) => matches(topic, requestedTopic))
    ?? topics.find((topic) => matches(topic, selectedNode?.wikiId ?? linkedWiki ?? null))
    ?? (!requestedNode && !sourceId ? topics.find((topic) => topic.title === createdTitle) ?? topics.find((topic) => !topic.excluded && !!topic.error) ?? topics.find((topic) => !topic.excluded) ?? topics[0] : undefined);
  const source = sourceId ? (evidence?.scope === wiki.status?.scope && evidence?.reference.id === sourceId ? evidence.reference : null) ?? graph?.nodes.find((node) => node.source?.id === sourceId)?.source
    ?? selectedNode?.citations.find((ref) => ref.id === sourceId)
    ?? (selectedTopic?.candidate ?? selectedTopic?.published)?.citations.find((ref) => ref.id === sourceId)
    : selectedNode?.kind === "source" ? selectedNode.source : undefined;
  const selection = (source ? graph?.nodes.find(node => node.kind === "source" && node.source?.id === source.id)?.id : null) ?? requestedNode ?? (selectedTopic ? `wiki:${selectedTopic.id}` : null);
  const term = search.trim().toLowerCase();
  const filteredTopics = topics.filter((topic) => `${topic.title} ${topic.purpose}`.toLowerCase().includes(term));
  const discoveries = graph?.nodes.filter((node) => node.kind !== "wiki" && `${node.title} ${node.description}`.toLowerCase().includes(term)) ?? [];
  const selectNode = (id: string | null) => navigation.replace(id ? `/memory?tab=wiki&node=${encodeURIComponent(id)}` : "/memory?tab=wiki");
  const selectTopic = (id: string) => navigation.replace(`/memory?tab=wiki&topic=${encodeURIComponent(id)}&node=${encodeURIComponent(`wiki:${id}`)}`);
  const selectSource = (ref: SourceRef) => {
    setEvidence({ scope: wiki.status?.scope, reference: ref });
    const params = new URLSearchParams({ tab: "wiki", source: ref.id });
    if (requestedNode) params.set("node", requestedNode);
    if (selectedTopic) params.set("topic", selectedTopic.id);
    navigation.replace(`/memory?${params}`);
  };
  const selectedTopicId = selectedTopic?.id;
  useEffect(() => {
    if (requestedTopic && selectedTopicId) document.getElementById(`wiki-topic-${selectedTopicId}`)?.focus({ preventScroll: true });
  }, [requestedTopic, selectedTopicId]);
  return <div className="@container" aria-label={t("workbench.wiki_workspace")}>
    <div className="flex min-w-0 flex-col gap-4 @min-[64rem]:flex-row">
      <nav className="min-w-0 space-y-4 rounded-lg border border-border bg-muted/15 p-3 @min-[64rem]:sticky @min-[64rem]:top-0 @min-[64rem]:max-h-[75dvh] @min-[64rem]:w-48 @min-[64rem]:shrink-0 @min-[64rem]:self-start @min-[64rem]:overflow-y-auto" aria-label={t("workbench.wiki_sidebar")}>
        <Input value={search} onChange={(event) => setSearch(event.target.value)} aria-label={t("workbench.wiki_sidebar_search")} placeholder={t("workbench.wiki_sidebar_search")} />
        <div className="space-y-2"><h2 className="px-2 text-xs font-medium text-muted-foreground">{t("workbench.topics")}</h2><div className="max-h-64 space-y-1 overflow-y-auto @min-[64rem]:max-h-none">{filteredTopics.map((topic) => <button key={topic.id} type="button" aria-current={selectedTopic?.id === topic.id && !source ? "page" : undefined} title={topic.title} className="flex w-full min-w-0 items-start gap-2 rounded-md p-2 text-start text-sm hover:bg-muted aria-[current=page]:bg-muted aria-[current=page]:font-medium" onClick={() => selectTopic(topic.id)}><BookOpen className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" /><span className="min-w-0"><span className="line-clamp-2 break-words">{topic.title}</span><span className="block text-xs text-muted-foreground">{t(topic.excluded ? "workbench.exclude" : topic.error ? "workbench.topic_failed" : topic.candidate ? "workbench.candidate" : topic.published ? "workbench.published" : "workbench.pending")}</span></span></button>)}</div></div>
        {discoveries.length > 0 && <div className="space-y-2"><h2 className="px-2 text-xs font-medium text-muted-foreground">{t("workbench.wiki_linked_notes")}</h2><div className="max-h-64 space-y-1 overflow-y-auto @min-[64rem]:max-h-none">{discoveries.map((node) => <button key={node.id} type="button" title={node.title} aria-current={selection === node.id && !selectedTopic ? "page" : undefined} className="flex w-full min-w-0 items-start gap-2 rounded-md p-2 text-start text-sm hover:bg-muted aria-[current=page]:bg-muted" onClick={() => selectNode(node.id)}>{node.kind === "source" ? <FileText className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" /> : <Network className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />}<span className="line-clamp-2 break-words">{node.title}</span></button>)}</div></div>}
        <details open={!topics.length}><summary className="cursor-pointer rounded-md border border-border p-2 text-xs font-medium">{t("workbench.topic_create")}</summary><div className="mt-3"><WikiTopicForm onCreated={(title) => { setCreatedTitle(title); navigation.replace("/memory?tab=wiki"); }} /></div><p className="mt-2 text-xs leading-relaxed text-muted-foreground">{t("workbench.topic_unique_hint")}</p></details>
      </nav>
      <div ref={stage} className="flex min-w-0 flex-1 flex-col gap-4 @min-[64rem]:flex-row @min-[64rem]:gap-0" style={{ "--wiki-reader-share": `${readerShare}%` } as CSSProperties}>
        <section className="min-w-0 space-y-4 @min-[64rem]:max-h-[75dvh] @min-[64rem]:basis-[var(--wiki-reader-share)] @min-[64rem]:overflow-y-auto @min-[64rem]:pe-4" aria-label={t("workbench.wiki_reader")}>
          {source ? <><GraphSourceNote key={`${wiki.status?.scope}:${source.id}`} source={source} />{graph && <GraphRelations selected={graph.nodes.find(node => node.source?.id === source.id)} graph={graph} onSelect={selectNode} onSource={selectSource} />}</> : selectedTopic ? <><WikiTopicContent key={`${wiki.status?.scope}:${selectedTopic.id}`} topic={selectedTopic} mutate={wiki.mutate} busy={wiki.busy} canPublish={!!wiki.status?.initialComplete && wiki.status.allowAi && wiki.status.enabled} onSource={selectSource} reading />{selectedNode && selectedNode.kind !== "wiki" && graph && <GraphNodeDetails selected={selectedNode} graph={graph} onSelect={selectNode} onSource={selectSource} />}</> : graph && selectedNode ? <div className="rounded-lg border border-border p-4"><GraphNodeDetails selected={selectedNode} graph={graph} onSelect={selectNode} onSource={selectSource} /></div> : <div className="space-y-2 rounded-lg border border-dashed border-border p-6"><BookOpen className="size-6 text-muted-foreground" aria-hidden="true" /><p className="text-sm text-muted-foreground">{t(wiki.isPending ? "workbench.wiki_loading_topics" : "workbench.wiki_reader_empty")}</p></div>}
        </section>
        <div className="hidden @min-[64rem]:flex"><ResizableHandle label={t("workbench.wiki_resize_reader")} onResize={(delta) => { const width = stage.current?.clientWidth ?? 1; const direction = stage.current && getComputedStyle(stage.current).direction === "rtl" ? -1 : 1; setReaderShare((share) => Math.max(26, Math.min(50, share + direction * delta / width * 100))); }} /></div>
        <aside className="min-w-0 flex-1 @min-[64rem]:sticky @min-[64rem]:top-0 @min-[64rem]:self-start @min-[64rem]:ps-4" aria-label={t("workbench.wiki_graph_panel")}><KnowledgeGraphView embedded selectedId={selection} onSelect={selectNode} onSource={selectSource} /></aside>
      </div>
    </div>
  </div>;
}
