import { describe, expect, it } from "vitest";
import { catalogIssueLocation, citationIssueLocation, wikiFailureResolution, workbenchErrorCopy } from "./errors";

describe("Wiki failure recovery guidance", () => {
  it.each([
    "Lynclaw synthesis failed (HTTP 422): Citation does not match source evidence",
    "AI citation does not match the original source",
    "AI invented an audio position",
  ])("recognizes citation validation from remote and local checks: %s", error => {
    expect(workbenchErrorCopy(error)?.key).toBe("workbench.error_citations");
    expect(wikiFailureResolution(error)).toMatchObject({ citation: true, advice: "workbench.wiki_failure_citation_help" });
    expect(wikiFailureResolution(error).settings).toBeUndefined();
    expect(wikiFailureResolution(error).allowContext).not.toBe(true);
  });
  it.each([
    ["Lynclaw authentication failed; sign in again", "account"],
    ["Cloud knowledge identity verification failed", "account"],
    ["Cloud knowledge offline", "connection"],
    ["Cloud knowledge request failed (HTTP 503)", "connection"],
    ["Cloud knowledge request failed (HTTP 429)", "connection"],
    ["Cloud knowledge request failed (HTTP 404)", "model"],
    ["Cloud knowledge request failed (HTTP 403)", "scope"],
    ["Cloud knowledge organization is not enabled on this server", "scope"],
    ["Cloud knowledge selected folders changed; review the organization range", "scope"],
    ["Lynclaw synthesis failed (HTTP 422): Invalid Wiki publication metadata", "model"],
    ["Cloud knowledge capability unavailable or authorization rejected", "scope"],
    ["A source is outside the current cloud policy or stopped from automatic use", "scope"],
    ["Lynclaw model service is unavailable", "model"],
  ])("points to the relevant settings for %s", (error, settings) => {
    expect(wikiFailureResolution(error).settings).toBe(settings);
  });
  it("keeps source conflicts, insufficient evidence and unknown errors actionable", () => {
    expect(wikiFailureResolution("Local document was edited; resolve its sync conflict before AI processing").advice).toBe("workbench.wiki_failure_source_help");
    expect(wikiFailureResolution("No relevant source evidence found for this topic").advice).toBe("workbench.wiki_failure_evidence_help");
    expect(wikiFailureResolution("Unexpected processing error")).toEqual({ reason: "workbench.wiki_failure_unknown", advice: "workbench.wiki_failure_unknown_help" });
  });
});

it("distinguishes catalog rules and old records without directing users to model settings", () => {
  const error = "Lynclaw synthesis failed (HTTP 422): Invalid Wiki catalog output";
  const legacy = wikiFailureResolution(error);
  expect(legacy).toMatchObject({ catalog: true, advice: "workbench.wiki_catalog_help" });
  expect(legacy.settings).toBeUndefined();
  expect(wikiFailureResolution(error, { correctionAttempted: false, catalogIssue: { code: "invalid_context" } }).advice)
    .toBe("workbench.wiki_catalog_context_help");
  for (const [code, reason] of [
    ["invalid_kind", "workbench.wiki_catalog_kind"], ["duplicate_key", "workbench.wiki_catalog_duplicate"],
    ["missing_existing_source", "workbench.wiki_catalog_existing_source"], ["invalid_existing_id", "workbench.wiki_catalog_existing_id"],
  ] as const) {
    const issue = { code, topicIndex: 1 };
    expect(wikiFailureResolution(error, { correctionAttempted: true, catalogIssue: issue }).reason).toBe(reason);
    expect(catalogIssueLocation(issue)).toEqual({ key: "workbench.wiki_catalog_location_topic", values: { topic: 2 } });
  }
  expect(wikiFailureResolution("Citation does not match source evidence", { correctionAttempted: true,
    catalogIssue: { code: "invalid_citation", topicIndex: 0 }, citationIssue: { code: "quote_not_found" } }).reason)
    .toBe("workbench.wiki_citation_not_found");
  expect(citationIssueLocation({ code: "quote_not_found", location: "topics[1].citations", citationIndex: 0 }))
    .toEqual({ key: "workbench.wiki_citation_location_topics", values: { item: 2, reference: 1 } });
  for (const topicIndex of [-1, 40, 1.5]) expect(catalogIssueLocation({ code: "invalid_kind", topicIndex })).toBeNull();
});

it.each(["Invalid topic match output", "Invalid topic relation", "Event date needs an exact dated source quote"])("explains malformed association output: %s", error => {
  expect(workbenchErrorCopy(error)?.key).toBe("workbench.error_model_output");
  expect(wikiFailureResolution(error).settings).toBe("model");
});


it("distinguishes citation causes without blaming the meeting text", () => {
  const error = "Citation does not match source evidence";
  expect(wikiFailureResolution(error, { correctionAttempted: true, citationIssue: { code: "quote_not_found" } }).reason)
    .toBe("workbench.wiki_citation_not_found");
  expect(wikiFailureResolution(error, { correctionAttempted: true, citationIssue: { code: "source_revision_mismatch" } }).reason)
    .toBe("workbench.wiki_citation_revision");
  expect(wikiFailureResolution("No relevant source evidence found for this topic").allowContext).toBe(true);
});

it("renders bounded citation positions and leaves old records unlocated", () => {
  expect(citationIssueLocation()).toBeNull();
  expect(citationIssueLocation({ code: "quote_not_found", location: "memoryItems[2].citations", citationIndex: 1 }))
    .toEqual({ key: "workbench.wiki_citation_location_memoryItems", values: { item: 3, reference: 2 } });
  for (const citationIndex of [-1, 40, 1.5]) {
    expect(citationIssueLocation({ code: "quote_not_found", location: "citations", citationIndex })).toBeNull();
  }
  expect(citationIssueLocation({ code: "quote_not_found", location: "PRIVATE_MODEL_QUOTE", citationIndex: 0 })).toBeNull();
});


it("routes connection checks to cloud settings and preserves the failed phase", () => {
  expect(wikiFailureResolution("Cloud knowledge connection failed (stage: capabilities; reason: timeout)"))
    .toMatchObject({ reason: "workbench.wiki_failure_connection_timeout", settings: "connection" });
  expect(wikiFailureResolution("Cloud knowledge connection failed (stage: identity_binding; reason: connect)"))
    .toMatchObject({ reason: "workbench.wiki_failure_binding_connection", settings: "connection" });
  expect(wikiFailureResolution("Cloud knowledge identity verification failed [stage: capabilities]").settings).toBe("account");
});
