"use client";

import { useState } from "react";
import { useTranslation } from "@lynse/core/i18n/react";
import { Button } from "@lynse/ui/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@lynse/ui/components/ui/dialog";
import { getWorkbenchApi } from "./api";
import { useKnowledgePolicy } from "./knowledge-policy";

export function LocalMemorySync({ id, title }: { id: string; title: string }) {
  const { t } = useTranslation();
  const policy = useKnowledgePolicy();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const bridge = getWorkbenchApi();
  if (!id.startsWith("local:") || !bridge?.syncMemorySource) return null;
  const authorized = policy.data?.capabilities?.policy?.local_text_consent && policy.data.capabilities.policy.memory_consent;
  return <section className="space-y-2 rounded-lg border border-border p-3">
    <Button variant="outline" size="sm" disabled={!authorized || busy} onClick={() => setOpen(true)}>{t("memory_manager.sync_local")}</Button>
    <p className="text-xs text-muted-foreground">{t("memory_manager.sync_local_hint")}</p>
    {status && <p role="status" className="text-sm">{status}</p>}
    <Dialog open={open} onOpenChange={setOpen}><DialogContent><DialogHeader><DialogTitle>{t("memory_manager.sync_local")}</DialogTitle><DialogDescription>{t("memory_manager.sync_local_preview", { title })}</DialogDescription></DialogHeader><div className="flex justify-end gap-2"><Button variant="ghost" onClick={() => setOpen(false)}>{t("memory_manager.cancel")}</Button><Button disabled={busy} onClick={() => {
      setBusy(true);
      void bridge.syncMemorySource!(id).then(result => {
        if (!result.complete) throw new Error("Source commit incomplete");
        setStatus(t("memory_manager.source_synced")); setOpen(false);
      }).catch(() => setStatus(t("memory_manager.failed"))).finally(() => setBusy(false));
    }}>{t("memory_manager.sync_local")}</Button></div></DialogContent></Dialog>
  </section>;
}
