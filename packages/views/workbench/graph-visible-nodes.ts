import type { GraphNode, KnowledgeGraph } from "./types";

export const GRAPH_NODE_LIMIT = 90;

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
