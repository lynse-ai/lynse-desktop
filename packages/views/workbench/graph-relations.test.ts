import { describe, expect, it } from "vitest";
import { graphRelations } from "./graph-relations";
import type { GraphNode, KnowledgeGraph } from "./types";

const nodes: GraphNode[] = ["alpha", "beta", "wiki", "meeting", "other-meeting", "unrelated"].map(id => ({ id, title: id, kind: id.includes("meeting") ? "source" : "topic", status: "unknown", description: "", citations: [], updates: [] }));
const graph: KnowledgeGraph = { nodes, automaticTracking: true, tracking: { processing: false, completed: 1, total: 1, failed: 0, error: "" }, edges: [
  { id: "a", source: "alpha", target: "meeting", kind: "evidence" },
  { id: "b", source: "beta", target: "meeting", kind: "evidence" },
  { id: "c", source: "unrelated", target: "other-meeting", kind: "evidence" },
  { id: "w", source: "wiki", target: "alpha", kind: "wiki_link" },
] };

describe("graph relationship explanations", () => {
  it("explains shared evidence without inventing semantic edges", () => {
    const groups = graphRelations(graph, "alpha");
    expect(groups.find(group => group.kind === "evidence")?.entries.map(entry => entry.node.id)).toEqual(["meeting"]);
    expect(groups.find(group => group.kind === "shared_source")?.entries.map(entry => [entry.node.id, entry.via.map(source => source.id)])).toEqual([["beta", ["meeting"]]]);
    expect(groups.some(group => group.kind === "related")).toBe(false);
    expect(groups.flatMap(group => group.entries).some(entry => entry.node.id === "unrelated")).toBe(false);
    expect(groups.find(group => group.kind === "wiki_link")?.entries[0]?.incoming).toBe(true);
  });
  it("lets readers explore discoveries supported by a source and ignores revoked endpoints", () => {
    const copy = { ...graph, edges: [...graph.edges, { id: "revoked", source: "missing", target: "meeting", kind: "evidence" }] };
    expect(graphRelations(copy, "meeting").flatMap(group => group.entries).map(entry => entry.node.id)).toEqual(["alpha", "beta"]);
    expect(graphRelations({ ...graph, edges: [] }, "alpha")).toEqual([]);
  });
  it("preserves both directions when Wiki pages link to each other", () => {
    const copy = { ...graph, edges: [...graph.edges, { id: "reverse-wiki", source: "alpha", target: "wiki", kind: "wiki_link" }] };
    expect(graphRelations(copy, "alpha").find(group => group.kind === "wiki_link")?.entries.map(entry => entry.incoming).sort()).toEqual([false, true]);
  });
});
