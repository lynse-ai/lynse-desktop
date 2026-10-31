"use client";

import { useState } from "react";
import { useTranslation } from "@lynse/core/i18n/react";
import { Button } from "@lynse/ui/components/ui/button";
import { Input } from "@lynse/ui/components/ui/input";
import { Markdown } from "@lynse/ui/markdown";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@lynse/ui/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@lynse/ui/components/ui/select";
import { Plus, Pencil } from "../icons";
import { collectionTimeline, topicSources } from "./wiki-browse";
import type { useWiki } from "./wiki";
import type { SourceRef, WikiTopic, WikiTopicLink } from "./types";

type Wiki = ReturnType<typeof useWiki>;
export function CreateWikiTopic({ wiki, topic, onCreated }: { wiki: Wiki; topic?: WikiTopic; onCreated: (id: string) => void }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [purpose, setPurpose] = useState("");
  const [error, setError] = useState("");
  return <>
    <Button size="sm" variant={topic ? "outline" : "default"} onClick={() => { setTitle(topic?.title ?? ""); setPurpose(topic?.purpose ?? ""); setError(""); setOpen(true); }}>
      {topic ? <Pencil className="size-4" aria-hidden="true" /> : <Plus className="size-4" aria-hidden="true" />}{t(topic ? "workbench.collection_edit" : "workbench.collection_create")}
    </Button>
    <Dialog open={open} onOpenChange={setOpen}><DialogContent className="sm:max-w-lg"><DialogHeader><DialogTitle>{t(topic ? "workbench.collection_edit" : "workbench.collection_create")}</DialogTitle><DialogDescription>{t("workbench.collection_create_hint")}</DialogDescription></DialogHeader>
      <form className="space-y-4" onSubmit={event => {
        event.preventDefault(); if (!title.trim()) return;
        void wiki.mutate({ action: "topic", mode: "collection", ...(topic ? { id: topic.id } : {}), title: title.trim(), purpose: purpose.trim() }).then(result => {
          const id = result?.createdTopicId ?? topic?.id;
          if (id) { setOpen(false); onCreated(id); }
          else setError(t("workbench.collection_save_failed"));
        }).catch(() => setError(t("workbench.collection_save_failed")));
      }}>
        <label className="block space-y-2 text-sm"><span>{t("workbench.topic_title")}</span><Input required autoFocus maxLength={200} value={title} onChange={e => setTitle(e.target.value)} /></label>
        <label className="block space-y-2 text-sm"><span>{t("workbench.collection_focus")}</span><textarea className="min-h-28 w-full rounded-md border border-input bg-background p-3 text-sm leading-relaxed" maxLength={8000} value={purpose} onChange={e => setPurpose(e.target.value)} placeholder={t("workbench.collection_focus_hint")} /></label>
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        {!wiki.status?.allowAi && <p className="text-sm text-muted-foreground">{t("workbench.collection_wait_ai")}</p>}
        <div className="flex justify-end gap-2"><Button type="button" variant="outline" onClick={() => setOpen(false)}>{t("workbench.cancel")}</Button><Button type="submit" disabled={wiki.busy || !title.trim()}>{t(wiki.status?.allowAi ? topic ? "workbench.collection_save_run" : "workbench.collection_create_run" : "workbench.save")}</Button></div>
      </form>
    </DialogContent></Dialog>
  </>;
}

export function CollectionContent({ topic, topics, wiki, onRead, onSource }: { topic: WikiTopic; topics: WikiTopic[]; wiki: Wiki; onRead: (topic: WikiTopic) => void; onSource: (ref: SourceRef) => void }) {
  const { t, i18n } = useTranslation();
  const [target, setTarget] = useState("");
  const [error, setError] = useState("");
  const collection = topic.collection!;
  const links = collection.links;
  const sourceDates = wiki.data?.sourceDates ?? {};
  const included = links.filter(link => link.state === "included" && !link.error);
  const failed = links.filter(link => !!link.error && link.state !== "excluded");
  const candidates = links.filter(link => link.state === "candidate" && !link.error);
  const excluded = links.filter(link => link.state === "excluded");
  const available = topics.filter(item => !item.collection && !!item.published && !item.excluded && item.inScope !== false);
  const events = collectionTimeline(topic, sourceDates);
  const change = (id: string, state: "included" | "excluded") => {
    setError("");
    void wiki.mutate({ action: "topic_link", id: topic.id, targetId: id, state }).catch(() => setError(t("workbench.collection_save_failed")));
  };
  function row(link: WikiTopicLink) {
    const member = topics.find(item => item.id === link.targetId);
    return <li key={link.targetId} className="space-y-3 rounded-lg border border-border p-4">
      <div className="flex flex-wrap items-center justify-between gap-2"><button type="button" className="text-start font-medium text-primary underline-offset-4 hover:underline" onClick={() => { if (member) onRead(member); }}>{member?.title ?? link.targetId}</button><span className="text-xs text-muted-foreground">{t(link.manual ? "workbench.collection_manual_choice" : "workbench.collection_ai_choice")}</span></div>
      {link.error && <p role="alert" className="break-words text-sm text-destructive">{link.error}</p>}
      {link.reason && <p className="text-sm leading-relaxed text-muted-foreground">{link.reason}</p>}
      <div className="flex flex-wrap gap-2">{link.citations.map((ref, index) => <Button key={index} size="sm" variant="ghost" onClick={() => onSource(ref)}>{t("workbench.collection_evidence", { count: index + 1 })}</Button>)}</div>
      <div className="flex flex-wrap gap-2">{!link.error && link.state !== "included" && <Button size="sm" variant="outline" disabled={wiki.busy} onClick={() => change(link.targetId, "included")}>{t(link.state === "excluded" ? "workbench.collection_restore" : "workbench.collection_include")}</Button>}{link.state !== "excluded" && <Button size="sm" variant="ghost" disabled={wiki.busy} onClick={() => change(link.targetId, "excluded")}>{t("workbench.collection_remove")}</Button>}</div>
    </li>;
  }
  const pending = ["matching", "compiling"].includes(collection.status);
  return <div className="space-y-7">
    <div className="flex flex-wrap items-center gap-3"><CreateWikiTopic wiki={wiki} topic={topic} onCreated={() => undefined} /><Button size="sm" variant="outline" disabled={wiki.busy || pending || !wiki.status?.allowAi} onClick={() => { void wiki.mutate({ action: "retry", id: topic.id }).catch(() => setError(t("workbench.collection_save_failed"))); }}>{t("workbench.collection_update")}</Button></div>
    {topic.purpose && <p className="whitespace-pre-wrap text-sm leading-relaxed text-muted-foreground">{topic.purpose}</p>}
    {!wiki.status?.allowAi ? <p role="status" className="text-sm text-muted-foreground">{t("workbench.collection_wait_ai")}</p> : pending ? <p role="status" aria-live="polite" className="text-sm text-muted-foreground">{t(collection.status === "matching" ? "workbench.collection_matching" : "workbench.collection_compiling", { completed: collection.completed, total: collection.total })}</p> : !topic.error && !included.length && <p role="status" className="text-sm text-muted-foreground">{t(collection.status === "ready" ? "workbench.collection_no_matches" : "workbench.collection_pending")}</p>}
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {collection.hierarchy ? <p className="text-sm text-muted-foreground">{t("workbench.hierarchy_overview", { count: included.length, meetings: topicSources(topic).length })}</p>
      : topic.published && <Markdown mode="full">{topic.published.markdown.replace(/^# [^\n]+(?:\n|$)/, "")}</Markdown>}
    <section className="space-y-4" aria-label={t("workbench.collection_timeline")}><h3 className="text-base font-semibold">{t("workbench.collection_timeline")}</h3>{!events.length && <p className="text-sm text-muted-foreground">{t("workbench.collection_no_events")}</p>}{events.map(event => <div key={`${event.topicId}:${event.id}`} className="space-y-2 border-s-2 border-primary/20 ps-4">
      <h4 className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-sm font-semibold">{event.date ? <time dateTime={event.date}>{new Date(`${event.date}T12:00:00Z`).toLocaleDateString(i18n.language, { timeZone: "UTC" })}</time> : t("workbench.collection_unknown_date")}{event.dateBasis === "record" && <span className="text-xs font-normal text-muted-foreground">{t("workbench.collection_record_date")}</span>}</h4><p className="text-sm leading-relaxed">{event.text}</p><div className="flex flex-wrap gap-2">{event.citations.map((ref, refIndex) => <Button key={refIndex} size="sm" variant="ghost" onClick={() => onSource(ref)}>{t("workbench.collection_evidence", { count: refIndex + 1 })}</Button>)}</div>
    </div>)}</section>
    <section className="space-y-3" aria-label={t(collection.hierarchy ? "workbench.hierarchy_issues" : "workbench.collection_related")}><h3 className="text-base font-semibold">{t(collection.hierarchy ? "workbench.hierarchy_issues" : "workbench.collection_related")}</h3><ul className="space-y-3">{included.map(row)}</ul>
      <div className="flex flex-wrap items-center gap-2"><Select value={target} onValueChange={value => setTarget(value ?? "")}><SelectTrigger className="w-full sm:w-72" aria-label={t("workbench.collection_add_existing")}><SelectValue placeholder={t("workbench.collection_add_existing")} /></SelectTrigger><SelectContent>{available.filter(item => !included.some(link => link.targetId === item.id)).map(item => <SelectItem key={item.id} value={item.id}>{item.title}</SelectItem>)}</SelectContent></Select><Button size="sm" variant="outline" disabled={!target || wiki.busy} onClick={() => { change(target, "included"); setTarget(""); }}>{t("workbench.collection_include")}</Button></div>
    </section>
    {!!failed.length && <section className="space-y-3" aria-label={t("workbench.collection_failed")}><h3 className="text-base font-semibold">{t("workbench.collection_failed")}</h3><p className="text-sm text-muted-foreground">{t("workbench.collection_failed_hint")}</p><ul className="space-y-3">{failed.map(row)}</ul></section>}
    {!!candidates.length && <section className="space-y-3" aria-label={t("workbench.collection_candidates")}><h3 className="text-base font-semibold">{t("workbench.collection_candidates")}</h3><ul className="space-y-3">{candidates.map(row)}</ul></section>}
    {!!excluded.length && <details className="rounded-lg border border-border p-4"><summary className="cursor-pointer text-sm">{t("workbench.collection_excluded")}</summary><ul className="mt-3 space-y-3">{excluded.map(row)}</ul></details>}
  </div>;
}
