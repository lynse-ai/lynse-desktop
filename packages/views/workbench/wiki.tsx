"use client";

import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@lynse/core/api";
import { useAuthStore } from "@lynse/core/auth";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@lynse/ui/components/ui/select";
import { useIntegrationStatus } from "../connections/use-connect-flow";
import { featureFlags } from "../feature-flags";
import { usePluginStore } from "../plugins/state";
import { useTranslation } from "@lynse/core/i18n/react";
import { Button } from "@lynse/ui/components/ui/button";
import { Input } from "@lynse/ui/components/ui/input";
import { Switch } from "@lynse/ui/components/ui/switch";
import { Markdown } from "@lynse/ui/markdown";
import { toast } from "sonner";
import { getWorkbenchApi, refreshWorkbench, useWorkbench, useWikiEnabled } from "./api";
import { useNavigation } from "../navigation";
import { DEFAULT_EMBEDDING_MODEL, embeddingModelError } from "./embedding-model";
import { workbenchErrorCopy } from "./errors";
import type { SourceRef, WikiModelsConfig, WikiRequest, WikiTopic } from "./types";

const defaultModels: WikiModelsConfig = { embedding: DEFAULT_EMBEDDING_MODEL };
export function useWiki() {
  const status = useWorkbench((s) => s.status);
  const wikiEnabled = useWikiEnabled();
  const qc = useQueryClient();
  const bridge = getWorkbenchApi();
  const [busy, setBusy] = useState(false);
  const scope = status?.scope;
  const queryKey = ["workbench-wiki", scope];
  const enabled = wikiEnabled && !!bridge?.wiki && !!scope;
  const query = useQuery({ queryKey, queryFn: () => bridge!.wiki({ action: "state" }), enabled, networkMode: "always" });
  useEffect(() => {
    if (enabled) void qc.invalidateQueries({ queryKey: ["workbench-wiki", scope], exact: true }, { cancelRefetch: false });
  }, [enabled, qc, scope, status?.updatedAt]);
  async function mutate(request: WikiRequest) {
    if (!bridge || busy) return;
    setBusy(true);
    try { qc.setQueryData(queryKey, await bridge.wiki(request)); }
    catch (error) { toast.error(String(error)); throw error; }
    finally { setBusy(false); }
  }
  return { ...query, mutate, busy, status };
}
export function WikiStatus() {
  const { t } = useTranslation();
  const wiki = useWiki();
  if (!wiki.status?.enabled) return null;
  if (!wiki.status.initialComplete) return <p className="text-xs text-muted-foreground">{t("workbench.wiki_wait_sync")}</p>;
  if (!wiki.status.allowAi) return <p className="text-xs text-muted-foreground">{t("workbench.wiki_wait_consent")}</p>;
  return <p className="text-xs text-muted-foreground" aria-live="polite">{t("workbench.wiki_counts", { published: wiki.data?.topics.filter((topic) => !!topic.published).length ?? 0, candidates: wiki.data?.topics.filter((topic) => !!topic.candidate).length ?? 0, failed: wiki.data?.topics.filter((topic) => !!topic.error || topic.stale).length ?? 0 })}</p>;
}

export function WikiAttention() {
  const { t } = useTranslation();
  const navigation = useNavigation();
  const wiki = useWiki();
  const failures = wiki.data?.topics.filter((topic) => !!topic.error && !topic.excluded) ?? [];
  const errorCount = workbenchErrorCopy(wiki.status?.error ?? "")?.count ?? 0;
  if (!failures.length && !errorCount) return null;
  return <section className="space-y-3 rounded-lg border border-destructive/30 bg-destructive/5 p-4" aria-label={t("workbench.wiki_attention")}>
    <h2 className="text-sm font-medium">{t("workbench.wiki_attention")}</h2>
    {wiki.isPending && <p role="status" className="text-xs text-muted-foreground">{t("workbench.wiki_loading_topics")}</p>}
    {wiki.error && <div className="space-y-2"><p role="alert" className="text-xs text-destructive">{t("workbench.wiki_load_failed")}</p><Button size="sm" variant="outline" onClick={() => void wiki.refetch()}>{t("workbench.retry")}</Button></div>}
    {!wiki.isPending && !wiki.error && !failures.length && <div className="space-y-2"><p className="text-xs text-muted-foreground">{t("workbench.wiki_refresh_topics")}</p><Button size="sm" variant="outline" onClick={() => void Promise.all([refreshWorkbench(), wiki.refetch()]).catch(() => undefined)}>{t("workbench.retry")}</Button></div>}
    {failures.map((topic) => { const copy = workbenchErrorCopy(topic.error); return <div key={topic.id} className="space-y-2">
      <h3 className="text-sm font-medium">{topic.title}</h3>
      <p className="text-xs leading-relaxed text-destructive">{copy ? t(copy.key, { count: copy.count }) : topic.error}</p>
      <div className="flex flex-wrap gap-2"><Button size="sm" variant="outline" onClick={() => { useWorkbench.getState().close(); navigation.replace(`/memory?tab=wiki&topic=${encodeURIComponent(topic.id)}`); const target = document.getElementById(`wiki-topic-${topic.id}`); target?.scrollIntoView({ block: "start" }); target?.focus({ preventScroll: true }); }}>{t("workbench.wiki_view_topic")}</Button><Button size="sm" disabled={wiki.busy || !wiki.status?.enabled || !wiki.status.allowAi || topic.pinned} onClick={() => void wiki.mutate({ action: "retry", id: topic.id }).catch(() => undefined)}>{t("workbench.retry")}</Button></div>
    </div>; })}
  </section>;
}
export function WikiModels() {
  const wiki = useWiki();
  return <WikiModelsForm key={wiki.status?.scope ?? ""} wiki={wiki} />;
}
function WikiModelsForm({ wiki }: { wiki: ReturnType<typeof useWiki> }) {
  const { t } = useTranslation();
  const [models, setModels] = useState(defaultModels);
  const [embeddingKey, setEmbeddingKey] = useState("");
  const [dirty, setDirty] = useState(false);
  const savedModels = wiki.data?.models;
  useEffect(() => { if (savedModels && !dirty) setModels(savedModels); }, [savedModels, dirty]);
  const error = embeddingModelError(models.embedding);
  function updateEmbedding(patch: Partial<WikiModelsConfig["embedding"]>) {
    setDirty(true);
    setModels({ ...models, embedding: { ...models.embedding, ...patch } });
  }
  async function save() {
    if (!savedModels || error) return;
    const key = embeddingKey.trim();
    await wiki.mutate({ action: "models", models: { ...models, embedding: {
      baseUrl: models.embedding.baseUrl.trim().replace(/\/+$/, ""),
      model: models.embedding.model.trim(),
    } }, ...(key ? { embeddingKey: key } : {}) });
    setEmbeddingKey("");
    setDirty(false);
    toast.success(t("workbench.model_saved"));
  }
  return <details className="rounded-md border border-border p-3">
    <summary className="cursor-pointer text-xs font-medium">{t("workbench.wiki_models")}</summary>
    <div className="mt-3 space-y-3">
      <p className="text-xs text-muted-foreground">{t("workbench.wiki_models_hint")}</p>
      <fieldset className="min-w-0 space-y-2" disabled={wiki.busy || !savedModels}>
        <legend className="mb-1 text-xs font-medium">{t("workbench.embedding_model")}</legend>
        <label className="block space-y-1 text-xs"><span>{t("workbench.api_url")}</span><Input value={models.embedding.baseUrl} placeholder={DEFAULT_EMBEDDING_MODEL.baseUrl} spellCheck={false} autoComplete="off" aria-describedby="wiki-embedding-url-hint" onChange={(e) => updateEmbedding({ baseUrl: e.target.value })} /></label>
        <p id="wiki-embedding-url-hint" className="break-words text-xs text-muted-foreground">{t("workbench.embedding_url_hint")}</p>
        <label className="block space-y-1 text-xs"><span>{t("workbench.model_name")}</span><Input value={models.embedding.model} spellCheck={false} autoComplete="off" onChange={(e) => updateEmbedding({ model: e.target.value })} /></label>
        <label className="block space-y-1 text-xs"><span>{t("workbench.api_key")}</span><Input type="password" autoComplete="new-password" spellCheck={false} value={embeddingKey} onChange={(e) => { setDirty(true); setEmbeddingKey(e.target.value); }} /></label>
        <p className="text-xs text-muted-foreground">{t("workbench.embedding_key_hint")}</p>
        <Button size="sm" variant="ghost" onClick={() => updateEmbedding(DEFAULT_EMBEDDING_MODEL)}>{t("workbench.embedding_restore_default")}</Button>
      </fieldset>
      {dirty && error && <p role="alert" className="text-xs text-destructive">{t(error)}</p>}
      {wiki.error && <p role="alert" className="text-xs text-destructive">{String(wiki.error)}</p>}
      <Button size="sm" variant="outline" disabled={wiki.busy || !savedModels || !!error} onClick={() => void save().catch(() => undefined)}>{t("workbench.save")}</Button>
    </div>
  </details>;
}
export function WikiSources() {
  const { t } = useTranslation();
  const wiki = useWiki();
  const authenticated = useAuthStore((state) => state.isAuthenticated);
  const installed = usePluginStore((state) => state.entries["lynse.gmail"]?.enabled);
  const available = !featureFlags.pluginMarketplace || !!installed;
  const wikiEnabled = useWikiEnabled();
  const connection = useIntegrationStatus("gmail", authenticated && available && wikiEnabled);
  const accounts = connection.data?.accounts ?? [];
  const storedId = wiki.data?.sources?.gmailAccountId ?? "";
  const selectedId = accounts.some((account) => account.id === storedId) ? storedId : accounts.length === 1 ? accounts[0]!.id : "";
  const connected = !!connection.data?.connected && !connection.isError;
  const selected = connected && !!selectedId;
  function save(gmailEnabled: boolean, gmailAccountId: string) {
    void wiki.mutate({ action: "sources", sources: { gmailEnabled, gmailAccountId, integrationsUrl: api().getIntegrationsBaseUrl() ?? api().getBaseUrl() } }).catch(() => undefined);
  }
  return <section className="space-y-2 rounded-md border border-border p-3">
    <h3 className="text-xs font-medium">{t("workbench.wiki_sources")}</h3>
    <p className="text-xs text-muted-foreground">{t("workbench.gmail_hint")}</p>
    <div className="flex items-center justify-between gap-3"><label htmlFor="wiki-gmail" className="text-xs">{t("workbench.gmail_enable")}</label><Switch id="wiki-gmail" checked={wiki.data?.sources?.gmailEnabled ?? false} disabled={wiki.busy || (!selected && !wiki.data?.sources?.gmailEnabled)} onCheckedChange={(enabled) => save(enabled, selectedId || storedId)} /></div>
    {!available || !connected ? <p className="text-xs text-muted-foreground">{t("workbench.gmail_connections_hint")}</p> : <label className="block space-y-1 text-xs"><span>{t("workbench.gmail_account")}</span><Select value={selectedId} disabled={wiki.busy} onValueChange={(value) => { if (value) save(wiki.data?.sources?.gmailEnabled ?? false, value); }}><SelectTrigger className="w-full" aria-label={t("workbench.gmail_account")}><SelectValue placeholder={t("workbench.gmail_choose_account")} /></SelectTrigger><SelectContent>{accounts.map((account) => <SelectItem key={account.id} value={account.id}>{account.email || account.display_name}</SelectItem>)}</SelectContent></Select></label>}
    {wiki.data?.sources?.error && <p role="alert" className="text-xs text-destructive">{wiki.data.sources.error}</p>}
  </section>;
}

export function WikiTopicContent({ topic, mutate, busy, canPublish, onSource, reading = false }: { topic: WikiTopic; mutate: (request: WikiRequest) => Promise<void>; busy: boolean; canPublish: boolean; onSource?: (source: SourceRef) => void; reading?: boolean }) {
  const { t } = useTranslation();
  const navigation = useNavigation();
  const [notes, setNotes] = useState(topic.notes);
  const [markdown, setMarkdown] = useState(topic.candidate?.markdown ?? topic.published?.markdown ?? "");
  const [reviewing, setReviewing] = useState(!reading);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  useEffect(() => setMarkdown(topic.candidate?.markdown ?? topic.published?.markdown ?? ""), [topic.candidate?.id, topic.published?.id, topic.candidate?.markdown, topic.published?.markdown]);
  const update = (patch: Partial<WikiTopic>) => void mutate({ action: "topic", id: topic.id, title: topic.title, purpose: topic.purpose, notes, ...patch }).catch(() => undefined);
  const errorCopy = workbenchErrorCopy(topic.error);
  const page = topic.candidate ?? topic.published;
  const preview = page?.markdown.trimStart().startsWith(`# ${topic.title}\n`) ? page.markdown.trimStart().slice(topic.title.length + 3).trimStart() : page?.markdown ?? "";
  const controls = <>
    <label className="block space-y-1 text-xs"><span>{t("workbench.topic_notes")}</span><textarea className="min-h-16 w-full rounded-md border border-input bg-background p-2 text-sm" value={notes} maxLength={20000} onChange={(e) => setNotes(e.target.value)} /></label>
    <div className="flex flex-wrap gap-1"><Button size="sm" variant="ghost" disabled={busy} onClick={() => update({})}>{t("workbench.save")}</Button><Button size="sm" variant="ghost" disabled={busy} onClick={() => update({ pinned: !topic.pinned })}>{t(topic.pinned ? "workbench.unpin" : "workbench.pin")}</Button><Button size="sm" variant="ghost" disabled={busy} onClick={() => update({ excluded: !topic.excluded })}>{t(topic.excluded ? "workbench.include" : "workbench.exclude")}</Button><Button size="sm" variant="ghost" disabled={busy || topic.excluded || topic.pinned} onClick={() => void mutate({ action: "retry", id: topic.id }).catch(() => undefined)}>{t("workbench.retry")}</Button>
      {confirmingDelete
        ? <Button size="sm" variant="ghost" className="text-destructive" disabled={busy} onBlur={() => setConfirmingDelete(false)} onClick={() => { setConfirmingDelete(false); void mutate({ action: "topic_delete", id: topic.id }).then(() => navigation.replace("/memory?tab=wiki")).catch(() => undefined); }}>{t("workbench.topic_delete_confirm")}</Button>
        : <Button size="sm" variant="ghost" className="text-destructive" disabled={busy} onClick={() => setConfirmingDelete(true)}>{t("workbench.topic_delete")}</Button>}
    </div>
  </>;
  return <article id={`wiki-topic-${topic.id}`} tabIndex={-1} aria-label={topic.title} className="scroll-mt-4 space-y-3 rounded-lg border border-border p-3">
    <div className="flex flex-wrap items-start justify-between gap-2"><div><h3 className="text-sm font-medium">{topic.title}</h3><p className="text-xs text-muted-foreground">{topic.purpose}</p></div><span className="text-xs text-muted-foreground">{t(topic.error ? "workbench.topic_failed" : topic.candidate ? "workbench.candidate" : topic.stale ? "workbench.stale" : topic.published ? "workbench.published" : "workbench.pending")}</span></div>
    {topic.error && <p role="alert" className="text-xs text-destructive">{errorCopy ? t(errorCopy.key, { count: errorCopy.count }) : topic.error}</p>}
    {!reading && controls}
    {topic.candidate && (reviewing || !reading) ? <>
      <label className="block space-y-1 text-xs"><span>{t("workbench.page_content")}</span><textarea className="min-h-48 w-full rounded-md border border-input bg-background p-3 text-sm leading-relaxed" value={markdown} onChange={(e) => setMarkdown(e.target.value)} maxLength={200000} /></label>
      <div className="flex flex-wrap gap-2"><Button size="sm" disabled={busy || !canPublish} onClick={() => void mutate({ action: "review", id: topic.id, candidateId: topic.candidate!.id, approve: true, markdown }).catch(() => undefined)}>{t("workbench.publish")}</Button><Button size="sm" variant="outline" disabled={busy} onClick={() => void mutate({ action: "review", id: topic.id, candidateId: topic.candidate!.id, approve: false }).catch(() => undefined)}>{t("workbench.reject")}</Button></div>
    </> : page ? <>{topic.candidate && <Button size="sm" variant="outline" onClick={() => setReviewing(true)}>{t("workbench.wiki_review_candidate")}</Button>}<Markdown mode="full">{preview}</Markdown></> : <p className="text-xs text-muted-foreground">{t(topic.error ? "workbench.no_page_failed" : "workbench.no_page")}</p>}
    <div className="flex flex-wrap gap-1">{(topic.candidate ?? topic.published)?.citations.map((source, index) => <Button key={`${source.id}:${index}`} size="sm" variant="ghost" title={source.quote} onClick={() => onSource ? onSource(source) : useWorkbench.getState().showSource(source)}>{t("workbench.source")}{source.startMs != null ? ` · ${Math.floor(source.startMs / 1000)}s` : ""}</Button>)}</div>
    {reading && <details className="border-t border-border pt-3"><summary className="cursor-pointer text-xs font-medium">{t("workbench.wiki_topic_controls")}</summary><div className="mt-3 space-y-3">{controls}</div></details>}
  </article>;
}
export function WikiTopicForm({ onCreated }: { onCreated?: (title: string) => void }) {
  const { t } = useTranslation();
  const wiki = useWiki();
  const [title, setTitle] = useState("");
  const [purpose, setPurpose] = useState("");
  return <form className="space-y-2" onSubmit={(event) => { event.preventDefault(); void wiki.mutate({ action: "topic", title, purpose }).then(() => { onCreated?.(title); setTitle(""); setPurpose(""); }).catch(() => undefined); }}>
    <Input aria-label={t("workbench.topic_title")} placeholder={t("workbench.topic_title")} value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} />
    <Input aria-label={t("workbench.topic_purpose")} placeholder={t("workbench.topic_purpose")} value={purpose} maxLength={8000} onChange={(e) => setPurpose(e.target.value)} />
    <Button type="submit" size="sm" variant="outline" disabled={wiki.busy || !wiki.status?.enabled || !title.trim()}>{t("workbench.topic_create")}</Button>
  </form>;
}

export function WikiTopics() {
  const { t } = useTranslation();
  const wiki = useWiki();
  const navigation = useNavigation();
  const requestedTopic = navigation.searchParams.get("topic");
  const requestedTopicId = wiki.data?.topics.find((topic) => topic.id === requestedTopic || topic.mergedIds?.includes(requestedTopic ?? ""))?.id;
  useEffect(() => { if (requestedTopic && requestedTopicId) { const target = document.getElementById(`wiki-topic-${requestedTopicId}`); target?.scrollIntoView({ block: "start" }); target?.focus({ preventScroll: true }); } }, [requestedTopic, requestedTopicId]);
  return <section className="space-y-3">
    <h2 className="text-sm font-medium">{t("workbench.topics")}</h2><p className="text-xs text-muted-foreground">{t("workbench.topic_hint")}</p>
    {wiki.error && <p role="alert" className="text-xs text-destructive">{String(wiki.error)}</p>}
    <WikiTopicForm />
    {wiki.data?.topics.slice().sort((a, b) => Number(!!b.error && !b.excluded) - Number(!!a.error && !a.excluded)).map((topic) => <WikiTopicContent key={`${wiki.status?.scope}:${topic.id}`} topic={topic} mutate={wiki.mutate} busy={wiki.busy} canPublish={!!wiki.status?.initialComplete && wiki.status.allowAi && wiki.status.enabled} />)}
  </section>;
}
