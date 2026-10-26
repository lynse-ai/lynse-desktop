"use client";
import { useTranslation } from "@lynse/core/i18n/react";
import type { GraphMetrics, GraphUsage, KnowledgeGraph } from "./types";

export function graphUsageCount(value: number | null | undefined, field: keyof GraphUsage, metrics: GraphMetrics, unknown: string): string {
  if (metrics.calls === 0 && metrics.unknownCalls === 0) return "0";
  if (value == null) return unknown;
  const complete = metrics.unknownCalls === 0 && (metrics.knownCalls[field] ?? 0) === metrics.calls;
  return `${complete ? "" : "≥"}${value.toLocaleString()}`;
}

export function GraphProcessingStats({ tracking }: { tracking: KnowledgeGraph["tracking"] }) {
  const { t } = useTranslation();
  const unknown = t("workbench.graph_usage_unknown");
  const runs = tracking.runs?.slice(-3).reverse() ?? [];
  return <details className="text-xs text-muted-foreground">
    <summary className="cursor-pointer font-medium">{t("workbench.graph_usage")}</summary>
    <p className="mt-2">{t("workbench.graph_fixed_model")}</p>
    {!runs.length && <p className="mt-2">{unknown}</p>}
    <div className="mt-2 space-y-3">{runs.map((run, index) => {
      const { usage, metrics } = run.accounting;
      const completeInput = metrics.unknownCalls === 0 && metrics.knownCalls.input === metrics.calls;
      const completeCached = metrics.unknownCalls === 0 && metrics.knownCalls.cachedInput === metrics.calls;
      const ratio = completeInput && completeCached && usage.input != null && usage.input > 0 && usage.cachedInput != null
        ? Math.round(100 * usage.cachedInput / usage.input) : null;
      const calls = metrics.unknownCalls ? metrics.calls ? `≥${metrics.calls}` : unknown : String(metrics.calls);
      return <article key={`${run.startedAt}-${index}`} aria-label={t(`workbench.graph_run_${run.kind}`)} className="space-y-2 rounded border border-border p-2">
        <p className="font-medium text-foreground">{t(`workbench.graph_run_${run.kind}`)}</p>
        <p>{t("workbench.graph_usage_local", { hits: run.cacheHits, total: run.cacheHits + run.misses })}</p>
        <dl className="grid grid-cols-2 gap-x-3 gap-y-1">
          <dt>{t("workbench.graph_usage_calls")}</dt><dd className="text-right tabular-nums">{calls}</dd>
          {(["input", "output", "cachedInput"] as const).map(field => <div key={field} className="contents">
            <dt>{t(`workbench.graph_usage_${field === "cachedInput" ? "cached" : field}`)}</dt>
            <dd className="text-right tabular-nums">{graphUsageCount(usage[field], field, metrics, unknown)}</dd>
          </div>)}
        </dl>
        {ratio != null && <p>{t("workbench.graph_usage_cache_ratio", { value: ratio })}</p>}
        <p>{t("workbench.graph_usage_time", {
          elapsed: (run.elapsedMs / 1000).toFixed(1),
          queued: (metrics.queuedMs / 1000).toFixed(1),
          generation: metrics.unknownCalls || (metrics.completedCalls ?? 0) < metrics.calls ? unknown : (metrics.generationMs / 1000).toFixed(1),
        })}</p>
        {(metrics.unknownCalls > 0 || (metrics.calls > 0 && (metrics.knownCalls.input ?? 0) < metrics.calls)) && <p>{t("workbench.graph_usage_partial_hint")}</p>}
      </article>;
    })}</div>
  </details>;
}
