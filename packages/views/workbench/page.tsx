"use client";

import { useEffect } from "react";
import { useTranslation } from "@lynse/core/i18n/react";
import { Button } from "@lynse/ui/components/ui/button";
import { Card, CardContent } from "@lynse/ui/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@lynse/ui/components/ui/tabs";
import { Brain, BookOpen, Settings } from "../icons";
import { useNavigation } from "../navigation";
import { BetaBadge } from "../beta-badge";
import { VaultConfigCard } from "../settings/vault-config-card";
import { getWorkbenchApi, useWorkbench, useWikiEnabled } from "./api";
import { MemoryLibrary } from "./memory-library";
import { isWikiProcessingComplete, WorkbenchProgress } from "./progress";
import { WikiAttention, WikiStatus } from "./wiki";
import { WikiWorkspace } from "./wiki-workspace";

export function MemoryPage() {
  const { t } = useTranslation();
  const navigation = useNavigation();
  const wikiEnabled = useWikiEnabled();
  const status = useWorkbench((state) => state.status);
  const error = useWorkbench((state) => state.error);
  const requestedTab = navigation.searchParams.get("tab");
  const tab = requestedTab === "library" || requestedTab === "settings" ? requestedTab : "wiki";
  const available = !!getWorkbenchApi();
  useEffect(() => { if (!wikiEnabled) navigation.replace("/home"); }, [wikiEnabled, navigation]);


  if (!wikiEnabled) return null;
  return <main className="flex min-h-0 flex-1 flex-col" aria-label={t("workbench.memory_title")}>
    <header className="flex shrink-0 items-center justify-between gap-3 border-b border-border px-5 py-4" data-tauri-drag-region>
      <div className="min-w-0" data-tauri-drag-region>
        <h1 className="flex items-center gap-2 text-lg font-semibold" aria-label={t("workbench.memory_title")} aria-description={t("settings.beta_badge")} data-tauri-drag-region><Brain aria-hidden="true" className="size-5" />{t("workbench.memory_title")}<span aria-hidden="true"><BetaBadge /></span></h1>
        <p className="mt-1 text-xs text-muted-foreground">{t("workbench.memory_hint")}</p>
      </div>
    </header>
    {!available ? <p className="p-5 text-sm text-muted-foreground">{t("workbench.memory_unavailable")}</p> : <Tabs value={tab} onValueChange={(value) => navigation.replace(`/memory?tab=${value}`)} className="min-h-0 flex-1 gap-0">
      <div className="shrink-0 border-b border-border px-5 py-2">
        <TabsList aria-label={t("workbench.memory_title")} variant="line">
          <TabsTrigger value="wiki" aria-label="Wiki" aria-description={t("settings.beta_badge")}><BookOpen aria-hidden="true" />Wiki<span aria-hidden="true"><BetaBadge /></span></TabsTrigger>
          <TabsTrigger value="library"><Brain aria-hidden="true" />{t("workbench.memory_library")}</TabsTrigger>
          <TabsTrigger value="settings"><Settings aria-hidden="true" />{t("workbench.memory_settings")}</TabsTrigger>
        </TabsList>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        <div className={`mx-auto space-y-4 ${tab === "settings" ? "max-w-4xl" : "max-w-none"}`}>
          {status?.enabled && tab !== "settings" && !isWikiProcessingComplete(status, error) && <Card><CardContent><WorkbenchProgress status={status} error={error} /></CardContent></Card>}
          {tab !== "settings" && <WikiAttention />}
          <TabsContent value="wiki" className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2"><WikiStatus /><Button size="sm" variant="outline" onClick={() => useWorkbench.getState().show()}>{t("workbench.memory_browse_sources")}</Button></div>
            {!status?.enabled && <div className="space-y-3 rounded-lg border border-border p-4"><p className="text-sm text-muted-foreground">{t("workbench.memory_enable_hint")}</p><Button size="sm" onClick={() => navigation.replace("/memory?tab=settings")}>{t("workbench.memory_settings")}</Button></div>}
            <WikiWorkspace key={status?.scope} />
          </TabsContent>
          <TabsContent value="library" keepMounted><MemoryLibrary key={status?.scope} /></TabsContent>
          <TabsContent value="settings" className="space-y-4"><VaultConfigCard /></TabsContent>
        </div>
      </div>
    </Tabs>}
  </main>;
}
