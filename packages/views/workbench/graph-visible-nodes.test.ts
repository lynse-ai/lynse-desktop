import { describe, expect, it } from "vitest";
import { visibleGraphNodes } from "./graph-visible-nodes";
import type { GraphNode, KnowledgeGraph } from "./types";

const topics: GraphNode[] = Array.from({ length: 100 }, (_, i) => ({ id: `topic-${i}`, title: `Topic ${String(i).padStart(3, "0")}`, kind: "topic", status: "unknown", description: "", updates: [], citations: [] }));
const sources: GraphNode[] = topics.map((node, i) => ({ ...node, id: `source-${i}`, title: `Meeting ${i}`, kind: "source", status: "source" }));
const edges: KnowledgeGraph["edges"] = topics.map((node, i) => ({ id: `evidence-${i}`, source: node.id, target: sources[i]!.id, kind: "evidence" }));

describe("bounded graph neighborhood", () => {
  it("keeps both ends of evidence links when discoveries alone exceed the limit", () => {
    const visible = visibleGraphNodes([...topics, ...sources], edges, null);
    const ids = new Set(visible.map(node => node.id));
    expect(visible).toHaveLength(90);
    expect(visible.filter(node => node.kind === "source")).toHaveLength(45);
    expect(edges.filter(edge => ids.has(edge.source) && ids.has(edge.target))).toHaveLength(45);
  });

  it("includes a selected node outside the default neighborhood with its source", () => {
    const visible = visibleGraphNodes([...topics, ...sources], edges, "topic-99");
    expect(visible).toHaveLength(90);
    expect(visible.map(node => node.id)).toContain("topic-99");
    expect(visible.map(node => node.id)).toContain("source-99");
  });

  it("keeps the default layout membership stable when selecting a visible item", () => {
    const nodes = [...topics, ...sources];
    const baseline = visibleGraphNodes(nodes, edges, null);
    expect(visibleGraphNodes(nodes, edges, baseline[10]!.id)).toEqual(baseline);
    expect(visibleGraphNodes(nodes, edges, "not-matching")).toEqual(baseline);
  });

  it("respects the filtered node set without inventing source nodes or relationships", () => {
    const visible = visibleGraphNodes(topics, edges, null);
    expect(visible).toHaveLength(90);
    expect(visible.every(node => node.kind === "topic")).toBe(true);
    expect(visibleGraphNodes([], edges, null)).toEqual([]);
  });
});
