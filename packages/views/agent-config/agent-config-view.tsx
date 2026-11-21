"use client";

import { useTranslation } from "@lynse/core/i18n/react";
import { cn } from "@lynse/ui/lib/utils";
import { useNavigation } from "../navigation";
import { isWebPlatform } from "../platform";
import { OverviewTab } from "./overview-tab";
import { ApiKeysTab } from "./api-keys-tab";
import { AuthorizationsTab } from "./authorizations-tab";
import { DocsTab } from "./docs-tab";
import { AgentTab } from "./agent-tab";

/** Console tabs, mirrored from the biji.com open-platform reference:
 *  概览 / API Key / 我的授权 / 开发文档 / AI Agent. */
export type AgentConfigTab = "overview" | "keys" | "authorizations" | "docs" | "agent";

const TAB_IDS: AgentConfigTab[] = ["overview", "keys", "authorizations", "docs", "agent"];

/** Agent configuration console (web only): open-platform style tabs for
 *  overview, API keys, MCP authorizations, developer docs and AI-tool setup.
 *  Tab selection syncs to ?tab= so sections stay linkable. */
export function AgentConfigView() {
  const { t } = useTranslation();
  const { searchParams, replace } = useNavigation();
  const tab = TAB_IDS.find((id) => id === searchParams.get("tab")) ?? "overview";

  function setTab(nextTab: AgentConfigTab) {
    if (nextTab === tab) return;
    replace(nextTab === "overview" ? "/agent" : `/agent?tab=${nextTab}`);
  }

  if (!isWebPlatform()) return null;

  const labels: Record<AgentConfigTab, string> = {
    overview: t("agentConfig.tab_overview"),
    keys: t("agentConfig.tab_keys"),
    authorizations: t("agentConfig.tab_authorizations"),
    docs: t("agentConfig.tab_docs"),
    agent: t("agentConfig.tab_agent"),
  };

  // The dashboard shell never scrolls at document level (body is
  // overflow-hidden), so this page owns its vertical scroll like every
  // other view (same pattern as workbench AccountKnowledgeSearch).
  return (
    <main className="min-h-0 min-w-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-5xl space-y-5 p-4">
        <header className="space-y-1">
          <h1 className="text-lg font-semibold tracking-tight">{t("agentConfig.title")}</h1>
          <p className="text-xs leading-relaxed text-muted-foreground">{t("agentConfig.subtitle")}</p>
        </header>
        <nav aria-label={t("agentConfig.title")} className="flex flex-wrap gap-1.5 border-b pb-2">
          {TAB_IDS.map((id) => (
            <button
              key={id}
              type="button"
              aria-current={tab === id ? "true" : undefined}
              onClick={() => setTab(id)}
              className={cn(
                "rounded-lg px-3 py-1.5 text-xs font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring",
                tab === id ? "bg-foreground/5 text-foreground" : "text-muted-foreground hover:text-foreground",
              )}
            >
              {labels[id]}
            </button>
          ))}
        </nav>
        {tab === "overview" && <OverviewTab onNavigate={setTab} />}
        {tab === "keys" && <ApiKeysTab />}
        {tab === "authorizations" && <AuthorizationsTab />}
        {tab === "docs" && <DocsTab onNavigate={setTab} />}
        {tab === "agent" && <AgentTab onNavigate={setTab} />}
      </div>
    </main>
  );
}
