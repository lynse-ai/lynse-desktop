"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { useTranslation } from "@lynse/core/i18n/react";
import { Button } from "@lynse/ui/components/ui/button";
import { Input } from "@lynse/ui/components/ui/input";
import { Network } from "../icons";
import { useNavigation } from "../navigation";
import { useWorkbench } from "./api";
import { useWiki, WikiTopicContent } from "./wiki";
import { KnowledgeGraphScene } from "./knowledge-graph-scene";
import { graphNeighborhood, GRAPH_NODE_LIMIT, visibleGraphNodes } from "./graph-visible-nodes";
import { graphRelations, graphRelationKey } from "./graph-relations";
import { GraphSourceNote } from "./graph-source-note";
import type { GraphKind, GraphNode, KnowledgeGraph, SourceRef } from "./types";

import { graphKinds as kinds, graphColors as color, graphKindKey as kindKey, graphNodeKindKey, graphStatusKey as statusKey, graphModalityKey, graphPredicateKey } from "./graph-vocabulary";
import { GraphTracking as TrackingSettings } from "./graph-tracking";
import { GraphQuestions } from "./graph-questions";
import { GraphIdentity } from "./graph-identity";
import { GraphReview } from "./graph-review";
import { GraphCitations as Citations } from "./graph-evidence";

export function TrackedDiscoveries() {
  const { t } = useTranslation();
  const navigation = useNavigation();
  const wiki = useWiki();
  const nodes = wiki.data?.graph?.nodes.filter((node) => node.kind !== "source" && node.kind !== "wiki") ?? [];
  if (!wiki.status?.enabled) return null;
  return <section className="space-y-3 rounded-lg border border-border p-4" aria-label={t("workbench.graph_discoveries")}>
    <div className="flex flex-wrap items-center justify-between gap-2"><h2 className="flex items-center gap-2 text-sm font-medium"><Network className="size-4" aria-hidden="true" />{t("workbench.graph_discoveries")}</h2><Button size="sm" variant="ghost" onClick={() => navigation.replace("/memory?tab=graph")}>{t("workbench.graph_open")}</Button></div>
    <p className="text-xs text-muted-foreground">{t("workbench.graph_discoveries_hint")}</p>
    <div className="flex flex-wrap gap-2">{nodes.slice(0, 8).map((node) => <Button key={node.id} variant="outline" size="sm" className="max-w-full" onClick={() => navigation.replace(`/memory?tab=graph&node=${encodeURIComponent(node.id)}`)}><span className="size-2 shrink-0 rounded-full" style={{ background: color[node.kind] }} /><span className="truncate">{node.title}</span><span className="shrink-0 text-xs text-muted-foreground">{t(graphNodeKindKey(node))}</span></Button>)}</div>
    {!nodes.length && <p className="text-xs text-muted-foreground">{t("workbench.graph_discoveries_empty")}</p>}
  </section>;
}

function RelationReview({ id, confirmed }: { id: string; confirmed: boolean }) {
  const wiki = useWiki(); const { t } = useTranslation();
  async function hide() {
    const scope = wiki.status?.scope;
    await wiki.mutate({ action: "tracking_dismiss", id });
    if (useWorkbench.getState().status?.scope !== scope) return;
    toast(t("workbench.graph_dismissed"), { duration: Infinity, closeButton: true, action: { label: t("workbench.graph_undo"), onClick: () => {
      if (useWorkbench.getState().status?.scope === scope) void wiki.mutate({ action: "tracking_restore", id }).catch(() => undefined);
    } } });
  }
  return <div className="flex flex-wrap gap-2"><Button size="sm" variant="ghost" disabled={wiki.busy} onClick={() => void wiki.mutate(confirmed ? { action: "tracking_reset", id } : { action: "tracking_review", id, review: "confirmed" }).catch(() => undefined)}>{t(confirmed ? "workbench.graph_reset_review" : "workbench.graph_confirm")}</Button><Button size="sm" variant="ghost" disabled={wiki.busy} onClick={() => void hide().catch(() => undefined)}>{t("workbench.graph_reject_relation")}</Button></div>;
}

export function GraphRelations({ selected, graph, onSelect, onSource }: { selected?: GraphNode; graph: KnowledgeGraph; onSelect: (id: string | null) => void; onSource?: (source: SourceRef) => void }) {
  const { t } = useTranslation();
  const groups = useMemo(() => selected ? graphRelations(graph, selected.id) : [], [graph, selected]);
  return <div className="space-y-4">{groups.map(group => <section key={group.kind} className="space-y-2" aria-label={t(graphRelationKey[group.kind])}>
    <h4 className="text-xs font-medium">{t(graphRelationKey[group.kind])} · {group.entries.length}</h4>
    {group.kind === "shared_source" && <p className="text-xs leading-relaxed text-muted-foreground">{t("workbench.graph_shared_hint")}</p>}
    <div className="space-y-1">{group.entries.map(({ node, incoming, via, edge }) => <div key={`${node.id}:${incoming}:${edge?.id ?? ""}`}><button type="button" className="block w-full rounded-md border border-border p-2 text-start text-xs hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring" onClick={() => onSelect(node.id)}>
      <span className="block break-words font-medium">{edge && graphPredicateKey[edge.kind] ? `${t(graphPredicateKey[edge.kind]!)} ${incoming ? "←" : "→"} ` : ""}{node.title}</span>
      <span className="mt-1 block text-muted-foreground">{t(graphNodeKindKey(node))}{group.kind === "wiki_link" ? ` · ${t(incoming ? "workbench.graph_linked_from" : "workbench.graph_links_to")}` : group.kind === "documented_by" ? ` · ${t(incoming ? "workbench.graph_documents" : "workbench.graph_documented_by")}` : ""}</span>
      {via.length > 0 && <span className="mt-1 block break-words text-muted-foreground">{t("workbench.graph_via", { sources: via.map(source => source.title).join(" · ") })}</span>}
    </button>{edge?.citations && <div className="space-y-2 p-2"><p className="text-xs text-muted-foreground">{edge.modality ? t(graphModalityKey[edge.modality]) + " · " : ""}{t(edge.review === "confirmed" ? "workbench.graph_confirmed" : "workbench.graph_unreviewed")}</p><Citations citations={edge.citations} graph={graph} onSource={onSource} /><RelationReview id={edge.id} confirmed={edge.review === "confirmed"} /></div>}</div>)}</div>
  </section>)}</div>;
}

export function GraphNodeDetails({ selected, graph, onSelect, onSource }: { selected?: GraphNode; graph: KnowledgeGraph; onSelect: (id: string | null) => void; onSource?: (source: SourceRef) => void }) {
  const { t } = useTranslation();
  const navigation = useNavigation();
  const wiki = useWiki();
  async function dismiss() {
    if (!selected) return;
    const scope = wiki.status?.scope;
    await wiki.mutate({ action: "tracking_dismiss", id: selected.id });
    if (useWorkbench.getState().status?.scope !== scope) return;
    onSelect(null);
    toast(t("workbench.graph_dismissed"), {
      duration: Infinity, closeButton: true,
      action: { label: t("workbench.graph_undo"), onClick: () => {
        if (useWorkbench.getState().status?.scope !== scope) return;
        void wiki.mutate({ action: "tracking_restore", id: selected.id }).catch(() => undefined);
      } },
    });
  }
  if (!selected) return <div className="flex min-h-40 flex-col justify-center gap-2 text-sm text-muted-foreground"><Network className="size-6" aria-hidden="true" /><p>{t("workbench.graph_select")}</p></div>;
  return <div className="space-y-4" aria-label={t("workbench.graph_details")}>
    <div className="space-y-2"><p className="text-xs text-muted-foreground">{t(graphNodeKindKey(selected))} · {t(statusKey[selected.status] ?? "workbench.graph_unknown")}</p><h3 className="break-words text-base font-semibold">{selected.title}</h3><p className="whitespace-pre-wrap break-words text-sm leading-relaxed">{selected.description}</p></div>
    {selected.wikiId && <Button size="sm" variant="outline" onClick={() => navigation.replace(`/memory?tab=wiki&topic=${encodeURIComponent(selected.wikiId!)}`)}>{t("workbench.graph_view_wiki")}</Button>}
    {selected.modality && <p className="text-xs text-muted-foreground">{t(graphModalityKey[selected.modality])}{selected.timeText ? ` · ${t("workbench.graph_time_literal", { time: selected.timeText })}` : ""}</p>}
    {selected.kind === "event" && !selected.timeText && <p className="text-xs text-muted-foreground">{t("workbench.graph_time_unknown")}</p>}
    {selected.extractedAt && <p className="text-xs text-muted-foreground">{t("workbench.graph_extracted_at", { time: new Date(selected.extractedAt).toLocaleString() })}</p>}
    {selected.dueText && <p className="text-xs">{t("workbench.graph_due_literal", { time: selected.dueText })}</p>}
    {selected.kind !== "source" && selected.kind !== "wiki" && <GraphReview key={selected.id + ":" + selected.reviewedAt} node={selected} />}
    {selected.kind === "entity" && <GraphIdentity node={selected} graph={graph} onSelect={onSelect} />}
    <GraphRelations selected={selected} graph={graph} onSelect={onSelect} onSource={onSource} />
    {selected.updates.length > 0 && <div className="space-y-3"><h4 className="text-xs font-medium">{t("workbench.graph_history")}</h4>{selected.updates.map((update, i) => <div key={i} className="space-y-2 border-s-2 border-border ps-3"><p className="text-xs text-muted-foreground">{update.observedAt ? new Date(update.observedAt).toLocaleDateString() : t("workbench.graph_date_unknown")} · {t(statusKey[update.status])}</p><p className="text-xs leading-relaxed">{update.description}</p><Citations citations={update.citations} graph={graph} onSource={onSource} /></div>)}</div>}
    {!selected.updates.length && <Citations citations={selected.citations} graph={graph} onSource={onSource} />}
    {selected.kind !== "source" && selected.kind !== "wiki" && <Button size="sm" variant="ghost" disabled={wiki.busy} onClick={() => void dismiss().catch(() => undefined)}>{t("workbench.graph_dismiss")}</Button>}
  </div>;
}

interface KnowledgeGraphViewProps { embedded?: boolean; selectedId?: string | null; onSelect?: (id: string | null) => void; onSource?: (source: SourceRef) => void }

export function KnowledgeGraphView(props: KnowledgeGraphViewProps) {
  const scope = useWorkbench(state => state.status?.scope);
  return <GraphView key={scope} {...props} />;
}

function GraphView({ embedded = false, selectedId, onSelect, onSource: externalSource }: KnowledgeGraphViewProps) {
  const { t } = useTranslation();
  const navigation = useNavigation();
  const wiki = useWiki();
  const graph = wiki.data?.graph;
  const needsExtraction = !!graph && !graph.nodes.some(node => node.kind !== "wiki" && node.kind !== "source");
  const [search, setSearch] = useState("");
  const [kind, setKind] = useState<GraphKind | "all">("all");
  const [browsing, setBrowsing] = useState(false);
  const [scope, setScope] = useState<"global" | "local">("local");
  const [depth, setDepth] = useState(1);
  const [trail, setTrail] = useState<string[]>([]);
  const [previewSource, setPreviewSource] = useState<SourceRef | null>(null);
  const [localSelection, setLocalSelection] = useState<string | null>(navigation.searchParams.get("node"));
  const selection = selectedId === undefined ? localSelection : selectedId;
  const lastSelection = useRef(selection);
  const returning = useRef(false);
  const nodes = graph?.nodes;
  const edges = graph?.edges;
  useEffect(() => { if (previewSource && !nodes?.some(node => node.kind === "source" && node.source?.id === previewSource.id)) setPreviewSource(null); }, [nodes, previewSource]);
  const selected = nodes?.find(node => node.id === selection);
  useEffect(() => {
    const last = lastSelection.current;
    if (last === selection) return;
    lastSelection.current = selection;
    if (!returning.current && last && selection && nodes?.some(node => node.id === last)) setTrail(items => [...items.slice(-29), last]);
    returning.current = false;
  }, [selection, nodes]);
  const local = scope === "local" && !!selected;
  const hasFilter = !!search.trim() || kind !== "all";
  const filtered = useMemo(() => (nodes ?? []).filter(node => (kind === "all" || node.kind === kind) && (node.title + " " + node.description + " " + (node.members?.map(member => member.title).join(" ") ?? "")).toLowerCase().includes(search.trim().toLowerCase())), [nodes, kind, search]);
  const neighborhood = useMemo(() => graphNeighborhood(nodes ?? [], edges ?? [], selection, depth), [nodes, edges, selection, depth]);
  const sceneNodes = local ? neighborhood : filtered;
  const visible = useMemo(() => local ? neighborhood.slice(0, GRAPH_NODE_LIMIT) : visibleGraphNodes(filtered, edges ?? [], selection), [local, neighborhood, filtered, edges, selection]);
  const setSelection = (id: string | null, remember = true) => {
    if (!remember) returning.current = true;
    setPreviewSource(null); setLocalSelection(id); setScope("local"); onSelect?.(id);
  };
  const previous = trail.findLast(id => id !== selection && nodes?.some(node => node.id === id));
  const goBack = () => {
    if (!previous) return;
    setTrail(items => items.slice(0, items.lastIndexOf(previous)));
    setSelection(previous, false);
  };
  const openSource = (reference: SourceRef) => {
    if (embedded && externalSource) { setPreviewSource(reference); externalSource(reference); return; }
    const source = nodes?.find(node => node.kind === "source" && node.source?.id === reference.id);
    if (source) setSelection(source.id);
    setPreviewSource(reference);
  };
  if (!graph) return <section className="space-y-3" aria-label={t("workbench.graph_title")}><h2 className="text-base font-semibold">{t("workbench.graph_title")}</h2><p role={wiki.error ? "alert" : "status"} className="text-sm text-muted-foreground">{t(wiki.isPending ? "workbench.graph_loading" : "workbench.graph_load_failed")}</p>{wiki.error && <p className="break-words text-xs text-destructive">{String(wiki.error)}</p>}{!wiki.isPending && <Button size="sm" variant="outline" onClick={() => void wiki.refetch()}>{t("workbench.retry")}</Button>}</section>;

  const controls = <div className="space-y-3">
    <label className="block space-y-1 text-xs font-medium"><span>{t("workbench.graph_search")}</span><Input value={search} onChange={event => setSearch(event.target.value)} placeholder={t("workbench.graph_search_example")} /></label>
    <div className="flex flex-wrap gap-1" aria-label={t("workbench.graph_filter")}>{(["all", ...kinds] as const).map(value => <Button key={value} size="sm" variant={kind === value ? "secondary" : "ghost"} aria-pressed={kind === value} onClick={() => setKind(value)}>{value !== "all" && <span aria-hidden="true" className="size-2 shrink-0 rounded-full" style={{ background: color[value] }} />}{t(value === "all" ? "workbench.graph_all" : kindKey[value])}<span className="text-muted-foreground">{value === "all" ? nodes?.length ?? 0 : nodes?.filter(node => node.kind === value).length ?? 0}</span></Button>)}</div>
    <div className="flex flex-wrap items-center gap-1" aria-label={t("workbench.graph_scope")}>
      <Button size="sm" variant={local ? "ghost" : "secondary"} aria-pressed={!local} onClick={() => setScope("global")}>{t("workbench.graph_global")}</Button>
      <Button size="sm" variant={local ? "secondary" : "ghost"} aria-pressed={local} disabled={!selected} onClick={() => setScope("local")}>{t("workbench.graph_local")}</Button>
      {local && <div className="flex gap-1" aria-label={t("workbench.graph_depth")}>{[1, 2].map(value => <Button key={value} size="sm" variant={depth === value ? "outline" : "ghost"} aria-pressed={depth === value} onClick={() => setDepth(value)}>{t(value === 1 ? "workbench.graph_one_hop" : "workbench.graph_two_hops")}</Button>)}</div>}
      <Button size="sm" variant="ghost" disabled={!previous} onClick={goBack}>{t("workbench.graph_back")}</Button>
      {hasFilter && <Button size="sm" variant="ghost" onClick={() => { setSearch(""); setKind("all"); }}>{t("workbench.graph_clear_filters")}</Button>}
    </div>
    <p className="text-xs leading-relaxed text-muted-foreground">{t(local ? "workbench.graph_local_hint" : "workbench.graph_global_hint")}</p>
    <details open={browsing || hasFilter} className="rounded-lg border border-border p-3" onToggle={event => setBrowsing(event.currentTarget.open)}>
      <summary className="cursor-pointer text-xs font-medium">{t("workbench.graph_browse", { count: filtered.length })}</summary>
      <div data-graph-browse className="mt-2 grid max-h-48 gap-1 overflow-y-auto sm:grid-cols-2">{(browsing || hasFilter) && filtered.map(node => <button key={node.id} type="button" className="flex min-w-0 items-start gap-2 rounded p-2 text-start text-xs hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring" title={node.title} onClick={() => setSelection(node.id)}>
        <span className="mt-1 size-2 shrink-0 rounded-full" style={{ background: color[node.kind] }} /><span className="min-w-0 flex-1 break-words">{node.title}</span><span className="shrink-0 text-muted-foreground">{t(graphNodeKindKey(node))}</span>
      </button>)}</div>
      {hasFilter && !filtered.length && <p className="mt-2 text-xs text-muted-foreground">{t("workbench.graph_no_matches")}</p>}
    </details>
  </div>;

  const topic = selected?.wikiId ? wiki.data?.topics.find(item => item.id === selected.wikiId || item.mergedIds?.includes(selected.wikiId!)) : undefined;
  const source = previewSource ?? (selected?.kind === "source" ? selected.source : undefined);
  const reader = <div className="space-y-4">
    {previewSource && <Button size="sm" variant="outline" onClick={() => { if (selected?.kind === "source" && previous) goBack(); else setPreviewSource(null); }}>{t("workbench.graph_back")}</Button>}
    {source ? <><GraphSourceNote key={wiki.status?.scope + ":" + source.id} source={source} /><GraphRelations selected={nodes?.find(node => node.source?.id === source.id)} graph={graph} onSelect={setSelection} onSource={openSource} /></>
      : topic && selected?.kind === "wiki" ? <><WikiTopicContent key={wiki.status?.scope + ":" + topic.id} topic={topic} mutate={wiki.mutate} busy={wiki.busy} canPublish={!!wiki.status?.initialComplete && wiki.status.allowAi && wiki.status.enabled} onSource={openSource} reading /><GraphRelations selected={selected} graph={graph} onSelect={setSelection} onSource={openSource} /></>
      : <GraphNodeDetails selected={selected} graph={graph} onSelect={setSelection} onSource={openSource} />}
  </div>;

  return <section className="space-y-4" aria-label={t("workbench.graph_title")}>
    <div><h2 className="text-base font-semibold">{t("workbench.graph_title")}</h2><p className="mt-1 text-xs leading-relaxed text-muted-foreground">{t("workbench.graph_hint")}</p></div>
    {wiki.error && <p role="alert" className="text-xs text-destructive">{String(wiki.error)}</p>}
    {needsExtraction && <TrackingSettings wiki={wiki} expanded />}
    <GraphQuestions graph={graph} onSelect={setSelection} onSource={openSource} compact={embedded} />
    {controls}
    <div className={embedded ? "min-w-0" : "grid gap-4 xl:grid-cols-[minmax(0,1fr)_19rem]"}>
      <div className="min-w-0 space-y-2">
        <div className="relative overflow-hidden rounded-xl border border-border">
          <KnowledgeGraphScene nodes={visible} edges={graph.edges} selection={selection} onSelect={setSelection} nodeLabel={node => t(graphNodeKindKey(node)) + ": " + node.title} details={reader} controls={controls}
            viewKey={local ? "local:" + selection + ":" + depth : "global:" + kind + ":" + search} />
          {!visible.length && <p className="pointer-events-none absolute inset-0 flex items-center justify-center p-8 text-center text-sm text-muted-foreground">{t(hasFilter ? "workbench.graph_no_matches" : "workbench.graph_empty")}</p>}
        </div>
        <p role="status" className="text-xs leading-relaxed text-muted-foreground">{t("workbench.graph_canvas_hint", { shown: visible.length, total: sceneNodes.length })}</p>
        {local && neighborhood.length > visible.length && <details className="rounded-lg border border-border p-3"><summary className="cursor-pointer text-xs font-medium">{t("workbench.graph_more_neighbors", { count: neighborhood.length - visible.length })}</summary><div className="mt-2 max-h-48 space-y-1 overflow-y-auto">{neighborhood.slice(visible.length).map(node => <button key={node.id} type="button" className="block w-full rounded p-2 text-start text-xs hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring" onClick={() => setSelection(node.id)}>{node.title}</button>)}</div></details>}
      </div>
      {!embedded && <aside className="min-w-0 rounded-xl border border-border p-4" aria-label={t("workbench.graph_details")}>{reader}</aside>}
    </div>
    {!needsExtraction && (embedded && !graph.tracking?.failed && !graph.tracking?.processing && (!graph.tracking || graph.tracking.completed >= graph.tracking.total || graph.tracking.paused) ? <details className="rounded-lg border border-border p-3"><summary className="cursor-pointer text-xs font-medium">{t("workbench.graph_auto")}</summary><div className="mt-3"><TrackingSettings wiki={wiki} /></div></details> : <TrackingSettings wiki={wiki} />)}
  </section>;
}
