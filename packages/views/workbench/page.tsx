"use client";

import { useEffect, useState } from "react";
import { useTranslation } from "@lynse/core/i18n/react";
import { memoryApi } from "@lynse/core/api/memory";
import { api } from "@lynse/core/api";
import { useAuthStore } from "@lynse/core/auth";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@lynse/ui/components/ui/button";
import { Input } from "@lynse/ui/components/ui/input";
import { ArrowLeft, Brain, BookOpen, List, Network, Search, Settings } from "../icons";
import { useNavigation } from "../navigation";
import { BetaBadge } from "../beta-badge";
import { SwapFade } from "../swap-fade";
import { VaultConfigCard } from "../settings/vault-config-card";
import { getWorkbenchApi, useWorkbench, useWikiEnabled } from "./api";
import { MemoryLibrary } from "./memory-library";
import { MemoryManagementPage } from "./memory-management";
import { useWiki, WikiAttention } from "./wiki";
import { WikiWorkspace } from "./wiki-workspace";
import { HierarchyStatus } from "./wiki-grouping";
import { WorkbenchSettingsContent } from "./components";
import { isWikiProcessingComplete, WorkbenchProgress } from "./progress";
import { wikiModelErrorKey, workbenchErrorCopy } from "./errors";

import { SettingsDialog } from "../settings/settings-dialog";

export function KnowledgePage() {
  const { t } = useTranslation();
  const navigation = useNavigation();
  const wikiEnabled = useWikiEnabled();
  const status = useWorkbench((state) => state.status);
  const error = useWorkbench((state) => state.error);
  const failure = error || status?.error || "";
  const modelError = wikiModelErrorKey(failure);
  const errorCopy = workbenchErrorCopy(failure);
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
        <h1 className={`flex shrink-0 items-center gap-2 font-semibold ${tab === "wiki" ? "text-sm" : "text-lg"}`} aria-label={title} data-tauri-drag-region><Icon aria-hidden="true" className={tab === "wiki" ? "size-4 shrink-0" : "size-5 shrink-0"} />{title}<span aria-hidden="true"><BetaBadge /></span></h1>
        {tab === "wiki" && <div className="flex items-center gap-1" role="group" aria-label={t("workbench.auto_views")} data-tauri-drag-region={false}>
          {[{ id: "graph", label: "workbench.graph_title", shortLabel: "workbench.auto_graph_view", icon: Network }, { id: "catalog", label: "workbench.auto_catalog", shortLabel: "workbench.auto_catalog_view", icon: List }].map(({ id, label, shortLabel, icon: ViewIcon }) => <Button key={id} size="sm" variant={view === id ? "secondary" : "ghost"} aria-label={t(label)} aria-pressed={view === id} onClick={() => navigation.replace(`/memory?tab=wiki${id === "catalog" ? "&view=catalog" : ""}`)}><ViewIcon className="size-3.5" aria-hidden="true" />{t(shortLabel)}</Button>)}
        </div>}
        {tab === "settings" && <p className="mt-1 text-xs text-muted-foreground">{t("workbench.memory_hint")}</p>}
      </div>
      <div className="flex shrink-0 flex-wrap items-center justify-end gap-2" data-tauri-drag-region={false}>
        {tab === "wiki" && status?.enabled && <Button size="sm" variant="ghost" onClick={() => useWorkbench.getState().show()}><Search className="size-4" aria-hidden="true" />{t("workbench.search")}</Button>}
        {tab === "wiki" ? <Button size="icon-sm" variant="ghost" aria-label={t("workbench.memory_settings")} onClick={() => changeTab("settings")}><Settings className="size-4" aria-hidden="true" /></Button> : <Button size="sm" variant="ghost" onClick={() => tab === "library" ? setAssistantSettingsOpen(true) : changeTab("wiki")}><ArrowLeft className="size-4 rtl:rotate-180" aria-hidden="true" />{t(tab === "library" ? "workbench.memory_back_assistant" : "workbench.auto_back")}</Button>}
      </div>
    </header>
    {available && tab === "wiki" && status?.enabled && !isWikiProcessingComplete(status, error) && <section className="shrink-0 border-b border-border px-5 py-3" aria-label={t("workbench.home_progress_label")}><WorkbenchProgress status={status} error={error} compact /></section>}
    {!available ? <p className="p-5 text-sm text-muted-foreground">{t("workbench.memory_unavailable")}</p> : <div className={"min-h-0 flex-1 overflow-y-auto px-5 py-4" + (tab === "wiki" ? " flex flex-col" : "")}>
      <div className={`mx-auto w-full space-y-4 ${tab === "wiki" ? "flex min-h-0 flex-1 flex-col " : ""}${tab === "settings" ? "max-w-4xl" : "max-w-none"}`}>
        {tab === "wiki" && <SwapFade viewKey="wiki" className="flex min-h-0 flex-1 flex-col gap-4"><>
          {!!wiki.data?.topics.length && !navigation.searchParams.has("topic") && <HierarchyStatus wiki={wiki} onCreated={id => navigation.replace(`/memory?${new URLSearchParams({tab:"wiki",topic:id,view})}`)} />}
          {failure && errorCopy?.key !== "workbench.error_topics" && (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border p-3">
              <p role="alert" className="text-sm text-destructive">{t(modelError ?? errorCopy?.key ?? "workbench.auto_update_failed", { count: errorCopy?.count })}</p>
              <div className="flex flex-wrap gap-2">
                {modelError && <Button size="sm" variant="outline" onClick={() => changeTab("settings")}>{t("workbench.auto_settings")}</Button>}
                <Button size="sm" variant="outline" disabled={wiki.busy || !automatic} onClick={() => void wiki.mutate({ action: "retry" }).catch(() => undefined)}>{t("workbench.retry")}</Button>
              </div>
            </div>
          )}
          <WikiAttention />
          {(!status?.automation || !status.enabled || !status.allowAi) && <WorkbenchSettingsContent activation />}
          <WikiWorkspace key={status?.scope} />
        </></SwapFade>}
        {tab === "library" && <SwapFade viewKey="library"><MemoryLibrary key={status?.scope} /></SwapFade>}
        {tab === "settings" && <SwapFade viewKey="settings"><VaultConfigCard key={status?.scope} wikiSettings /></SwapFade>}
      </div>
    </div>}
    {assistantSettingsOpen && <SettingsDialog open onOpenChange={setAssistantSettingsOpen} initialSectionId="ai_assistant" />}
  </main>;
}

export function MemoryPage() {
  const navigation = useNavigation();
  const legacyLibrary = navigation.searchParams.get("tab") === "library";
  useEffect(() => {
    if (legacyLibrary) navigation.replace("/memory/manage?view=files");
  }, [legacyLibrary, navigation]);
  if (legacyLibrary) return null;
  if (navigation.pathname === "/memory/manage") return <MemoryManagementPage />;
  return getWorkbenchApi() ? <KnowledgePage /> : <AccountKnowledgeSearch />;
}

function AccountKnowledgeSearch() {
  const { t } = useTranslation();
  const user = useAuthStore(state => state.user);
  const [draft, setDraft] = useState("");
  const [query, setQuery] = useState("");
  const result = useQuery({
    queryKey: ["account-knowledge-search", api().getBaseUrl(), api().getAgentBaseUrl(), user?.id, query],
    queryFn: ({ signal }) => memoryApi.searchKnowledge(query, signal),
    enabled: !!user && !!query,
    gcTime: 0,
    retry: false,
  });
  const items = user && result.isSuccess && !result.isFetching ? result.data.items : undefined;
  return <main className="min-h-0 min-w-0 flex-1 overflow-y-auto p-5">
    <div className="mx-auto max-w-3xl space-y-5">
      <h1 className="text-lg font-semibold">{t("workbench.auto_title")}</h1>
      <form className="flex gap-2" onSubmit={event => { event.preventDefault(); setQuery(draft.trim()); }}>
        <Input type="search" value={draft} maxLength={512} onChange={event => setDraft(event.target.value)} aria-label={t("workbench.search")} placeholder={t("workbench.search")} />
        <Button type="submit" disabled={!user || !draft.trim()}>{t("workbench.search")}</Button>
      </form>
      {!user && <p role="status" className="text-sm text-muted-foreground">{t("memory_manager.sign_in")}</p>}
      {result.isFetching && <p role="status" className="text-sm text-muted-foreground">{t("memory_manager.loading")}</p>}
      {result.error && <p role="alert" className="text-sm text-destructive">{t("memory_manager.connection_failed")}</p>}
      {items && result.data?.retrieval?.degraded && <p role="status" className="text-sm text-muted-foreground">{t("workbench.knowledge_keyword_fallback")}</p>}
      {items && !items.length && <p role="status" className="text-sm text-muted-foreground">{t("workbench.no_results")}</p>}
      {items?.map(item => <article key={item.id} className="space-y-2 rounded-lg border border-border p-4">
        <h2 className="break-words text-sm font-semibold">{item.title}</h2>
        <blockquote className="whitespace-pre-wrap break-words text-sm leading-relaxed">{item.excerpt}</blockquote>
        <p className="break-all text-xs text-muted-foreground">{t("workbench.source")} {item.source.id}</p>
      </article>)}
    </div>
  </main>;
}
