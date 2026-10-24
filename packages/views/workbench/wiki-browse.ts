import type { KnowledgeGraph, SourceRef, WikiChange, WikiTopic } from "./types";

export function browsableTopics(topics: WikiTopic[]): WikiTopic[] {
  return topics.filter(topic => !topic.excluded && topic.inScope !== false && !!topic.published);
}
export function topicOverview(topic: WikiTopic): string {
  return topic.published?.overview || topic.purpose || topic.published?.markdown.split("\n").find(line => !!line.trim() && !line.startsWith("#")) || "";
}
export function topicSources(topic: WikiTopic): SourceRef[] {
  return [...new Map((topic.published?.citations ?? []).map(source => [source.id, source])).values()];
}
export function topicChanges(topic: WikiTopic): WikiChange[] {
  const revisions = [topic.published, ...(topic.history ?? []).slice().reverse()].filter(revision => revision && ["approved", "auto_validated"].includes(revision.review));
  return [...new Map(revisions.flatMap(revision => revision?.changes ?? []).map(change => [change.id, change])).values()]
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
export function recentWikiChanges(topics: WikiTopic[]) {
  return browsableTopics(topics).flatMap(topic => topicChanges(topic).map(change => ({ ...change, topicId: topic.id, title: topic.title })))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
export function topicDetails(topic: WikiTopic, graph?: KnowledgeGraph) {
  const sources = new Set(topicSources(topic).map(source => source.id));
  return graph?.nodes.filter(node => ["person", "task", "decision", "risk", "milestone", "document"].includes(node.subtype ?? "") && node.citations.some(reference => sources.has(reference.id))) ?? [];
}
export function browsingGraph(topics: WikiTopic[], supplied?: KnowledgeGraph): KnowledgeGraph {
  const available = browsableTopics(topics);
  const ids = new Set(available.map(topic => `wiki:${topic.id}`));
  return {
    nodes: available.map(topic => ({ id: `wiki:${topic.id}`, wikiId: topic.id, kind: "wiki", subtype: topic.topicKind, title: topic.title, description: topicOverview(topic), status: topic.stale ? "stale" : "published", citations: [], updates: [] })),
    edges: supplied?.edges.filter(edge => ids.has(edge.source) && ids.has(edge.target)) ?? [],
    automaticTracking: true, tracking: { processing: false, completed: available.length, total: available.length, failed: 0, error: "" },
  };
}
