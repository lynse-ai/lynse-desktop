"use client";

import { useState } from "react";
import { useTranslation } from "@lynse/core/i18n/react";
import { Button } from "@lynse/ui/components/ui/button";
import { Input } from "@lynse/ui/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@lynse/ui/components/ui/dialog";
import { topicSources } from "./wiki-browse";
import type { WikiTopic } from "./types";
import type { useWiki } from "./wiki";

type Wiki = ReturnType<typeof useWiki>;
export function GroupWikiTopics({ wiki, topic, onCreated }: { wiki: Wiki; topic?: WikiTopic; onCreated: (id: string) => void }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [ids, setIds] = useState<Set<string>>(() => new Set());
  const [search, setSearch] = useState("");
  const [target, setTarget] = useState("");
  const [title, setTitle] = useState("");
  const [error, setError] = useState("");
  const topics = wiki.data?.topics ?? [];
  const members = topics.filter(item => !item.collection && !item.excluded && item.inScope !== false && !!item.published);
  const groups = topics.filter(item => !!item.collection && !item.excluded);
  const matches = members.filter(item => item.title.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()));
  const selected = members.filter(item => ids.has(item.id));
  const meetings = new Set(selected.flatMap(item => topicSources(item).map(source => source.id)));
  return <>
    <Button size="sm" variant="outline" disabled={!members.length} onClick={() => {
      setIds(new Set(topic ? [topic.id] : [])); setSearch(""); setTarget(""); setTitle(""); setError(""); setOpen(true);
    }}>{t(topic ? "workbench.hierarchy_move" : "workbench.hierarchy_merge")}</Button>
    <Dialog open={open} onOpenChange={value => { if (!wiki.busy) setOpen(value); }}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader><DialogTitle>{t("workbench.hierarchy_merge")}</DialogTitle><DialogDescription>{t("workbench.hierarchy_merge_help")}</DialogDescription></DialogHeader>
        <form className="space-y-4" onSubmit={event => {
          event.preventDefault(); if (!selected.length || (!target && !title.trim()) || wiki.busy) return;
          setError("");
          void wiki.mutate({ action: "topic_group", ids: selected.map(item => item.id), ...(target ? { targetId: target } : { title: title.trim() }) })
            .then(result => { if (result?.createdTopicId) { setOpen(false); onCreated(result.createdTopicId); } else setError(t("workbench.hierarchy_save_failed")); })
            .catch(() => setError(t("workbench.hierarchy_save_failed")));
        }}>
          <label className="block space-y-2 text-sm"><span>{t("workbench.hierarchy_destination")}</span><select className="min-h-10 w-full rounded-md border border-input bg-background px-3" value={target} onChange={event => setTarget(event.target.value)}>
            <option value="">{t("workbench.hierarchy_new")}</option>{groups.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}
          </select></label>
          {!target && <label className="block space-y-2 text-sm"><span>{t("workbench.topic_title")}</span><Input required maxLength={200} value={title} onChange={event => setTitle(event.target.value)} placeholder={t("workbench.hierarchy_title_hint")} /></label>}
          <Input aria-label={t("workbench.hierarchy_search")} placeholder={t("workbench.hierarchy_search")} value={search} onChange={event => setSearch(event.target.value)} />
          <p role="status" className="text-sm text-muted-foreground">{t("workbench.hierarchy_selected", { count: selected.length, meetings: meetings.size })}</p>
          <div className="max-h-64 space-y-1 overflow-y-auto rounded-lg border border-border p-2" aria-label={t("workbench.hierarchy_choose")}>
            {matches.slice(0, 100).map(item => <label key={item.id} className="flex min-h-11 cursor-pointer items-start gap-3 rounded-md p-2 hover:bg-muted">
              <input type="checkbox" className="mt-1 size-4 shrink-0 accent-primary" checked={ids.has(item.id)} onChange={event => setIds(current => {
                const next = new Set(current); if (event.target.checked) next.add(item.id); else next.delete(item.id); return next;
              })} /><span className="min-w-0 text-sm"><span className="block break-words">{item.title}</span><span className="text-xs text-muted-foreground">{t("workbench.auto_meeting_count", { count: topicSources(item).length })}</span></span>
            </label>)}
            {!matches.length && <p className="p-2 text-sm text-muted-foreground">{t("workbench.hierarchy_no_matches")}</p>}
          </div>
          {matches.length > 100 && <p className="text-xs text-muted-foreground">{t("workbench.hierarchy_search_more")}</p>}
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
          <div className="flex justify-end gap-2"><Button type="button" variant="ghost" disabled={wiki.busy} onClick={() => setOpen(false)}>{t("workbench.cancel")}</Button><Button type="submit" disabled={wiki.busy || !selected.length || (!target && !title.trim())}>{t("workbench.hierarchy_confirm")}</Button></div>
        </form>
      </DialogContent>
    </Dialog>
  </>;
}

export function HierarchyStatus({ wiki, onCreated }: { wiki: Wiki; onCreated: (id: string) => void }) {
  const { t } = useTranslation();
  const [failure, setFailure] = useState(false);
  const error = wiki.data?.hierarchy?.error;
  return <section className="shrink-0 space-y-3 rounded-lg border border-border p-4" aria-label={t("workbench.hierarchy_navigation")}>
    <p className="text-sm leading-relaxed text-muted-foreground">{t("workbench.hierarchy_hint")}</p>
    <div className="flex flex-wrap gap-2"><GroupWikiTopics wiki={wiki} onCreated={onCreated} /><Button size="sm" variant="outline" disabled={wiki.busy || !wiki.status?.enabled || !wiki.status.allowAi || wiki.status.wikiProgress?.stage === "grouping"} onClick={() => {
      setFailure(false); void wiki.mutate({ action: "topic_groups_retry" }).catch(() => setFailure(true));
    }}>{t(error ? "workbench.hierarchy_retry" : "workbench.hierarchy_auto")}</Button></div>
    {(error || failure) && <div className="space-y-2"><p role="alert" className="text-sm text-destructive">{t("workbench.hierarchy_failed")}</p>{error && <details className="text-xs"><summary className="cursor-pointer">{t("workbench.wiki_failure_technical")}</summary><p className="mt-2 break-words font-mono">{error}</p></details>}</div>}
  </section>;
}
