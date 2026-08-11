"use client";

import { useEffect, useState } from "react";
import { Loader2 } from "../icons";
import { Card, CardContent, CardHeader, CardTitle } from "@lynse/ui/components/ui/card";
import { Label } from "@lynse/ui/components/ui/label";
import { Input } from "@lynse/ui/components/ui/input";
import { Button } from "@lynse/ui/components/ui/button";
import { useTranslation } from "@lynse/core/i18n/react";
import { getDesktopLiveTranslationApi } from "../live-translation/desktop-api";
import type {
  LiveTranslationProvider,
  LiveTranslationProviderConfig,
} from "../live-translation/types";

/**
 * Settings card that lets the user pick the live-translation engine and store
 * its credentials. The Qwen (DashScope) API key is persisted to the OS
 * Keychain via the Tauri bridge; the endpoint and iLiveData secrets go through
 * the same bridge. This mirrors the provider config UI on the live-translation
 * page but lives in Settings so the key can be managed in one place.
 */
export function LiveTranslationConfigCard() {
  const api = getDesktopLiveTranslationApi();
  const { t } = useTranslation();

  const [config, setConfig] = useState<LiveTranslationProviderConfig | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (!api) return;
    let cancelled = false;
    api
      .getProviderConfig()
      .then((cfg) => {
        if (!cancelled) setConfig(cfg);
      })
      .catch(() => {
        if (!cancelled) setConfig(null);
      })
      .finally(() => {
        if (!cancelled) setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [api]);

  if (!api || !loaded || !config) return null;

  function updateProvider(provider: LiveTranslationProvider) {
    setConfig((c) => (c ? { ...c, provider } : c));
    setSaved(false);
  }

  function updateQwen(
    field: keyof LiveTranslationProviderConfig["qwen"],
    value: string,
  ) {
    setConfig((c) => (c ? { ...c, qwen: { ...c.qwen, [field]: value } } : c));
    setSaved(false);
  }

  function updateVolc(
    field: keyof LiveTranslationProviderConfig["volc"],
    value: string,
  ) {
    setConfig((c) => (c ? { ...c, volc: { ...c.volc, [field]: value } } : c));
    setSaved(false);
  }

  function updateILiveData(
    field: keyof LiveTranslationProviderConfig["ilivedata"],
    value: string,
  ) {
    setConfig((c) =>
      c ? { ...c, ilivedata: { ...c.ilivedata, [field]: value } } : c,
    );
    setSaved(false);
  }

  async function save() {
    if (!api || !config) return;
    setSaving(true);
    try {
      const normalized = await api.saveProviderConfig(config);
      setConfig(normalized);
      setSaved(true);
      window.setTimeout(() => setSaved(false), 2500);
    } catch {
      /* ignore — the bridge surfaces its own error toast */
    } finally {
      setSaving(false);
    }
  }

  const isQwen = config.provider === "qwen";
  const isILiveData = config.provider === "ilivedata_direct";
  const isVolc = config.provider === "volc";

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-xs">{t("settings.live_translation")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="space-y-1.5">
          <Label htmlFor="lt-provider" className="text-xs">
            {t("live_translation.provider")}
          </Label>
          <select
            id="lt-provider"
            value={config.provider}
            onChange={(e) =>
              updateProvider(e.target.value as LiveTranslationProvider)
            }
            className="h-8 w-full rounded-md border border-border bg-background px-2 text-xs outline-none focus:border-primary"
          >
            <option value="lynse_backend">
              {t("live_translation.provider_backend")}
            </option>
            <option value="ilivedata_direct">
              {t("live_translation.provider_ilivedata_direct")}
            </option>
            <option value="qwen">{t("live_translation.provider_qwen")}</option>
            <option value="volc">{t("live_translation.provider_volc")}</option>
          </select>
        </div>

        {isVolc && (
          <div className="space-y-2 rounded-lg border border-border bg-card p-3">
            <p className="text-[11px] leading-relaxed text-amber-700 dark:text-amber-300">
              {t("live_translation.volc_hint")}
            </p>
            <div className="space-y-1.5">
              <Label htmlFor="lt-volc-key" className="text-[11px]">
                {t("live_translation.provider_volc_api_key")}
              </Label>
              <Input
                id="lt-volc-key"
                type="password"
                autoComplete="off"
                value={config.volc.apiKey}
                onChange={(e) => updateVolc("apiKey", e.target.value)}
                className="h-8 text-xs"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="lt-volc-endpoint" className="text-[11px]">
                {t("live_translation.provider_volc_endpoint")}
              </Label>
              <Input
                id="lt-volc-endpoint"
                value={config.volc.endpoint}
                onChange={(e) => updateVolc("endpoint", e.target.value)}
                className="h-8 text-xs"
              />
            </div>
          </div>
        )}

        {isQwen && (
          <div className="space-y-2 rounded-lg border border-border bg-card p-3">
            <p className="text-[11px] leading-relaxed text-amber-700 dark:text-amber-300">
              {t("live_translation.qwen_hint")}
            </p>
            <div className="space-y-1.5">
              <Label htmlFor="lt-qwen-key" className="text-[11px]">
                {t("live_translation.provider_qwen_api_key")}
              </Label>
              <Input
                id="lt-qwen-key"
                type="password"
                autoComplete="off"
                placeholder="sk-..."
                value={config.qwen.apiKey}
                onChange={(e) => updateQwen("apiKey", e.target.value)}
                className="h-8 text-xs"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="lt-qwen-endpoint" className="text-[11px]">
                {t("live_translation.provider_qwen_endpoint")}
              </Label>
              <Input
                id="lt-qwen-endpoint"
                value={config.qwen.endpoint}
                onChange={(e) => updateQwen("endpoint", e.target.value)}
                className="h-8 text-xs"
              />
            </div>
          </div>
        )}

        {isILiveData && (
          <div className="space-y-2 rounded-lg border border-border bg-card p-3">
            <p className="text-[11px] leading-relaxed text-amber-700 dark:text-amber-300">
              {t("live_translation.direct_test_hint")}
            </p>
            <div className="space-y-1.5">
              <Label htmlFor="lt-ilivedata-endpoint" className="text-[11px]">
                {t("live_translation.provider_websocket_endpoint")}
              </Label>
              <Input
                id="lt-ilivedata-endpoint"
                value={config.ilivedata.endpoint}
                onChange={(e) => updateILiveData("endpoint", e.target.value)}
                className="h-8 text-xs"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="lt-ilivedata-pid" className="text-[11px]">
                {t("live_translation.provider_pid")}
              </Label>
              <Input
                id="lt-ilivedata-pid"
                value={config.ilivedata.pid}
                onChange={(e) => updateILiveData("pid", e.target.value)}
                className="h-8 text-xs"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="lt-ilivedata-secret" className="text-[11px]">
                {t("live_translation.provider_secret_key")}
              </Label>
              <Input
                id="lt-ilivedata-secret"
                type="password"
                autoComplete="off"
                value={config.ilivedata.secretKey}
                onChange={(e) => updateILiveData("secretKey", e.target.value)}
                className="h-8 text-xs"
              />
            </div>
          </div>
        )}

        <div className="flex items-center gap-3">
          <Button
            type="button"
            size="sm"
            className="h-7 text-xs"
            onClick={save}
            disabled={saving}
          >
            {saving ? <Loader2 className="size-3.5 animate-spin" /> : null}
            {t("live_translation.save_provider_config")}
          </Button>
          {saved && (
            <span className="inline-flex items-center gap-1.5 text-xs text-green-600">
              <span className="size-1.5 rounded-full bg-green-500" />
              {t("live_translation.provider_config_saved")}
            </span>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
