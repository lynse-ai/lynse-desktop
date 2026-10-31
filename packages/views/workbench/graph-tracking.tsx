"use client";
import { useEffect, useState } from "react";
import { useTranslation } from "@lynse/core/i18n/react";
import { Button } from "@lynse/ui/components/ui/button";
import { Input } from "@lynse/ui/components/ui/input";
import { Switch } from "@lynse/ui/components/ui/switch";
import { useWorkbench } from "./api";
import { useWiki } from "./wiki";
import { workbenchErrorCopy } from "./errors";
export function GraphTracking({ wiki, expanded = false }: { wiki: ReturnType<typeof useWiki>; expanded?: boolean }) {
  const { t } = useTranslation();
  const graph = wiki.data?.graph;
  const tracking = graph?.tracking;
  const sources = graph?.availableSources ?? [];
  const saved = sources.filter(source => source.selected).map(source => source.id).sort().join("\n");
  const [selected, setSelected] = useState<string[]>(() => sources.filter(source => source.selected).map(source => source.id));
  const [dirty, setDirty] = useState(false);
  const [search, setSearch] = useState("");
  useEffect(() => { if (!dirty) setSelected(saved ? saved.split("\n") : []); }, [saved, dirty]);
  const canProcess = !!wiki.status?.enabled && wiki.status.allowAi && wiki.status.initialComplete;
  const errorCopy = workbenchErrorCopy(tracking?.error ?? "");
  async function start() {
    const scope = wiki.status?.scope;
    await wiki.mutate({ action: "tracking_sources", ids: selected.filter(id => sources.some(source => source.id === id)) });
    if (useWorkbench.getState().status?.scope !== scope) return;
    await wiki.mutate({ action: "tracking", enabled: true });
    setDirty(false);
  }
  return <div className="space-y-3 rounded-lg border border-border p-3">
    <div className="flex items-center justify-between gap-3"><label htmlFor="graph-auto-tracking" className="text-sm font-medium">{t("workbench.graph_auto")}</label><Switch id="graph-auto-tracking" checked={graph?.automaticTracking ?? false} disabled={wiki.busy || !graph || (!graph.automaticTracking && (!canProcess || dirty || !saved))} onCheckedChange={enabled => void wiki.mutate({ action: "tracking", enabled }).catch(() => undefined)} /></div>
    <p className="text-xs leading-relaxed text-muted-foreground">{t("workbench.graph_auto_hint")}</p>
    <details open={expanded || undefined}><summary className="cursor-pointer text-xs font-medium">{t("workbench.graph_choose_sources", { count: selected.length })}</summary><div className="mt-2 space-y-2">
      <Input aria-label={t("workbench.graph_source_search")} value={search} onChange={event => setSearch(event.target.value)} />
      <Button size="sm" variant="outline" disabled={wiki.busy || !sources.length} onClick={() => { setSelected(sources.map(source => source.id)); setDirty(true); }}>{t("workbench.graph_select_all_summaries")}</Button>
      <div className="max-h-48 space-y-1 overflow-y-auto">{sources.filter(source => source.title.toLowerCase().includes(search.toLowerCase())).map(source => <label key={source.id} className="flex items-start gap-2 p-2 text-xs"><input type="checkbox" checked={selected.includes(source.id)} disabled={wiki.busy} onChange={event => { setDirty(true); setSelected(current => event.target.checked ? [...current, source.id] : current.filter(id => id !== source.id)); }} /><span className="min-w-0 break-words">{source.title}</span></label>)}</div>
      {!sources.length && <p className="text-xs text-muted-foreground">{t("workbench.graph_no_sources")}</p>}
      <Button size="sm" disabled={wiki.busy || !canProcess || !selected.length} onClick={() => void start().catch(() => undefined)}>{t("workbench.graph_start_selected", { count: selected.length })}</Button>
      {dirty && <p className="text-xs text-muted-foreground">{t("workbench.graph_selection_unsaved")}</p>}
    </div></details>
    {!!tracking?.legacyChunks && <div className="space-y-2 text-xs text-muted-foreground"><p>{t("workbench.graph_legacy_kept")}</p><Button size="sm" variant="outline" disabled={wiki.busy || !canProcess || tracking.processing} onClick={() => void wiki.mutate({ action: "tracking_refresh" }).catch(() => undefined)}>{t("workbench.graph_refresh_legacy")}</Button></div>}
    {!canProcess && <p className="text-xs text-muted-foreground">{t(wiki.status?.enabled ? wiki.status.allowAi ? "workbench.wiki_wait_sync" : "workbench.wiki_wait_consent" : "workbench.memory_enable_hint")}</p>}
    {canProcess && graph?.automaticTracking && tracking && !tracking.paused && <p role="status" className="text-xs text-muted-foreground">{t("workbench.graph_tracking_progress", { completed: tracking.completed, total: tracking.total })}</p>}
    {!!tracking?.failed && <div className="space-y-2"><p role="alert" className="text-xs text-destructive">{t("workbench.graph_tracking_failed", { count: tracking.failed })}</p><Button size="sm" variant="outline" disabled={wiki.busy || !canProcess || !graph?.automaticTracking} onClick={() => void wiki.mutate({ action: "tracking_retry" }).catch(() => undefined)}>{t("workbench.retry")}</Button><details className="text-xs text-muted-foreground"><summary className="cursor-pointer">{t("workbench.graph_failure_reason")}</summary><p className="mt-1 break-words">{errorCopy ? t(errorCopy.key, { count: errorCopy.count }) : tracking.error}</p></details></div>}
  </div>;
}
