"use client";

import { lazy, Suspense, useState } from "react";
import { useTranslation } from "@lynse/core/i18n/react";
import { Button } from "@lynse/ui/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@lynse/ui/components/ui/dialog";
import { useNavigation } from "../navigation";
import { catalogIssueLocation, citationIssueLocation, wikiFailureResolution } from "./errors";
import { GraphSourceNote } from "./graph-source-note";
import { WikiFailureReport } from "./wiki-failure-report";
import type { SourceRef, WikiRequest, WikiTopic } from "./types";
import type { useWiki } from "./wiki";

const SettingsDialog = lazy(() => import("../settings/settings-dialog").then(module => ({ default: module.SettingsDialog })));
type Wiki = ReturnType<typeof useWiki>;
const stages: Record<string, string> = {
  matching: "workbench.collection_matching_stage",
  preparing: "workbench.home_preparing", analyzing: "workbench.home_analyzing",
  compiling: "workbench.home_compiling", validating: "workbench.wiki_failure_validating",
};

export function WikiFailures({ wiki }: { wiki: Wiki }) {
  const { t, i18n } = useTranslation();
  const navigation = useNavigation();
  const [source, setSource] = useState<SourceRef | null>(null);
  const [excluding, setExcluding] = useState<WikiTopic | null>(null);
  const [correcting, setCorrecting] = useState<WikiTopic | null>(null);
  const [notes, setNotes] = useState("");
  const [settings, setSettings] = useState<"account" | "ai_assistant" | null>(null);
  const [actionError, setActionError] = useState("");
  const [deferred, setDeferred] = useState<Set<string>>(() => new Set());
  const topics = wiki.data?.topics ?? [];
  const failures = topics.filter(topic => !topic.excluded && !!topic.error);
  const excluded = topics.filter(topic => topic.excluded);
  const canProcess = !!wiki.status?.enabled && !!wiki.status.allowAi;

  async function apply(requests: WikiRequest[], done?: () => void) {
    setActionError("");
    try {
      for (const request of requests) await wiki.mutate(request);
      done?.();
    } catch { setActionError(t("workbench.wiki_failure_action_failed")); }
  }
  const exclusion = (topic: WikiTopic, excluded: boolean): WikiRequest => ({ action: "topic", id: topic.id, title: topic.title, purpose: topic.purpose, notes: topic.notes, excluded });
  function sourceRows(topic: WikiTopic) {
    const refs = [...(topic.published?.citations ?? []), ...(topic.candidate?.citations ?? [])];
    const ids = [...new Set([...(topic.failure?.sourceIds ?? []), ...(topic.sourceIds ?? []), ...refs.map(ref => ref.id)])];
    return ids.flatMap(id => {
      const entry = wiki.status?.entries.find(entry => entry.id === id);
      const ref = refs.find(ref => ref.id === id);
      if (!entry && !ref) return [];
      return [{ title: entry?.title ?? id, reference: ref ?? { id, kind: entry!.kind, revision: entry!.revision, quote: "" } }];
    });
  }

  if (!failures.length && !excluded.length) return null;
  return <div className="shrink-0 space-y-3">
    {actionError && !excluding && !correcting && <p role="alert" className="text-sm text-destructive">{actionError}</p>}
    {!!failures.length && <section className="space-y-4 rounded-lg border border-border p-4" aria-label={t("workbench.wiki_attention")}>
      <h2 className="text-base font-semibold">{t("workbench.wiki_attention")}</h2>
      <p className="text-sm leading-relaxed text-muted-foreground">{t("workbench.wiki_failure_preserved")}</p>
      {failures.map(topic => {
        const resolution = wikiFailureResolution(topic.error, topic.failure?.validation);
        const issue = topic.failure?.validation?.citationIssue;
        const position = citationIssueLocation(issue) ?? catalogIssueLocation(topic.failure?.validation?.catalogIssue);
        const date = topic.failure?.occurredAt ? new Date(topic.failure.occurredAt) : null;
        const sources = sourceRows(topic);
        if (deferred.has(topic.id)) return <article key={topic.id} aria-label={topic.title} className="min-w-0 space-y-3 border-t border-border pt-4">
          <h3 className="break-words text-sm font-semibold">{topic.title}</h3>
          <p className="text-sm text-muted-foreground">{t("workbench.wiki_failure_deferred")}</p>
          <Button size="sm" variant="outline" onClick={() => setDeferred(current => { const next = new Set(current); next.delete(topic.id); return next; })}>{t("workbench.wiki_failure_continue")}</Button>
        </article>;
        return <article key={topic.id} aria-label={topic.title} className="min-w-0 space-y-3 border-t border-border pt-4">
          <h3 className="break-words text-sm font-semibold">{topic.title}</h3>
          <p className="text-sm leading-relaxed text-destructive">{t(resolution.reason)}</p>
          <p className="text-sm leading-relaxed text-muted-foreground">{t(resolution.advice)}</p>
          {topic.failure?.validation?.correctionAttempted && <p className="text-sm text-muted-foreground">{t("workbench.wiki_failure_correction_attempted")}</p>}
          {topic.pinned && <p className="text-sm text-muted-foreground">{t("workbench.wiki_failure_pinned")}</p>}
          <div className="flex flex-wrap gap-2">
            <Button size="sm" disabled={wiki.busy || !canProcess} onClick={() => void apply([...(topic.pinned ? [{ action: "topic" as const, id: topic.id, title: topic.title, purpose: topic.purpose, notes: topic.notes, pinned: false }] : []), { action: "retry", id: topic.id }])}>{t(topic.pinned ? "workbench.wiki_failure_unpin_retry" : "workbench.wiki_failure_retry")}</Button>
            {resolution.allowContext && <Button size="sm" variant="outline" disabled={wiki.busy || !canProcess || topic.pinned} onClick={() => { setActionError(""); setCorrecting(topic); setNotes(topic.notes); }}>{t("workbench.wiki_failure_correct")}</Button>}
            {(resolution.citation || resolution.catalog) && <WikiFailureReport title={topic.title} message={topic.failure?.message ?? topic.error} stage={topic.failure?.stage} occurredAt={topic.failure?.occurredAt} validation={topic.failure?.validation} />}
            {resolution.settings && <Button size="sm" variant="outline" onClick={() => (resolution.settings === "scope" || resolution.settings === "connection") ? navigation.push("/memory?tab=settings") : setSettings(resolution.settings === "account" ? "account" : "ai_assistant")}>{t(resolution.settings === "connection" ? "workbench.wiki_failure_connection_settings" : resolution.settings === "scope" ? "workbench.auto_settings" : resolution.settings === "account" ? "workbench.wiki_failure_account" : "workbench.wiki_failure_model")}</Button>}
            <Button size="sm" variant="outline" onClick={() => setDeferred(current => new Set(current).add(topic.id))}>{t("workbench.wiki_failure_later")}</Button>
            <Button size="sm" variant="ghost" disabled={wiki.busy} onClick={() => { setActionError(""); setExcluding(topic); }}>{t("workbench.wiki_failure_exclude")}</Button>
          </div>
          {!!sources.length && <div className="space-y-1"><p className="text-xs font-medium">{t("workbench.auto_sources")}</p>{sources.map(row => <Button key={row.reference.id} size="sm" variant="ghost" className="h-auto min-h-9 max-w-full whitespace-normal text-start" onClick={() => setSource(row.reference)}>{t("workbench.wiki_failure_open_source", { title: row.title })}</Button>)}</div>}
          <details className="rounded-md bg-muted/40 p-3">
            <summary className="cursor-pointer text-xs font-medium">{t(resolution.citation ? "workbench.wiki_failure_citation_details" : "workbench.wiki_failure_details")}</summary>
            {resolution.citation && !position && <p className="mt-3 text-xs text-muted-foreground">{t("workbench.wiki_citation_location_unknown")}</p>}
            <dl className="mt-3 space-y-2 text-xs">
              {position && <div><dt className="text-muted-foreground">{t("workbench.wiki_citation_location")}</dt><dd>{t(position.key, position.values)}</dd></div>}
              {issue?.sourceId && sources.some(row => row.reference.id === issue.sourceId) && <div><dt className="text-muted-foreground">{t("workbench.wiki_citation_source")}</dt><dd>{sources.find(row => row.reference.id === issue.sourceId)!.title}</dd></div>}
              <div><dt className="text-muted-foreground">{t("workbench.wiki_failure_stage")}</dt><dd>{t(stages[topic.failure?.stage ?? ""] ?? "workbench.wiki_failure_stage_unknown")}</dd></div>
              {date && !Number.isNaN(date.getTime()) && <div><dt className="text-muted-foreground">{t("workbench.wiki_failure_time")}</dt><dd><time dateTime={topic.failure!.occurredAt}>{date.toLocaleString(i18n.language)}</time></dd></div>}
              <div><dt className="text-muted-foreground">{t("workbench.wiki_failure_technical")}</dt><dd className="whitespace-pre-wrap break-all font-mono">{topic.failure?.message ?? topic.error}</dd></div>
            </dl>
          </details>
        </article>;
      })}
    </section>}
    {!!excluded.length && <details className="rounded-lg border border-border p-4"><summary className="cursor-pointer text-sm font-medium">{t("workbench.wiki_failure_excluded", { count: excluded.length })}</summary><p className="mt-3 text-sm text-muted-foreground">{t("workbench.wiki_failure_excluded_help")}</p><div className="mt-3 space-y-2">{excluded.map(topic => <div key={topic.id} className="flex flex-wrap items-center justify-between gap-2"><p className="min-w-0 break-words text-sm">{topic.title}</p><Button size="sm" variant="outline" disabled={wiki.busy} onClick={() => void apply([exclusion(topic, false), ...(canProcess && !topic.pinned ? [{ action: "retry" as const, id: topic.id }] : [])])}>{t("workbench.wiki_failure_restore")}</Button></div>)}</div></details>}
    <Dialog open={!!excluding} onOpenChange={open => { if (!open) setExcluding(null); }}><DialogContent><DialogHeader><DialogTitle>{t("workbench.wiki_failure_exclude_title", { title: excluding?.title })}</DialogTitle><DialogDescription>{t("workbench.wiki_failure_exclude_help")}</DialogDescription></DialogHeader>{actionError && <p role="alert" className="text-sm text-destructive">{actionError}</p>}<div className="flex flex-wrap justify-end gap-2"><Button variant="outline" onClick={() => setExcluding(null)}>{t("workbench.cancel")}</Button><Button disabled={wiki.busy} onClick={() => { if (excluding) void apply([exclusion(excluding, true)], () => setExcluding(null)); }}>{t("workbench.wiki_failure_exclude")}</Button></div></DialogContent></Dialog>
    <Dialog open={!!correcting} onOpenChange={open => { if (!open) setCorrecting(null); }}><DialogContent><DialogHeader><DialogTitle>{t("workbench.wiki_failure_correct")}</DialogTitle><DialogDescription>{t("workbench.auto_correction_hint")}</DialogDescription></DialogHeader><label className="space-y-2 text-sm"><span>{t("workbench.auto_user_notes")}</span><textarea className="min-h-36 w-full rounded-md border border-input bg-background p-3" value={notes} maxLength={20000} onChange={event => setNotes(event.target.value)} /></label>{actionError && <p role="alert" className="text-sm text-destructive">{actionError}</p>}<Button disabled={wiki.busy} onClick={() => { if (correcting) void apply([{ action: "correction", id: correcting.id, notes }, { action: "retry", id: correcting.id }], () => setCorrecting(null)); }}>{t("workbench.wiki_failure_save_retry")}</Button></DialogContent></Dialog>
    <Dialog open={!!source} onOpenChange={open => { if (!open) setSource(null); }}><DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-2xl"><DialogHeader><DialogTitle>{t("workbench.auto_source_meetings")}</DialogTitle><DialogDescription>{t("workbench.auto_source_hint")}</DialogDescription></DialogHeader>{source && <GraphSourceNote key={source.id} source={source} />}</DialogContent></Dialog>
    {settings && <Suspense fallback={null}><SettingsDialog open onOpenChange={open => { if (!open) setSettings(null); }} initialSectionId={settings} /></Suspense>}
  </div>;
}
