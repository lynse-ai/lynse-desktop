"use client";
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "@lynse/core/i18n/react";
import { Button } from "@lynse/ui/components/ui/button";
import { toast } from "sonner";
import { Download, Loader2, LockKeyhole, LockKeyholeOpen, Paperclip } from "../icons";
import { getDesktopInspirationApi } from "./desktop-api";
import { ensureInspirationUnlocked, privacyError } from "./privacy-state";
import type { InspirationRecord } from "./types";

export function ProtectedRecordLabel() {
  const { t } = useTranslation();
  return <p className="mt-2 flex items-center gap-2 text-sm text-muted-foreground"><LockKeyhole className="size-4" />{t("inspiration_private.encrypted")}</p>;
}
export function InspirationLockButton({ record, className }: { record: InspirationRecord; className?: string }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const encrypted = record.protection === "e2ee";
  return <button type="button" aria-label={t(encrypted ? "inspiration_private.decrypt" : "inspiration_private.encrypt")} title={t(record.transition ? "inspiration_private.pending" : encrypted ? "inspiration_private.decrypt" : "inspiration_private.encrypt")} disabled={busy || (!!record.transition && record.transition.phase !== "preparing")} className={className} onClick={(event) => {
    event.stopPropagation();
    setBusy(true);
    void (async () => {
      if (!(await ensureInspirationUnlocked())) return;
      await getDesktopInspirationApi()!.privacy!.toggle(record.id);
      await queryClient.invalidateQueries({ queryKey: ["inspirations"] });
      await queryClient.invalidateQueries({ queryKey: ["inspiration-detail"] });
    })().catch((error) => toast.error(privacyError(error, t))).finally(() => setBusy(false));
  }}>{busy ? <Loader2 className="size-3.5 animate-spin" /> : encrypted ? <LockKeyhole className="size-3.5" /> : <LockKeyholeOpen className="size-3.5" />}</button>;
}
export function InspirationFiles({ record }: { record: InspirationRecord }) {
  const { t } = useTranslation();
  const [exporting, setExporting] = useState<string | null>(null);
  if (!record.files?.length || record.locked) return null;
  return <div className="space-y-2" onClick={(event) => event.stopPropagation()}>{record.files.map((file) => <div key={file.file} className="flex min-w-0 items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm"><Paperclip className="size-4 shrink-0 text-muted-foreground" /><span className="min-w-0 flex-1 truncate" title={file.name}>{file.name}</span><span className="shrink-0 text-xs text-muted-foreground">{(file.size / 1024).toFixed(0)} KB</span><Button variant="ghost" size="icon-sm" disabled={!!exporting} title={`${t("inspiration_private.export")} · ${t("inspiration_private.sensitive_export")}`} onClick={() => {
    setExporting(file.file);
    void (async () => {
      if (record.protection === "e2ee" && !(await ensureInspirationUnlocked())) return;
      await getDesktopInspirationApi()?.exportFile?.(record.id, file.file, file.name);
    })().catch((error) => toast.error(privacyError(error, t))).finally(() => setExporting(null));
  }}>{exporting === file.file ? <Loader2 className="size-4 animate-spin" /> : <Download className="size-4" />}</Button></div>)}</div>;
}
