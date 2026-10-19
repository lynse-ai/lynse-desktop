"use client";

import { useState, type ReactNode } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@lynse/ui/components/ui/dialog";
import { Card, CardContent, CardHeader, CardTitle } from "@lynse/ui/components/ui/card";
import { useTranslation } from "@lynse/core/i18n/react";
import {
  Sun,
  UserCircle,
  Languages,
  CalendarDays,
  Cloud,
  Captions,
  Info,
  Puzzle,
  Bot,
  Plug,
} from "../icons";
import { cn } from "@lynse/ui/lib/utils";
import { isWebPlatform } from "../platform";
import { ConnectionsCard } from "../connections";
import {
  getDesktopLocalTranscriptionApi,
} from "../workspace/local-transcription";
import { getDesktopMeetingDetectorApi } from "../live-translation";
import { getDesktopLiveTranslationApi } from "../live-translation/desktop-api";
import { featureFlags, isConnectionsEnabled, isBetaFeaturesUnlocked } from "../feature-flags";
import { BetaBadge } from "../beta-badge";
import { getDesktopVaultApi } from "../workspace/note-vault";
import { getDesktopWebdavSyncApi } from "./webdav-sync";
import { AboutContent } from "../about/about-content";
import { AccountCard } from "./account-card";
import { StorageCard } from "./storage-card";
import { SttSettingsSection } from "./stt-settings-section";
import { LiveTranslationConfigCard } from "./live-translation-config-card";
import { RecordingDevicesCard } from "./recording-devices-card";
import { AutoRecordConfigCard } from "./auto-record-config-card";
import { WorkbenchSettingsCard } from "../workbench";
import { VaultConfigCard } from "./vault-config-card";
import { WebdavSyncConfigCard } from "./webdav-sync-config-card";
import { AgentServerCard } from "./agent-server-card";
import { McpConfigCard } from "./mcp-config-card";
import { ModelConfigCard } from "./model-config-card";
import { WorkBuddyConfigCard } from "./workbuddy-config-card";
import { AppearanceSection } from "./appearance-settings";
import { ContextInboxCard } from "./context-inbox-card";
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

type SettingsSectionId =
  | "account"
  | "ai_assistant"
  | "live_translation"
  | "auto_record"
  | "sync"
  | "feishu"
  | "workbuddy"
  | "stt"
  | "connections"
  | "plugins"
  | "about"
  // Plugin contributions may register additional section ids at runtime.
  | (string & {});

interface SettingsSection {
  id: SettingsSectionId;
  label: string;
  icon: typeof Sun;
  content: ReactNode;
  /** Renders a Beta chip next to the nav label (beta-gated sections only). */
  beta?: boolean;
}

export function SettingsDialog({
  open,
  onOpenChange,
  initialSectionId = "account",
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialSectionId?: SettingsSectionId;
}) {
  const { t } = useTranslation();

  const [activeSectionId, setActiveSectionId] = useState<SettingsSectionId>(initialSectionId);
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
            <AppearanceSection />
          </CardContent>
        </Card>

        <StorageCard onManageModels={hasLocalTranscription ? () => setActiveSectionId("stt") : undefined} />
      </>
    ),
  });

  // AI assistant: where lynclaw connects (route B direct agent backend) plus
  // the WorkBuddy account binding, moved in from its former standalone
  // plugin-contributed section.
  //
  // The first three cards are beta surfaces (see feature-flags.ts): debug
  // builds and dev shells show them with a Beta badge; official builds hide
  // them so the features stay off by default.
  sections.push({
    id: "ai_assistant",
    label: t("settings.ai_assistant"),
    icon: Bot,
    content: (
      <>
        {!isWebPlatform() && isBetaFeaturesUnlocked() && (
          <ContextInboxCard onOpenChat={() => onOpenChange(false)} />
        )}
        {isBetaFeaturesUnlocked() && <AgentServerCard />}
        {isBetaFeaturesUnlocked() && <ModelConfigCard />}
        <WorkBuddyConfigCard />
        <McpConfigCard />
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
          <WorkbenchSettingsCard />
          <WebdavSyncConfigCard />
        </>
      ),
    });
  }

  // The Feishu section is plugin-contributed (see plugins/builtin) and appears
  // through the loop below; WorkBuddy now lives in the AI assistant section.

  // Plugin-contributed sections. With the marketplace flag off, every
  // available contributor renders unconditionally — the exact pre-plugin
  // behavior, i.e. the rollback path.
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

  // Third-party integrations. Gated from feature-flags alone: the section
  // disappears entirely while the /api/v2/integrations backend is not
  // deployed, rather than showing rows that can only error.
  //
  // Desktop only, per PRD §2 ("P0-P2 不做 Web 端 UI"): the flag is global, so
  // without this check flipping it on would surface the section in the web app
  // too, where there is no deep-link or native surface for the flows.
  //
  // The gate is also channel-aware (isConnectionsEnabled): still in beta, so
  // official builds hide the section entirely.
  if (isConnectionsEnabled() && !isWebPlatform()) {
    sections.push({
      id: "connections",
      label: t("settings.connections"),
      icon: Plug,
      content: <ConnectionsCard />,
      beta: true,
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
                  <span className="min-w-0 flex-1 truncate">{section.label}</span>
                  {section.beta && <BetaBadge />}
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
