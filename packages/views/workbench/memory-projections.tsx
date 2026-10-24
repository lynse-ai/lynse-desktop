"use client";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { memoryApi } from "@lynse/core/api/memory";
import { useTranslation } from "@lynse/core/i18n/react";
import { Markdown } from "@lynse/ui/markdown";
import { Button } from "@lynse/ui/components/ui/button";

export function MemoryProjections({ account }: { account: string }) {
  const { t } = useTranslation();
  const [view, setView] = useState("daily");
  const [offset, setOffset] = useState(0);
  const query = useQuery({ queryKey: ["memory-projections", account, view, offset], queryFn: ({ signal }) => memoryApi.projections(view, offset, signal), retry: false });
  return <section className="space-y-4" aria-label={t("memory_manager.projections")}>
    <p className="text-sm text-muted-foreground">{t("memory_manager.projection_hint")}</p>
    <nav className="flex flex-wrap gap-2" aria-label={t("memory_manager.projections")}>
      {["daily", "summary", "categories", "people", "briefing"].map(value => <Button key={value} size="sm" variant={view === value ? "secondary" : "ghost"} aria-pressed={view === value} onClick={() => { setView(value); setOffset(0); }}>{t(`memory_manager.projection_${value}`)}</Button>)}
    </nav>
    {query.isPending && <p role="status">{t("memory_manager.loading")}</p>}
    {query.error && <p role="alert">{t("memory_manager.failed")}</p>}
    {query.data?.projections.length === 0 && <p>{t("memory_manager.empty")}</p>}
    {query.data?.projections.map(projection => <article key={projection.id} className="space-y-3 rounded-lg border border-border p-4">
      <p className="text-sm text-muted-foreground">{projection.day} · v{projection.version} · {projection.coverage.included}/{projection.coverage.eligible}</p>
      <p className="text-xs text-muted-foreground">{t("memory_manager.projection_cutoff")} {projection.coverage_cutoff}</p>
      {(projection.failures.length > 0 || projection.coverage.omitted > 0) && <p role="status" className="text-sm">{t("memory_manager.projection_gap")}</p>}
      {projection.blocks.map(block => <div key={block.memory_id} className="border-t border-border pt-3"><p className="text-xs text-muted-foreground">{block.scope_id || t("memory_manager.work_scope")} · {block.category} · {block.modality}</p><Markdown mode="full">{block.content}</Markdown></div>)}
    </article>)}
    {query.data && query.data.total > 25 && <div className="flex gap-2"><Button size="sm" variant="outline" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 25))}>{t("memory_manager.previous")}</Button><Button size="sm" variant="outline" disabled={offset + 25 >= query.data.total} onClick={() => setOffset(offset + 25)}>{t("memory_manager.next")}</Button></div>}
  </section>;
}
