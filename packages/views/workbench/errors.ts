export function workbenchErrorCopy(error: string): { key: string; count?: number } | null {
  if (error.includes("Discovery names do not match source evidence")) return { key: "workbench.error_discovery_names" };
  const topics = error.match(/^Wiki processing failed for (\d+) topics;/);
  if (topics) return { key: "workbench.error_topics", count: Number(topics[1]) };
  if (error.includes("Insufficient evidence must not contain factual output")) return { key: "workbench.error_inconsistent_evidence" };
  if (error.includes("Every claim needs source citations") || error.includes("unsupported claim")) return { key: "workbench.error_missing_citations" };
  if (error.includes("Citation does not match source evidence") || error.includes("unsupported audio position")) return { key: "workbench.error_citations" };
  if (error.includes("Invalid evidence graph output") || error.includes("Graph citation")) return { key: "workbench.error_model_output" };
  if (error.includes("Invalid memory kind")) return { key: "workbench.error_memory_kind" };
  if (error.includes("Model did not return valid structured output") || error.includes("Invalid synthesis result") || error.includes("Irrelevant Wiki analysis must contain no claims")) return { key: "workbench.error_model_output" };
  if (error.includes("Unknown synthesis task")) return { key: "workbench.error_service_version" };
  return null;
}
