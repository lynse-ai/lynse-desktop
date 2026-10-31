import type { KnowledgeGraph, SourceRef, WikiChange, WikiTopic } from "./types";

export function browsableTopics(topics: WikiTopic[]): WikiTopic[] {
  return topics.filter(topic => !topic.excluded && topic.inScope !== false && (!!topic.published || !!topic.collection));
}
export function parentTopics(topic: WikiTopic, topics: WikiTopic[]): WikiTopic[] {
  return browsableTopics(topics).filter(parent => parent.collection?.hierarchy && parent.collection.links.some(link => link.targetId === topic.id && link.state === "included"));
}
export function topLevelTopics(topics: WikiTopic[]): WikiTopic[] {
  const available = browsableTopics(topics);
  const nested = new Set(available.flatMap(topic => topic.collection?.hierarchy && !!topic.published
    ? topic.collection.links.filter(link => link.state === "included" && !link.error).map(link => link.targetId) : []));
  return available.filter(topic => !!topic.collection || !nested.has(topic.id))
    .sort((a, b) => Number(!!b.collection) - Number(!!a.collection));
}
export function topicOverview(topic: WikiTopic): string {
  return topic.published?.overview || topic.purpose || topic.published?.markdown.split("\n").find(line => !!line.trim() && !line.startsWith("#")) || "";
}
export function topicSources(topic: WikiTopic): SourceRef[] {
  return [...new Map((topic.published?.citations ?? []).map(source => [source.id, source])).values()];
}
function calendarDate(value: string): string {
  const date = value.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return "";
  const parsed = new Date(`${date}T12:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date ? date : "";
}
function sourceRecordDate(citations: SourceRef[], sourceDates: Record<string, string>) {
  const dates = citations.map(ref => calendarDate(sourceDates[ref.id] ?? "")).filter(Boolean).sort();
  return dates[0] ?? "";
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
  const roots = topLevelTopics(topics);
  const available = (roots.some(topic => !!topic.collection?.hierarchy) ? roots.filter(topic => !!topic.collection) : roots).filter(topic => !!topic.published);
  const parents = new Map<string,string>(topics.flatMap(topic => topic.collection?.hierarchy && !!topic.published && !topic.excluded && topic.inScope !== false
    ? topic.collection.links.filter(link => link.state === "included" && !link.error).map(link => [`wiki:${link.targetId}`, `wiki:${topic.id}`] as const) : []));
  const ids = new Set(available.map(topic => `wiki:${topic.id}`));
  const edges = new Map((supplied?.edges ?? []).map(edge => {
    const source = parents.get(edge.source) ?? edge.source;
    const target = parents.get(edge.target) ?? edge.target;
    return [`${source}:${target}`, { ...edge, id: source === edge.source && target === edge.target ? edge.id : `${edge.id}:${source}:${target}`, source, target }] as const;
  }).filter(([, edge]) => edge.source !== edge.target && ids.has(edge.source) && ids.has(edge.target)));
  return {
    nodes: available.map(topic => ({ id: `wiki:${topic.id}`, wikiId: topic.id, kind: "wiki", subtype: topic.topicKind, title: topic.title, description: topicOverview(topic), status: topic.stale ? "stale" : "published", citations: [], updates: [] })),
    edges: [...edges.values()],
    automaticTracking: true, tracking: { processing: false, completed: available.length, total: available.length, failed: 0, error: "" },
  };
}

export function collectionTimeline(topic: WikiTopic, sourceDates: Record<string, string> = {}) {
  const events = (topic.collection?.links ?? []).filter(link => link.state === "included" && !link.error).flatMap(link => link.events.map(event => {
    const date = calendarDate(event.date);
    const recorded = !date ? sourceRecordDate(event.citations, sourceDates) : "";
    return { ...event, date: date || recorded || "", dateBasis: date ? event.dateBasis : recorded ? "record" as const : "unknown" as const, topicId: link.targetId };
  }));
  const unique = new Map<string, typeof events[number]>();
  for (const event of events) {
    const key = JSON.stringify([event.text.replace(/\s+/g, " ").trim(), event.date]);
    const previous = unique.get(key);
    if (previous) previous.citations = [...new Map([...previous.citations, ...event.citations].map(ref => [JSON.stringify(ref), ref])).values()];
    else unique.set(key, { ...event, citations: [...event.citations] });
  }
  return [...unique.values()].sort((a, b) => b.date.localeCompare(a.date) || a.id.localeCompare(b.id));
}
