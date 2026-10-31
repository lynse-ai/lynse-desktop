import { api } from "./client";

export interface UsageSummary {
  mode: "shadow";
  available: true;
  totals: { calls: number; input_tokens: number; output_tokens: number; total_tokens: number; unknown_usage_calls: number; unknown_cost_calls: number };
  shadow_micro_points: number;
  charged_micro_points: 0;
  pending_orders: number;
  groups: { feature: string; model: string; credential_source: string; status: string; calls: number }[];
}

/** Explicit session token; the API client rejects stale sessions and never uses an API key. */
export async function getUsageSummary(sessionToken: string, signal?: AbortSignal): Promise<UsageSummary> {
  const client = api();
  const direct = client.getAgentBaseUrl() && client.getAgentBaseUrl() !== client.getBaseUrl();
  const result = await client.get<UsageSummary>(direct ? "/api/usage/summary" : "/api/business/ai/usage/summary", {
    baseUrl: client.getAgentBaseUrl() ?? client.getBaseUrl(), tokenOnly: true, sessionToken, signal,
  });
  if (result.mode !== "shadow" || result.available !== true || result.charged_micro_points !== 0 || !result.totals) {
    throw new Error("Usage summary unavailable");
  }
  return result;
}
