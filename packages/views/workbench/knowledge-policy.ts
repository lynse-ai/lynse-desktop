"use client";

import { useQuery } from "@tanstack/react-query";
import { api } from "@lynse/core/api";
import { useAuthStore } from "@lynse/core/auth";
import { memoryApi, memoryOperationId, type KnowledgePolicy } from "@lynse/core/api/memory";
import { getWorkbenchApi } from "./api";

export function useKnowledgePolicy() {
  const user = useAuthStore(state => state.user);
  const authenticated = useAuthStore(state => state.isAuthenticated);
  return useQuery({
    queryKey: ["knowledge-policy", api().getBaseUrl(), api().getAgentBaseUrl(), user?.id],
    queryFn: async () => {
      const native = getWorkbenchApi()?.knowledgePolicy;
      if (native) return native({ action: "read" });
      return { capabilities: await memoryApi.capabilities(), pending: false };
    },
    enabled: authenticated,
    retry: false,
    refetchOnWindowFocus: true,
  });
}

export async function updateKnowledgePolicy(current: KnowledgePolicy, changes: Partial<KnowledgePolicy>): Promise<KnowledgePolicy> {
  const native = getWorkbenchApi()?.knowledgePolicy;
  if (native) {
    const result = await native({ action: "update", policy: {
      ...changes, base_range_version: current.range_version, base_grant_version: current.grant_version,
      base_processing_version: current.processing_version,
    } });
    if (!result.policy || result.pending) throw new Error("Cloud knowledge policy pending synchronization");
    return result.policy;
  }
  return (await memoryApi.savePolicy(current, changes, memoryOperationId())).knowledge;
}
