"use client";

import { useQuery } from "@tanstack/react-query";
import { api } from "@lynse/core/api";
import { useAuthStore } from "@lynse/core/auth";
import { memoryApi } from "@lynse/core/api/memory";
import { useTranslation } from "@lynse/core/i18n/react";
import { Button } from "@lynse/ui/components/ui/button";
import { ArrowLeft, Brain } from "../icons";
import { useNavigation } from "../navigation";
import { TopicMemoryLibrary } from "./topic-memory-library";

function MemoryManagementContent({ account }: { account: string }) {
  const { t } = useTranslation();
  const navigation = useNavigation();
  const authenticated = useAuthStore(state => state.isAuthenticated);
  const capabilities = useQuery({ queryKey: ["memory-capabilities", account], queryFn: ({ signal }) => memoryApi.capabilities(signal), enabled: authenticated, retry: false });
  const available = !!capabilities.data?.available && capabilities.data.features.memory_management && capabilities.data.features.topic_files;
  return <main className="flex min-h-0 min-w-0 flex-1 flex-col" aria-label={t("memory_manager.title")}>
    <header className="flex shrink-0 items-center justify-between gap-3 border-b border-border px-5 py-4"><h1 className="flex items-center gap-2 text-lg font-semibold"><Brain className="size-5" aria-hidden="true" />{t("memory_manager.title")}</h1><Button variant="ghost" size="sm" onClick={() => { if (navigation.canGoBack) navigation.back(); else navigation.replace("/chat"); }}><ArrowLeft className="size-4" aria-hidden="true" />{t("memory_manager.back")}</Button></header>
    <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto p-5"><p className="text-sm text-muted-foreground">{t("memory_manager.hint")}</p>
      {!authenticated ? <p role="status">{t("memory_manager.sign_in")}</p> : capabilities.isPending ? <p role="status">{t("memory_manager.loading")}</p> : available ? <TopicMemoryLibrary account={account} /> : <div className="space-y-3"><p role="status">{t("memory_manager.unavailable")}</p><Button size="sm" variant="outline" onClick={() => { void capabilities.refetch(); }}>{t("memory_manager.refresh")}</Button></div>}
    </div>
  </main>;
}

export function MemoryManagementPage() {
  const user = useAuthStore(state => state.user);
  const account = `${api().getBaseUrl()}|${api().getAgentBaseUrl() ?? ""}|${user?.id ?? "signed-out"}`;
  return <MemoryManagementContent key={account} account={account} />;
}
