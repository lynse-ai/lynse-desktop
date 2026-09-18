"use client";

import { useState, useEffect, type ReactNode } from "react";
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
import { useTheme } from "@lynse/ui/components/common/theme-provider";
import { useTranslation } from "@lynse/core/i18n/react";
import {
  Sun,
  Moon,
  Monitor,
  UserCircle,
  Languages,
  CalendarDays,
  Cloud,
  Bot,
  Briefcase,
  Captions,
  Info,
} from "../icons";
import { cn } from "@lynse/ui/lib/utils";
import {
  getDesktopLocalTranscriptionApi,
  type DesktopLocalTranscriptionApi,
  type SttDownloadProgress,
  type SttEngine,
  type SttModelInfo,
  OFFLINE_TRANSCRIPTION_ENABLED_KEY,
} from "../workspace/local-transcription";
import type { LocalHotwordPackage, LocalVoiceprint } from "../workspace/types";
import { getDesktopMeetingDetectorApi } from "../live-translation";
import { getDesktopLiveTranslationApi } from "../live-translation/desktop-api";
import { featureFlags } from "../feature-flags";
import { getDesktopVaultApi } from "../workspace/note-vault";
import { getDesktopWebdavSyncApi } from "./webdav-sync";
import { getDesktopFeishuApi } from "../feishu/feishu";
import { AboutContent } from "../about/about-content";
import { AccountCard } from "./account-card";
import { StorageCard } from "./storage-card";
import { SttConfigSection } from "./stt-config-section";
import { LiveTranslationConfigCard } from "./live-translation-config-card";
import { RecordingDevicesCard } from "./recording-devices-card";
import { AutoRecordConfigCard } from "./auto-record-config-card";
import { VaultConfigCard } from "./vault-config-card";
import { WebdavSyncConfigCard } from "./webdav-sync-config-card";
import { FeishuConfigCard } from "../feishu/feishu-config-card";
import { WorkBuddyConfigCard } from "./workbuddy-config-card";
// Fixed width AND height so switching sections never resizes the window —
// each section scrolls inside the same body pane.
export const SETTINGS_DIALOG_CONTENT_CLASS =
  "sm:max-w-3xl h-[min(90vh,760px)] grid-rows-[auto_minmax(0,1fr)] gap-0 overflow-hidden p-0";
// Two-pane layout: category nav on the left, active section content on the
// right (WeChat-style settings).
export const SETTINGS_NAV_CLASS =
  "w-40 shrink-0 space-y-0.5 overflow-y-auto border-e bg-muted/30 p-2 sm:w-48";
export const SETTINGS_BODY_CLASS = "min-h-0 min-w-0 flex-1 overflow-y-auto";

type ThemeOption = "light" | "dark" | "system";

type SettingsSectionId =
  | "account"
  | "live_translation"
  | "auto_record"
  | "sync"
  | "feishu"
  | "workbuddy"
  | "stt"
  | "about";

interface SettingsSection {
  id: SettingsSectionId;
  label: string;
  icon: typeof Sun;
  content: ReactNode;
}

export function SettingsDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { theme, setTheme } = useTheme();
  const { t } = useTranslation();

  const themeOptions: { value: ThemeOption; label: string; icon: typeof Sun }[] = [
    { value: "light", label: t("layout.theme_light"), icon: Sun },
    { value: "dark", label: t("layout.theme_dark"), icon: Moon },
    { value: "system", label: t("layout.theme_system"), icon: Monitor },
  ];

  const [activeSectionId, setActiveSectionId] = useState<SettingsSectionId>("account");
  const [offlineTranscription, setOfflineTranscription] = useState(false);
  const localTranscriptionApi = getDesktopLocalTranscriptionApi();
  const hasLocalTranscription = !!localTranscriptionApi;
  const [models, setModels] = useState<SttModelInfo[]>([]);
  const [modelBusy, setModelBusy] = useState(false);
  const [modelError, setModelError] = useState<string | null>(null);
  const [downloadProgress, setDownloadProgress] = useState<SttDownloadProgress | null>(null);
  const [hotwordPackages, setHotwordPackages] = useState<LocalHotwordPackage[]>([]);
  const [voiceprints, setVoiceprints] = useState<LocalVoiceprint[]>([]);
  const [hotwordName, setHotwordName] = useState("");
  const [hotwordText, setHotwordText] = useState("");

  useEffect(() => {
    if (open) {
      setOfflineTranscription(localStorage.getItem(OFFLINE_TRANSCRIPTION_ENABLED_KEY) === "1");
      refreshModels();
      refreshLocalAssets();
    }
  }, [open]);

  // Subscribe once to download-progress events so the progress bar can update
  // live while a model downloads. Only one download runs at a time (Rust holds
  // a global lock), so a single latest-progress state is sufficient.
  useEffect(() => {
    if (!localTranscriptionApi) return;
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    localTranscriptionApi.onSttDownloadProgress((progress) => {
      setDownloadProgress(progress);
    }).then((fn) => {
      if (!cancelled) unlisten = fn;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [localTranscriptionApi]);

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
    setDownloadProgress(null);
    try {
      setModels((await localTranscriptionApi.downloadSttModel(provider, modelId)).models);
    } catch (e: unknown) {
      setModelError(e instanceof Error ? e.message : t("settings.local_model_download_failed"));
    } finally {
      setModelBusy(false);
      setDownloadProgress(null);
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

  // Only sections available in the current environment get a nav entry; the
  // availability checks mirror the ones the config cards use internally.
  const sections: SettingsSection[] = [];

  // Account & Storage: identity + quota, appearance, and local disk usage.
  sections.push({
    id: "account",
    label: t("settings.account_storage"),
    icon: UserCircle,
    content: (
      <>
        <AccountCard />

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
                      "flex flex-col items-center gap-1.5 rounded-lg border-2 px-2 py-2 text-xs font-medium transition-[border-color,background-color,color]",
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

        <StorageCard onManageModels={hasLocalTranscription ? () => setActiveSectionId("stt") : undefined} />
      </>
    ),
  });

  if (getDesktopLiveTranslationApi()) {
    sections.push({
      id: "live_translation",
      label: t("settings.live_translation"),
      icon: Languages,
      content: (
        <div className="space-y-4">
          <LiveTranslationConfigCard />
          <RecordingDevicesCard />
        </div>
      ),
    });
  }

  if (featureFlags.autoRecord && getDesktopMeetingDetectorApi()) {
    sections.push({
      id: "auto_record",
      label: t("auto_record.title"),
      icon: CalendarDays,
      content: <AutoRecordConfigCard />,
    });
  }

  // Vault and WebDAV are both note-sync targets; they share one page.
  if (getDesktopVaultApi() || getDesktopWebdavSyncApi()) {
    sections.push({
      id: "sync",
      label: t("settings.sync"),
      icon: Cloud,
      content: (
        <>
          <VaultConfigCard />
          <WebdavSyncConfigCard />
        </>
      ),
    });
  }

  if (getDesktopFeishuApi()) {
    sections.push({
      id: "feishu",
      label: t("feishu.title"),
      icon: Bot,
      content: <FeishuConfigCard />,
    });
  }

  // WorkBuddy authorization is plain backend HTTP plus the system browser, so
  // it is available everywhere the user is signed in — no desktop API gate.
  sections.push({
    id: "workbuddy",
    label: t("workbuddy.title"),
    icon: Briefcase,
    content: <WorkBuddyConfigCard />,
  });

  if (hasLocalTranscription) {
    sections.push({
      id: "stt",
      label: t("settings.stt"),
      icon: Captions,
      content: (
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
              <>
                <SttConfigSection
                  api={localTranscriptionApi as DesktopLocalTranscriptionApi}
                  models={models}
                  modelBusy={modelBusy}
                  modelError={modelError}
                  downloadProgress={downloadProgress}
                  onDownloadModel={handleDownloadModel}
                  onDeleteModel={handleDeleteModel}
                  hotwordPackages={hotwordPackages}
                />

                <div className="rounded-md border bg-muted/30 p-2.5">
                  <p className="text-xs font-medium">{t("settings.hotword_packages")}</p>
                  <div className="mt-2 space-y-2">
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
                  </div>
                </div>

                <div className="rounded-md border bg-muted/30 p-2.5">
                  <p className="text-xs font-medium">{t("settings.voiceprints")}</p>
                  <div className="mt-2 space-y-1">
                    {voiceprints.length === 0 ? (
                      <p className="text-2xs text-muted-foreground">
                        {t("settings.voiceprints_empty")}
                      </p>
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
                          {t("settings.delete")}
                        </Button>
                      </div>
                    ))}
                  </div>
                </div>
              </>
            )}
          </CardContent>
        </Card>
      ),
    });
  }

  // About is environment-independent (desktop window on Tauri, dialog fallback
  // on web), so it always gets a nav entry — last, like native settings apps.
  sections.push({
    id: "about",
    label: t("layout.about"),
    icon: Info,
    content: <AboutContent />,
  });

  const activeSection =
    sections.find((section) => section.id === activeSectionId) ?? sections[0];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={SETTINGS_DIALOG_CONTENT_CLASS}>
        <DialogHeader className="border-b px-4 py-3 pe-12">
          <DialogTitle>{t("nav.settings")}</DialogTitle>
        </DialogHeader>

        <div className="flex min-h-0 min-w-0">
          <nav className={SETTINGS_NAV_CLASS} aria-label={t("nav.settings")}>
            {sections.map((section) => {
              const isActive = section.id === activeSection?.id;
              const Icon = section.icon;
              return (
                <button
                  key={section.id}
                  type="button"
                  onClick={() => setActiveSectionId(section.id)}
                  aria-current={isActive ? "true" : undefined}
                  className={cn(
                    "flex items-center gap-2 rounded-md px-2.5 py-2 text-left text-xs font-medium transition-colors",
                    isActive
                      ? "bg-background text-foreground shadow-sm"
                      : "text-muted-foreground hover:bg-background/60 hover:text-foreground"
                  )}
                >
                  <Icon className={cn("size-3.5 shrink-0", isActive && "text-primary")} />
                  <span className="truncate">{section.label}</span>
                </button>
              );
            })}
          </nav>

          <div className={SETTINGS_BODY_CLASS}>
            {/* About fills the pane so its copyright block pins to the bottom
                like the native About window; other sections stack cards. */}
            {activeSection?.id === "about" ? (
              <div className="h-full px-4 pb-4">{activeSection.content}</div>
            ) : (
              <div className="space-y-4 px-4 py-4">{activeSection?.content}</div>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
