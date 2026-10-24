"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "@lynse/core/i18n/react";
import { Button } from "@lynse/ui/components/ui/button";
import { Input } from "@lynse/ui/components/ui/input";
import { Markdown } from "@lynse/ui/markdown";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@lynse/ui/components/ui/dialog";
import { ArrowLeft, ArrowRight, BookOpen, FileText, List, Network, Pencil } from "../icons";
import { useNavigation } from "../navigation";
import { GraphSourceNote } from "./graph-source-note";
import { KnowledgeGraphScene } from "./knowledge-graph-scene";
import { useWiki } from "./wiki";
import { browsingGraph, browsableTopics, recentWikiChanges, topicChanges, topicDetails, topicOverview, topicSources } from "./wiki-browse";
import { useWikiBrowser } from "./wiki-browser-state";
import type { GraphCamera } from "./graph-scene-layout";
import type { SourceRef, WikiTopic } from "./types";

export function WikiWorkspace() {
  const { t, i18n } = useTranslation();
  const navigation = useNavigation();
  const wiki = useWiki();
  const scope = wiki.status?.scope;
  const browse = useWikiBrowser(state => state.browse);
  const update = useWikiBrowser(state => state.update);
  useEffect(() => useWikiBrowser.getState().setScope(scope), [scope]);
  const cameraChanged = useCallback((camera: GraphCamera) => useWikiBrowser.getState().update({ camera }), []);
  const [source, setSource] = useState<SourceRef | null>(null);
  const [correcting, setCorrecting] = useState(false);
  const [notes, setNotes] = useState("");
  const [correctionError, setCorrectionError] = useState("");
  const [historyCount, setHistoryCount] = useState(5);
  const readerRef = useRef<HTMLElement>(null);
  const catalogSearchRef = useRef<HTMLInputElement>(null);
  const wasReading = useRef(false);
  useEffect(() => { setSource(null); setCorrecting(false); setNotes(""); setHistoryCount(5); }, [scope]);
  const allTopics = wiki.data?.topics ?? [];
  const topics = browsableTopics(allTopics);
  const graph = browsingGraph(topics, wiki.data?.topicGraph);
  const view = navigation.searchParams.get("view") === "catalog" ? "catalog" : "graph";
  const requested = navigation.searchParams.get("topic");
  const node = navigation.searchParams.get("node")?.replace(/^wiki:/, "") ?? browse.selectedId;
  const selected = topics.find(topic => topic.id === (requested ?? node) || topic.mergedIds?.includes(requested ?? node ?? ""));
  const reading = !!requested && !!selected;
  const selectedTopicId = selected?.id;
  useEffect(() => {
    if (reading) readerRef.current?.focus();
    else if (wasReading.current) {
      if (view === "catalog") catalogSearchRef.current?.focus();
      else if (selectedTopicId) document.querySelector<SVGElement>(`[data-graph-node="${CSS.escape(`wiki:${selectedTopicId}`)}"]`)?.focus({ preventScroll: true });
    }
    wasReading.current = reading;
  }, [reading, selectedTopicId, view]);
  const requestedSource = navigation.searchParams.get("source");
  const reference = source ?? (requestedSource ? allTopics.flatMap(topic => topic.published?.citations ?? []).find(ref => ref.id === requestedSource) ?? wiki.data?.graph?.nodes.find(item => item.source?.id === requestedSource)?.source : null);
  const changes = recentWikiChanges(topics);
  const date = (value: string) => { const parsed = new Date(value); return Number.isNaN(parsed.getTime()) ? "" : parsed.toLocaleDateString(i18n.language, { month: "short", day: "numeric" }); };
  const path = (values: Record<string, string> = {}) => `/memory?${new URLSearchParams({ tab: "wiki", ...(view === "catalog" ? { view: "catalog" } : {}), ...values })}`;
  function select(id: string) { update({ selectedId: id.replace(/^wiki:/, "") }); navigation.replace(path({ node: id })); }
  function read(topic: WikiTopic) { update({ selectedId: topic.id }); navigation.replace(path({ topic: topic.id, node: `wiki:${topic.id}` })); setHistoryCount(5); }
  const sourceName = (ref: SourceRef) => wiki.status?.entries.find(entry => entry.id === ref.id)?.title ?? wiki.data?.graph?.nodes.find(item => item.source?.id === ref.id)?.title ?? t("workbench.source");
  const sources = (topic: WikiTopic) => <section className="space-y-3"><h3 className="text-sm font-semibold">{t(topicSources(topic).some(source => source.kind === "gmail") ? "workbench.auto_sources" : "workbench.auto_source_meetings")}</h3><div className="space-y-1">{topicSources(topic).map(ref => <button key={ref.id} type="button" className="flex min-h-10 w-full items-start gap-2 rounded-md p-2 text-start text-sm hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring" onClick={() => setSource(ref)}><FileText className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" /><span className="min-w-0 break-words">{sourceName(ref)}</span></button>)}</div></section>;
  const correction = (topic: WikiTopic) => <Button size="sm" variant="ghost" className="text-primary" onClick={() => { setNotes(topic.notes); setCorrectionError(""); setCorrecting(true); }}><Pencil className="size-4" aria-hidden="true" />{t("workbench.auto_correct")}</Button>;
  function timeline(topic?: WikiTopic) {
    const rows = topic ? topicChanges(topic).map(change => ({ ...change, topicId: topic.id, title: topic.title })) : changes;
    return <section className="space-y-4" aria-label={t("workbench.auto_recent")}><h2 className="text-base font-semibold">{t("workbench.auto_recent")}</h2>{!rows.length && <p className="text-sm leading-relaxed text-muted-foreground">{t("workbench.auto_no_changes")}</p>}<div className="space-y-5">{rows.slice(0, reading ? historyCount : 5).map(change => <div key={`${change.topicId}:${change.id}`} className="space-y-2 border-s-2 border-primary/20 ps-4"><p className="text-xs text-muted-foreground">{date(change.createdAt)}</p>{!topic && <button type="button" className="text-start text-sm font-medium text-primary underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-ring" onClick={() => { const target = topics.find(item => item.id === change.topicId); if (target) read(target); }}>{change.title}</button>}<p className="text-sm leading-relaxed">{change.text}</p>{change.citations[0] && <button type="button" className="text-start text-xs text-muted-foreground underline underline-offset-4" onClick={() => setSource(change.citations[0]!)}>{t("workbench.auto_from", { title: sourceName(change.citations[0]) })}</button>}</div>)}</div>{reading && rows.length > historyCount && <Button size="sm" variant="outline" onClick={() => setHistoryCount(count => count + 10)}>{t("workbench.auto_more_history")}</Button>}</section>;
  }
  if (wiki.isPending) return <p role="status" className="p-6 text-sm text-muted-foreground">{t("workbench.wiki_loading_topics")}</p>;
  if (wiki.error) return <div role="alert" className="space-y-3 p-6"><p className="text-sm">{t("workbench.wiki_load_failed")}</p><Button size="sm" variant="outline" onClick={() => void wiki.refetch()}>{t("workbench.retry")}</Button></div>;
  if (!wiki.status?.automation && !topics.length) return null;
  return <div className="@container min-w-0" aria-label={t("workbench.auto_workspace")}>
    <div className={reading ? "hidden" : "mb-5 flex flex-wrap gap-2 border-b border-border pb-3"} aria-label={t("workbench.auto_views")}>
      {[{ id: "graph", label: "workbench.graph_title", icon: Network }, { id: "catalog", label: "workbench.auto_catalog", icon: List }].map(({ id, label, icon: Icon }) => <Button key={id} size="sm" variant={view === id ? "secondary" : "ghost"} aria-pressed={view === id} onClick={() => navigation.replace(`/memory?tab=wiki${id === "catalog" ? "&view=catalog" : ""}`)}><Icon className="size-4" aria-hidden="true" />{t(label)}</Button>)}
    </div>
    {!topics.length ? <div className="mx-auto flex min-h-80 max-w-lg flex-col items-center justify-center gap-3 px-5 text-center"><Network className="size-8 text-primary" aria-hidden="true" /><h2 className="text-base font-semibold">{t("workbench.auto_empty")}</h2><p className="text-sm leading-relaxed text-muted-foreground">{t("workbench.auto_empty_hint")}</p><Button size="sm" variant="outline" onClick={() => navigation.replace("/memory?tab=settings")}>{t("workbench.auto_settings")}</Button></div> : <>
      <div className={reading ? "hidden" : "grid min-w-0 gap-6 @min-[52rem]:grid-cols-[minmax(0,1fr)_19rem]"}>
        <section className="min-w-0" aria-label={t(view === "graph" ? "workbench.graph_title" : "workbench.auto_catalog")}>
          <div className={view === "graph" ? "" : "hidden"}><KnowledgeGraphScene simple nodes={graph.nodes.slice(0, 40)} edges={graph.edges} selection={selected ? `wiki:${selected.id}` : null} onSelect={select} nodeLabel={item => item.title} initialCamera={browse.camera} onCameraChange={cameraChanged} viewKey={scope} />{graph.nodes.length > 40 && <Button size="sm" variant="ghost" onClick={() => navigation.replace("/memory?tab=wiki&view=catalog")}>{t("workbench.auto_more_topics", { count: graph.nodes.length - 40 })}</Button>}</div>
          {view === "catalog" && <div className="space-y-5"><div className="flex flex-wrap items-center justify-between gap-3"><h2 className="text-lg font-semibold">{t("workbench.auto_catalog")}</h2><Input ref={catalogSearchRef} className="w-full @min-[30rem]:w-60" value={browse.search} onChange={event => update({ search: event.target.value })} aria-label={t("workbench.auto_search_topics")} placeholder={t("workbench.auto_search_topics")} /></div><div className="grid gap-4 @min-[35rem]:grid-cols-2">{topics.filter(topic => topic.title.toLocaleLowerCase().includes(browse.search.toLocaleLowerCase())).map(topic => <button key={topic.id} type="button" className="space-y-3 rounded-xl border border-border p-5 text-start hover:bg-muted/40 focus-visible:outline-2 focus-visible:outline-ring" onClick={() => read(topic)}><BookOpen className="size-5 text-primary" aria-hidden="true" /><h3 className="break-words text-base font-semibold">{topic.title}</h3><p className="line-clamp-3 break-words text-sm leading-relaxed text-muted-foreground">{topicOverview(topic)}</p><p className="text-xs text-muted-foreground">{t(topicSources(topic).some(source => source.kind === "gmail") ? "workbench.auto_source_count" : "workbench.auto_meeting_count", { count: topicSources(topic).length })}{topic.published?.createdAt ? ` · ${date(topic.published.createdAt)}` : ""}</p></button>)}</div>{!topics.some(topic => topic.title.toLocaleLowerCase().includes(browse.search.toLocaleLowerCase())) && <div className="space-y-2"><p role="status" className="text-sm text-muted-foreground">{t("workbench.wiki_no_results", { query: browse.search })}</p><Button size="sm" variant="ghost" onClick={() => update({ search: "" })}>{t("workbench.wiki_clear_search")}</Button></div>}</div>}
        </section>
        <aside className="min-w-0 space-y-6 border-t border-border pt-5 @min-[52rem]:border-s @min-[52rem]:border-t-0 @min-[52rem]:ps-6 @min-[52rem]:pt-0" aria-label={t("workbench.auto_preview")}>
          {selected ? <><div className="space-y-3"><p className="text-xs text-muted-foreground">{t(selected.topicKind === "project" ? "workbench.graph_project" : "workbench.graph_topic")}</p><h2 className="break-words text-2xl font-semibold">{selected.title}</h2><p className="text-xs text-muted-foreground">{t(topicSources(selected).some(source => source.kind === "gmail") ? "workbench.auto_source_count" : "workbench.auto_meeting_count", { count: topicSources(selected).length })}</p><p className="break-words text-sm leading-relaxed text-muted-foreground">{topicOverview(selected)}</p><Button className="min-h-11 rounded-lg px-5 text-sm" onClick={() => read(selected)}>{t("workbench.auto_read_topic")}<ArrowRight className="size-4" aria-hidden="true" /></Button></div>{selected.stale && <p className="text-sm text-muted-foreground">{t("workbench.auto_stale")}</p>}{timeline(selected)}{sources(selected)}{correction(selected)}</> : timeline()}
        </aside>
      </div>
      {reading && selected && <article ref={readerRef} tabIndex={-1} id={`wiki-topic-${selected.id}`} className="mx-auto max-w-[75ch] space-y-7 pb-8" aria-label={selected.title}>
        <Button size="sm" variant="ghost" onClick={() => navigation.replace(path({ node: `wiki:${selected.id}` }))}><ArrowLeft className="size-4" aria-hidden="true" />{t("workbench.auto_back")}</Button>
        <header className="space-y-3"><h2 className="break-words text-2xl font-semibold">{selected.title}</h2><p className="text-xs text-muted-foreground">{t(selected.published?.review === "auto_validated" ? "workbench.auto_authored" : "workbench.published")}{selected.published?.createdAt ? ` · ${date(selected.published.createdAt)}` : ""}</p>{selected.stale && <p className="text-sm text-muted-foreground">{t("workbench.auto_stale")}</p>}{selected.error && <div role="alert" className="space-y-2"><p className="text-sm text-destructive">{t("workbench.auto_update_failed")}</p><Button size="sm" variant="outline" disabled={wiki.busy || !wiki.status?.enabled || !wiki.status.allowAi || selected.pinned} onClick={() => void wiki.mutate({ action: "retry", id: selected.id }).catch(() => undefined)}>{t("workbench.retry")}</Button></div>}</header>
        <Markdown mode="full">{selected.published?.markdown.replace(/^# [^\n]+\n/, "") ?? ""}</Markdown>
        {selected.notes && <section className="space-y-2 rounded-lg bg-muted/40 p-4"><h3 className="text-sm font-semibold">{t("workbench.auto_user_notes")}</h3><p className="whitespace-pre-wrap break-words text-sm leading-relaxed">{selected.notes}</p></section>}
        {correction(selected)}{timeline(selected)}{sources(selected)}
        {!!topicDetails(selected, wiki.data?.graph).length && <details className="rounded-lg border border-border p-4"><summary className="cursor-pointer text-sm font-medium">{t("workbench.auto_related")}</summary><p className="mt-3 text-xs leading-relaxed text-muted-foreground">{t("workbench.auto_related_hint")}</p><div className="mt-4 space-y-4">{topicDetails(selected, wiki.data?.graph).map(item => <div key={item.id} className="space-y-1"><h3 className="break-words text-sm font-medium">{item.title}</h3><p className="break-words text-sm leading-relaxed text-muted-foreground">{item.description}</p>{item.citations[0] && <button type="button" className="text-start text-xs text-primary underline underline-offset-4" onClick={() => setSource(item.citations[0]!)}>{sourceName(item.citations[0])}</button>}</div>)}</div></details>}
        {!!selected.history?.length && <details className="rounded-lg border border-border p-4"><summary className="cursor-pointer text-sm font-medium">{t("workbench.auto_history")}</summary><div className="mt-4 space-y-5">{selected.history.slice().reverse().slice(0, historyCount).map(revision => <details key={revision.id}><summary className="cursor-pointer text-sm">{date(revision.createdAt)} · {t(revision.review === "auto_validated" ? "workbench.auto_authored" : revision.review === "approved" ? "workbench.published" : "workbench.candidate")}</summary><div className="mt-3"><Markdown mode="full">{revision.markdown}</Markdown></div></details>)}{selected.history.length > historyCount && <Button size="sm" variant="outline" onClick={() => setHistoryCount(count => count + 10)}>{t("workbench.auto_more_history")}</Button>}</div></details>}
      </article>}
    </>}
    <Dialog open={!!reference} onOpenChange={open => { if (!open) { setSource(null); if (requestedSource) navigation.replace(path(reading && selected ? { topic: selected.id } : {})); } }}><DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-2xl"><DialogHeader><DialogTitle>{t(reference?.kind === "gmail" ? "workbench.auto_sources" : "workbench.auto_source_meetings")}</DialogTitle><DialogDescription>{t("workbench.auto_source_hint")}</DialogDescription></DialogHeader>{reference && <GraphSourceNote key={`${scope}:${reference.id}`} source={reference} />}</DialogContent></Dialog>
    <Dialog open={correcting && !!selected} onOpenChange={setCorrecting}><DialogContent className="sm:max-w-lg"><DialogHeader><DialogTitle>{t("workbench.auto_correct")}</DialogTitle><DialogDescription>{t("workbench.auto_correction_hint")}</DialogDescription></DialogHeader><label className="space-y-2 text-sm"><span>{t("workbench.auto_user_notes")}</span><textarea className="min-h-40 w-full rounded-md border border-input bg-background p-3 text-sm leading-relaxed" value={notes} maxLength={20000} onChange={event => setNotes(event.target.value)} /></label>{correctionError && <p role="alert" className="text-sm text-destructive">{correctionError}</p>}<Button size="sm" disabled={wiki.busy} onClick={() => { if (selected) void wiki.mutate({ action: "correction", id: selected.id, notes }).then(() => setCorrecting(false)).catch(() => setCorrectionError(t("workbench.auto_correction_failed"))); }}>{t("workbench.save")}</Button></DialogContent></Dialog>
  </div>;
}
