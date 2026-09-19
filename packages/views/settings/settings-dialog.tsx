"use client";

import { useState, type ReactNode } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@lynse/ui/components/ui/dialog";
import { Card, CardContent, CardHeader, CardTitle } from "@lynse/ui/components/ui/card";
import { Label } from "@lynse/ui/components/ui/label";
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
  Captions,
  Info,
  Puzzle,
} from "../icons";
import { cn } from "@lynse/ui/lib/utils";
import {
  getDesktopLocalTranscriptionApi,
} from "../workspace/local-transcription";
import { getDesktopMeetingDetectorApi } from "../live-translation";
import { getDesktopLiveTranslationApi } from "../live-translation/desktop-api";
import { featureFlags } from "../feature-flags";
import { getDesktopVaultApi } from "../workspace/note-vault";
import { getDesktopWebdavSyncApi } from "./webdav-sync";
import { AboutContent } from "../about/about-content";
import { AccountCard } from "./account-card";
import { StorageCard } from "./storage-card";
import { SttSettingsSection } from "./stt-settings-section";
import { LiveTranslationConfigCard } from "./live-translation-config-card";
import { RecordingDevicesCard } from "./recording-devices-card";
import { AutoRecordConfigCard } from "./auto-record-config-card";
import { VaultConfigCard } from "./vault-config-card";
import { WebdavSyncConfigCard } from "./webdav-sync-config-card";
import {
  getSettingsSections,
  PluginCommunitySection,
  usePluginStore,
} from "../plugins";
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
  | "plugins"
  | "about"
  // Plugin contributions may register additional section ids at runtime.
  | (string & {});

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
  const pluginEntries = usePluginStore((s) => s.entries);
  const localTranscriptionApi = getDesktopLocalTranscriptionApi();
  const hasLocalTranscription = !!localTranscriptionApi;

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

  // The Feishu and WorkBuddy sections are plugin-contributed (see
  // plugins/builtin) and appear through the loop below.

  // Plugin-contributed sections (WorkBuddy is the first contributor). With
  // the marketplace flag off, every available contributor renders
  // unconditionally — the exact pre-plugin behavior, i.e. the rollback path.
  for (const { manifest, section } of getSettingsSections(pluginEntries, {
    respectInstallState: featureFlags.pluginMarketplace,
  })) {
    const SectionContent = section.component;
    sections.push({
      id: section.id,
      label: t(section.titleKey ?? manifest.nameKey),
      icon: manifest.icon,
      content: <SectionContent />,
    });
  }

  if (hasLocalTranscription) {
    sections.push({
      id: "stt",
      label: t("settings.stt"),
      icon: Captions,
      content: (
        <SttSettingsSection
          onBrowseModels={
            featureFlags.pluginMarketplace ? () => setActiveSectionId("plugins") : undefined
          }
        />
      ),
    });
  }

  if (featureFlags.pluginMarketplace) {
    sections.push({
      id: "plugins",
      label: t("plugins.community.title"),
      icon: Puzzle,
      content: <PluginCommunitySection onOpenSection={setActiveSectionId} />,
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
