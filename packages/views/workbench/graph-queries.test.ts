import { describe, expect, it } from "vitest";
import { graphAnswers } from "./graph-queries";
import type { GraphNode, KnowledgeGraph } from "./types";
const ref = { id: "one", kind: "meeting", revision: "r1", quote: "张三负责A项目，周五提交预算表。" };
const node = (id: string, subtype: string, status: GraphNode["status"] = "unknown"): GraphNode => ({ id, kind: ["task", "decision", "risk"].includes(subtype) ? "event" : "entity", subtype, title: id, status, description: id, modality: "asserted", review: "confirmed", citations: [ref], updates: [] });
const graph: KnowledgeGraph = { automaticTracking: false, tracking: { processing: false, completed: 1, total: 1, failed: 0, error: "" }, nodes: [node("张三", "person"), node("项目", "project"), node("同名项目", "project"), node("未知任务", "task"), node("完成任务", "task", "completed"), node("风险", "risk"), node("建议决策", "decision")], edges: [
  { id: "owns", source: "张三", target: "项目", kind: "responsible_for", modality: "asserted", citations: [ref] },
  { id: "project", source: "未知任务", target: "项目", kind: "project", citations: [ref] },
  { id: "risk", source: "风险", target: "项目", kind: "about", citations: [ref] },
  { id: "shared", source: "建议决策", target: "项目", kind: "evidence", citations: [ref] },
] };
describe("source-backed graph questions", () => {
  it("queries explicit responsibility without merging same-name projects or guessing shared-source semantics", () => {
    expect(graphAnswers(graph, "responsibility", "项目").map(answer => answer.node.id)).toEqual(["张三"]);
    expect(graphAnswers(graph, "responsibility", "同名项目")).toEqual([]);
    expect(graphAnswers(graph, "decisions", "项目").map(answer => answer.node.id)).toEqual(["风险"]);
  });
  it("keeps unknown task status unconfirmed and excludes completed, cancelled and negated tasks", () => {
    expect(graphAnswers(graph, "tasks").map(answer => [answer.node.id, answer.needsConfirmation])).toEqual([["未知任务", true]]);
    const copy = { ...graph, nodes: graph.nodes.map(node => node.id === "未知任务" ? { ...node, modality: "negated" as const } : node) };
    expect(graphAnswers(copy, "tasks")).toEqual([]);
  });
  it("ignores revoked endpoints, unsupported and negative responsibility claims", () => {
    const copy = { ...graph, edges: graph.edges.map(edge => edge.id === "owns" ? { ...edge, modality: "negated" as const } : edge) };
    expect(graphAnswers(copy, "responsibility")).toEqual([]);
    expect(graphAnswers({ ...graph, nodes: graph.nodes.filter(node => node.id !== "张三") }, "responsibility")).toEqual([]);
    expect(graphAnswers({ ...graph, edges: graph.edges.map(edge => ({ ...edge, citations: [] })) }, "responsibility")).toEqual([]);
  });
});
