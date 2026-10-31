import type { CatalogIssue, CitationIssue, WikiValidationDetails } from "./types";

export function workbenchErrorCopy(error: string): { key: string; count?: number } | null {
  if (/Cloud knowledge request failed \(HTTP (404|501)\)/.test(error)) return { key: "workbench.error_service_version" };
  if (error.includes("Graph DeepSeek credentials are not configured")) return { key: "workbench.graph_error_credentials" };
  if (error.includes("Model output was truncated")) return { key: "workbench.graph_error_truncated" };
  if (error.includes("outcome is unknown") || error.includes("Graph request interrupted")) return { key: "workbench.graph_error_unknown_outcome" };
  if (error.includes("Graph model rate limited")) return { key: "workbench.graph_error_rate_limit" };
  if (["Lynclaw authentication failed; sign in again", "Cloud knowledge identity verification failed", "Cloud knowledge identity mismatch"].some(message => error === message || error.startsWith(`${message} [stage:`))) return { key: "workbench.error_session_auth" };
  if (error === "Cloud knowledge organization is not enabled on this server") return { key: "workbench.wiki_source_not_enrolled" };
  if (error === "Cloud knowledge selected folders changed; review the organization range") return { key: "workbench.wiki_source_range_changed" };
  const sources = error.match(/^Wiki catalog failed for (\d+) sources;/);
  if (sources) return { key: "workbench.wiki_source_failed_count", count: Number(sources[1]) };
  if (error.includes("Discovery names do not match source evidence")) return { key: "workbench.error_discovery_names" };
  const topics = error.match(/^Wiki processing failed for (\d+) topics;/);
  if (topics) return { key: "workbench.error_topics", count: Number(topics[1]) };
  if (error.includes("Invalid Wiki catalog output")) return { key: "workbench.wiki_failure_catalog_format" };
  if (error.includes("Invalid Wiki publication metadata")) return { key: "workbench.wiki_failure_publication_format" };
  if (error.includes("Insufficient evidence must not contain factual output")) return { key: "workbench.error_inconsistent_evidence" };
  if (error.includes("Every claim needs source citations") || error.includes("unsupported claim")) return { key: "workbench.error_missing_citations" };
  if (error.includes("Invalid citation") || error.includes("Citation does not match source evidence") || error.includes("AI citation does not match the original source") || error.includes("unsupported audio position") || error.includes("AI invented an audio position")) return { key: "workbench.error_citations" };
  if (error.includes("Invalid evidence graph output") || error.includes("Graph citation")) return { key: "workbench.error_model_output" };
  if (error.includes("Invalid memory kind")) return { key: "workbench.error_memory_kind" };
  if (error.includes("Model did not return valid structured output") || error.includes("Invalid synthesis result") || /Invalid topic (match|relation|timeline)|Event date needs/.test(error) || error.includes("Irrelevant Wiki analysis must contain no claims")) return { key: "workbench.error_model_output" };
  if (error.includes("Graph service version does not confirm deepseek-flash")) return { key: "workbench.error_service_version" };
  if (error.includes("Unknown synthesis task")) return { key: "workbench.error_service_version" };
  return null;
}

const citationReasons: Record<CitationIssue["code"], string> = {
  missing_citations: "workbench.wiki_citation_missing",
  invalid_reference: "workbench.wiki_citation_format",
  source_missing: "workbench.wiki_citation_source_missing",
  source_revision_mismatch: "workbench.wiki_citation_revision",
  quote_missing: "workbench.wiki_citation_missing",
  quote_not_found: "workbench.wiki_citation_not_found",
  quote_too_long: "workbench.wiki_citation_too_long",
  audio_position_mismatch: "workbench.wiki_citation_position",
};
const catalogReasons: Record<CatalogIssue["code"], string> = {
  result_format: "workbench.wiki_failure_catalog_format", topic_format: "workbench.wiki_failure_catalog_format",
  too_many_topics: "workbench.wiki_catalog_too_many", invalid_field: "workbench.wiki_catalog_field",
  invalid_kind: "workbench.wiki_catalog_kind", duplicate_key: "workbench.wiki_catalog_duplicate",
  missing_new_source: "workbench.wiki_catalog_new_source", invalid_existing_id: "workbench.wiki_catalog_existing_id",
  existing_kind_mismatch: "workbench.wiki_catalog_existing_kind", missing_existing_source: "workbench.wiki_catalog_existing_source",
  invalid_citation: "workbench.error_citations", invalid_context: "workbench.wiki_catalog_context",
};

export function catalogIssueLocation(issue?: CatalogIssue | null): { key: string; values: Record<string, number> } | null {
  if (!issue || !Object.hasOwn(catalogReasons, issue.code)) return null;
  if (issue.topicIndex === undefined) return { key: "workbench.wiki_catalog_location_result", values: {} };
  if (!Number.isInteger(issue.topicIndex) || issue.topicIndex < 0 || issue.topicIndex >= 40) return null;
  return { key: "workbench.wiki_catalog_location_topic", values: { topic: issue.topicIndex + 1 } };
}

export function citationIssueLocation(issue?: CitationIssue | null): { key: string; values: Record<string, number> } | null {
  const index = issue?.citationIndex;
  if (!issue || typeof index !== "number" || !Number.isInteger(index) || index < 0 || index >= 40) return null;
  const reference = index + 1;
  if (issue.location === "citations") return { key: "workbench.wiki_citation_location_summary", values: { reference } };
  const match = issue.location?.match(/^(memoryItems|todoSuggestions|decisions|topics)\[(\d+)\]\.citations$/);
  if (!match || Number(match[2]) >= (match[1] === "topics" ? 40 : 50)) return null;
  return { key: `workbench.wiki_citation_location_${match[1]}`, values: { item: Number(match[2]) + 1, reference } };
}

export function wikiFailureResolution(error: string, validation?: WikiValidationDetails | null): { reason: string; advice: string; settings?: "model" | "account" | "scope" | "connection"; allowContext?: boolean; citation?: boolean; catalog?: boolean } {
  const copy = workbenchErrorCopy(error);
  if (copy?.key === "workbench.wiki_failure_catalog_format" || validation?.catalogIssue) {
    const code = validation?.catalogIssue?.code;
    const citation = validation?.citationIssue?.code;
    return { reason: code === "invalid_citation" && citation ? citationReasons[citation]
      : code && catalogReasons[code] ? catalogReasons[code] : "workbench.wiki_failure_catalog_format",
      advice: code === "invalid_context" ? "workbench.wiki_catalog_context_help" : "workbench.wiki_catalog_help", catalog: true, citation: code === "invalid_citation" };
  }
  if (copy?.key === "workbench.wiki_failure_publication_format") return { reason: copy.key, advice: "workbench.wiki_failure_format_help", settings: "model" };
  if (["workbench.wiki_source_not_enrolled", "workbench.wiki_source_range_changed"].includes(copy?.key ?? "")) return { reason: copy!.key, advice: "workbench.wiki_failure_scope_help", settings: "scope" };
  if (/Cloud knowledge (offline|unavailable|connection failed)/.test(error)) return {
    reason: /reason: timeout/.test(error) ? "workbench.wiki_failure_connection_timeout"
      : /stage: identity_binding/.test(error) ? "workbench.wiki_failure_binding_connection" : "workbench.wiki_failure_connection",
    advice: "workbench.wiki_failure_connection_help", settings: "connection" };
  if (copy && ["workbench.error_citations", "workbench.error_missing_citations"].includes(copy.key)) {
    const code = validation?.citationIssue?.code;
    return { reason: code && citationReasons[code] ? citationReasons[code] : copy.key, advice: "workbench.wiki_failure_citation_help", citation: true };
  }
  if (copy?.key === "workbench.error_session_auth") return { reason: copy.key, advice: "workbench.wiki_failure_auth_help", settings: "account" };
  if (copy?.key === "workbench.error_service_version") return { reason: copy.key, advice: "workbench.wiki_failure_service_help", settings: "model" };
  if (/Cloud knowledge request failed \(HTTP (429|5\d\d)\)/.test(error)) return {
    reason: /HTTP 429/.test(error) ? "workbench.wiki_failure_connection_busy" : "workbench.wiki_failure_connection",
    advice: "workbench.wiki_failure_connection_help", settings: "connection" };
  if (/cloud knowledge|cloud policy|source eligibility|outside.*policy|no longer authorized/i.test(error)) return { reason: "workbench.wiki_failure_authorization", advice: "workbench.wiki_failure_scope_help", settings: "scope" };
  if (/network|offline|unavailable|timed? ?out|HTTP (429|5\d\d)/i.test(error)) return { reason: "workbench.wiki_failure_connection", advice: "workbench.wiki_failure_connection_help", settings: "model" };
  if (/sources? changed|source.*changed|source.*conflict|document was edited|source.*unreadable|invalid source/i.test(error)) return { reason: "workbench.wiki_failure_source", advice: "workbench.wiki_failure_source_help" };
  if (/no relevant source|no supported evidence/i.test(error)) return { reason: "workbench.wiki_failure_evidence", advice: "workbench.wiki_failure_evidence_help", allowContext: true };
  if (copy) return { reason: copy.key, advice: "workbench.wiki_failure_model_help", settings: "model" };
  return { reason: "workbench.wiki_failure_unknown", advice: "workbench.wiki_failure_unknown_help" };
}
