import type { GraphNode, KnowledgeGraph } from "./types";

export const GRAPH_NODE_LIMIT = 190;

// Traverse the complete graph before applying the drawing budget or search filters.
export function graphNeighborhood(nodes: GraphNode[], edges: KnowledgeGraph["edges"], selection: string | null, depth: number): GraphNode[] {
  if (!selection || !nodes.some(node => node.id === selection)) return [];
  const ids = new Set(nodes.map(node => node.id));
  const adjacency = new Map<string, Set<string>>();
  for (const edge of edges) {
    if (!ids.has(edge.source) || !ids.has(edge.target)) continue;
    for (const [a, b] of [[edge.source, edge.target], [edge.target, edge.source]]) {
      if (!adjacency.has(a!)) adjacency.set(a!, new Set());
      adjacency.get(a!)!.add(b!);
    }
  }
  const visited = new Set([selection]);
  let frontier = [selection];
  for (let level = 0; level < depth; level++) {
    const next: string[] = [];
    for (const id of frontier) for (const neighbor of adjacency.get(id) ?? []) {
      if (!visited.has(neighbor)) { visited.add(neighbor); next.push(neighbor); }
    }
    frontier = next;
  }
  const byId = new Map(nodes.map(node => [node.id, node]));
  return [...visited].map(id => byId.get(id)!);
}

// Keep both ends of real relationships instead of dropping all source nodes.
export function visibleGraphNodes(nodes: GraphNode[], edges: KnowledgeGraph["edges"], selection: string | null, limit = GRAPH_NODE_LIMIT): GraphNode[] {
  const byId = new Map(nodes.map(node => [node.id, node]));
  const neighbors = new Map(nodes.map(node => [node.id, new Set<string>()]));
  for (const edge of edges) {
    if (edge.source === edge.target || !byId.has(edge.source) || !byId.has(edge.target)) continue;
    neighbors.get(edge.source)!.add(edge.target);
    neighbors.get(edge.target)!.add(edge.source);
  }
  const ranked = nodes.slice().sort((a, b) =>
    Number(a.kind === "source") - Number(b.kind === "source")
    || neighbors.get(b.id)!.size - neighbors.get(a.id)!.size
    || a.title.localeCompare(b.title) || a.id.localeCompare(b.id));
  const order = new Map(ranked.map((node, i) => [node.id, i]));
  const fill = (first?: string) => {
    const chosen = new Set<string>();
    for (const seed of first ? [byId.get(first)!, ...ranked] : ranked) {
      if (chosen.size >= limit) break;
      if (chosen.has(seed.id)) continue;
      const queue = [seed.id];
      const queued = new Set(queue);
      for (let index = 0; index < queue.length && chosen.size < limit; index++) {
        const id = queue[index]!;
        if (chosen.has(id)) continue;
        chosen.add(id);
        for (const neighbor of [...neighbors.get(id)!].sort((a, b) => order.get(a)! - order.get(b)!)) {
          if (!chosen.has(neighbor) && !queued.has(neighbor)) { queued.add(neighbor); queue.push(neighbor); }
        }
      }
    }
    return [...chosen].map(id => byId.get(id)!);
  };
  const visible = fill();
  return selection && byId.has(selection) && !visible.some(node => node.id === selection) ? fill(selection) : visible;
}
