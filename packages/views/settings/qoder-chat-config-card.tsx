"use client";

import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@lynse/ui/components/ui/card";
import { Label } from "@lynse/ui/components/ui/label";
import { Input } from "@lynse/ui/components/ui/input";
import { Button } from "@lynse/ui/components/ui/button";
import { useTranslation } from "@lynse/core/i18n/react";
import { getDesktopQoderChatApi, type QoderChatConfig } from "../workspace/chat-transport";

export function QoderChatConfigCard() {
  const api = getDesktopQoderChatApi();
  const { t } = useTranslation();
  const [config, setConfig] = useState<QoderChatConfig | null>(null);
  const [pat, setPat] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!api) return;
    let cancelled = false;
    api.getConfig().then((value) => {
      if (!cancelled) setConfig(value);
    }).catch((reason: unknown) => {
      if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason));
    });
    return () => {
      cancelled = true;
    };
  }, [api]);

  if (!api || !config) return null;

  async function savePat() {
    if (!api || !pat.trim()) return;
    setSaving(true);
    setSaved(false);
    setError(null);
    try {
      setConfig(await api.savePat(pat.trim()));
      setPat("");
      setSaved(true);
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-xs">{t("settings.qoder_chat")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          {t("settings.qoder_chat_hint")}
        </p>
        <div className="grid gap-1 rounded-md border bg-muted/30 p-2.5 text-[10px] text-muted-foreground">
          <span className="truncate">Agent · {config.agentId}</span>
          <span className="truncate">Environment · {config.environmentId}</span>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="dlg-qoder-pat" className="text-xs">Qoder PAT</Label>
          <Input
            id="dlg-qoder-pat"
            type="password"
            autoComplete="off"
            placeholder={config.configured ? t("settings.qoder_pat_configured") : "QODER_PAT"}
            value={pat}
            onChange={(event) => {
              setPat(event.target.value);
              setSaved(false);
            }}
            className="h-8 text-sm"
          />
        </div>
        {error && <p className="text-xs text-destructive">{error}</p>}
        <div className="flex items-center gap-3">
          <Button
            type="button"
            size="sm"
            className="h-7 text-xs"
            onClick={savePat}
            disabled={!pat.trim() || saving}
          >
            {saving ? t("settings.qoder_saving") : t("settings.qoder_save_pat")}
          </Button>
          {(saved || config.configured) && (
            <span className="inline-flex items-center gap-1.5 text-xs text-green-600">
              <span className="size-1.5 rounded-full bg-green-500" />
              {saved ? t("settings.qoder_pat_saved") : t("settings.qoder_pat_configured")}
            </span>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
