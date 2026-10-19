"use client";
import { useState } from "react";
import { Button } from "@lynse/ui/components/ui/button";
import { Input } from "@lynse/ui/components/ui/input";
import { useTranslation } from "@lynse/core/i18n/react";
import { toast } from "sonner";
import { getDesktopLiveTranslationApi } from "../live-translation/desktop-api";
import type { RecordingMarker } from "../live-translation/types";

export function RecordingMarkers({ markers }: { markers: RecordingMarker[] }) {
  const { t } = useTranslation();
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  async function marker(kind: RecordingMarker["kind"], id?: string, remove?: boolean) {
    const api = getDesktopLiveTranslationApi();
    if (!api?.marker) return;
    setBusy(true);
    try { await api.marker(kind, note, id, remove); setNote(""); }
    catch (error) { toast.error(String(error)); }
    finally { setBusy(false); }
  }
  return <section aria-label={t("workbench.marker")} className="shrink-0 space-y-2 border-b border-border bg-muted/20 px-5 py-2">
    <div className="flex flex-wrap items-center gap-2">
      <Input className="h-8 min-w-24 flex-1" maxLength={2000} aria-label={t("workbench.marker_note")} placeholder={t("workbench.marker_note")} value={note} onChange={(event) => setNote(event.target.value)} />
      {(["highlight", "decision", "todo"] as const).map((kind) => <Button key={kind} size="sm" variant="outline" disabled={busy} onClick={() => void marker(kind)}>{t(`workbench.${kind}`)}</Button>)}
    </div>
    {markers.length > 0 && <ul className="flex max-h-20 flex-wrap gap-2 overflow-y-auto">
      {markers.map((item) => <li key={item.id} className="flex items-center gap-1 rounded-md bg-background px-2 text-xs">
        <span className="tabular-nums text-muted-foreground">{Math.floor(item.startMs / 60_000)}:{String(Math.floor(item.startMs / 1000) % 60).padStart(2, "0")}</span>
        <span>{t(`workbench.${item.kind}`)}{item.note ? ` · ${item.note}` : ""}</span>
        <Button size="sm" variant="ghost" disabled={busy} aria-label={`${t("workbench.remove")} ${item.note || t(`workbench.${item.kind}`)}`} onClick={() => void marker(item.kind, item.id, true)}>×</Button>
      </li>)}
    </ul>}
  </section>;
}
