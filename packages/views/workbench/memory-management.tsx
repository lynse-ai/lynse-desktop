"use client";

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "@lynse/core/api";
import { useAuthStore } from "@lynse/core/auth";
import { memoryApi, memoryOperationId, type ForgetPreview, type ForgetStatus, type MemoryPreview, type MemoryRecord } from "@lynse/core/api/memory";
import { useTranslation } from "@lynse/core/i18n/react";
import { Button } from "@lynse/ui/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@lynse/ui/components/ui/dialog";
import { Markdown } from "@lynse/ui/markdown";
import { ArrowLeft, Brain, Plus, RefreshCw } from "../icons";
import { useNavigation } from "../navigation";
import { MemoryProjections } from "./memory-projections";
import { MemoryLibrary } from "./memory-library";
import { getWorkbenchApi, useWorkbench } from "./api";

function message(error: unknown, t: (key: string) => string): string {
  return t(error instanceof ApiError && error.status === 409 ? "memory_manager.changed"
    : error instanceof ApiError && [404, 405, 503].includes(error.status) ? "memory_manager.unavailable"
    : "memory_manager.failed");
}

function MemoryManagementContent() {
  const { t } = useTranslation();
  const navigation = useNavigation();
  const user = useAuthStore(state => state.user);
  const authenticated = useAuthStore(state => state.isAuthenticated);
  const account = `${api().getBaseUrl()}|${user?.id ?? ""}`;
  const qc = useQueryClient();
  const nativeUser = useWorkbench(state => state.status?.userId);
  const [filter, setFilter] = useState(navigation.searchParams.get("view") === "files" ? "files" : "confirmed");
  const [offset, setOffset] = useState(0);
  const [selection, setSelection] = useState<string[]>([]);
  const [explanation, setExplanation] = useState<MemoryRecord | null>(null);
  const [editing, setEditing] = useState<MemoryRecord | "new" | null>(null);
  const [text, setText] = useState("");
  const [preview, setPreview] = useState<MemoryPreview | ForgetPreview | null>(null);
  const [cleanup, setCleanup] = useState<ForgetStatus | null>(null);
  const [failure, setFailure] = useState("");
  const capabilities = useQuery({ queryKey: ["memory-capabilities", account], queryFn: ({ signal }) => memoryApi.capabilities(signal), enabled: authenticated, retry: false });
  const available = !!capabilities.data?.available && capabilities.data.features.memory_management;
  const records = useQuery({ queryKey: ["managed-memory", account, filter, offset], queryFn: ({ signal }) => memoryApi.list(filter, offset, signal), enabled: available && !["files", "projections"].includes(filter), retry: false });
  const refresh = () => { setSelection([]); void qc.invalidateQueries({ queryKey: ["managed-memory", account] }); };
  const action = useMutation({
    mutationFn: async (operation: () => Promise<unknown>) => operation(),
    onSuccess: () => { setFailure(""); refresh(); },
    onError: error => setFailure(message(error, t)),
  });
  useEffect(() => { setSelection([]); setExplanation(null); setEditing(null); setText(""); setPreview(null); setCleanup(null); setFailure(""); }, [account]);
  const cleanupPlan = cleanup?.plan_id;
  const cleanupComplete = cleanup?.cloud_cleanup_complete;
  useEffect(() => {
    if (!cleanupPlan || cleanupComplete) return;
    const controller = new AbortController();
    const timer = setInterval(() => { void memoryApi.forgetStatus(cleanupPlan, controller.signal).then(setCleanup).catch(() => undefined); }, 3000);
    return () => { clearInterval(timer); controller.abort(); };
  }, [cleanupPlan, cleanupComplete]);
  function back() { if (navigation.canGoBack) navigation.back(); else navigation.replace("/chat"); }
  function operate(operation: () => Promise<unknown>) { action.mutate(operation); }
  function review(ids: string[], forget: boolean) {
    const operation = memoryOperationId();
    operate(async () => setPreview(forget ? await memoryApi.previewForget(ids, operation) : await memoryApi.previewConfirmation(ids, operation)));
  }
  return <main className="flex min-h-0 min-w-0 flex-1 flex-col" aria-label={t("memory_manager.title")}>
    <header className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-4">
      <h1 className="flex items-center gap-2 text-lg font-semibold"><Brain className="size-5" aria-hidden="true" />{t("memory_manager.title")}</h1>
      <Button variant="ghost" size="sm" onClick={back}><ArrowLeft className="size-4" aria-hidden="true" />{t("memory_manager.back")}</Button>
    </header>
    <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-5">
      <p className="max-w-3xl text-sm text-muted-foreground">{t("memory_manager.hint")}</p>
      {!authenticated && <p role="status">{t("memory_manager.sign_in")}</p>}
      {capabilities.isPending && authenticated && <p role="status">{t("memory_manager.loading")}</p>}
      {(capabilities.error || capabilities.data && !available) && <p role="status">{t("memory_manager.unavailable")}</p>}
      <div className="flex flex-wrap items-center gap-2">
        <nav className="flex flex-wrap gap-1" aria-label={t("memory_manager.filters")}>
          {["confirmed", "candidate", "unavailable", "rejected", "files", ...(capabilities.data?.projections ? ["projections"] : [])].map(value => <Button key={value} size="sm" variant={filter === value ? "secondary" : "ghost"} aria-pressed={filter === value} onClick={() => { setFilter(value); setOffset(0); setSelection([]); }}>{t(`memory_manager.${value === "unavailable" ? "unavailable_filter" : value}`)}</Button>)}
        </nav>
        <Button size="sm" variant="outline" disabled={action.isPending} onClick={() => { refresh(); void capabilities.refetch(); }}><RefreshCw className="size-4" aria-hidden="true" />{t("memory_manager.refresh")}</Button>
        <Button size="sm" disabled={!available} onClick={() => { setEditing("new"); setText(""); }}><Plus className="size-4" aria-hidden="true" />{t("memory_manager.add")}</Button>
      </div>
      {failure && <p role="alert" className="text-sm text-destructive">{failure}</p>}
      {cleanup && <p role="status" className="rounded-lg border border-border p-3 text-sm">{t(cleanup.cloud_cleanup_complete ? "memory_manager.forgotten" : "memory_manager.cleaning")} · {t("memory_manager.device_pending")}</p>}
      {filter === "projections" && available ? <MemoryProjections key={account} account={account} /> : filter === "files" ? available && getWorkbenchApi() && nativeUser === capabilities.data?.user_id ? <MemoryLibrary /> : <p role="status">{t("memory_manager.unavailable")}</p> : <>
        {filter === "candidate" && selection.length > 0 && <Button size="sm" disabled={action.isPending} onClick={() => review(selection, false)}>{t("memory_manager.confirm_selected", { count: selection.length })}</Button>}
        {records.isPending && available && <p role="status">{t("memory_manager.loading")}</p>}
        {records.error && <p role="alert">{message(records.error, t)}</p>}
        {available && !records.isPending && !records.error && !records.data?.records.length && <p className="text-sm text-muted-foreground">{t("memory_manager.empty")}</p>}
        <div className="space-y-3">{records.data?.records.map(row => <article key={row.id} className="space-y-3 rounded-lg border border-border p-4">
          <div className="flex items-start gap-3">{filter === "candidate" && <input type="checkbox" aria-label={t("memory_manager.select")} checked={selection.includes(row.id)} onChange={event => setSelection(current => event.target.checked ? [...current, row.id] : current.filter(id => id !== row.id))} className="mt-1 size-4 shrink-0" />}<div className="min-w-0 flex-1"><Markdown mode="full">{row.content}</Markdown></div></div>
          <p className="text-xs text-muted-foreground">{t(`memory_manager.${row.status}`, { defaultValue: row.status })} · {row.scope_id || t("memory_manager.work_scope")} · {row.memory_type}</p>
          {!row.eligibility.usable && <p className="text-xs text-muted-foreground">{t("memory_manager.not_used")} {row.eligibility.reasons.map(reason => t(`memory_manager.reason_${reason}`, { defaultValue: reason })).join(" · ")}</p>}
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="ghost" disabled={action.isPending} onClick={() => operate(async () => setExplanation(await memoryApi.explain(row.id)))}>{t("memory_manager.explain")}</Button>
            {filter === "candidate" ? <><Button size="sm" disabled={action.isPending} onClick={() => review([row.id], false)}>{t("memory_manager.confirm")}</Button><Button size="sm" variant="outline" disabled={action.isPending} onClick={() => { const id = memoryOperationId(); operate(() => memoryApi.action({ action: "reject", record_id: row.id, expected_revision: row.revision }, id)); }}>{t("memory_manager.reject")}</Button></> : row.eligibility.usable && <Button size="sm" variant="outline" onClick={() => { setEditing(row); setText(row.content); }}>{t("memory_manager.correct")}</Button>}
            <Button size="sm" variant="ghost" disabled={action.isPending} onClick={() => review([row.id], true)}>{t("memory_manager.forget")}</Button>
          </div>
        </article>)}</div>
        {records.data && records.data.total > 50 && <div className="flex items-center gap-3"><Button variant="outline" size="sm" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 50))}>{t("memory_manager.previous")}</Button><span className="text-sm">{offset + 1}–{Math.min(offset + 50, records.data.total)} / {records.data.total}</span><Button variant="outline" size="sm" disabled={offset + 50 >= records.data.total} onClick={() => setOffset(offset + 50)}>{t("memory_manager.next")}</Button></div>}
      </>}
    </div>
    <Dialog open={!!editing} onOpenChange={open => { if (!open) setEditing(null); }}><DialogContent><DialogHeader><DialogTitle>{t(editing === "new" ? "memory_manager.add" : "memory_manager.correct")}</DialogTitle><DialogDescription>{t("memory_manager.manual_hint")}</DialogDescription></DialogHeader><textarea aria-label={t("memory_manager.content")} value={text} maxLength={8000} onChange={event => setText(event.target.value)} className="min-h-48 w-full rounded-md border border-input bg-background p-3 text-sm" /><div className="flex justify-end gap-2"><Button variant="ghost" onClick={() => setEditing(null)}>{t("memory_manager.cancel")}</Button><Button disabled={action.isPending || !text.trim()} onClick={() => { const current = editing; const id = memoryOperationId(); operate(async () => { await memoryApi.action(current && current !== "new" ? { action: "replace", record_id: current.id, expected_revision: current.revision, content: text } : { action: "add", content: text, scene: "work" }, id); setEditing(null); }); }}>{t("memory_manager.save")}</Button></div></DialogContent></Dialog>
    <Dialog open={!!preview} onOpenChange={open => { if (!open) setPreview(null); }}><DialogContent><DialogHeader><DialogTitle>{t(preview && "plan_id" in preview ? "memory_manager.forget_preview" : "memory_manager.confirm_preview")}</DialogTitle><DialogDescription>{t(preview && "plan_id" in preview ? "memory_manager.forget_hint" : "memory_manager.confirm_hint", { count: preview?.items.length ?? 0 })}</DialogDescription></DialogHeader><ul className="max-h-60 space-y-2 overflow-y-auto text-sm">{preview?.items.map(item => <li key={item.id}>{records.data?.records.find(row => row.id === item.id && row.revision === item.revision)?.content ?? t("memory_manager.related_memory")} <span className="text-xs text-muted-foreground">v{item.revision}</span></li>)}</ul><div className="flex justify-end gap-2"><Button variant="ghost" onClick={() => setPreview(null)}>{t("memory_manager.cancel")}</Button><Button disabled={action.isPending} onClick={() => { if (!preview) return; const frozen = preview; const id = memoryOperationId(); operate(async () => { if ("plan_id" in frozen) setCleanup(await memoryApi.forget(frozen, id)); else await memoryApi.confirm(frozen.preview_id, id); setPreview(null); }); }}>{t(preview && "plan_id" in preview ? "memory_manager.forget" : "memory_manager.confirm")}</Button></div></DialogContent></Dialog>
    <Dialog open={!!explanation} onOpenChange={open => { if (!open) setExplanation(null); }}><DialogContent><DialogHeader><DialogTitle>{t("memory_manager.explain")}</DialogTitle><DialogDescription>{explanation?.eligibility.usable ? t("memory_manager.usable") : t("memory_manager.not_used")}</DialogDescription></DialogHeader><p className="text-sm">{explanation?.provenance?.statement_origin || explanation?.provenance?.knowledge?.modality || t("memory_manager.manual_statement")}</p>{explanation?.evidence_dependencies?.map((edge, index) => <blockquote key={`${edge.parent_id}:${index}`} className="space-y-2 border-s-2 border-border ps-3 text-sm"><p>{edge.excerpt}</p><p className="break-all text-xs text-muted-foreground">{edge.parent_id} · v{edge.parent_revision}</p></blockquote>)}</DialogContent></Dialog>
  </main>;
}

export function MemoryManagementPage() {
  const user = useAuthStore(state => state.user);
  return <MemoryManagementContent key={`${api().getBaseUrl()}|${user?.id ?? "signed-out"}`} />;
}
