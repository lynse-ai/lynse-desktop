export function workbenchErrorCopy(error: string): { key: string; count?: number } | null {
  if (error === "Lynclaw authentication failed; sign in again") return { key: "workbench.error_session_auth" };
  if (error.includes("Discovery names do not match source evidence")) return { key: "workbench.error_discovery_names" };
  const topics = error.match(/^Wiki processing failed for (\d+) topics;/);
  if (topics) return { key: "workbench.error_topics", count: Number(topics[1]) };
  if (error.includes("Insufficient evidence must not contain factual output")) return { key: "workbench.error_inconsistent_evidence" };
  if (error.includes("Every claim needs source citations") || error.includes("unsupported claim")) return { key: "workbench.error_missing_citations" };
  if (error.includes("Citation does not match source evidence") || error.includes("AI citation does not match the original source") || error.includes("unsupported audio position") || error.includes("AI invented an audio position")) return { key: "workbench.error_citations" };
  if (error.includes("Invalid evidence graph output") || error.includes("Graph citation")) return { key: "workbench.error_model_output" };
  if (error.includes("Invalid memory kind")) return { key: "workbench.error_memory_kind" };
  if (error.includes("Model did not return valid structured output") || error.includes("Invalid synthesis result") || /Invalid topic (match|relation|timeline)|Event date needs/.test(error) || error.includes("Irrelevant Wiki analysis must contain no claims")) return { key: "workbench.error_model_output" };
  if (error.includes("Unknown synthesis task")) return { key: "workbench.error_service_version" };
  return null;
}

export function wikiFailureResolution(error: string): { reason: string; advice: string; settings?: "model" | "account" | "scope" } {
  const copy = workbenchErrorCopy(error);
  if (copy?.key === "workbench.error_session_auth") return { reason: copy.key, advice: "workbench.wiki_failure_auth_help", settings: "account" };
  if (copy?.key === "workbench.error_service_version") return { reason: copy.key, advice: "workbench.wiki_failure_service_help", settings: "model" };
  if (/cloud knowledge|cloud policy|source eligibility|outside.*policy|no longer authorized/i.test(error)) return { reason: "workbench.wiki_failure_authorization", advice: "workbench.wiki_failure_scope_help", settings: "scope" };
  if (/network|offline|unavailable|timed? ?out|HTTP (429|5\d\d)/i.test(error)) return { reason: "workbench.wiki_failure_connection", advice: "workbench.wiki_failure_connection_help", settings: "model" };
  if (/sources? changed|source.*changed|source.*conflict|document was edited|source.*unreadable|invalid source/i.test(error)) return { reason: "workbench.wiki_failure_source", advice: "workbench.wiki_failure_source_help" };
  if (/no relevant source|no supported evidence/i.test(error)) return { reason: "workbench.wiki_failure_evidence", advice: "workbench.wiki_failure_evidence_help" };
  if (copy) return { reason: copy.key, advice: "workbench.wiki_failure_model_help", settings: "model" };
  return { reason: "workbench.wiki_failure_unknown", advice: "workbench.wiki_failure_unknown_help" };
}
