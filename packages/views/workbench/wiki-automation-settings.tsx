"use client";

import { useEffect, useId, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "@lynse/core/i18n/react";
import { Button } from "@lynse/ui/components/ui/button";
import { FolderOpen, Loader2 } from "../icons";
import { useFolders } from "../workspace/hooks/use-folders";
import { getWorkbenchApi, refreshWorkbench, useWorkbench } from "./api";
import type { WikiAutomationConfig } from "./types";
import { useKnowledgePolicy, updateKnowledgePolicy } from "./knowledge-policy";

export function WikiAutomationSettings({ activation = false, disabled = false }: { activation?: boolean; disabled?: boolean }) {
  const { t } = useTranslation();
  const status = useWorkbench(state => state.status);
  const folders = useFolders();
  const qc = useQueryClient();
  const id = useId();
  const cloud = useKnowledgePolicy();
  const policy = cloud.data?.capabilities?.policy;
  const [memoryConsent, setMemoryConsent] = useState(false);
  const [projections, setProjections] = useState(false);
  const [localConsent, setLocalConsent] = useState(false);
  const [extractionPaused, setExtractionPaused] = useState(true);
  const [selection, setSelection] = useState<WikiAutomationConfig>({ folderIds: [], includeUnfiled: false });
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const saved = status?.automation;
  useEffect(() => {
    if (dirty) return;
    setSelection(policy?.enrolled ? { folderIds: policy.folder_ids, includeUnfiled: policy.include_unfiled } : saved ?? { folderIds: [], includeUnfiled: false });
    setMemoryConsent(policy?.memory_consent ?? false);
    setLocalConsent(policy?.local_text_consent ?? false);
    setProjections(policy?.projections_enabled ?? false);
    setExtractionPaused(policy?.extraction_paused ?? true);
  }, [saved, dirty, policy]);
  const active = !!status?.enabled && status.allowAi && !!saved;
  async function configure(enabled: boolean) {
    const bridge = getWorkbenchApi();
    if (!bridge || busy) return;
    if (enabled && !selection.folderIds.length && !selection.includeUnfiled) {
      setError(t("workbench.auto_choose_folder"));
      document.getElementById(id)?.focus();
      return;
    }
    setBusy(true); setError("");
    try {
      if (enabled) {
        if (!cloud.data?.capabilities?.available || !policy) throw new Error(t("memory_manager.unavailable"));
        // Restrict the Native mirror before submitting a cloud scope change.
        await bridge.configure(active, active, selection);
        await updateKnowledgePolicy(policy, { enrolled: true, folder_ids: selection.folderIds,
          include_unfiled: selection.includeUnfiled, memory_consent: memoryConsent,
          local_text_consent: localConsent, projections_enabled: projections, extraction_paused: !memoryConsent || extractionPaused });
        await cloud.refetch();
      }
      const next = await bridge.configure(enabled, enabled, enabled ? selection : undefined);
      useWorkbench.getState().setStatus(next);
      setDirty(false);
      await Promise.all([qc.invalidateQueries({ queryKey: ["vault-config"] }), qc.invalidateQueries({ queryKey: ["workbench-wiki"] })]);
    } catch (cause) { setError(String(cause)); await refreshWorkbench(); await cloud.refetch(); }
    finally { setBusy(false); }
  }
  const unavailable = disabled || busy || !status;
  return <section className={activation ? "mx-auto w-full max-w-2xl space-y-5 rounded-xl border border-border p-5 sm:p-8" : "space-y-4"} aria-label={t("workbench.auto_settings")}>
    <div className="space-y-2"><h2 className="flex items-center gap-2 text-base font-semibold"><FolderOpen className="size-5 text-primary" aria-hidden="true" />{t(activation ? "workbench.auto_welcome" : "workbench.auto_settings")}</h2><p className="text-sm leading-relaxed text-muted-foreground">{t("workbench.auto_range_hint")}</p></div>
    <fieldset id={id} tabIndex={-1} aria-describedby={error ? `${id}-error` : undefined} className="min-w-0 rounded-lg border border-border p-3 focus-visible:outline-2 focus-visible:outline-ring" disabled={unavailable}>
      <legend className="px-1 text-sm font-medium">{t("workbench.auto_folders")}</legend>
      {folders.isPending && <p role="status" className="p-2 text-sm text-muted-foreground">{t("workbench.auto_loading_folders")}</p>}
      {folders.isError && <div className="space-y-2 p-2"><p role="alert" className="text-sm text-destructive">{t("workbench.auto_folder_error")}</p><Button type="button" size="sm" variant="outline" onClick={() => void folders.refetch()}>{t("workbench.retry")}</Button></div>}
      <div className="max-h-60 overflow-y-auto">
        {(folders.data ?? []).map(folder => <label key={folder.id} className="flex min-h-10 cursor-pointer items-center gap-3 rounded-md px-2 py-2 text-sm hover:bg-muted"><input type="checkbox" className="size-4 shrink-0 accent-primary" checked={selection.folderIds.includes(folder.id)} onChange={event => { setDirty(true); setSelection(current => ({ ...current, folderIds: event.target.checked ? [...current.folderIds, folder.id] : current.folderIds.filter(value => value !== folder.id) })); }} /><span className="min-w-0 break-words">{folder.folderName}</span></label>)}
        {selection.folderIds.filter(folderId => !folders.isPending && !folders.isError && !folders.data?.some(folder => folder.id === folderId)).map(folderId => <label key={folderId} className="flex min-h-10 items-center gap-3 px-2 py-2 text-sm"><input type="checkbox" className="size-4 shrink-0 accent-primary" checked onChange={() => { setDirty(true); setSelection(current => ({ ...current, folderIds: current.folderIds.filter(value => value !== folderId) })); }} /><span>{t("workbench.auto_missing_folder")}</span></label>)}
        <label className="flex min-h-10 cursor-pointer items-center gap-3 rounded-md px-2 py-2 text-sm hover:bg-muted"><input type="checkbox" className="size-4 shrink-0 accent-primary" checked={selection.includeUnfiled} onChange={event => { setDirty(true); setSelection(current => ({ ...current, includeUnfiled: event.target.checked })); }} /><span>{t("workbench.auto_unfiled")}</span></label>
      </div>
    </fieldset>
    <p className="text-sm leading-relaxed text-muted-foreground">{t("workbench.auto_consent")}</p>
    <p className="text-xs text-muted-foreground">{t("memory_manager.range_hint")}</p>
    {cloud.data?.capabilities?.available && <fieldset disabled={unavailable} className="space-y-4 rounded-lg border border-border p-4">
      <legend className="px-1 text-sm font-medium">{t("memory_manager.settings_title")}</legend>
      <div className="space-y-1">
        <label className="flex min-h-10 cursor-pointer items-center gap-3 text-sm font-medium"><input type="checkbox" checked={memoryConsent} aria-describedby={`${id}-memory-hint`} onChange={event => { setMemoryConsent(event.target.checked); setDirty(true); }} className="size-4 shrink-0" />{t("memory_manager.cloud_consent")}</label>
        <p id={`${id}-memory-hint`} className="pl-7 text-sm leading-relaxed text-muted-foreground">{t("memory_manager.cloud_hint")}</p>
      </div>
      {memoryConsent && <div className="space-y-4 border-t border-border pt-4">
        <div className="space-y-1">
          <label className="flex min-h-10 cursor-pointer items-center gap-3 text-sm"><input type="checkbox" checked={!extractionPaused} aria-describedby={`${id}-update-hint`} onChange={event => { setExtractionPaused(!event.target.checked); setDirty(true); }} className="size-4 shrink-0" />{t("memory_manager.auto_update")}</label>
          <p id={`${id}-update-hint`} className="pl-7 text-sm leading-relaxed text-muted-foreground">{t("memory_manager.auto_update_hint")}</p>
        </div>
        <div className="space-y-1">
          <label className="flex min-h-10 cursor-pointer items-center gap-3 text-sm"><input type="checkbox" checked={localConsent} aria-describedby={`${id}-local-hint`} onChange={event => { setLocalConsent(event.target.checked); setDirty(true); }} className="size-4 shrink-0" />{t("memory_manager.local_consent")}</label>
          <p id={`${id}-local-hint`} className="pl-7 text-sm leading-relaxed text-muted-foreground">{t("memory_manager.local_hint")}</p>
        </div>
        <div className="space-y-1">
          <label className="flex min-h-10 cursor-pointer items-center gap-3 text-sm"><input type="checkbox" checked={projections} aria-describedby={`${id}-recap-hint`} onChange={event => { setProjections(event.target.checked); setDirty(true); }} className="size-4 shrink-0" />{t("memory_manager.projection_enabled")}</label>
          <p id={`${id}-recap-hint`} className="pl-7 text-sm leading-relaxed text-muted-foreground">{t("memory_manager.projection_setting_hint")}</p>
        </div>
      </div>}
    </fieldset>}
    {(cloud.error || cloud.data && !cloud.data.capabilities?.available) && <p role="status" className="text-sm text-muted-foreground">{t("memory_manager.unavailable")}</p>}
    {cloud.data?.pending && <p role="status" className="text-sm text-muted-foreground">{t("memory_manager.policy_pending")}</p>}
    {error && <p id={`${id}-error`} role="alert" className="break-words text-sm text-destructive">{error}</p>}
    <div className="flex flex-wrap items-center gap-2"><Button size="sm" disabled={unavailable || folders.isError} onClick={() => void configure(true)}>{busy && <Loader2 className="size-3.5 animate-spin motion-reduce:animate-none" aria-hidden="true" />}{t(active ? "workbench.auto_save_range" : "workbench.auto_enable")}</Button>{active && <Button size="sm" variant="outline" disabled={unavailable} onClick={() => void configure(false)}>{t("workbench.auto_pause")}</Button>}</div>
    <p className="text-xs leading-relaxed text-muted-foreground">{t("workbench.auto_defaults")}</p>
  </section>;
}
