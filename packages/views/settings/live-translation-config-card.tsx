"use client";

import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@lynse/ui/components/ui/card";
import { useTranslation } from "@lynse/core/i18n/react";
import { getDesktopLiveTranslationApi } from "../live-translation/desktop-api";
import { ProviderSettings } from "../live-translation/provider-settings";
import type { LiveTranslationProviderConfig } from "../live-translation/types";

/**
 * Settings card for the live-translation engine. The provider dropdown and
 * its credential form are rendered by the shared `ProviderSettings`
 * (driven by the provider plugin registry); this wrapper only owns
 * load/save against the desktop bridge. Credentials are persisted to the
 * OS Keychain by the bridge.
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

  function updateField(providerId: string, fieldKey: string, value: string) {
    setConfig((current) =>
      current
        ? {
            ...current,
            values: {
              ...current.values,
              [providerId]: {
                ...current.values[providerId],
                [fieldKey]: value,
              },
            },
          }
        : current,
    );
  }

  async function activate(providerId: string) {
    if (!api || !config) return;
    try {
      setConfig(await api.saveProviderConfig({ ...config, activeProvider: providerId }));
    } catch {
      /* ignore — the bridge surfaces its own error toast */
    }
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

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-xs">{t("settings.live_translation")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <ProviderSettings
          config={config}
          onFieldChange={updateField}
          onProviderChange={(providerId) => void activate(providerId)}
          onSave={() => void save()}
          saving={saving}
          saved={saved}
        />
      </CardContent>
    </Card>
  );
}
