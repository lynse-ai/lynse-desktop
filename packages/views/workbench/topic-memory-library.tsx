"use client";

import { useCallback, useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError } from "@lynse/core/api";
import { memoryApi, memoryOperationId, type MemoryFileDocument, type MemoryFileMember, type MemoryPreview, type ForgetPreview, type ForgetStatus } from "@lynse/core/api/memory";
import { useTranslation } from "@lynse/core/i18n/react";
import { Button } from "@lynse/ui/components/ui/button";
import { Input } from "@lynse/ui/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@lynse/ui/components/ui/dialog";
import { Markdown } from "@lynse/ui/markdown";
import { FileText, FolderOpen, MoreHorizontal, Plus, RefreshCw, Search } from "../icons";
import { getWorkbenchApi, useWorkbench } from "./api";
import { useMemoryDrafts } from "./memory-drafts";

type FileAction = "create" | "rename" | "move" | "merge" | "split";
type Review = { preview: MemoryPreview | ForgetPreview; contents: MemoryFileMember[] };

function errorKey(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  if (text.includes("english_title_required") || text.includes("English file title")) return "file_english_title";
  if (text.includes("file_structure_changed") || text.includes("section separators") || text.includes("deletion preview")) return "file_structure";
  if (text.includes("file_too_large") || text.includes("Move files into a folder")) return "file_too_large";
  return error instanceof ApiError && error.status === 409 ? "changed" : "failed";
}

function Sources({ members }: { members: MemoryFileMember[] }) {
  const { t } = useTranslation();
  const edges = members.flatMap(member => member.sources ?? []);
  const unique = edges.filter((edge, index) => edges.findIndex(other => other.parent_id === edge.parent_id && other.parent_revision === edge.parent_revision && other.excerpt === edge.excerpt) === index);
  if (!unique.length) return null;
  return <details className="text-sm"><summary className="cursor-pointer text-muted-foreground">{t("memory_manager.file_sources")} · {unique.length}</summary><div className="mt-3 space-y-3">{unique.map((edge, index) => <blockquote key={index} className="space-y-2 border-s-2 border-border ps-3"><p className="whitespace-pre-wrap">{edge.excerpt}</p>{edge.parent_type === "source" && edge.parent_id.startsWith("meeting:") && getWorkbenchApi() && <Button size="sm" variant="ghost" onClick={() => {
    const id = edge.parent_id.slice("meeting:".length).replace(/^desktop:/, "local:");
    useWorkbench.getState().showSource({ id, revision: String(edge.parent_revision), kind: "meeting_summary", quote: edge.excerpt });
  }}>{t("memory_manager.file_source_open")}</Button>}</blockquote>)}</div></details>;
}

export function TopicMemoryLibrary({ account }: { account: string }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [query, setQuery] = useState("");
  const [folder, setFolder] = useState("");
  const [mode, setMode] = useState<"read" | "edit">("read");
  const [failure, setFailure] = useState("");
  const [saved, setSaved] = useState(false);
  const [form, setForm] = useState<{ action: FileAction; base: MemoryFileDocument | null } | null>(null);
  const [name, setName] = useState("");
  const [target, setTarget] = useState("");
  const [sections, setSections] = useState<string[]>([]);
  const [review, setReview] = useState<Review | null>(null);
  const [cleanup, setCleanup] = useState<ForgetStatus | null>(null);
  const [discard, setDiscard] = useState(false);
  const [emptyDelete, setEmptyDelete] = useState<MemoryFileDocument | null>(null);
  const files = useQuery({ queryKey: ["topic-memory-files", account], queryFn: ({ signal }) => memoryApi.files(signal), retry: false });
  const storedPath = useMemoryDrafts(state => state.selectedPaths[account]);
  const path = files.data?.files.some(file => file.path === storedPath) ? storedPath : files.data?.files[0]?.path;
  const doc = useQuery({ queryKey: ["topic-memory-file", account, path], queryFn: ({ signal }) => memoryApi.readFile(path!, signal), enabled: !!path, retry: false });
  const destination = useQuery({ queryKey: ["topic-memory-file", account, target], queryFn: ({ signal }) => memoryApi.readFile(target, signal), enabled: form?.action === "merge" && !!target, retry: false });
  const key = `${account}/${path ?? ""}`;
  const draft = useMemoryDrafts(state => state.drafts[key]);
  const dirty = !!draft && draft.markdown !== draft.original;
  const markdown = dirty ? draft.markdown : doc.data?.markdown ?? "";
  const refresh = useCallback(() => {
    void qc.invalidateQueries({ queryKey: ["topic-memory-files", account] });
    void qc.invalidateQueries({ queryKey: ["topic-memory-file", account] });
  }, [account, qc]);
  const action = useMutation({ mutationFn: (operation: () => Promise<unknown>) => operation(), onSuccess: () => { setFailure(""); refresh(); }, onError: error => setFailure(t(`memory_manager.${errorKey(error)}`)) });
  const busy = action.isPending;
  useEffect(() => { setMode("read"); setSaved(false); setFailure(""); }, [path]);
  useEffect(() => {
    const resume = () => { if (document.visibilityState !== "hidden") refresh(); };
    window.addEventListener("online", resume);
    window.addEventListener("focus", resume);
    return () => { window.removeEventListener("online", resume); window.removeEventListener("focus", resume); };
  }, [refresh]);
  useEffect(() => {
    if (!cleanup || cleanup.cloud_cleanup_complete) return;
    const controller = new AbortController();
    const timer = setInterval(() => { void memoryApi.forgetStatus(cleanup.plan_id, controller.signal).then(setCleanup).catch(() => undefined); }, 3000);
    return () => { clearInterval(timer); controller.abort(); };
  }, [cleanup]);
  function select(next: string) { useMemoryDrafts.getState().select(account, next); }
  function openForm(operation: FileAction) {
    setForm({ action: operation, base: doc.data ?? null });
    setName(operation === "rename" ? doc.data?.title ?? "" : operation === "move" ? doc.data?.folder ?? "" : "");
    setTarget(""); setSections([]); setFailure("");
  }
  function save() {
    if (!doc.data || !dirty) return;
    const body = { path: doc.data.path, revision: draft.revision, markdown: draft.markdown };
    const operation = memoryOperationId();
    action.mutate(async () => {
      const result = await memoryApi.saveFile(body, operation);
      useMemoryDrafts.getState().remove(key);
      qc.setQueryData(["topic-memory-file", account, result.path], result);
      setMode("read"); setSaved(true);
    });
  }
  function preview(ids: string[], forget: boolean) {
    const operation = memoryOperationId();
    const contents = [...doc.data?.members ?? [], ...doc.data?.pendingUpdates ?? []];
    action.mutate(async () => {
      const frozen = forget ? await memoryApi.previewForget(ids, operation) : await memoryApi.previewConfirmation(ids, operation);
      setReview({ preview: frozen, contents });
    });
  }
  function submitForm() {
    if (!form) return;
    const operation = memoryOperationId();
    const frozen = form;
    const targetDocument = destination.data;
    action.mutate(async () => {
      let result: MemoryFileDocument;
      if (frozen.action === "create") result = await memoryApi.createFile(name, operation);
      else {
        if (!frozen.base) return;
        const base = { path: frozen.base.path, revision: frozen.base.revision };
        if (frozen.action === "rename") result = await memoryApi.organizeFile({ ...base, action: "rename", title: name }, operation);
        else if (frozen.action === "move") result = await memoryApi.organizeFile({ ...base, action: "move", folder: name }, operation);
        else if (frozen.action === "split") result = await memoryApi.organizeFile({ ...base, action: "split", title: name, record_ids: sections }, operation);
        else {
          if (!targetDocument) return;
          result = await memoryApi.organizeFile({ ...base, action: "merge", target_path: targetDocument.path, target_revision: targetDocument.revision }, operation);
        }
      }
      qc.setQueryData(["topic-memory-file", account, result.path], result);
      select(result.path); setForm(null);
    });
  }
  const filtered = files.data?.files.filter(file => (!folder || file.folder === folder) && `${file.title} ${file.folder ?? ""} ${file.aliases?.join(" ") ?? ""} ${file.searchText ?? ""}`.toLowerCase().includes(query.trim().toLowerCase())) ?? [];
  const folders = [...new Set(files.data?.files.map(file => file.folder).filter((value): value is string => !!value))].sort();
  const pending = doc.data?.pendingUpdates ?? [];
  return <section className="flex min-h-0 flex-1 flex-col gap-4" aria-label={t("memory_manager.files")}>
    <div className="flex flex-wrap items-center gap-3">
      <div className="relative min-w-48 flex-1"><Search className="pointer-events-none absolute start-3 top-2.5 size-4 text-muted-foreground" aria-hidden="true" /><Input className="ps-9" aria-label={t("memory_manager.file_search")} placeholder={t("memory_manager.file_search")} value={query} onChange={event => setQuery(event.target.value)} /></div>
      {!!folders.length && <select aria-label={t("memory_manager.file_move")} value={folder} onChange={event => setFolder(event.target.value)} className="h-9 max-w-48 rounded-md border border-input bg-background px-2 text-sm"><option value="">{t("memory_manager.file_all_folders")}</option>{folders.map(value => <option key={value}>{value}</option>)}</select>}
      <Button variant="ghost" size="sm" aria-label={t("memory_manager.refresh")} disabled={busy || files.isFetching} onClick={refresh}><RefreshCw className="size-4" aria-hidden="true" /></Button>
      <Button size="sm" onClick={() => openForm("create")}><Plus className="size-4" aria-hidden="true" />{t("memory_manager.file_new")}</Button>
    </div>
    {failure && <p role="alert" className="text-sm text-destructive">{failure}</p>}
    {cleanup && <p role="status" className="text-sm text-muted-foreground">{t(cleanup.cloud_cleanup_complete ? "memory_manager.forgotten" : "memory_manager.cleaning")}</p>}
    {files.error && <p role="alert">{t("memory_manager.failed")}</p>}
    {files.isPending && <p role="status">{t("memory_manager.loading")}</p>}
    {!files.isPending && !files.error && !files.data?.files.length ? <div className="space-y-3 rounded-xl border border-dashed border-border px-6 py-16 text-center"><FileText className="mx-auto size-8 text-muted-foreground" aria-hidden="true" /><h2 className="font-medium">{t("memory_manager.file_empty")}</h2><p className="mx-auto max-w-md text-sm text-muted-foreground">{t("memory_manager.file_empty_hint")}</p></div> : !!files.data?.files.length && <div className="@container min-h-0 flex-1"><div className="flex min-h-0 flex-col gap-5 @min-[48rem]:h-full @min-[48rem]:flex-row">
      <nav className="max-h-64 space-y-1 overflow-y-auto @min-[48rem]:max-h-none @min-[48rem]:w-64 @min-[48rem]:shrink-0" aria-label={t("memory_manager.files")}>
        <p className="px-3 pb-2 text-xs text-muted-foreground">{t("memory_manager.file_count", { count: filtered.length })}</p>
        {filtered.map(file => <button type="button" key={file.path} aria-current={file.path === path ? "page" : undefined} onClick={() => select(file.path)} className={`flex w-full gap-3 rounded-lg px-3 py-3 text-start outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring ${file.path === path ? "bg-muted" : ""}`}><FileText aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-muted-foreground" /><span className="min-w-0 space-y-1"><span className="block break-words text-sm font-medium">{file.title.replace(/\.md$/i, "")}.md</span>{file.folder && <span className="flex items-center gap-1 text-xs text-muted-foreground"><FolderOpen className="size-3" aria-hidden="true" />{file.folder}</span>}{!!file.pendingCount && <span className="block text-xs text-muted-foreground">{t("memory_manager.file_pending", { count: file.pendingCount })}</span>}{file.updatedAt && <time dateTime={file.updatedAt} className="block text-xs text-muted-foreground">{new Date(file.updatedAt).toLocaleDateString()}</time>}</span></button>)}
        {!filtered.length && <p className="p-3 text-sm text-muted-foreground">{t("memory_manager.file_no_match")}</p>}
      </nav>
      <div className="min-h-0 min-w-0 flex-1 space-y-5 rounded-xl border border-border bg-background p-5 @min-[48rem]:overflow-y-auto">
        {doc.isPending && path && <p role="status">{t("memory_manager.loading")}</p>}
        {doc.error && <p role="alert">{t("memory_manager.failed")}</p>}
        {doc.data && <>
          <div className="flex flex-wrap items-center justify-between gap-2"><p className="min-w-0 break-words text-sm font-medium">{doc.data.title.replace(/\.md$/i, "")}.md</p><div className="flex flex-wrap gap-2">
            {doc.data.editable && <Button variant="ghost" size="sm" disabled={busy} onClick={() => setMode(mode === "read" ? "edit" : "read")}>{t(mode === "read" ? "memory_manager.file_edit" : "memory_manager.file_preview")}</Button>}
            {dirty && <Button size="sm" disabled={busy} onClick={save}>{t("memory_manager.file_save")}</Button>}
            <details className="relative"><summary aria-label={t("memory_manager.file_actions")} className="flex size-8 cursor-pointer list-none items-center justify-center rounded-md hover:bg-muted"><MoreHorizontal className="size-4" aria-hidden="true" /></summary><div className="absolute end-0 z-10 mt-1 min-w-44 rounded-lg border border-border bg-popover p-1 shadow-md">{(["rename", "move", "merge", "split"] as const).map(value => <Button key={value} size="sm" variant="ghost" className="w-full justify-start" disabled={busy || dirty || value === "split" && (doc.data?.recordIds.length ?? 0) < 2 || value === "merge" && (files.data?.files.length ?? 0) < 2} onClick={event => { event.currentTarget.closest("details")?.removeAttribute("open"); openForm(value); }}>{t(`memory_manager.file_${value}`)}</Button>)}<Button size="sm" variant="ghost" className="w-full justify-start text-destructive" disabled={busy || dirty} onClick={event => { event.currentTarget.closest("details")?.removeAttribute("open"); if (doc.data?.recordIds.length) preview(doc.data.recordIds, true); else setEmptyDelete(doc.data ?? null); }}>{t("memory_manager.file_delete")}</Button></div></details>
          </div></div>
          {dirty ? <p role="status" className="text-xs text-muted-foreground">{t("memory_manager.file_unsaved")} <button type="button" className="underline" onClick={() => setDiscard(true)}>{t("memory_manager.file_reload")}</button></p> : saved && <p role="status" className="text-xs text-muted-foreground">{t("memory_manager.file_saved")}</p>}
          {mode === "edit" && doc.data.editable ? <textarea aria-label={t("memory_manager.content")} value={markdown} maxLength={8000} disabled={busy} className="min-h-80 w-full resize-y rounded-lg border border-input bg-background p-4 font-mono text-sm leading-relaxed outline-none focus-visible:ring-2 focus-visible:ring-ring" onChange={event => { useMemoryDrafts.getState().set(key, { markdown: event.target.value, original: dirty ? draft.original : doc.data!.markdown, revision: dirty ? draft.revision : doc.data!.revision }); setSaved(false); }} onKeyDown={event => { if ((event.metaKey || event.ctrlKey) && event.key === "s") { event.preventDefault(); if (!busy) save(); } }} /> : <div className="min-h-32 overflow-x-auto"><Markdown mode="full">{markdown}</Markdown></div>}
          <Sources members={doc.data.members ?? []} />
          {!!pending.length && <section aria-label={t("memory_manager.file_review")} className="space-y-4 border-t border-border pt-5"><div className="flex flex-wrap items-center justify-between gap-2"><h2 className="text-sm font-medium">{t("memory_manager.file_pending", { count: pending.length })}</h2><Button size="sm" disabled={busy || dirty} onClick={() => preview(pending.map(item => item.id), false)}>{t("memory_manager.file_confirm_updates")}</Button></div><p className="text-sm text-muted-foreground">{t("memory_manager.file_pending_hint")}</p>{pending.map(item => <article key={item.id} className="space-y-3 rounded-lg bg-muted/40 p-4"><Markdown mode="full">{item.content}</Markdown><Sources members={[item]} /><Button size="sm" variant="ghost" disabled={busy} onClick={() => { const operation = memoryOperationId(); action.mutate(() => memoryApi.action({ action: "reject", record_id: item.id, expected_revision: item.revision }, operation)); }}>{t("memory_manager.file_discard_update")}</Button></article>)}</section>}
          <p className="text-xs text-muted-foreground">{t("memory_manager.file_language_hint")}</p>
        </>}
      </div>
    </div></div>}
    <Dialog open={!!form} onOpenChange={open => { if (!open && !busy) setForm(null); }}><DialogContent className="max-w-xl"><DialogHeader><DialogTitle>{t(`memory_manager.file_${form?.action === "create" ? "new" : form?.action ?? "new"}`)}</DialogTitle><DialogDescription>{t(form?.action === "split" ? "memory_manager.file_split_hint" : "memory_manager.file_organize_hint")}</DialogDescription></DialogHeader><form className="space-y-4" onSubmit={event => { event.preventDefault(); submitForm(); }}>
      {form?.action === "merge" ? <><label className="block space-y-2 text-sm"><span>{t("memory_manager.file_target")}</span><select className="w-full rounded-md border border-input bg-background p-2" value={target} onChange={event => setTarget(event.target.value)} required><option value="">—</option>{files.data?.files.filter(file => file.path !== form.base?.path).map(file => <option key={file.path} value={file.path}>{file.title}.md</option>)}</select></label>{destination.data && <div className="max-h-52 space-y-3 overflow-y-auto rounded-lg border border-border p-3 text-sm"><p>{t("memory_manager.file_merge_preview")}</p><Markdown mode="full">{destination.data.markdown}</Markdown></div>}{destination.error && <p role="alert">{t("memory_manager.failed")}</p>}</> : <label className="block space-y-2 text-sm"><span>{t(form?.action === "move" ? "memory_manager.file_folder" : "memory_manager.file_title")}</span><Input value={name} onChange={event => setName(event.target.value)} maxLength={120} autoFocus /></label>}
      {form?.action === "split" && <div className="max-h-56 space-y-3 overflow-y-auto">{[...form.base?.members ?? [], ...form.base?.pendingUpdates ?? []].map(member => <label key={member.id} className="flex gap-3 rounded-lg border border-border p-3 text-sm"><input type="checkbox" checked={sections.includes(member.id)} onChange={event => setSections(current => event.target.checked ? [...current, member.id] : current.filter(id => id !== member.id))} /><span className="whitespace-pre-wrap">{member.content}</span></label>)}</div>}
      {failure && <p role="alert" className="text-sm text-destructive">{failure}</p>}<div className="flex justify-end gap-2"><Button type="button" variant="ghost" disabled={busy} onClick={() => setForm(null)}>{t("memory_manager.cancel")}</Button><Button type="submit" disabled={busy || (form?.action !== "move" && form?.action !== "merge" && !name.trim()) || (form?.action === "merge" && (!destination.data || destination.isFetching)) || (form?.action === "split" && (!sections.length || sections.length >= (form.base?.recordIds.length ?? 0)))}>{t("memory_manager.file_save")}</Button></div>
    </form></DialogContent></Dialog>
    <Dialog open={!!review} onOpenChange={open => { if (!open && !busy) setReview(null); }}><DialogContent><DialogHeader><DialogTitle>{t(review && "plan_id" in review.preview ? "memory_manager.file_delete_title" : "memory_manager.file_confirm_updates")}</DialogTitle><DialogDescription>{t(review && "plan_id" in review.preview ? "memory_manager.forget_hint" : "memory_manager.confirm_hint", { count: review?.preview.items.length ?? 0 })}</DialogDescription></DialogHeader>{review && "plan_id" in review.preview && !!review.preview.affected_file_paths?.length && <p className="text-sm">{t("memory_manager.file_affected_files", { files: review.preview.affected_file_paths.map(path => { const file = files.data?.files.find(item => item.path === path); return file ? `${file.title}.md` : t("memory_manager.related_memory"); }).join(" · ") })}</p>}<ul className="max-h-64 space-y-3 overflow-y-auto text-sm">{review?.preview.items.map(item => <li key={item.id}>{review.contents.find(member => member.id === item.id && member.revision === item.revision)?.content ?? t("memory_manager.related_memory")}</li>)}</ul><div className="flex justify-end gap-2"><Button variant="ghost" disabled={busy} onClick={() => setReview(null)}>{t("memory_manager.cancel")}</Button><Button disabled={busy} onClick={() => {
      if (!review) return;
      const frozen = review.preview;
      const operation = memoryOperationId();
      action.mutate(async () => { if ("plan_id" in frozen) { setCleanup(await memoryApi.forget(frozen, operation)); useMemoryDrafts.getState().remove(key); } else await memoryApi.confirm(frozen.preview_id, operation); setReview(null); });
    }}>{t(review && "plan_id" in review.preview ? "memory_manager.file_delete" : "memory_manager.confirm")}</Button></div></DialogContent></Dialog>
    <Dialog open={discard} onOpenChange={setDiscard}><DialogContent><DialogHeader><DialogTitle>{t("memory_manager.file_discard_title")}</DialogTitle><DialogDescription>{t("memory_manager.file_discard_hint")}</DialogDescription></DialogHeader><div className="flex justify-end gap-2"><Button variant="ghost" onClick={() => setDiscard(false)}>{t("memory_manager.cancel")}</Button><Button onClick={() => { useMemoryDrafts.getState().remove(key); setDiscard(false); setMode("read"); refresh(); }}>{t("memory_manager.file_reload")}</Button></div></DialogContent></Dialog>
    <Dialog open={!!emptyDelete} onOpenChange={open => { if (!open) setEmptyDelete(null); }}><DialogContent><DialogHeader><DialogTitle>{t("memory_manager.file_delete_title")}</DialogTitle><DialogDescription>{t("memory_manager.file_delete_empty")}</DialogDescription></DialogHeader><div className="flex justify-end gap-2"><Button variant="ghost" onClick={() => setEmptyDelete(null)}>{t("memory_manager.cancel")}</Button><Button disabled={busy} onClick={() => { if (!emptyDelete) return; const frozen = emptyDelete; const operation = memoryOperationId(); action.mutate(async () => { await memoryApi.removeEmptyFile(frozen.path, frozen.revision, operation); setEmptyDelete(null); }); }}>{t("memory_manager.file_delete")}</Button></div></DialogContent></Dialog>
  </section>;
}
