"use client";

import { useMemo, useState } from "react";
import { toast } from "sonner";
import { useTranslation } from "@lynse/core/i18n/react";
import { Button } from "@lynse/ui/components/ui/button";
import { Input } from "@lynse/ui/components/ui/input";
import { Switch } from "@lynse/ui/components/ui/switch";
import { Network } from "../icons";
import { useNavigation } from "../navigation";
import { useWorkbench } from "./api";
import { useWiki } from "./wiki";
import { workbenchErrorCopy } from "./errors";
import { KnowledgeGraphScene } from "./knowledge-graph-scene";
import type { GraphKind, GraphNode, GraphStatus, KnowledgeGraph, SourceRef } from "./types";

const kinds: GraphKind[] = ["project", "topic", "goal", "wiki", "source"];
const color: Record<GraphKind, string> = { project: "var(--chart-1)", topic: "var(--chart-2)", goal: "var(--chart-3)", wiki: "var(--chart-4)", source: "var(--muted-foreground)" };
const kindKey = { project: "workbench.graph_project", topic: "workbench.graph_topic", goal: "workbench.graph_goal", wiki: "workbench.graph_wiki", source: "workbench.graph_source" } as const;
const statusKey: Record<GraphStatus, "workbench.graph_unknown" | "workbench.graph_proposed" | "workbench.graph_active" | "workbench.graph_blocked" | "workbench.graph_completed" | "workbench.unresolved" | "workbench.candidate" | "workbench.published" | "workbench.stale" | "workbench.graph_source"> = {
  unknown: "workbench.graph_unknown", proposed: "workbench.graph_proposed", active: "workbench.graph_active", blocked: "workbench.graph_blocked", completed: "workbench.graph_completed", unresolved: "workbench.unresolved", candidate: "workbench.candidate", published: "workbench.published", stale:"workbench.stale", source: "workbench.graph_source",
};

function TrackingSettings({ wiki }: { wiki: ReturnType<typeof useWiki> }) {
  const { t } = useTranslation();
  const graph = wiki.data?.graph;
  const tracking = graph?.tracking;
  const errorCopy = workbenchErrorCopy(tracking?.error ?? "");
  const canProcess = !!wiki.status?.enabled && wiki.status.allowAi && wiki.status.initialComplete;
  return <div className="space-y-2 rounded-lg border border-border p-3">
    <div className="flex items-center justify-between gap-3"><label htmlFor="graph-auto-tracking" className="text-sm font-medium">{t("workbench.graph_auto")}</label><Switch id="graph-auto-tracking" checked={graph?.automaticTracking ?? true} disabled={wiki.busy || !graph} onCheckedChange={(enabled) => void wiki.mutate({ action: "tracking", enabled }).catch(() => undefined)} /></div>
    <p className="text-xs leading-relaxed text-muted-foreground">{t("workbench.graph_auto_hint")}</p>
    {!canProcess ? <p className="text-xs text-muted-foreground">{t(wiki.status?.enabled ? wiki.status.allowAi ? "workbench.wiki_wait_sync" : "workbench.wiki_wait_consent" : "workbench.memory_enable_hint")}</p> : graph?.automaticTracking && tracking && !tracking.paused && (tracking.processing || tracking.completed + tracking.failed < tracking.total) ? <p className="text-xs text-muted-foreground" role="status">{t("workbench.graph_tracking_progress", { completed: tracking.completed, total: tracking.total })}</p> : null}
    {!!tracking?.failed && <div className="flex flex-wrap items-center gap-2"><p role="alert" className="text-xs text-destructive">{t("workbench.graph_tracking_failed", { count: tracking.failed })}</p><Button size="sm" variant="outline" disabled={wiki.busy || !canProcess || !graph?.automaticTracking} onClick={() => void wiki.mutate({ action: "tracking_retry" }).catch(() => undefined)}>{t("workbench.retry")}</Button><details className="text-xs text-muted-foreground"><summary className="cursor-pointer">{t("workbench.graph_failure_reason")}</summary><p className="mt-1 break-words">{errorCopy ? t(errorCopy.key, { count: errorCopy.count }) : tracking.error}</p></details></div>}
  </div>;
}

export function TrackedDiscoveries() {
  const { t } = useTranslation();
  const navigation = useNavigation();
  const wiki = useWiki();
  const nodes = wiki.data?.graph?.nodes.filter((node) => node.kind !== "source" && node.kind !== "wiki") ?? [];
  if (!wiki.status?.enabled) return null;
  return <section className="space-y-3 rounded-lg border border-border p-4" aria-label={t("workbench.graph_discoveries")}>
    <div className="flex flex-wrap items-center justify-between gap-2"><h2 className="flex items-center gap-2 text-sm font-medium"><Network className="size-4" aria-hidden="true" />{t("workbench.graph_discoveries")}</h2><Button size="sm" variant="ghost" onClick={() => navigation.replace("/memory?tab=graph")}>{t("workbench.graph_open")}</Button></div>
    <p className="text-xs text-muted-foreground">{t("workbench.graph_discoveries_hint")}</p>
    <div className="flex flex-wrap gap-2">{nodes.slice(0, 8).map((node) => <Button key={node.id} variant="outline" size="sm" className="max-w-full" onClick={() => navigation.replace(`/memory?tab=graph&node=${encodeURIComponent(node.id)}`)}><span className="size-2 shrink-0 rounded-full" style={{ background: color[node.kind] }} /><span className="truncate">{node.title}</span><span className="shrink-0 text-xs text-muted-foreground">{t(kindKey[node.kind])}</span></Button>)}</div>
    {!nodes.length && <p className="text-xs text-muted-foreground">{t("workbench.graph_discoveries_empty")}</p>}
  </section>;
}

function Citations({ citations, graph, onSource }: { citations: SourceRef[]; graph: KnowledgeGraph; onSource?: (source: SourceRef) => void }) {
  const { t } = useTranslation();
  return <div className="space-y-2">{citations.map((ref, i) => <button key={`${ref.id}:${i}`} type="button" className="block w-full rounded-md border border-border p-2 text-start text-xs hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring" onClick={() => onSource ? onSource(ref) : useWorkbench.getState().showSource(ref)}>
    <span className="block font-medium">{graph.nodes.find((n) => n.id === `source:${ref.id}`)?.title ?? t("workbench.source")}{ref.startMs != null ? ` · ${Math.floor(ref.startMs / 60000)}:${String(Math.floor(ref.startMs / 1000) % 60).padStart(2, "0")}` : ""}</span><span className="mt-1 line-clamp-3 block text-muted-foreground">{ref.quote}</span>
  </button>)}</div>;
}

export function GraphNodeDetails({ selected, graph, onSelect, onSource }: { selected?: GraphNode; graph: KnowledgeGraph; onSelect: (id: string | null) => void; onSource?: (source: SourceRef) => void }) {
  const { t } = useTranslation();
  const navigation = useNavigation();
  const wiki = useWiki();
  const connected = new Set(graph.edges.flatMap((edge) => edge.source === selected?.id ? [edge.target] : edge.target === selected?.id ? [edge.source] : []));
  if (!selected) return <div className="flex min-h-40 flex-col justify-center gap-2 text-sm text-muted-foreground"><Network className="size-6" aria-hidden="true" /><p>{t("workbench.graph_select")}</p></div>;
  return <div className="space-y-4" aria-label={t("workbench.graph_details")}>
    <div className="space-y-2"><p className="text-xs text-muted-foreground">{t(kindKey[selected.kind])} · {t(statusKey[selected.status] ?? "workbench.graph_unknown")}</p><h3 className="break-words text-base font-semibold">{selected.title}</h3><p className="whitespace-pre-wrap break-words text-sm leading-relaxed">{selected.description}</p></div>
    {selected.wikiId && <Button size="sm" variant="outline" onClick={() => navigation.replace(`/memory?tab=wiki&topic=${encodeURIComponent(selected.wikiId!)}`)}>{t("workbench.graph_view_wiki")}</Button>}
    {selected.updates.length > 0 && <div className="space-y-3"><h4 className="text-xs font-medium">{t("workbench.graph_history")}</h4>{selected.updates.map((update, i) => <div key={i} className="space-y-2 border-s-2 border-border ps-3"><p className="text-xs text-muted-foreground">{update.observedAt ? new Date(update.observedAt).toLocaleDateString() : t("workbench.graph_date_unknown")} · {t(statusKey[update.status])}</p><p className="text-xs leading-relaxed">{update.description}</p><Citations citations={update.citations} graph={graph} onSource={onSource} /></div>)}</div>}
    {!selected.updates.length && <Citations citations={selected.citations} graph={graph} onSource={onSource} />}
    {connected.size > 0 && <div className="space-y-2"><h4 className="text-xs font-medium">{t("workbench.graph_related")}</h4><div className="flex flex-wrap gap-1">{graph.nodes.filter((node) => connected.has(node.id) && node.kind !== "source").map((node) => <Button key={node.id} variant="outline" size="sm" className="max-w-full" onClick={() => onSelect(node.id)}><span className="truncate">{node.title}</span></Button>)}</div></div>}
    {selected.kind !== "source" && selected.kind !== "wiki" && <Button size="sm" variant="ghost" disabled={wiki.busy} onClick={() => void wiki.mutate({ action: "tracking_dismiss", id: selected.id }).then(() => { onSelect(null); toast(t("workbench.graph_dismissed"), { duration: 10000, action: { label: t("workbench.graph_undo"), onClick: () => void wiki.mutate({ action: "tracking_restore", id: selected.id }).catch(() => undefined) } }); }).catch(() => undefined)}>{t("workbench.graph_dismiss")}</Button>}
  </div>;
}

export function KnowledgeGraphView({ embedded = false, selectedId, onSelect }: { embedded?: boolean; selectedId?: string | null; onSelect?: (id: string | null) => void }) {
  const { t } = useTranslation();
  const navigation = useNavigation();
  const wiki = useWiki();
  const graph = wiki.data?.graph;
  const [search, setSearch] = useState("");
  const [kind, setKind] = useState<GraphKind | "all">("all");
  const [browsing, setBrowsing] = useState(false);
  const [localSelection, setLocalSelection] = useState<string | null>(navigation.searchParams.get("node"));
  const selection = selectedId === undefined ? localSelection : selectedId;
  const setSelection = (id: string | null) => { setLocalSelection(id); onSelect?.(id); };
  const nodes = graph?.nodes;
  const edges = graph?.edges;
  const filtered = useMemo(() => (nodes ?? []).filter((node) => (kind === "all" || node.kind === kind) && `${node.title} ${node.description}`.toLowerCase().includes(search.trim().toLowerCase())), [nodes, kind, search]);
  const visible = useMemo(() => {
    const degree = new Map<string, number>();
    for (const edge of edges ?? []) { degree.set(edge.source, (degree.get(edge.source) ?? 0) + 1); degree.set(edge.target, (degree.get(edge.target) ?? 0) + 1); }
    const ranked = filtered.slice().sort((a, b) => Number(a.kind === "source") - Number(b.kind === "source") || (degree.get(b.id) ?? 0) - (degree.get(a.id) ?? 0) || a.title.localeCompare(b.title));
    const limited = ranked.slice(0, 90);
    const selected = ranked.find((node) => node.id === selection);
    if (selected && !limited.some((node) => node.id === selection)) limited[limited.length - 1] = selected;
    return limited;
  }, [filtered, edges, selection]);
  const selected = nodes?.find((n) => n.id === selection);
  if (!graph) return <section className="space-y-3" aria-label={t("workbench.graph_title")}><h2 className="text-base font-semibold">{t("workbench.graph_title")}</h2><p role={wiki.error ? "alert" : "status"} className="text-sm text-muted-foreground">{t(wiki.isPending ? "workbench.graph_loading" : "workbench.graph_load_failed")}</p>{wiki.error && <p className="break-words text-xs text-destructive">{String(wiki.error)}</p>}{!wiki.isPending && <Button size="sm" variant="outline" onClick={() => void wiki.refetch()}>{t("workbench.retry")}</Button>}</section>;
  return <section className="space-y-4" aria-label={t("workbench.graph_title")}>
    <div><h2 className="text-base font-semibold">{t("workbench.graph_title")}</h2><p className="mt-1 text-xs leading-relaxed text-muted-foreground">{t("workbench.graph_hint")}</p></div>
    {embedded && !graph.tracking?.failed && !graph.tracking?.processing && (!graph.tracking || graph.tracking.completed >= graph.tracking.total || graph.tracking.paused) ? <details className="rounded-lg border border-border p-3"><summary className="cursor-pointer text-xs font-medium">{t("workbench.graph_auto")}</summary><div className="mt-3"><TrackingSettings wiki={wiki} /></div></details> : <TrackingSettings wiki={wiki} />}
    {wiki.error && <p role="alert" className="text-xs text-destructive">{String(wiki.error)}</p>}
    <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t("workbench.graph_search")} aria-label={t("workbench.graph_search")} />
    <div className="flex flex-wrap gap-1" aria-label={t("workbench.graph_filter")}>{(["all", ...kinds] as const).map((value) => <Button key={value} size="sm" variant={kind === value ? "secondary" : "ghost"} aria-pressed={kind === value} onClick={() => setKind(value)}>{value !== "all" && <span className="size-2 rounded-full" style={{ background: color[value] }} />}{t(value === "all" ? "workbench.graph_all" : kindKey[value])}<span className="text-muted-foreground">{value === "all" ? nodes?.length ?? 0 : nodes?.filter((node) => node.kind === value).length ?? 0}</span></Button>)}</div>
    <div className={embedded ? "min-w-0" : "grid gap-4 xl:grid-cols-[minmax(0,1fr)_19rem]"}>
      <div className="min-w-0 space-y-2">
        <div className="relative overflow-hidden rounded-xl border border-border bg-muted/15">
          <KnowledgeGraphScene nodes={visible} edges={graph.edges} selection={selection} onSelect={setSelection} colors={color} nodeLabel={node => `${t(kindKey[node.kind])}: ${node.title}`} />
          {!visible.length && <p className="pointer-events-none absolute inset-0 flex items-center justify-center p-8 text-center text-sm text-muted-foreground">{t(search || kind !== "all" ? "workbench.no_results" : "workbench.graph_empty")}</p>}
        </div>
        <p className="text-xs text-muted-foreground">{t("workbench.graph_canvas_hint", { shown: visible.length, total: filtered.length })}</p>
        <details className="rounded-lg border border-border p-3" onToggle={event => setBrowsing(event.currentTarget.open)}><summary className="cursor-pointer text-xs font-medium">{t("workbench.graph_browse", { count: filtered.length })}</summary><div data-graph-browse className="mt-2 grid max-h-64 gap-1 overflow-y-auto sm:grid-cols-2">{browsing && filtered.map((node) => <button key={node.id} className="flex min-w-0 items-center gap-2 rounded p-2 text-left text-xs hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring" onClick={() => setSelection(node.id)}><span className="size-2 shrink-0 rounded-full" style={{ background: color[node.kind] }} /><span className="truncate">{node.title}</span><span className="ml-auto shrink-0 text-muted-foreground">{t(kindKey[node.kind])}</span></button>)}</div></details>
      </div>
      {!embedded && <aside className="min-w-0 rounded-xl border border-border p-4" aria-label={t("workbench.graph_details")}><GraphNodeDetails selected={selected} graph={graph} onSelect={setSelection} /></aside>}
    </div>
  </section>;
}
