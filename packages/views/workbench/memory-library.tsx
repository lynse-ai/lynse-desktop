"use client";

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "@lynse/core/i18n/react";
import { Button } from "@lynse/ui/components/ui/button";
import { Input } from "@lynse/ui/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@lynse/ui/components/ui/dialog";
import { Markdown } from "@lynse/ui/markdown";
import { FileText, Plus, RefreshCw } from "../icons";
import { getWorkbenchApi, refreshWorkbench, useWorkbench } from "./api";
import { SourceButtons } from "./components";
import { useMemoryDrafts } from "./memory-drafts";
import type { MemoryDocument } from "./types";

function errorCopy(error: unknown, t: (key: string) => string): string {
  const message = String(error);
  const key = message.includes("Memory file changed") ? "memory_file_conflict"
    : message.includes("authorization") || message.includes("identity") ? "memory_cloud_auth"
    : message.includes("offline") || message.includes("endpoint") ? "memory_cloud_unavailable"
    : message.includes("rejected") ? "memory_cloud_rejected"
    : message.includes("8000") ? "memory_cloud_length" : "memory_file_error";
  return t(`workbench.${key}`);
}

function MemoryFileEditor({ document, scope, reload, select }: { document: MemoryDocument; scope: string; reload(): void; select(path: string): void }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const key = `${scope}/${document.path}`;
  const draft = useMemoryDrafts((state) => state.drafts[key]);
  const dirty = !!draft && draft.markdown !== draft.original;
  const markdown = dirty ? draft.markdown : document.markdown;
  const [mode, setMode] = useState<"read" | "edit">("read");
  const [discard, setDiscard] = useState(false);
  const [saved, setSaved] = useState(false);
  const save = useMutation({
    mutationFn: () => getWorkbenchApi()!.saveMemoryFile(scope, document.path, markdown, dirty ? draft.revision : document.revision),
    onSuccess: (result) => {
      useMemoryDrafts.getState().remove(key);
      queryClient.setQueryData(["memory-file", scope, document.path], result);
      void queryClient.invalidateQueries({ queryKey: ["memory-files", scope] });
      void refreshWorkbench();
      setSaved(true);
      setMode("read");
      select(result.path);
    },
  });
  const reloadSaved = useMutation({ mutationFn: () => getWorkbenchApi()!.reloadMemoryFile(scope, document.path), onSuccess: (result) => {
    queryClient.setQueryData(["memory-file", scope, document.path], result);
    discardDraft();
  } });
  function discardDraft() {
    useMemoryDrafts.getState().remove(key);
    save.reset(); setDiscard(false); setMode("read"); reload();
  }
  function followLink(path: string) {
    if (/^(?:MEMORY\.md|memory_summary\.md|(?:notes|entries)\/[a-zA-Z0-9_-]+\.md)$/.test(path)) select(path);
    else if (/^https?:\/\//.test(path)) window.open(path, "_blank", "noopener,noreferrer");
  }
  return <article className="min-w-0 space-y-4" aria-label={t("workbench.memory_document")}>
    <header className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0 space-y-1"><h3 className="break-words text-base font-semibold">{document.title}</h3><p className="break-all font-mono text-xs text-muted-foreground">{document.path}</p></div>
      <div className="flex flex-wrap items-center gap-2">
        {document.editable && <Button size="sm" variant="outline" onClick={() => setMode(mode === "read" ? "edit" : "read")}>{t(mode === "read" ? "workbench.memory_edit_document" : "workbench.memory_preview")}</Button>}
        {document.editable && dirty && <Button size="sm" disabled={save.isPending} onClick={() => save.mutate()}>{t(save.isPending ? "workbench.memory_saving" : "workbench.memory_save_document")}</Button>}
        {dirty && <Button size="sm" variant="ghost" disabled={save.isPending} onClick={() => setDiscard(true)}>{t("workbench.memory_discard")}</Button>}
      </div>
    </header>
    <p className="text-xs text-muted-foreground">{t(!document.editable ? "workbench.memory_snapshot_hint" : document.kind === "entry" ? "workbench.memory_entry_hint" : "workbench.memory_note_hint")}</p>
    {dirty && <p role="status" className="text-xs text-muted-foreground">{t("workbench.memory_unsaved")}</p>}
    {!dirty && (saved || document.syncState) && <p role="status" className="text-xs text-muted-foreground">{t(document.syncState === "pending" ? "workbench.memory_pending_cloud" : document.syncState === "offline" ? "workbench.memory_offline" : document.syncState === "template" ? "workbench.memory_template" : document.syncState === "conflict" ? "workbench.memory_cloud_conflict" : "workbench.memory_saved")}</p>}
    {document.memoryStatus && <p className="text-xs text-muted-foreground">{t(`workbench.memory_status_${document.memoryStatus}`, { defaultValue: document.memoryStatus })}</p>}
    {(save.error || reloadSaved.error || document.syncState === "conflict" || (dirty && draft.revision !== document.revision)) && <div role="alert" className="space-y-2 rounded-md border border-border bg-muted/30 p-3 text-sm"><p>{errorCopy(save.error ?? reloadSaved.error ?? document.syncError ?? "Memory file changed", t)}</p><Button size="sm" variant="outline" onClick={() => setDiscard(true)}>{t("workbench.memory_reload_document")}</Button></div>}
    {mode === "edit" && document.editable ? <label className="block space-y-2"><span className="text-xs font-medium">{t("workbench.memory_markdown")}</span><textarea aria-label={t("workbench.memory_markdown")} value={markdown} disabled={save.isPending} maxLength={8000} onChange={(event) => {
      useMemoryDrafts.getState().set(key, { markdown: event.target.value, original: dirty ? draft.original : document.markdown, revision: dirty ? draft.revision : document.revision });
      setSaved(false); save.reset();
    }} onKeyDown={(event) => { if ((event.metaKey || event.ctrlKey) && event.key === "s") { event.preventDefault(); if (dirty && !save.isPending) save.mutate(); } }} className="min-h-80 w-full resize-y rounded-lg border border-input bg-background p-4 font-mono text-sm leading-relaxed outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/50" /></label> : <div className="min-h-60 overflow-x-auto rounded-lg border border-border p-4"><Markdown mode="full" onUrlClick={followLink} onFileClick={followLink}>{markdown || t("workbench.memory_blank_document")}</Markdown></div>}
    <SourceButtons sources={document.citations} />
    <Dialog open={discard} onOpenChange={setDiscard}><DialogContent className="max-w-sm"><DialogHeader><DialogTitle>{t("workbench.memory_discard_title")}</DialogTitle><DialogDescription>{t("workbench.memory_discard_hint")}</DialogDescription></DialogHeader><div className="flex justify-end gap-2"><Button variant="ghost" onClick={() => setDiscard(false)}>{t("workbench.cancel")}</Button><Button disabled={reloadSaved.isPending} onClick={() => reloadSaved.mutate()}>{t("workbench.memory_reload_document")}</Button></div></DialogContent></Dialog>
  </article>;
}

export function MemoryLibrary() {
  const { t } = useTranslation();
  const status = useWorkbench((state) => state.status);
  const scope = status?.scope ?? "";
  const bridge = getWorkbenchApi();
  const queryClient = useQueryClient();
  const [path, setPath] = useState("MEMORY.md");
  const [query, setQuery] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [title, setTitle] = useState("");
  const drafts = useMemoryDrafts((state) => state.drafts);
  const files = useQuery({ queryKey: ["memory-files", scope], queryFn: async () => { const result = await bridge!.memoryFiles(scope); void queryClient.invalidateQueries({ queryKey: ["memory-file", scope] }); return result; }, enabled: !!bridge && !!scope, networkMode: "always" });
  const document = useQuery({ queryKey: ["memory-file", scope, path], queryFn: () => bridge!.readMemoryFile(scope, path), enabled: !!bridge && !!scope, networkMode: "always" });
  const create = useMutation({
    mutationFn: () => bridge!.createMemoryFile(scope, title),
    onSuccess: (result) => {
      queryClient.setQueryData(["memory-file", scope, result.path], result);
      void queryClient.invalidateQueries({ queryKey: ["memory-files", scope] });
      setPath(result.path); setCreateOpen(false); setTitle("");
    },
  });
  const filtered = files.data?.filter((file) => `${file.path} ${file.title}`.toLowerCase().includes(query.trim().toLowerCase())) ?? [];
  useEffect(() => {
    const resume = () => {
      if (window.document.visibilityState !== "hidden") {
        void queryClient.invalidateQueries({ queryKey: ["memory-files", scope] });
      }
    };
    window.addEventListener("online", resume);
    window.addEventListener("focus", resume);
    return () => { window.removeEventListener("online", resume); window.removeEventListener("focus", resume); };
  }, [queryClient, scope]);
  function reload() { void files.refetch(); void document.refetch(); void refreshWorkbench(); }
  return <section className="space-y-4" aria-label={t("workbench.memory_library")}>
    <div className="flex flex-wrap items-start justify-between gap-3"><div className="space-y-1"><h2 className="text-sm font-semibold">{t("workbench.memory_library")}</h2><p className="max-w-2xl text-xs leading-relaxed text-muted-foreground">{t("workbench.memory_library_hint")}</p></div><div className="flex gap-2"><Button size="sm" variant="outline" disabled={!scope || files.isFetching || document.isFetching} onClick={reload}><RefreshCw aria-hidden="true" className="size-3.5" />{t("workbench.memory_refresh_files")}</Button><Button size="sm" disabled={!scope || !files.data} onClick={() => setCreateOpen(true)}><Plus aria-hidden="true" className="size-3.5" />{t("workbench.memory_create_document")}</Button></div></div>
    <Input value={query} onChange={(event) => setQuery(event.target.value)} aria-label={t("workbench.memory_file_search")} placeholder={t("workbench.memory_file_search")} />
    <div className="space-y-3">
        {files.error && <div role="alert" className="space-y-2"><p>{errorCopy(files.error, t)}</p><Button variant="outline" size="sm" onClick={reload}>{t("workbench.retry")}</Button></div>}
        <div className="@container"><div className="flex min-w-0 flex-col gap-4 @min-[50rem]:flex-row">
          <nav aria-label={t("workbench.memory_files")} className="max-h-64 space-y-1 overflow-y-auto rounded-lg border border-border p-2 @min-[50rem]:max-h-[65dvh] @min-[50rem]:w-60 @min-[50rem]:shrink-0">
            {files.isPending && <p role="status" className="p-2 text-xs text-muted-foreground">{t("workbench.memory_loading")}</p>}
            {filtered.map((file) => <button key={file.path} type="button" aria-current={path === file.path ? "page" : undefined} onClick={() => setPath(file.path)} className={`flex w-full items-start gap-2 rounded-md px-2 py-2.5 text-start text-sm outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring ${path === file.path ? "bg-muted font-medium" : ""}`}><FileText aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-muted-foreground" /><span className="min-w-0"><span className="line-clamp-2 break-words">{file.title}</span><span className="mt-1 block break-all font-mono text-[11px] text-muted-foreground">{file.path}</span>{drafts[`${scope}/${file.path}`] && drafts[`${scope}/${file.path}`]!.markdown !== drafts[`${scope}/${file.path}`]!.original && <span className="block text-xs text-muted-foreground">{t("workbench.memory_unsaved")}</span>}</span></button>)}
            {!files.isPending && !files.error && !filtered.length && <p className="p-2 text-xs text-muted-foreground">{t("workbench.memory_no_files")}</p>}
          </nav>
          <div className="min-w-0 flex-1 rounded-lg border border-border p-4">
            {document.isPending && <p role="status" className="text-sm text-muted-foreground">{t("workbench.memory_loading")}</p>}
            {document.error && <div role="alert" className="space-y-2"><p>{errorCopy(document.error, t)}</p><Button size="sm" variant="outline" onClick={reload}>{t("workbench.retry")}</Button></div>}
            {document.data && <MemoryFileEditor key={`${scope}/${path}`} document={document.data} scope={scope} reload={reload} select={setPath} />}
          </div>
        </div></div>
    </div>
    <Dialog open={createOpen} onOpenChange={setCreateOpen}><DialogContent className="max-w-md"><DialogHeader><DialogTitle>{t("workbench.memory_create_document")}</DialogTitle><DialogDescription>{t("workbench.memory_create_hint")}</DialogDescription></DialogHeader><form className="space-y-4" onSubmit={(event) => { event.preventDefault(); create.mutate(); }}><label className="block space-y-2 text-sm"><span>{t("workbench.memory_document_title")}</span><Input value={title} onChange={(event) => setTitle(event.target.value)} maxLength={120} autoFocus /></label>{create.error && <p role="alert" className="text-sm text-destructive">{errorCopy(create.error, t)}</p>}<div className="flex justify-end gap-2"><Button type="button" variant="ghost" onClick={() => setCreateOpen(false)}>{t("workbench.cancel")}</Button><Button type="submit" disabled={!title.trim() || create.isPending}>{t("workbench.memory_create_document")}</Button></div></form></DialogContent></Dialog>
  </section>;
}
