"use client";

import { useState, useEffect } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@lynse/ui/components/ui/dialog";
import { Card, CardContent, CardHeader, CardTitle } from "@lynse/ui/components/ui/card";
import { Label } from "@lynse/ui/components/ui/label";
import { Input } from "@lynse/ui/components/ui/input";
import { Button } from "@lynse/ui/components/ui/button";
import { Switch } from "@lynse/ui/components/ui/switch";
import { useAuthStore } from "@lynse/core/auth";
import { useTheme } from "@lynse/ui/components/common/theme-provider";
import { useTranslation } from "@lynse/core/i18n/react";
import { Sun, Moon, Monitor } from "../icons";
import { cn } from "@lynse/ui/lib/utils";
import {
  getDesktopLocalTranscriptionApi,
  type DesktopLocalTranscriptionApi,
  type SttEngine,
  type SttModelInfo,
  OFFLINE_TRANSCRIPTION_ENABLED_KEY,
} from "../workspace/local-transcription";
import type { LocalHotwordPackage, LocalVoiceprint } from "../workspace/types";
import { SttConfigSection } from "./stt-config-section";

const DEFAULT_API_URL = "http://119.97.160.133:10060";
export const SETTINGS_DIALOG_CONTENT_CLASS =
  "sm:max-w-2xl max-h-[min(90vh,760px)] grid-rows-[auto_minmax(0,1fr)] gap-0 overflow-hidden p-0";

type ThemeOption = "light" | "dark" | "system";

export function SettingsDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const login = useAuthStore((s) => s.login);
  const logout = useAuthStore((s) => s.logout);
  const { theme, setTheme } = useTheme();
  const { t } = useTranslation();

  const themeOptions: { value: ThemeOption; label: string; icon: typeof Sun }[] = [
    { value: "light", label: t("layout.theme_light"), icon: Sun },
    { value: "dark", label: t("layout.theme_dark"), icon: Moon },
    { value: "system", label: t("layout.theme_system"), icon: Monitor },
  ];

  const [apiUrl, setApiUrl] = useState(DEFAULT_API_URL);
  const [apiKey, setApiKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [offlineTranscription, setOfflineTranscription] = useState(false);
  const localTranscriptionApi = getDesktopLocalTranscriptionApi();
  const hasLocalTranscription = !!localTranscriptionApi;
  const [models, setModels] = useState<SttModelInfo[]>([]);
  const [modelBusy, setModelBusy] = useState(false);
  const [modelError, setModelError] = useState<string | null>(null);
  const [hotwordPackages, setHotwordPackages] = useState<LocalHotwordPackage[]>([]);
  const [voiceprints, setVoiceprints] = useState<LocalVoiceprint[]>([]);
  const [hotwordName, setHotwordName] = useState("");
  const [hotwordText, setHotwordText] = useState("");

  useEffect(() => {
    if (open) {
      const savedUrl = localStorage.getItem("lynse_api_url");
      if (savedUrl) setApiUrl(savedUrl);
      const savedKey = localStorage.getItem("lynse_api_key");
      if (savedKey) setApiKey(savedKey);
      setOfflineTranscription(localStorage.getItem(OFFLINE_TRANSCRIPTION_ENABLED_KEY) === "1");
      refreshModels();
      refreshLocalAssets();
    }
  }, [open]);

  async function handleConnect() {
    if (!apiKey.trim()) return;
    setError(null);
    setConnecting(true);
    try {
      await login(apiKey.trim(), apiUrl.trim());
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : t("settings.connection_failed");
      setError(message);
    } finally {
      setConnecting(false);
    }
  }

  function handleDisconnect() {
    logout();
    setApiKey("");
  }

  function handleOfflineTranscriptionChange(enabled: boolean) {
    setOfflineTranscription(enabled);
    localStorage.setItem(OFFLINE_TRANSCRIPTION_ENABLED_KEY, enabled ? "1" : "0");
  }

  async function refreshModels() {
    if (!localTranscriptionApi) return;
    setModelError(null);
    try {
      setModels((await localTranscriptionApi.listSttModels()).models);
    } catch (e: unknown) {
      setModelError(e instanceof Error ? e.message : t("settings.local_model_status_failed"));
    }
  }

  async function refreshLocalAssets() {
    if (!localTranscriptionApi) return;
    const [packages, localVoiceprints] = await Promise.all([
      localTranscriptionApi.listHotwordPackages().catch(() => []),
      localTranscriptionApi.listVoiceprints().catch(() => []),
    ]);
    setHotwordPackages(packages);
    setVoiceprints(localVoiceprints);
  }

  async function handleDownloadModel(provider: SttEngine, modelId: string) {
    if (!localTranscriptionApi) return;
    setModelBusy(true);
    setModelError(null);
    try {
      setModels((await localTranscriptionApi.downloadSttModel(provider, modelId)).models);
    } catch (e: unknown) {
      setModelError(e instanceof Error ? e.message : t("settings.local_model_download_failed"));
    } finally {
      setModelBusy(false);
    }
  }

  async function handleDeleteModel(provider: SttEngine, modelId: string) {
    if (!localTranscriptionApi) return;
    setModelBusy(true);
    setModelError(null);
    try {
      setModels((await localTranscriptionApi.deleteSttModel(provider, modelId)).models);
    } catch (e: unknown) {
      setModelError(e instanceof Error ? e.message : t("settings.local_model_delete_failed"));
    } finally {
      setModelBusy(false);
    }
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

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={SETTINGS_DIALOG_CONTENT_CLASS}>
        <DialogHeader className="border-b px-4 py-3 pr-12">
          <DialogTitle>{t("nav.settings")}</DialogTitle>
        </DialogHeader>

        <div className="min-h-0 space-y-4 overflow-y-auto px-4 py-4">
          {/* ── Appearance ─────────────────────────────── */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-xs">{t("settings.appearance")}</CardTitle>
            </CardHeader>
            <CardContent>
              <Label className="text-xs mb-2 block">{t("layout.theme")}</Label>
              <div className="grid grid-cols-3 gap-2">
                {themeOptions.map((option) => {
                  const isActive = theme === option.value;
                  const Icon = option.icon;
                  return (
                    <button
                      key={option.value}
                      onClick={() => setTheme(option.value)}
                      className={cn(
                        "flex flex-col items-center gap-1.5 rounded-lg border-2 px-2 py-2 text-xs font-medium transition-all",
                        isActive
                          ? "border-primary bg-primary/5 text-foreground"
                          : "border-transparent bg-muted/50 text-muted-foreground hover:bg-muted hover:text-foreground"
                      )}
                    >
                      <Icon className="size-4" />
                      <span>{option.label}</span>
                    </button>
                  );
                })}
              </div>
            </CardContent>
          </Card>

          {/* ── Speech-to-Text (STT) ───────────────────── */}
          {hasLocalTranscription && (
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
                <p className="text-[11px] leading-relaxed text-muted-foreground">
                  {t("settings.offline_transcription_hint")}
                </p>

                {!offlineTranscription ? (
                  <p className="rounded-md border bg-muted/30 p-2.5 text-[11px] text-muted-foreground">
                    {t("settings.offline_off_hint")}
                  </p>
                ) : (
                  <>
                    <SttConfigSection
                      api={localTranscriptionApi as DesktopLocalTranscriptionApi}
                      models={models}
                      modelBusy={modelBusy}
                      modelError={modelError}
                      onDownloadModel={handleDownloadModel}
                      onDeleteModel={handleDeleteModel}
                      hotwordPackages={hotwordPackages}
                    />

                    <div className="rounded-md border bg-muted/30 p-2.5">
                      <p className="text-xs font-medium">本地热词包</p>
                      <div className="mt-2 space-y-2">
                        <Input
                          value={hotwordName}
                          onChange={(event) => setHotwordName(event.target.value)}
                          placeholder="热词包名称"
                          className="h-8 text-xs"
                        />
                        <textarea
                          value={hotwordText}
                          onChange={(event) => setHotwordText(event.target.value)}
                          placeholder={"每行一个热词，或 误识别=>替换"}
                          className="min-h-20 w-full rounded-md border border-border bg-background px-3 py-2 text-xs outline-none focus:border-primary"
                        />
                        <Button
                          type="button"
                          size="sm"
                          className="h-7 text-xs"
                          onClick={handleSaveHotwordPackage}
                          disabled={!hotwordName.trim()}
                        >
                          保存热词包
                        </Button>
                        {hotwordPackages.length > 0 && (
                          <div className="space-y-1">
                            {hotwordPackages.map((pkg) => (
                              <div key={pkg.id} className="flex items-center justify-between gap-2 rounded bg-background px-2 py-1 text-xs">
                                <span className="truncate">{pkg.name} · {pkg.terms.length}词</span>
                                <Button
                                  type="button"
                                  size="sm"
                                  variant="ghost"
                                  className="h-6 px-2 text-xs"
                                  onClick={() => handleDeleteHotwordPackage(pkg.id)}
                                >
                                  删除
                                </Button>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>

                    <div className="rounded-md border bg-muted/30 p-2.5">
                      <p className="text-xs font-medium">本地声纹</p>
                      <div className="mt-2 space-y-1">
                        {voiceprints.length === 0 ? (
                          <p className="text-[11px] text-muted-foreground">暂无声纹，可在本地转写详情中从某个发言人保存。</p>
                        ) : voiceprints.map((voiceprint) => (
                          <div key={voiceprint.id} className="flex items-center justify-between gap-2 rounded bg-background px-2 py-1 text-xs">
                            <span className="truncate">{voiceprint.name}</span>
                            <Button
                              type="button"
                              size="sm"
                              variant="ghost"
                              className="h-6 px-2 text-xs"
                              onClick={() => handleDeleteVoiceprint(voiceprint.id)}
                            >
                              删除
                            </Button>
                          </div>
                        ))}
                      </div>
                    </div>
                  </>
                )}
              </CardContent>
            </Card>
          )}

          {/* ── API Configuration ──────────────────────── */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-xs">{t("settings.api_config")}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="space-y-1.5">
                <Label htmlFor="dlg-api-url" className="text-xs">{t("settings.api_base_url")}</Label>
                <Input
                  id="dlg-api-url"
                  placeholder={DEFAULT_API_URL}
                  value={apiUrl}
                  onChange={(e) => setApiUrl(e.target.value)}
                  className="h-8 text-sm"
                  disabled={isAuthenticated}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="dlg-api-key" className="text-xs">{t("settings.api_key")}</Label>
                <Input
                  id="dlg-api-key"
                  type="password"
                  placeholder="dk-..."
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  className="h-8 text-sm"
                  disabled={isAuthenticated}
                />
              </div>

              {error && (
                <p className="text-xs text-destructive">{error}</p>
              )}

              {isAuthenticated ? (
                <div className="flex items-center gap-3">
                  <span className="inline-flex items-center gap-1.5 text-xs text-green-600">
                    <span className="size-1.5 rounded-full bg-green-500" />
                    {t("settings.connected")}
                  </span>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 text-xs"
                    onClick={handleDisconnect}
                  >
                    {t("settings.disconnect")}
                  </Button>
                </div>
              ) : (
                <Button
                  size="sm"
                  className="h-7 text-xs"
                  onClick={handleConnect}
                  disabled={!apiKey.trim() || connecting}
                >
                  {connecting ? t("settings.connecting") : t("settings.connect")}
                </Button>
              )}
            </CardContent>
          </Card>
        </div>
      </DialogContent>
    </Dialog>
  );
}
