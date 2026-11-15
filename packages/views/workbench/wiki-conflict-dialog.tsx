"use client";

import { useState } from "react";
import { useTranslation } from "@lynse/core/i18n/react";
import { Button } from "@lynse/ui/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@lynse/ui/components/ui/dialog";
import { getWorkbenchApi } from "./api";
import type { WikiConflictResolution, WikiSyncConflict } from "./types";

const branches = ["local", "cloud"] as const;

export function WikiConflictDialog({ topicId, resolve }: {
  topicId: string;
  resolve: (request: WikiConflictResolution) => Promise<unknown>;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [preview, setPreview] = useState<WikiSyncConflict | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [markdown, setMarkdown] = useState("");
  const [edited, setEdited] = useState(false);
  const [details, setDetails] = useState<"local" | "cloud">("local");

  async function load(keepDraft: boolean) {
    const bridge = getWorkbenchApi();
    if (!bridge) return;
    setBusy(true);
    setError("");
    try {
      const response = await bridge.wiki({ action: "sync_conflict_preview", id: topicId });
      const next = response.syncConflict;
      if (!next) throw new Error(t("workbench.auto_update_failed"));
      setPreview(next);
      if (!keepDraft) {
        setMarkdown(next.suggestedMarkdown ?? next.local.markdown);
        setDetails("local");
      }
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  }

  async function save(choice: WikiConflictResolution["choice"]) {
    if (!preview) return;
    setBusy(true);
    setError("");
    try {
      await resolve({ action: "sync_conflict_resolve", id: topicId, choice, details, markdown,
        localVersion: preview.localVersion, cloudVersion: preview.cloudVersion });
      setOpen(false);
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  }

  return <div className="flex flex-wrap items-center gap-2">
    <p role="alert" className="text-sm text-destructive">{t("workbench.memory_cloud_conflict")}</p>
    <Button size="sm" variant="outline" onClick={() => { setPreview(null); setEdited(false); setOpen(true); void load(false); }}>
      {t("workbench.wiki_compare_versions")}
    </Button>
    <Dialog open={open} onOpenChange={next => { if (!busy) setOpen(next); }}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle>{t("workbench.wiki_compare_versions")}</DialogTitle>
          <DialogDescription>{t("workbench.wiki_conflict_description")}</DialogDescription>
        </DialogHeader>
        {busy && !preview && <p role="status" className="text-sm">{t("workbench.wiki_merge_loading")}</p>}
        {error && <div className="space-y-2">
          <p role="alert" className="text-sm text-destructive">{error}</p>
          <Button size="sm" variant="outline" disabled={busy} onClick={() => void load(edited)}>{t("workbench.wiki_merge_retry")}</Button>
        </div>}
        {preview && <>
          <div className="grid min-w-0 gap-4 sm:grid-cols-2">
            {branches.map(branch => <section key={branch} className="min-w-0 space-y-1">
              <h3 className="break-words text-sm font-semibold">{t(`workbench.wiki_${branch}_version`)} · {preview[branch].title}</h3>
              {preview[branch].purpose && <p className="break-words text-xs text-muted-foreground">{preview[branch].purpose}</p>}
              {preview[branch].notes && <p className="whitespace-pre-wrap break-words text-xs text-muted-foreground">{preview[branch].notes}</p>}
              <pre className="max-h-44 overflow-y-auto whitespace-pre-wrap break-words rounded-md border border-input p-2 text-xs">{preview[branch].markdown}</pre>
            </section>)}
          </div>
          {preview.canMerge && <div className="space-y-2">
            {preview.suggestedMarkdown != null && !edited && <p className="text-sm text-muted-foreground">{t("workbench.wiki_merge_suggestion")}</p>}
            <label className="block text-sm">
              {t("workbench.wiki_merge_details")}
              <select className="ms-2 rounded-md border border-input bg-background p-1" value={details} disabled={busy}
                onChange={event => setDetails(event.target.value === "cloud" ? "cloud" : "local")}>
                {branches.map(branch => <option key={branch} value={branch}>{t(`workbench.wiki_${branch}_version`)}</option>)}
              </select>
            </label>
            <textarea aria-label={t("workbench.wiki_merged_markdown")} className="min-h-36 w-full resize-y rounded-md border border-input bg-background p-2 font-mono text-sm"
              value={markdown} onChange={event => { setEdited(true); setMarkdown(event.target.value); }} maxLength={200_000} disabled={busy} />
          </div>}
          <div className="flex flex-wrap justify-end gap-2">
            <Button size="sm" variant="outline" disabled={busy || !!error} onClick={() => void save("local")}>{t("workbench.keep_local")}</Button>
            <Button size="sm" variant="outline" disabled={busy || !!error} onClick={() => void save("cloud")}>{t("workbench.use_cloud")}</Button>
            {preview.canMerge && <Button size="sm" disabled={busy || !!error || !markdown.trim()} onClick={() => void save("merge")}>{t("workbench.wiki_merge_publish")}</Button>}
          </div>
        </>}
      </DialogContent>
    </Dialog>
  </div>;
}
