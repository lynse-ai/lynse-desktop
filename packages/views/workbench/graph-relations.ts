import { graphPredicateKey } from "./graph-vocabulary";
import type { GraphEdge, GraphNode, KnowledgeGraph } from "./types";

export type GraphRelationKind = "evidence" | "wiki_link" | "documented_by" | "related" | "shared_source" | "claim";
export interface GraphRelation { node: GraphNode; incoming: boolean; via: GraphNode[]; edge?: GraphEdge }
export interface GraphRelationGroup { kind: GraphRelationKind; entries: GraphRelation[] }

export const graphRelationKey = {
  claim: "workbench.graph_claims",
  evidence: "workbench.graph_evidence", wiki_link: "workbench.graph_wiki_links",
  documented_by: "workbench.graph_documented", related: "workbench.graph_related", shared_source: "workbench.graph_shared_source",
} as const;

export function graphRelations(graph: KnowledgeGraph, selection: string): GraphRelationGroup[] {
  const byId = new Map(graph.nodes.map(node => [node.id, node]));
  const groups = new Map<GraphRelationKind, Map<string, GraphRelation>>();
  const direct = new Set([selection]);
  const add = (kind: GraphRelationKind, node: GraphNode, incoming: boolean, via: GraphNode[] = [], edge?: GraphEdge) => {
    if (!groups.has(kind)) groups.set(kind, new Map());
    const key = kind === "claim" ? edge!.id : kind === "wiki_link" || kind === "documented_by" ? `${node.id}:${incoming}` : node.id;
    const existing = groups.get(kind)!.get(key);
    if (existing) existing.via.push(...via.filter(source => !existing.via.some(item => item.id === source.id)));
    else groups.get(kind)!.set(key, { node, incoming, via, edge });
  };
  for (const edge of graph.edges) {
    if (edge.source !== selection && edge.target !== selection) continue;
    const node = byId.get(edge.source === selection ? edge.target : edge.source);
    if (!node || node.id === selection) continue;
    direct.add(node.id);
    const kind = edge.kind === "evidence" || edge.kind === "wiki_link" || edge.kind === "documented_by" ? edge.kind : graphPredicateKey[edge.kind] ? "claim" : "related";
    add(kind, node, edge.target === selection, [], kind === "claim" ? edge : undefined);
  }
  // Shared evidence is a discovery path, never a claim of dependency or causation.
  const sources = new Set(graph.edges.filter(edge => edge.kind === "evidence" && edge.source === selection && byId.get(edge.target)?.kind === "source").map(edge => edge.target));
  for (const edge of graph.edges) {
    if (edge.kind !== "evidence" || !sources.has(edge.target) || direct.has(edge.source)) continue;
    const node = byId.get(edge.source), source = byId.get(edge.target);
    if (node && source) add("shared_source", node, false, [source]);
  }
  return (["claim", "evidence", "wiki_link", "documented_by", "related", "shared_source"] as const).flatMap(kind => {
    const entries = [...(groups.get(kind)?.values() ?? [])].sort((a, b) => a.node.title.localeCompare(b.node.title));
    return entries.length ? [{ kind, entries }] : [];
  });
}
