import type { GraphEdge, GraphNode, KnowledgeGraph } from "./types";
export type GraphQuestion = "responsibility" | "tasks" | "decisions";
export interface GraphAnswer { node: GraphNode; relation?: GraphEdge; target?: GraphNode; needsConfirmation: boolean }
export function graphAnswers(graph: KnowledgeGraph, question: GraphQuestion, projectId = ""): GraphAnswer[] {
  const byId = new Map(graph.nodes.map(node => [node.id, node]));
  const supported = (edge: GraphEdge) => edge.modality !== "negated" && byId.has(edge.source) && byId.has(edge.target) && !!edge.citations?.length;
  if (question === "responsibility") return graph.edges.filter(edge => edge.kind === "responsible_for" && supported(edge) && (!projectId || edge.target === projectId)).map(relation => ({ node: byId.get(relation.source)!, target: byId.get(relation.target)!, relation, needsConfirmation: relation.review !== "confirmed" || relation.modality !== "asserted" }));
  const linked = new Set(graph.edges.filter(edge => ["project", "about", "belongs_to"].includes(edge.kind) && supported(edge) && edge.target === projectId).map(edge => edge.source));
  return graph.nodes.filter(node => node.kind === "event" && !!node.citations.length && node.modality !== "negated" && (!projectId || linked.has(node.id)) && (question === "tasks" ? ["task", "commitment"].includes(node.subtype ?? "") && !["completed", "cancelled"].includes(node.status) : ["decision", "risk", "issue", "change"].includes(node.subtype ?? ""))).map(node => ({ node, needsConfirmation: node.review !== "confirmed" || node.status === "unknown" || node.modality === "proposed" || node.modality === "uncertain" }));
}
