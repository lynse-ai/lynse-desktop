"use client";

import { useTranslation } from "@lynse/core/i18n/react";
import { Button } from "@lynse/ui/components/ui/button";
import { ListChecks } from "../icons";
import { useNavigation } from "../navigation";
import type { useWiki as UseWiki } from "./wiki";

type Wiki = ReturnType<typeof UseWiki>;

/**
 * Stock-taking health view for the knowledge base: processing progress, stale
 * pages, pending candidates and hierarchy errors. Purely derived from the
 * existing state payload — runtime failures stay in the failure panels.
 */
export function WikiHealth({ wiki }: { wiki: Wiki }) {
  const { t } = useTranslation();
  const navigation = useNavigation();
  const topics = (wiki.data?.topics ?? []).filter(topic => !topic.excluded);
  const stale = topics.filter(topic => topic.stale && !topic.error && !!topic.published);
  const candidates = topics.filter(topic => !!topic.candidate);
  const tracking = wiki.data?.graph?.tracking;
  const hierarchyError = wiki.data?.hierarchy?.error;
  if (!wiki.status?.enabled || (!stale.length && !candidates.length && !hierarchyError && !tracking?.processing)) return null;
  const open = (id: string) => navigation.replace(`/memory?tab=wiki&topic=${encodeURIComponent(id)}`);
  return <section className="shrink-0 space-y-3 rounded-lg border border-border p-4" aria-label={t("workbench.wiki_health")}>
    <h2 className="flex items-center gap-2 text-base font-semibold"><ListChecks className="size-4 text-primary" aria-hidden="true" />{t("workbench.wiki_health")}</h2>
    {tracking?.processing && <p role="status" className="text-sm text-muted-foreground">{t("workbench.wiki_health_progress", { completed: tracking.completed, total: tracking.total })}</p>}
    {hierarchyError && <p role="alert" className="break-words text-sm text-destructive">{t("workbench.wiki_health_hierarchy")}</p>}
    {!!stale.length && <div className="space-y-2">
      <p className="text-sm text-muted-foreground">{t("workbench.wiki_health_stale", { count: stale.length })}</p>
      <div className="flex flex-wrap gap-2">{stale.slice(0, 6).map(topic => <Button key={topic.id} size="sm" variant="outline" className="max-w-full" onClick={() => open(topic.id)}><span className="truncate">{topic.title}</span></Button>)}</div>
    </div>}
    {!!candidates.length && <p className="text-sm text-muted-foreground">{t("workbench.wiki_health_candidates", { count: candidates.length })}</p>}
    {(!!stale.length || !!hierarchyError) && <Button size="sm" variant="outline" onClick={() => void wiki.refetch()}>{t("workbench.retry")}</Button>}
  </section>;
}
