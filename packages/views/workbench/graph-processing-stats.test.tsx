// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { GraphProcessingStats, graphUsageCount } from "./graph-processing-stats";
import type { GraphMetrics, KnowledgeGraph } from "./types";

vi.mock("@lynse/core/i18n/react", () => ({ useTranslation: () => ({ t: (key: string, values?: Record<string, unknown>) => `${key}${values ? JSON.stringify(values) : ""}` }) }));
const metrics: GraphMetrics = { calls: 1, unknownCalls: 0, queuedMs: 3, generationMs: 50, knownCalls: { input: 1, output: 1, cachedInput: 1 } };

describe("graph usage accounting", () => {
  it("distinguishes missing usage from zero and shows known subtotals", () => {
    expect(graphUsageCount(null, "input", metrics, "unknown")).toBe("unknown");
    expect(graphUsageCount(0, "input", metrics, "unknown")).toBe("0");
    expect(graphUsageCount(10, "input", { ...metrics, calls: 2 }, "unknown")).toBe("≥10");
    expect(graphUsageCount(10, "input", { ...metrics, unknownCalls: 1 }, "unknown")).toBe("≥10");
    expect(graphUsageCount(null, "input", { ...metrics, calls: 0 }, "unknown")).toBe("0");
  });
  it("shows the fixed model and reports a repeat run without invented provider usage", () => {
    const tracking: KnowledgeGraph["tracking"] = { processing: false, completed: 2, total: 2, failed: 0, error: "", runs: [{
      kind: "repeat", startedAt: "now", elapsedMs: 10, cacheHits: 2, misses: 0, failed: 0,
      accounting: { usage: {}, metrics: { ...metrics, calls: 0, knownCalls: {} } },
    }] };
    render(<GraphProcessingStats tracking={tracking} />);
    expect(screen.getByText("workbench.graph_fixed_model")).toBeTruthy();
    expect(screen.getByLabelText("workbench.graph_run_repeat")).toBeTruthy();
    expect(screen.getByText('workbench.graph_usage_local{"hits":2,"total":2}')).toBeTruthy();
    expect(screen.queryByText("workbench.graph_usage_partial_hint")).toBeNull();
  });
  it("never displays a cache percentage from incomplete counters", () => {
    const tracking: KnowledgeGraph["tracking"] = { processing: false, completed: 1, total: 1, failed: 0, error: "", runs: [{
      kind: "initial", startedAt: "later", elapsedMs: 100, cacheHits: 0, misses: 1, failed: 0,
      accounting: { usage: { input: 100, cachedInput: 80 }, metrics: { ...metrics, calls: 2 } },
    }] };
    render(<GraphProcessingStats tracking={tracking} />);
    expect(screen.getByText("≥100")).toBeTruthy();
    expect(screen.queryByText(/workbench.graph_usage_cache_ratio/)).toBeNull();
    expect(screen.getByText("workbench.graph_usage_partial_hint")).toBeTruthy();
  });
});
