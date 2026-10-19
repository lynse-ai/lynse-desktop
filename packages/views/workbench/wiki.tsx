"use client";

import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@lynse/core/api";
import { useTranslation } from "@lynse/core/i18n/react";
import { Button } from "@lynse/ui/components/ui/button";
import { Input } from "@lynse/ui/components/ui/input";
import { Switch } from "@lynse/ui/components/ui/switch";
import { Markdown } from "@lynse/ui/markdown";
import { toast } from "sonner";
import { openExternalUrl } from "../app-update";
import { getWorkbenchApi, useWorkbench } from "./api";
import type { WikiModelsConfig, WikiRequest, WikiTopic } from "./types";

const emptyModels: WikiModelsConfig = { text: { baseUrl: "", model: "" }, embedding: { baseUrl: "", model: "" } };
function useWiki() {
  const status = useWorkbench((s) => s.status);
  const qc = useQueryClient();
  const bridge = getWorkbenchApi();
  const [busy, setBusy] = useState(false);
  const queryKey = ["workbench-wiki", status?.scope];
  const query = useQuery({ queryKey: [...queryKey, status?.updatedAt], queryFn: () => bridge!.wiki({ action: "state" }), enabled: !!bridge?.wiki && !!status, networkMode: "always" });
  async function mutate(request: WikiRequest) {
    if (!bridge || busy) return;
    setBusy(true);
    try { await bridge.wiki(request); await qc.invalidateQueries({ queryKey }); }
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
export function WikiModels() {
  const { t } = useTranslation();
  const wiki = useWiki();
  const [models, setModels] = useState(emptyModels);
  const [textKey, setTextKey] = useState("");
  const [embeddingKey, setEmbeddingKey] = useState("");
  const [oauthState, setOauthState] = useState("");
  const [accountId, setAccountId] = useState("");
  const savedModels = wiki.data?.models;
  const savedAccount = wiki.data?.sources?.gmailAccountId ?? "";
  useEffect(() => { if (savedModels) setModels(savedModels); }, [savedModels, wiki.status?.scope]);
  useEffect(() => setAccountId(savedAccount), [savedAccount, wiki.status?.scope]);
  async function connect(check: boolean) {
    try {
      const options = { baseUrl: api().getIntegrationsBaseUrl() ?? undefined, authScope: "integration" as const };
      if (check && oauthState) {
        const result = await api().getWithParams<{ status: string; account_id?: string }>("/api/v2/integrations/gmail/oauth-result", { state: oauthState }, options);
        if (result.status !== "done") { toast.message(t("workbench.gmail_wait")); return; }
        setAccountId(result.account_id ?? ""); toast.success(t("workbench.gmail_connected"));
        await wiki.mutate({ action: "sources", sources: { gmailEnabled: true, gmailAccountId: result.account_id ?? "", integrationsUrl: api().getIntegrationsBaseUrl() ?? api().getBaseUrl() } });
      } else {
        const result = await api().getWithParams<{ state: string; authorization_url: string }>("/api/v2/integrations/gmail/oauth-state", { platform: "desktop" }, options);
        setOauthState(result.state); openExternalUrl(result.authorization_url); toast.message(t("workbench.gmail_wait"));
      }
    } catch (error) { toast.error(String(error)); }
  }
  return <details className="rounded-md border border-border p-3">
    <summary className="cursor-pointer text-xs font-medium">{t("workbench.wiki_models")}</summary>
    <div className="mt-3 space-y-3">
      <p className="text-xs text-muted-foreground">{t("workbench.wiki_models_hint")}</p>
      {(["text", "embedding"] as const).map((kind) => <fieldset key={kind} className="space-y-2">
        <legend className="mb-1 text-xs font-medium">{t(`workbench.${kind}_model`)}</legend>
        <label className="block space-y-1 text-xs"><span>{t("workbench.api_url")}</span><Input value={models[kind].baseUrl} placeholder="https://api.example.com/v1" onChange={(e) => setModels({ ...models, [kind]: { ...models[kind], baseUrl: e.target.value } })} /></label>
        <label className="block space-y-1 text-xs"><span>{t("workbench.model_name")}</span><Input value={models[kind].model} onChange={(e) => setModels({ ...models, [kind]: { ...models[kind], model: e.target.value } })} /></label>
        <label className="block space-y-1 text-xs"><span>{t("workbench.api_key")}</span><Input type="password" autoComplete="new-password" value={kind === "text" ? textKey : embeddingKey} onChange={(e) => kind === "text" ? setTextKey(e.target.value) : setEmbeddingKey(e.target.value)} /></label>
      </fieldset>)}
      <Button size="sm" variant="outline" disabled={wiki.busy} onClick={() => void wiki.mutate({ action: "models", models, ...(textKey ? { textKey } : {}), ...(embeddingKey ? { embeddingKey } : {}) }).then(() => { setTextKey(""); setEmbeddingKey(""); toast.success(t("workbench.model_saved")); }).catch(() => undefined)}>{t("workbench.save")}</Button>
      <div className="space-y-2 border-t border-border pt-3">
        <p className="text-xs text-muted-foreground">{t("workbench.gmail_hint")}</p>
        <div className="flex items-center justify-between gap-3"><label htmlFor="wiki-gmail" className="text-xs">{t("workbench.gmail_enable")}</label><Switch id="wiki-gmail" checked={wiki.data?.sources?.gmailEnabled ?? false} disabled={wiki.busy} onCheckedChange={(gmailEnabled) => void wiki.mutate({ action: "sources", sources: { gmailEnabled, gmailAccountId: accountId, integrationsUrl: api().getIntegrationsBaseUrl() ?? api().getBaseUrl() } }).catch(() => undefined)} /></div>
        <Input aria-label={t("workbench.gmail_account")} placeholder={t("workbench.gmail_account")} value={accountId} onChange={(e) => setAccountId(e.target.value)} />
        <div className="flex flex-wrap gap-2"><Button size="sm" variant="outline" disabled={wiki.busy} onClick={() => void wiki.mutate({ action: "sources", sources: { gmailEnabled: wiki.data?.sources?.gmailEnabled ?? false, gmailAccountId: accountId, integrationsUrl: api().getIntegrationsBaseUrl() ?? api().getBaseUrl() } }).catch(() => undefined)}>{t("workbench.save")}</Button><Button size="sm" variant="outline" onClick={() => void connect(false)}>{t("workbench.gmail_connect")}</Button>{oauthState && <Button size="sm" variant="outline" onClick={() => void connect(true)}>{t("workbench.gmail_check")}</Button>}</div>
        {wiki.data?.sources?.error && <p role="alert" className="text-xs text-destructive">{wiki.data.sources.error}</p>}
      </div>
    </div>
  </details>;
}
function Topic({ topic, mutate, busy, canPublish }: { topic: WikiTopic; mutate: (request: WikiRequest) => Promise<void>; busy: boolean; canPublish: boolean }) {
  const { t } = useTranslation();
  const [notes, setNotes] = useState(topic.notes);
  const [markdown, setMarkdown] = useState(topic.candidate?.markdown ?? topic.published?.markdown ?? "");
  useEffect(() => setMarkdown(topic.candidate?.markdown ?? topic.published?.markdown ?? ""), [topic.candidate?.id, topic.published?.id, topic.candidate?.markdown, topic.published?.markdown]);
  const update = (patch: Partial<WikiTopic>) => void mutate({ action: "topic", id: topic.id, title: topic.title, purpose: topic.purpose, notes, ...patch }).catch(() => undefined);
  return <article className="space-y-3 rounded-lg border border-border p-3">
    <div className="flex flex-wrap items-start justify-between gap-2"><div><h3 className="text-sm font-medium">{topic.title}</h3><p className="text-xs text-muted-foreground">{topic.purpose}</p></div><span className="text-xs text-muted-foreground">{t(topic.candidate ? "workbench.candidate" : topic.stale ? "workbench.stale" : topic.published ? "workbench.published" : "workbench.pending")}</span></div>
    {topic.error && <p role="alert" className="text-xs text-destructive">{topic.error}</p>}
    <label className="block space-y-1 text-xs"><span>{t("workbench.topic_notes")}</span><textarea className="min-h-16 w-full rounded-md border border-input bg-background p-2 text-sm" value={notes} maxLength={20000} onChange={(e) => setNotes(e.target.value)} /></label>
    <div className="flex flex-wrap gap-1"><Button size="sm" variant="ghost" disabled={busy} onClick={() => update({})}>{t("workbench.save")}</Button><Button size="sm" variant="ghost" disabled={busy} onClick={() => update({ pinned: !topic.pinned })}>{t(topic.pinned ? "workbench.unpin" : "workbench.pin")}</Button><Button size="sm" variant="ghost" disabled={busy} onClick={() => update({ excluded: !topic.excluded })}>{t(topic.excluded ? "workbench.include" : "workbench.exclude")}</Button><Button size="sm" variant="ghost" disabled={busy || topic.excluded || topic.pinned} onClick={() => void mutate({ action: "retry", id: topic.id }).catch(() => undefined)}>{t("workbench.retry")}</Button></div>
    {topic.candidate ? <>
      <label className="block space-y-1 text-xs"><span>{t("workbench.page_content")}</span><textarea className="min-h-48 w-full rounded-md border border-input bg-background p-3 text-sm leading-relaxed" value={markdown} onChange={(e) => setMarkdown(e.target.value)} maxLength={200000} /></label>
      <div className="flex flex-wrap gap-2"><Button size="sm" disabled={busy || !canPublish} onClick={() => void mutate({ action: "review", id: topic.id, candidateId: topic.candidate!.id, approve: true, markdown }).catch(() => undefined)}>{t("workbench.publish")}</Button><Button size="sm" variant="outline" disabled={busy} onClick={() => void mutate({ action: "review", id: topic.id, candidateId: topic.candidate!.id, approve: false }).catch(() => undefined)}>{t("workbench.reject")}</Button></div>
    </> : topic.published ? <Markdown mode="full">{topic.published.markdown}</Markdown> : <p className="text-xs text-muted-foreground">{t("workbench.no_page")}</p>}
    <div className="flex flex-wrap gap-1">{(topic.candidate ?? topic.published)?.citations.map((source, index) => <Button key={`${source.id}:${index}`} size="sm" variant="ghost" title={source.quote} onClick={() => useWorkbench.getState().showSource(source)}>{t("workbench.source")}{source.startMs != null ? ` · ${Math.floor(source.startMs / 1000)}s` : ""}</Button>)}</div>
  </article>;
}
export function WikiTopics() {
  const { t } = useTranslation();
  const wiki = useWiki();
  const [title, setTitle] = useState("");
  const [purpose, setPurpose] = useState("");
  return <section className="space-y-3">
    <h2 className="text-sm font-medium">{t("workbench.topics")}</h2><p className="text-xs text-muted-foreground">{t("workbench.topic_hint")}</p>
    {wiki.error && <p role="alert" className="text-xs text-destructive">{String(wiki.error)}</p>}
    <form className="space-y-2" onSubmit={(event) => { event.preventDefault(); void wiki.mutate({ action: "topic", title, purpose }).then(() => { setTitle(""); setPurpose(""); }).catch(() => undefined); }}>
      <Input aria-label={t("workbench.topic_title")} placeholder={t("workbench.topic_title")} value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} />
      <Input aria-label={t("workbench.topic_purpose")} placeholder={t("workbench.topic_purpose")} value={purpose} maxLength={8000} onChange={(e) => setPurpose(e.target.value)} />
      <Button type="submit" size="sm" variant="outline" disabled={wiki.busy || !wiki.status?.enabled || !title.trim()}>{t("workbench.topic_create")}</Button>
    </form>
    {wiki.data?.topics.map((topic) => <Topic key={`${wiki.status?.scope}:${topic.id}`} topic={topic} mutate={wiki.mutate} busy={wiki.busy} canPublish={!!wiki.status?.initialComplete && wiki.status.allowAi && wiki.status.enabled} />)}
  </section>;
}
