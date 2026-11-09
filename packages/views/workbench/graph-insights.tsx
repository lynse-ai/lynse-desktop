"use client";

import { useTranslation } from "@lynse/core/i18n/react";
import { Sparkles } from "../icons";
import { communityPalette } from "./graph-vocabulary";
import type { useWiki } from "./wiki";

type Wiki = ReturnType<typeof useWiki>;

interface Entry { id: string | null; label: string; meta: string }

/**
 * Read-side intelligence cards computed on-device (Louvain communities plus
 * isolation/sparse/bridge/cross-cluster heuristics) from the topic graph.
 */
export function GraphInsights({ wiki, onSelect, compact = false }: { wiki: Wiki; onSelect: (id: string) => void; compact?: boolean }) {
  const { t } = useTranslation();
  const insights = wiki.data?.topicGraph?.insights;
  if (!wiki.status?.enabled || !insights) return null;
  const groups: { title: string; hint: string; entries: Entry[] }[] = [
    {
      title: t("workbench.graph_bridges"),
      hint: t("workbench.graph_bridges_hint"),
      entries: insights.bridgeTopics.map(topic => ({
        id: topic.id,
        label: topic.title,
        meta: t("workbench.graph_bridge_meta", { count: topic.communities }),
      })),
    },
    {
      title: t("workbench.graph_isolated"),
      hint: t("workbench.graph_isolated_hint"),
      entries: insights.isolatedTopics.slice(0, compact ? 3 : 8).map(topic => ({
        id: topic.id,
        label: topic.title,
        meta: t("workbench.graph_isolated_meta", { count: topic.degree }),
      })),
    },
    {
      title: t("workbench.graph_sparse"),
      hint: t("workbench.graph_sparse_hint"),
      entries: insights.sparseCommunities.map(community => ({
        id: community.members[0] ?? null,
        label: community.label,
        meta: t("workbench.graph_sparse_meta", { count: community.size, cohesion: Math.round(community.cohesion * 100) }),
      })),
    },
    {
      title: t("workbench.graph_cross_links"),
      hint: t("workbench.graph_cross_links_hint"),
      entries: insights.crossCommunityLinks.slice(0, compact ? 3 : 5).map(link => ({
        id: link.source,
        label: `${link.sourceTitle} ↔ ${link.targetTitle}`,
        meta: t("workbench.graph_cross_meta", { count: link.weight }),
      })),
    },
  ].filter(group => group.entries.length > 0);
  if (!groups.length) return null;
  return <section className="space-y-3 rounded-lg border border-border p-4" aria-label={t("workbench.graph_insights")}>
    <h2 className="flex items-center gap-2 text-sm font-medium"><Sparkles className="size-4 text-primary" aria-hidden="true" />{t("workbench.graph_insights")}</h2>
    {groups.map(group => <div key={group.title} className="space-y-2">
      <p className="text-xs font-medium">{group.title}<span className="ms-2 font-normal text-muted-foreground">{group.hint}</span></p>
      <div className="flex flex-wrap gap-2">{group.entries.map(entry => {
        const community = entry.id ? insights.communities.find(item => item.members.includes(entry.id!)) : undefined;
        const dot = community ? communityPalette[community.id % communityPalette.length] : undefined;
        return <button key={group.title + entry.label} type="button" className="flex max-w-full items-center gap-2 rounded-md border border-border px-2.5 py-1.5 text-start text-xs hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-60" disabled={!entry.id} onClick={() => entry.id && onSelect(entry.id)}>
          {dot && <span aria-hidden="true" className="size-2 shrink-0 rounded-full" style={{ background: dot }} />}
          <span className="truncate">{entry.label}</span>
          <span className="shrink-0 text-muted-foreground">{entry.meta}</span>
        </button>;
      })}</div>
    </div>)}
  </section>;
}
