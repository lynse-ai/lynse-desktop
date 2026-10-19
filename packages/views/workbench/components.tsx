"use client";

import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@lynse/core/api";
import { useAuthStore } from "@lynse/core/auth";
import { useTranslation } from "@lynse/core/i18n/react";
import { Card, CardContent, CardHeader, CardTitle } from "@lynse/ui/components/ui/card";
import { Button } from "@lynse/ui/components/ui/button";
import { Switch } from "@lynse/ui/components/ui/switch";
import { Input } from "@lynse/ui/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@lynse/ui/components/ui/dialog";
import { Markdown } from "@lynse/ui/markdown";
import { BookOpen, Loader2, RefreshCw, Search } from "../icons";
import { toast } from "sonner";
import { getDesktopLocalTranscriptionApi } from "../workspace/local-transcription";
import { AudioPlayer, type AudioPlayerHandle } from "../workspace/audio-player";
import { useTodoStore } from "../todo/use-todos";
import { useFileAudioUrl } from "../workspace/hooks/use-files";
import { DeleteConfirmDialog } from "../workspace/delete-confirm-dialog";
import { getWorkbenchApi, refreshWorkbench, useWorkbench } from "./api";
import type { MemoryItem, SourceRef, SynthesisResult, TodoSuggestion, WorkbenchReadResult } from "./types";
import { WikiModels, WikiTopics, WikiStatus } from "./wiki";

/** Account lifecycle stays outside AuthGate so logout also cancels native work. */
export function WorkbenchSupervisor() {
  const authenticated = useAuthStore((s) => s.isAuthenticated);
  const user = useAuthStore((s) => s.user);
  const { i18n } = useTranslation();
  useEffect(() => {
    const bridge = getWorkbenchApi();
    if (!bridge) return;
    let disposed = false;
    let boundScope: string | undefined;
    let unlisten: (() => void) | undefined;
    useWorkbench.setState({ status: null, error: null, open: false, selectedId: null });
    const token = api().getToken();
    if (!authenticated || !token) { void bridge.unbind(); return; }
    void bridge.bind({ baseUrl: api().getBaseUrl(), agentUrl: api().getAgentBaseUrl() ?? undefined,
      token, locale: i18n.language })
      .then((status) => { if (!disposed) { boundScope = status?.scope; useWorkbench.getState().setStatus(status); } })
      .catch((error: unknown) => { if (!disposed) useWorkbench.getState().setError(String(error)); });
    void bridge.onUpdate((status) => {
      if (!disposed && boundScope === status.scope) useWorkbench.getState().setStatus(status);
    }).then((cleanup) => { if (disposed) cleanup(); else unlisten = cleanup; });
    const resume = () => {
      if (document.visibilityState !== "hidden" && useWorkbench.getState().status?.enabled) {
        void bridge.sync(false).catch((error: unknown) => useWorkbench.getState().setError(String(error)));
      }
    };
    window.addEventListener("online", resume);
    document.addEventListener("visibilitychange", resume);
    return () => {
      disposed = true; unlisten?.();
      window.removeEventListener("online", resume);
      document.removeEventListener("visibilitychange", resume);
      void bridge.unbind();
    };
  }, [authenticated, user, i18n.language]);
  return null;
}

function Progress() {
  const { t } = useTranslation();
  const status = useWorkbench((s) => s.status);
  const error = useWorkbench((s) => s.error);
  return <div className="space-y-1 text-xs text-muted-foreground" aria-live="polite">
    {status && <>
      <p>{t(`workbench.${status.phase}`)}</p>
      <p>{t("workbench.progress", { synced: status.synced, total: status.discovered, waiting: status.awaitingTranscription, failed: status.failed, conflicts: status.conflicts })}</p>
    </>}
    {(error || status?.error) && <p role="alert" className="text-destructive">{error || status?.error}</p>}
  </div>;
}

export function WorkbenchSettingsContent({ disabled = false }: { disabled?: boolean }) {
  const bridge = getWorkbenchApi();
  const status = useWorkbench((s) => s.status);
  const authenticated = useAuthStore((s) => s.isAuthenticated);
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [clearing, setClearing] = useState(false);
  const qc = useQueryClient();
  if (!bridge) return null;
  async function configure(enabled: boolean, allowAi: boolean) {
    if (!bridge) return;
    setBusy(true);
    try { useWorkbench.getState().setStatus(await bridge.configure(enabled, allowAi)); await qc.invalidateQueries({ queryKey: ["vault-config"] }); }
    catch (error) { await refreshWorkbench().catch(() => undefined); await qc.invalidateQueries({ queryKey: ["vault-config"] }); useWorkbench.getState().setError(String(error)); }
    finally { setBusy(false); }
  }
  return <div className="space-y-3 border-t border-border pt-3">
      <div className="flex items-center justify-between gap-4">
        <label htmlFor="meeting-memory-enable" className="text-xs">{t("workbench.enable")}</label>
        <Switch id="meeting-memory-enable" checked={status?.enabled ?? false} disabled={disabled || busy || !authenticated || !status}
          onCheckedChange={(checked) => void configure(checked, status?.allowAi ?? false)} />
      </div>
      <p className="text-xs leading-relaxed text-muted-foreground">{t("workbench.hint")}</p>
      {!authenticated && <p className="text-xs text-muted-foreground">{t("workbench.sign_in")}</p>}
      {status?.enabled && <>
        <div className="flex items-center justify-between gap-4">
          <label htmlFor="meeting-memory-ai" className="text-xs">{t("workbench.allow_ai")}</label>
          <Switch id="meeting-memory-ai" checked={status.allowAi} disabled={disabled || busy} onCheckedChange={(checked) => void configure(true, checked)} />
        </div>
        <p className="text-xs leading-relaxed text-muted-foreground">{t("workbench.ai_hint")}</p>
      </>}
      <Progress />
      {status?.enabled && <><WikiStatus /><WikiModels /></>}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" onClick={() => useWorkbench.getState().show()}>{t("workbench.open")}</Button>
        {status?.enabled && <Button size="sm" variant="outline" disabled={busy} onClick={() => void bridge.sync().then(refreshWorkbench).catch((error: unknown) => toast.error(String(error)))}>
          <RefreshCw className="size-3.5" />{t("workbench.sync")}
        </Button>}
        {status && <Button size="sm" variant="ghost" onClick={() => setClearing(true)}>{t("workbench.clear")}</Button>}
      </div>
      <DeleteConfirmDialog open={clearing} onOpenChange={setClearing} description={t("workbench.clear_confirm")} pending={busy} confirmLabel={t("workbench.clear")}
        onConfirm={() => { setBusy(true); void bridge.clear().then(refreshWorkbench).then(() => setClearing(false)).catch((error: unknown) => toast.error(String(error))).finally(() => setBusy(false)); }} />
  </div>;
}

export function WorkbenchButton({ query = "", id }: { query?: string; id?: string }) {
  const { t } = useTranslation();
  if (!getWorkbenchApi()) return null;
  return <Button variant="ghost" size="sm" onClick={() => useWorkbench.getState().show(query, id)}><BookOpen className="size-3.5" />{t("workbench.review")}</Button>;
}

export function WorkbenchHomeCard() {
  const status = useWorkbench((s) => s.status);
  const { t } = useTranslation();
  if (!status?.enabled) return null;
  const memories = status.memories.filter((item) => !item.excluded).slice(-3).reverse();
  return <Card className="mb-5">
    <CardHeader className="flex-row items-center justify-between pb-2"><CardTitle className="text-sm">{t("workbench.title")}</CardTitle><WorkbenchButton /></CardHeader>
    <CardContent className="space-y-3">
      <Progress />
      {memories.map((item) => <button type="button" key={item.id} className="block w-full rounded-md p-2 text-left text-sm hover:bg-accent" onClick={() => item.citations[0] ? useWorkbench.getState().showSource(item.citations[0]) : useWorkbench.getState().show("", item.sourceId)}>
        <span className="mr-2 text-xs text-muted-foreground">{t(`workbench.${item.stale ? "unresolved" : item.kind}`)}</span>{item.text}
      </button>)}
    </CardContent>
  </Card>;
}

function MemoryCard({ item }: { item: MemoryItem }) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(item.text);
  const [busy, setBusy] = useState(false);
  async function save(text: string, pinned: boolean, excluded: boolean) {
    setBusy(true);
    try { await getWorkbenchApi()?.editMemory(item.id, text, pinned, excluded); await refreshWorkbench(); setEditing(false); }
    catch (error) { toast.error(String(error)); }
    finally { setBusy(false); }
  }
  return <article className="space-y-2 rounded-lg border border-border p-3">
    <p className="text-xs text-muted-foreground">{t(`workbench.${item.stale ? "unresolved" : item.kind}`)}{item.pinned ? ` · ${t("workbench.pin")}` : ""}</p>
    {editing ? <textarea aria-label={t("workbench.edit")} value={draft} onChange={(event) => setDraft(event.target.value)} maxLength={4000} className="min-h-20 w-full rounded border border-input bg-background p-2 text-sm" /> : <p className="text-sm leading-relaxed">{item.text}</p>}
    <div className="flex flex-wrap gap-1">
      <SourceButtons sources={item.citations} />
      <Button size="sm" variant="ghost" disabled={busy} onClick={() => editing ? void save(draft, !!item.pinned, false) : setEditing(true)}>{t(editing ? "workbench.save" : "workbench.edit")}</Button>
      <Button size="sm" variant="ghost" disabled={busy} onClick={() => void save(item.text, !item.pinned, false)}>{t(item.pinned ? "workbench.unpin" : "workbench.pin")}</Button>
      <Button size="sm" variant="ghost" disabled={busy} onClick={() => void save(item.text, !!item.pinned, true)}>{t("workbench.forget")}</Button>
    </div>
  </article>;
}

function TaskSuggestions({ id, suggestions }: { id: string; suggestions: TodoSuggestion[] }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [titles, setTitles] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  async function accept(items: TodoSuggestion[]) {
    setBusy(true);
    try {
      await getWorkbenchApi()?.confirmTodos(id, items.map((item) => ({ id: item.id, title: titles[item.id] ?? item.title, dueDate: item.dueDate })));
      await qc.invalidateQueries({ queryKey: ["workbench-document"] });
      await qc.invalidateQueries({ queryKey: ["todos"] });
      // Existing todo consumers share a client store as well as query caches.
      await useTodoStore.getState().load({ force: true });
    } catch (error) { toast.error(String(error)); }
    finally { setBusy(false); }
  }
  const pending = suggestions.filter((item) => !item.accepted);
  if (!suggestions.length) return null;
  return <section className="space-y-3">
    <div className="flex items-center justify-between gap-3"><h3 className="text-sm font-medium">{t("workbench.suggestions")}</h3>
      {pending.length > 1 && <Button size="sm" variant="outline" disabled={busy} onClick={() => void accept(pending)}>{t("workbench.accept_all")}</Button>}
    </div>
    {suggestions.map((item) => <div key={item.id} className="flex items-start gap-2">
      <Input aria-label={t("workbench.todo")} value={titles[item.id] ?? item.title} disabled={item.accepted} onChange={(event) => setTitles({ ...titles, [item.id]: event.target.value })} />
      <Button size="sm" variant="outline" disabled={busy || item.accepted} onClick={() => void accept([item])}>{t(item.accepted ? "workbench.accepted" : "workbench.accept")}</Button>
    </div>)}
  </section>;
}

function EditableSummary({ id, summary }: { id: string; summary: { id: string; markdown: string } }) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(summary.markdown);
  const [busy, setBusy] = useState(false);
  const qc = useQueryClient();
  async function save() {
    setBusy(true);
    try {
      await getWorkbenchApi()?.saveSummary(id, summary.id, draft);
      await qc.invalidateQueries({ queryKey: ["workbench-document"] });
      setEditing(false);
    } catch (error) { toast.error(String(error)); }
    finally { setBusy(false); }
  }
  return <section className="space-y-3">
    <div className="flex items-center justify-between gap-2"><h3 className="text-sm font-medium">{t("workbench.summary")}</h3>
      <div className="flex gap-1"><Button size="sm" variant="ghost" disabled={busy} onClick={() => editing ? void save() : setEditing(true)}>{t(editing ? "workbench.save" : "workbench.edit")}</Button>
        {!editing && <Button size="sm" variant="ghost" onClick={() => void getWorkbenchApi()?.regenerate(id).catch((error: unknown) => toast.error(String(error)))}>{t("workbench.retry")}</Button>}
      </div>
    </div>
    {editing ? <textarea aria-label={t("workbench.summary")} value={draft} maxLength={100000} onChange={(event) => setDraft(event.target.value)} className="min-h-60 w-full rounded-md border border-input bg-background p-3 text-sm leading-relaxed" /> : <Markdown mode="full">{summary.markdown}</Markdown>}
  </section>;
}

function MeetingReader({ id }: { id: string }) {
  const { t, i18n } = useTranslation();
  const bridge = getWorkbenchApi();
  const status = useWorkbench((s) => s.status);
  const query = useQuery<WorkbenchReadResult>({ queryKey: ["workbench-document", status?.scope, id, status?.updatedAt], queryFn: () => bridge!.read(id), networkMode: "always", enabled: !!bridge });
  const { data: audioUrl } = useFileAudioUrl(query.data?.document.kind === "meeting" ? query.data.document.id : null);
  const player = useRef<AudioPlayerHandle>(null);
  const transcriptView = useRef<HTMLElement>(null);
  const [transcribing, setTranscribing] = useState(false);
  const qc = useQueryClient();
  const selectedSource = useWorkbench((s) => s.selectedSource);
  useEffect(() => {
    if (selectedSource?.id === id && selectedSource.startMs != null && audioUrl) {
      player.current?.seekTo(selectedSource.startMs / 1000);
    }
  }, [selectedSource, id, audioUrl]);
  useEffect(() => {
    if (selectedSource?.id === id && query.data) transcriptView.current?.querySelector("[data-source-match='true']")?.scrollIntoView({ block: "center" });
  }, [selectedSource, id, query.data]);
  const entry = status?.entries.find((item) => item.id === (query.data?.document.id ?? id));
  async function transcribe() {
    const local = getDesktopLocalTranscriptionApi();
    if (!local) return;
    setTranscribing(true);
    try {
      const models = await local.listSttModels();
      if (!models.models.some((model) => model.status === "installed")) { toast.info(t("workbench.missing_model")); return; }
      await local.retry(id);
      await bridge?.sync(false);
      await qc.invalidateQueries({ queryKey: ["file-transcription", id] });
    } catch (error) { toast.error(String(error)); }
    finally { setTranscribing(false); }
  }
  if (query.isLoading) return <Loader2 className="m-6 size-5 animate-spin" />;
  if (query.error) return <p role="alert" className="p-4 text-sm text-destructive">{String(query.error)}</p>;
  const result = query.data;
  if (!result) return null;
  const document = result.document;
  if (document.kind === "wiki") return <section className="space-y-4"><h2 className="text-lg font-semibold">{document.title}</h2><Markdown mode="full">{result.markdown}</Markdown><SourceButtons sources={document.citations ?? []} /></section>;
  const latest = result.artifacts?.summaries.at(-1);
  return <div className="space-y-6">
    <div className="flex items-start justify-between gap-3"><h2 className="text-lg font-semibold">{document.title}</h2>
      {status?.enabled && <Button size="sm" variant="outline" onClick={() => void bridge?.exclude(document.id, !entry?.excluded).then(refreshWorkbench).catch((error: unknown) => toast.error(String(error)))}>{t(entry?.excluded ? "workbench.include" : "workbench.exclude")}</Button>}
    </div>
    {entry?.status === "conflict" && <div className="space-y-2 rounded-md bg-muted p-3 text-sm"><p role="status">{t("workbench.conflict")}</p>
      <div className="flex gap-2">{[true, false].map((keepLocal) => <Button key={String(keepLocal)} variant="outline" size="sm" onClick={() => void bridge?.resolveConflict(document.id, keepLocal).then(async () => { await refreshWorkbench(); await qc.invalidateQueries({ queryKey: ["workbench-document"] }); }).catch((error: unknown) => toast.error(String(error)))}>{t(keepLocal ? "workbench.keep_local" : "workbench.use_cloud")}</Button>)}</div>
      <Markdown>{result.markdown}</Markdown>
    </div>}
    {entry?.error && <p role="alert" className="text-sm text-destructive">{entry.error}</p>}
    {document.kind === "meeting" && (audioUrl ? <AudioPlayer ref={player} src={audioUrl} /> : <p className="text-xs text-muted-foreground">{t("workbench.no_audio")}</p>)}
    {!!document.markers?.length && <section className="space-y-2"><h3 className="text-sm font-medium">{t("workbench.marker")}</h3>
      {document.markers.map((marker) => <button key={marker.id} type="button" className="flex w-full gap-3 rounded-md border border-border p-2 text-left text-sm hover:bg-accent" onClick={() => {
        const segment = document.segments.find((item) => item.startMs != null && item.startMs >= marker.startMs) ?? document.segments.at(-1);
        useWorkbench.getState().showSource({kind:document.kind,id:document.id,revision:document.revision,startMs:marker.startMs,quote:segment?.text || segment?.recognizedText || ""});
      }}><span className="tabular-nums text-muted-foreground">{Math.floor(marker.startMs / 1000)}s</span><span>{t(`workbench.${marker.kind}`)}{marker.note ? ` · ${marker.note}` : ""}</span></button>)}
    </section>}
    {latest && <EditableSummary key={latest.id} id={document.id} summary={latest} />}
    <TaskSuggestions id={document.id} suggestions={result.artifacts?.todoSuggestions ?? []} />
    {!document.transcript && <div className="flex items-center gap-3"><span className="text-sm text-muted-foreground">{t("workbench.waiting")}</span>
      {id.startsWith("local:") && <Button size="sm" disabled={transcribing} onClick={() => void transcribe()}>{transcribing && <Loader2 className="size-3.5 animate-spin" />}{t("workbench.transcribe")}</Button>}
    </div>}
    <section ref={transcriptView}><h3 className="mb-3 text-sm font-medium">{t("workbench.transcript")}</h3>
      {document.segments.length ? document.segments.map((segment, index) => <button key={segment.id || index} type="button" data-source-match={!!selectedSource?.quote && (segment.text || segment.recognizedText || "").includes(selectedSource.quote)} className={`mb-2 block w-full rounded p-2 text-left text-sm leading-relaxed hover:bg-accent ${selectedSource?.quote && (segment.text || segment.recognizedText || "").includes(selectedSource.quote) ? "bg-accent ring-1 ring-ring" : ""}`} onClick={() => segment.startMs != null && player.current?.seekTo(segment.startMs / 1000)}>
        {segment.startMs != null && <span className="mr-2 text-xs tabular-nums text-muted-foreground">{new Date(segment.startMs).toISOString().slice(11, 19)}</span>}
        {segment.speakerName && <strong className="mr-2">{segment.speakerName}</strong>}{segment.text || segment.recognizedText}
      </button>) : <p className="whitespace-pre-wrap text-sm leading-relaxed"><QuotedText text={document.transcript} quote={selectedSource?.quote} /></p>}
    </section>
    {document.conclusions.map((summary, index) => <section key={summary.id ?? index}><h3 className="mb-2 text-sm font-medium">{summary.templateName || t("workbench.summary")}</h3><Markdown mode="full">{summary.conclusionText}</Markdown></section>)}
    {latest && result.artifacts && result.artifacts.summaries.length > 1 && <details><summary className="cursor-pointer text-xs text-muted-foreground">{t("workbench.summary")} · {result.artifacts.summaries.length}</summary>
      {result.artifacts.summaries.slice(0, -1).map((summary) => <section key={summary.id} className="mt-4"><p className="text-xs text-muted-foreground">{new Date(summary.createdAt).toLocaleString(i18n.language)}</p><Markdown>{summary.markdown}</Markdown></section>)}
    </details>}
  </div>;
}

export function WorkbenchDialog() {
  const panel = useWorkbench();
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [brief, setBrief] = useState<SynthesisResult | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bridge = getWorkbenchApi();
  useEffect(() => { if (panel.open) { setQuery(panel.query); setBrief(null); setError(null); } }, [panel.open, panel.query]);
  const results = useQuery({ queryKey: ["workbench-search", panel.status?.scope, query, panel.status?.updatedAt], queryFn: () => bridge!.search(query), networkMode: "always", enabled: !!bridge && panel.open && !!query.trim() });
  const items = query.trim() ? results.data?.items ?? [] : panel.status?.entries ?? [];
  const requestScope = useRef(panel.status?.scope);
  requestScope.current = panel.status?.scope;
  async function review() {
    if (!bridge) return;
    const scope = panel.status?.scope;
    setReviewing(true); setError(null); panel.select("");
    try { const result = await bridge.review(query); if (requestScope.current === scope) setBrief(result); }
    catch (failure) { if (requestScope.current === scope) setError(String(failure)); }
    finally { if (requestScope.current === scope) setReviewing(false); }
  }
  if (!bridge) return null;
  return <Dialog open={panel.open} onOpenChange={(open) => { if (!open) panel.close(); }}>
    <DialogContent className="flex h-[min(88vh,850px)] max-w-5xl flex-col gap-0 overflow-hidden p-0 sm:max-w-5xl">
      <DialogHeader className="shrink-0 border-b border-border px-5 py-4 pr-12"><DialogTitle>{t("workbench.title")}</DialogTitle><DialogDescription>{t("workbench.brief_hint")}</DialogDescription></DialogHeader>
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border p-3">
        <Search className="size-4 text-muted-foreground" /><Input aria-label={t("workbench.search")} placeholder={t("workbench.search")} value={query} onChange={(event) => { setQuery(event.target.value); setBrief(null); }} className="min-w-40 flex-1" />
        <Button size="sm" disabled={reviewing || !panel.status?.initialComplete || !panel.status.allowAi || !query.trim()} onClick={() => void review()}>{reviewing && <Loader2 className="size-3.5 animate-spin" />}{t("workbench.review")}</Button>
      </div>
      <div className="flex min-h-0 flex-1">
        <aside className="w-56 shrink-0 space-y-1 overflow-y-auto border-r border-border bg-muted/20 p-2 sm:w-64" aria-label={t("workbench.knowledge")}>
          <Progress />
          {!panel.status?.enabled && <p className="p-2 text-xs text-muted-foreground">{t("workbench.empty")}</p>}
          {items.map((item) => <button key={item.id} type="button" onClick={() => { panel.select(item.id); setBrief(null); }} className={`block w-full rounded-md px-3 py-2 text-left text-sm ${item.id === panel.selectedId ? "bg-accent text-accent-foreground" : "hover:bg-accent/60"}`}>
            <span className="line-clamp-2">{item.title}</span>{"status" in item && item.status === "awaiting_transcription" && <span className="text-xs text-muted-foreground">{t("workbench.waiting")}</span>}
          </button>)}
          {query && !items.length && <p className="p-2 text-xs text-muted-foreground">{t("workbench.no_results")}</p>}
        </aside>
        <div className="min-w-0 flex-1 overflow-y-auto p-5">
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
          {reviewing ? <p role="status" className="text-sm text-muted-foreground">{t("workbench.reviewing")}</p> : brief ? <section className="space-y-4">
            {brief.insufficientEvidence && <p className="text-sm text-muted-foreground">{t("workbench.insufficient")}</p>}
            <Markdown mode="full">{brief.summary}</Markdown>
            {brief.memoryItems.map((item, index) => <div key={item.id || index} className="space-y-1 rounded-md border border-border p-3"><p className="text-xs text-muted-foreground">{t(`workbench.${item.kind}`)}</p><p className="text-sm">{item.text}</p><SourceButtons sources={item.citations} /></div>)}
            <SourceButtons sources={brief.citations} />
          </section> : panel.selectedId ? <MeetingReader key={`${panel.status?.scope}:${panel.selectedId}`} id={panel.selectedId} /> : <section className="space-y-3">
            <WikiTopics />
            <h2 className="text-sm font-medium">{t("workbench.memories")}</h2>
            {!panel.status?.initialComplete && <p className="text-sm text-muted-foreground">{t("workbench.sync_first")}</p>}
            {panel.status?.memories.filter((item) => !item.excluded).slice().reverse().map((item) => <MemoryCard key={item.id} item={item} />)}
          </section>}
        </div>
      </div>
    </DialogContent>
  </Dialog>;
}

function QuotedText({ text, quote }: { text: string; quote?: string }) {
  const index = quote ? text.indexOf(quote) : -1;
  if (index < 0 || !quote) return <>{text}</>;
  return <>{text.slice(0, index)}<mark data-source-match="true" className="rounded bg-accent text-accent-foreground">{quote}</mark>{text.slice(index + quote.length)}</>;
}

function SourceButtons({ sources }: { sources: SourceRef[] }) {
  const { t } = useTranslation();
  return <div className="flex flex-wrap gap-1">{sources.map((source, index) => <Button key={`${source.id}:${index}`} size="sm" variant="ghost" title={source.quote} onClick={() => useWorkbench.getState().showSource(source)}>{t("workbench.source")}{source.startMs != null ? ` · ${Math.floor(source.startMs / 1000)}s` : ""}</Button>)}</div>;
}
