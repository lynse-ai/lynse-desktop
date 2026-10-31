"use client";

import { lazy, Suspense, useEffect, useState } from "react";
import { useTranslation } from "@lynse/core/i18n/react";
import { Button } from "@lynse/ui/components/ui/button";
import { ArrowLeft, Brain, BookOpen, List, Network, Settings } from "../icons";
import { useNavigation } from "../navigation";
import { VaultConfigCard } from "../settings/vault-config-card";
import { getWorkbenchApi, useWorkbench, useWikiEnabled } from "./api";
import { MemoryLibrary } from "./memory-library";
import { MemoryManagementPage } from "./memory-management";
import { useWiki, WikiAttention } from "./wiki";
import { WikiWorkspace } from "./wiki-workspace";
import { HierarchyStatus } from "./wiki-grouping";
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
  const view = navigation.searchParams.get("view") === "catalog" ? "catalog" : "graph";
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
    <header className={tab === "wiki" ? "flex min-h-12 shrink-0 items-center gap-3 border-b border-border px-5 py-2" : "flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-4"} data-tauri-drag-region>
      <div className={tab === "wiki" ? "flex min-w-0 flex-1 flex-wrap items-center gap-x-4 gap-y-2" : "min-w-0"} data-tauri-drag-region>
        <h1 className={`flex shrink-0 items-center gap-2 font-semibold ${tab === "wiki" ? "text-sm" : "text-lg"}`} aria-label={title} data-tauri-drag-region><Icon aria-hidden="true" className={tab === "wiki" ? "size-4 shrink-0" : "size-5 shrink-0"} />{title}</h1>
        {tab === "wiki" && <div className="flex items-center gap-1" role="group" aria-label={t("workbench.auto_views")} data-tauri-drag-region={false}>
          {[{ id: "graph", label: "workbench.graph_title", shortLabel: "workbench.auto_graph_view", icon: Network }, { id: "catalog", label: "workbench.auto_catalog", shortLabel: "workbench.auto_catalog_view", icon: List }].map(({ id, label, shortLabel, icon: ViewIcon }) => <Button key={id} size="sm" variant={view === id ? "secondary" : "ghost"} aria-label={t(label)} aria-pressed={view === id} onClick={() => navigation.replace(`/memory?tab=wiki${id === "catalog" ? "&view=catalog" : ""}`)}><ViewIcon className="size-3.5" aria-hidden="true" />{t(shortLabel)}</Button>)}
        </div>}
        {tab === "settings" && <p className="mt-1 text-xs text-muted-foreground">{t("workbench.memory_hint")}</p>}
      </div>
      <div className="flex shrink-0 flex-wrap items-center justify-end gap-2" data-tauri-drag-region={false}>
        {tab === "wiki" ? <Button size="icon-sm" variant="ghost" aria-label={t("workbench.memory_settings")} onClick={() => changeTab("settings")}><Settings className="size-4" aria-hidden="true" /></Button> : <Button size="sm" variant="ghost" onClick={() => tab === "library" ? setAssistantSettingsOpen(true) : changeTab("wiki")}><ArrowLeft className="size-4 rtl:rotate-180" aria-hidden="true" />{t(tab === "library" ? "workbench.memory_back_assistant" : "workbench.auto_back")}</Button>}
      </div>
    </header>
    {available && tab === "wiki" && status?.enabled && !isWikiProcessingComplete(status, error) && <section className="shrink-0 border-b border-border px-5 py-3" aria-label={t("workbench.home_progress_label")}><WorkbenchProgress status={status} error={error} compact /></section>}
    {!available ? <p className="p-5 text-sm text-muted-foreground">{t("workbench.memory_unavailable")}</p> : <div className={"min-h-0 flex-1 overflow-y-auto px-5 py-4" + (tab === "wiki" ? " flex flex-col" : "")}>
      <div className={`mx-auto w-full space-y-4 ${tab === "wiki" ? "flex min-h-0 flex-1 flex-col " : ""}${tab === "settings" ? "max-w-4xl" : "max-w-none"}`}>
        {tab === "wiki" && <>
          {!!wiki.data?.topics.length && !navigation.searchParams.has("topic") && <HierarchyStatus wiki={wiki} onCreated={id => navigation.replace(`/memory?${new URLSearchParams({tab:"wiki",topic:id,view})}`)} />}
          {(error || status?.error) && errorCopy?.key !== "workbench.error_topics" && <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border p-3"><p className="text-sm text-muted-foreground">{t(errorCopy?.key ?? "workbench.auto_update_failed", { count: errorCopy?.count })}</p><Button size="sm" variant="outline" disabled={wiki.busy || !automatic} onClick={() => void wiki.mutate({ action: "retry" }).catch(() => undefined)}>{t("workbench.retry")}</Button></div>}
          <WikiAttention />
          {(!status?.automation || !status.enabled || !status.allowAi) && <WorkbenchSettingsContent activation />}
          <WikiWorkspace key={status?.scope} />
        </>}
        {tab === "library" && <MemoryLibrary key={status?.scope} />}
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
