"use client";

import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@lynse/ui/components/ui/card";
import { Label } from "@lynse/ui/components/ui/label";
import { Input } from "@lynse/ui/components/ui/input";
import { Button } from "@lynse/ui/components/ui/button";
import { Switch } from "@lynse/ui/components/ui/switch";
import { useTranslation } from "@lynse/core/i18n/react";
import {
  getDesktopLocalTranscriptionApi,
  type DesktopLocalTranscriptionApi,
  OFFLINE_TRANSCRIPTION_ENABLED_KEY,
} from "../workspace/local-transcription";
import type { LocalHotwordPackage, LocalVoiceprint } from "../workspace/types";
import { SttConfigSection } from "./stt-config-section";

/**
 * The offline-transcription settings surface (PRD §5.3①): master toggle,
 * engine configuration, and hotword/voiceprint management. This is host core,
 * NOT a plugin — the pipeline is never gated; model download/uninstall lives
 * in the plugin community, reached via SttConfigSection's status hints.
 */
export function SttSettingsSection({ onBrowseModels }: { onBrowseModels?: () => void }) {
  const { t } = useTranslation();
  const localTranscriptionApi = getDesktopLocalTranscriptionApi();
  const [offlineTranscription, setOfflineTranscription] = useState(false);
  const [hotwordPackages, setHotwordPackages] = useState<LocalHotwordPackage[]>([]);
  const [voiceprints, setVoiceprints] = useState<LocalVoiceprint[]>([]);
  const [voiceprintBackend, setVoiceprintBackend] = useState<{
    backend: string | null;
    modelInstalled: boolean;
  } | null>(null);
  /** Voiceprint model download progress: null when idle, percent=null for indeterminate. */
  const [voiceprintDownload, setVoiceprintDownload] = useState<{ percent: number | null; error?: string | null } | null>(null);
  const [hotwordName, setHotwordName] = useState("");
  const [hotwordText, setHotwordText] = useState("");

  useEffect(() => {
    setOfflineTranscription(localStorage.getItem(OFFLINE_TRANSCRIPTION_ENABLED_KEY) === "1");
    void refreshLocalAssets();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!localTranscriptionApi) return;
    let unlisten: (() => void) | undefined;
    let active = true;
    localTranscriptionApi.onSttDownloadProgress((progress) => {
      if (progress.provider !== "sherpa") return;
      if (progress.phase === "done") {
        setVoiceprintDownload(null);
        void refreshLocalAssets();
      } else if (progress.phase === "error") {
        setVoiceprintDownload({ percent: null, error: progress.error ?? progress.phase });
      } else {
        setVoiceprintDownload({ percent: progress.percent });
      }
    }).then((fn) => {
      if (active) unlisten = fn;
      else fn();
    });
    return () => {
      active = false;
      unlisten?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [localTranscriptionApi]);

  function handleOfflineTranscriptionChange(enabled: boolean) {
    setOfflineTranscription(enabled);
    localStorage.setItem(OFFLINE_TRANSCRIPTION_ENABLED_KEY, enabled ? "1" : "0");
  }

  async function refreshLocalAssets() {
    if (!localTranscriptionApi) return;
    const [packages, localVoiceprints, backendStatus] = await Promise.all([
      localTranscriptionApi.listHotwordPackages().catch(() => []),
      localTranscriptionApi.listVoiceprints().catch(() => []),
      localTranscriptionApi.getVoiceprintBackendStatus().catch(() => null),
    ]);
    setHotwordPackages(packages);
    setVoiceprints(localVoiceprints);
    setVoiceprintBackend(backendStatus);
  }

  async function handleDownloadVoiceprintModel() {
    if (!localTranscriptionApi) return;
    setVoiceprintDownload({ percent: null });
    try {
      await localTranscriptionApi.downloadSttModel("sherpa", "3dspeaker-campplus");
    } catch (error) {
      setVoiceprintDownload({ percent: null, error: error instanceof Error ? error.message : String(error) });
    }
    await refreshLocalAssets();
  }

  async function handleSaveHotwordPackage() {
    if (!localTranscriptionApi || !hotwordName.trim()) return;
    const now = new Date().toISOString();
    const terms = hotwordText
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [term, replacement] = line.split("=>").map((part) => part.trim());
        return { term: term ?? "", replacement: replacement || undefined, enabled: true };
      })
      .filter((term) => term.term);
    await localTranscriptionApi.saveHotwordPackage({
      id: `hotword:${crypto.randomUUID()}`,
      name: hotwordName.trim(),
      enabled: true,
      createdAt: now,
      updatedAt: now,
      terms,
    });
    setHotwordName("");
    setHotwordText("");
    await refreshLocalAssets();
  }

  async function handleDeleteHotwordPackage(id: string) {
    if (!localTranscriptionApi) return;
    await localTranscriptionApi.deleteHotwordPackage(id);
    await refreshLocalAssets();
  }

  async function handleDeleteVoiceprint(id: string) {
    if (!localTranscriptionApi) return;
    await localTranscriptionApi.deleteVoiceprint(id);
    await refreshLocalAssets();
  }

  if (!localTranscriptionApi) return null;

  return (
    <>
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-xs">{t("settings.stt")}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-center justify-between gap-3">
            <Label htmlFor="dlg-offline-transcription" className="text-xs">
              {t("settings.offline_transcription")}
            </Label>
            <Switch
              id="dlg-offline-transcription"
              checked={offlineTranscription}
              onCheckedChange={handleOfflineTranscriptionChange}
            />
          </div>
          <p className="text-2xs leading-relaxed text-muted-foreground">
            {t("settings.offline_transcription_hint")}
          </p>

          {!offlineTranscription ? (
            <p className="rounded-md border bg-muted/30 p-2.5 text-2xs text-muted-foreground">
              {t("settings.offline_off_hint")}
            </p>
          ) : (
            <SttConfigSection
              api={localTranscriptionApi as DesktopLocalTranscriptionApi}
              hotwordPackages={hotwordPackages}
              onBrowseModels={onBrowseModels}
            />
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-xs">{t("settings.hotword_packages")}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <Input
            value={hotwordName}
            onChange={(event) => setHotwordName(event.target.value)}
            placeholder={t("settings.hotword_name_placeholder")}
            className="h-8 text-xs"
          />
          <textarea
            value={hotwordText}
            onChange={(event) => setHotwordText(event.target.value)}
            placeholder={t("settings.hotword_text_placeholder")}
            className="min-h-20 w-full rounded-md border border-border bg-background px-3 py-2 text-xs outline-none focus:border-primary"
          />
          <Button
            type="button"
            size="sm"
            className="h-7 text-xs"
            onClick={handleSaveHotwordPackage}
            disabled={!hotwordName.trim()}
          >
            {t("settings.hotword_save")}
          </Button>
          {hotwordPackages.length > 0 && (
            <div className="space-y-1">
              {hotwordPackages.map((pkg) => (
                <div key={pkg.id} className="flex items-center justify-between gap-2 rounded bg-background px-2 py-1 text-xs">
                  <span className="truncate">
                    {t("settings.hotword_terms_count", {
                      name: pkg.name,
                      terms: pkg.terms.length,
                    })}
                  </span>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    className="h-6 px-2 text-xs"
                    onClick={() => handleDeleteHotwordPackage(pkg.id)}
                  >
                    {t("settings.delete")}
                  </Button>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-xs">{t("settings.voiceprints")}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <div className="flex items-center justify-between gap-2 text-xs">
            <Label className="text-2xs text-muted-foreground">{t("settings.voiceprint_engine")}</Label>
            <span className="truncate text-2xs">
              {voiceprintBackend?.modelInstalled
                ? t("settings.voiceprint_engine_3dspeaker")
                : t("settings.voiceprint_engine_none")}
            </span>
          </div>

          {!voiceprintBackend?.modelInstalled && (
            <div className="space-y-1.5">
              {voiceprintDownload ? (
                <div className="rounded-md border bg-muted/30 p-2 text-2xs text-muted-foreground">
                  {voiceprintDownload.error
                    ? voiceprintDownload.error
                    : t("settings.voiceprint_3dspeaker_downloading", {
                        percent: voiceprintDownload.percent != null ? `${voiceprintDownload.percent}%` : "…",
                      })}
                </div>
              ) : (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="h-7 text-xs"
                  onClick={handleDownloadVoiceprintModel}
                >
                  {t("settings.voiceprint_3dspeaker_download")}
                </Button>
              )}
              <p className="text-2xs leading-relaxed text-muted-foreground">
                {t("settings.voiceprint_3dspeaker_note")}
              </p>
            </div>
          )}

          {voiceprints.length === 0 ? (
            <p className="text-2xs text-muted-foreground">
              {t("settings.voiceprints_empty")}
            </p>
          ) : voiceprints.map((voiceprint) => {
            // Only entries enrolled with the current engine (3D-Speaker) can
            // match; legacy CAM++/MECT entries are flagged so the user knows
            // to re-save them.
            const active = voiceprint.backend === "3dspeaker";
            return (
              <div key={voiceprint.id} className="space-y-0.5 rounded bg-background px-2 py-1">
                <div className="flex items-center justify-between gap-2">
                  <span className="flex min-w-0 items-center gap-1.5 text-xs">
                    <span className="truncate">{voiceprint.name}</span>
                    <span className="shrink-0 rounded border border-border px-1 text-2xs text-muted-foreground">
                      {active ? "3D-Speaker" : voiceprint.backend === "mect" ? "MECT" : "CAM++"}
                    </span>
                  </span>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    className="h-6 px-2 text-xs"
                    onClick={() => handleDeleteVoiceprint(voiceprint.id)}
                  >
                    {t("settings.delete")}
                  </Button>
                </div>
                {!active && (
                  <p className="text-2xs text-muted-foreground">{t("settings.voiceprint_legacy_inactive")}</p>
                )}
              </div>
            );
          })}
        </CardContent>
      </Card>
    </>
  );
}
