"use client";

import { lazy, Suspense, useEffect, useState } from "react";
import { useTranslation } from "@lynse/core/i18n/react";
import { Button } from "@lynse/ui/components/ui/button";
import { ArrowLeft, Brain, BookOpen, Settings } from "../icons";
import { useNavigation } from "../navigation";
import { BetaBadge } from "../beta-badge";
import { VaultConfigCard } from "../settings/vault-config-card";
import { getWorkbenchApi, useWorkbench, useWikiEnabled } from "./api";
import { MemoryLibrary } from "./memory-library";
import { MemoryManagementPage } from "./memory-management";
import { useWiki } from "./wiki";
import { WikiWorkspace } from "./wiki-workspace";
import { WorkbenchSettingsContent } from "./components";
import { isWikiProcessingComplete, WorkbenchProgress } from "./progress";
import { workbenchErrorCopy } from "./errors";

const AssistantSettingsDialog = lazy(() => import("../settings/settings-dialog").then(module => ({ default: module.SettingsDialog })));

export function KnowledgePage() {
  const { t } = useTranslation();
  const navigation = useNavigation();
  const wikiEnabled = useWikiEnabled();
  const status = useWorkbench((state) => state.status);
  const error = useWorkbench((state) => state.error);
  const errorCopy = workbenchErrorCopy(error || status?.error || "");
  const [assistantSettingsOpen, setAssistantSettingsOpen] = useState(false);
  const requestedTab = navigation.searchParams.get("tab");
  const tab = requestedTab === "library" || requestedTab === "settings" ? requestedTab : "wiki";
  const available = !!getWorkbenchApi();
  const wiki = useWiki();
  const automatic = !!status?.enabled && status.allowAi && !!status.automation;
  const processing = automatic && (!status.initialComplete || (!!status.wikiProgress && status.wikiProgress.stage !== "complete"));
  useEffect(() => { if (!wikiEnabled) navigation.replace("/home"); }, [wikiEnabled, navigation]);

  // Keep topic links and the current directory/graph view through settings.
  function changeTab(next: "wiki" | "settings") {
    const params = new URLSearchParams(navigation.searchParams);
    params.set("tab", next);
    navigation.replace(`/memory?${params}`);
  }
  const title = t(tab === "library" ? "workbench.memory_library" : tab === "settings" ? "workbench.memory_settings" : "workbench.auto_title");
  const Icon = tab === "library" ? Brain : BookOpen;

  if (!wikiEnabled) return null;
  return <main className="flex min-h-0 min-w-0 flex-1 flex-col" aria-label={title}>
    <header className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-4" data-tauri-drag-region>
      <div className="min-w-0" data-tauri-drag-region>
        <h1 className="flex items-center gap-2 text-lg font-semibold" aria-label={title} aria-description={t("settings.beta_badge")} data-tauri-drag-region><Icon aria-hidden="true" className="size-5 shrink-0" />{title}<span aria-hidden="true"><BetaBadge /></span></h1>
        {tab !== "library" && <p className="mt-1 text-xs text-muted-foreground">{t(tab === "wiki" ? "workbench.auto_subtitle" : "workbench.memory_hint")}</p>}
      </div>
      <div className="flex flex-wrap items-center justify-end gap-2">
        {tab === "wiki" ? <><p role="status" className="hidden text-xs text-muted-foreground sm:block">{t(!status?.automation ? "workbench.auto_needs_scope" : processing ? "workbench.auto_processing" : automatic ? "workbench.auto_active" : "workbench.auto_paused")}</p><Button size="icon-sm" variant="ghost" aria-label={t("workbench.memory_settings")} onClick={() => changeTab("settings")}><Settings className="size-4" aria-hidden="true" /></Button></> : <Button size="sm" variant="ghost" onClick={() => tab === "library" ? setAssistantSettingsOpen(true) : changeTab("wiki")}><ArrowLeft className="size-4 rtl:rotate-180" aria-hidden="true" />{t(tab === "library" ? "workbench.memory_back_assistant" : "workbench.auto_back")}</Button>}
      </div>
    </header>
    {available && tab === "wiki" && status?.enabled && !isWikiProcessingComplete(status, error) && <section className="shrink-0 border-b border-border px-5 py-3" aria-label={t("workbench.home_progress_label")}><WorkbenchProgress status={status} error={error} compact /></section>}
    {!available ? <p className="p-5 text-sm text-muted-foreground">{t("workbench.memory_unavailable")}</p> : <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
      <div className={`mx-auto space-y-4 ${tab === "settings" ? "max-w-4xl" : "max-w-none"}`}>
        {tab === "wiki" && <>
          {(error || status?.error) && <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border p-3"><p className="text-sm text-muted-foreground">{t(errorCopy?.key ?? "workbench.auto_update_failed", { count: errorCopy?.count })}</p><Button size="sm" variant="outline" disabled={wiki.busy || !automatic} onClick={() => void wiki.mutate({ action: "retry" }).catch(() => undefined)}>{t("workbench.retry")}</Button></div>}
          {(!status?.automation || !status.enabled || !status.allowAi) && <WorkbenchSettingsContent activation />}
          <WikiWorkspace key={status?.scope} />
        </>}
        <div hidden={tab !== "library"}><MemoryLibrary key={status?.scope} /></div>
        {tab === "settings" && <VaultConfigCard key={status?.scope} wikiSettings />}
      </div>
    </div>}
    {assistantSettingsOpen && <Suspense fallback={null}><AssistantSettingsDialog open onOpenChange={setAssistantSettingsOpen} initialSectionId="ai_assistant" /></Suspense>}
  </main>;
}

export function MemoryPage() {
  const navigation = useNavigation();
  const legacyLibrary = navigation.searchParams.get("tab") === "library";
  useEffect(() => {
    if (legacyLibrary) navigation.replace("/memory/manage?view=files");
  }, [legacyLibrary, navigation]);
  if (legacyLibrary) return null;
  return navigation.pathname === "/memory/manage" ? <MemoryManagementPage /> : <KnowledgePage />;
}
