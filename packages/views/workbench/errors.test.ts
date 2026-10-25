import { describe, expect, it } from "vitest";
import { wikiFailureResolution, workbenchErrorCopy } from "./errors";

describe("Wiki failure recovery guidance", () => {
  it.each([
    "Lynclaw synthesis failed (HTTP 422): Citation does not match source evidence",
    "AI citation does not match the original source",
    "AI invented an audio position",
  ])("recognizes citation validation from remote and local checks: %s", error => {
    expect(workbenchErrorCopy(error)?.key).toBe("workbench.error_citations");
    expect(wikiFailureResolution(error)).toMatchObject({ settings: "model", advice: "workbench.wiki_failure_model_help" });
  });
  it.each([
    ["Lynclaw authentication failed; sign in again", "account"],
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

it.each(["Invalid topic match output", "Invalid topic relation", "Event date needs an exact dated source quote"])("explains malformed association output: %s", error => {
  expect(workbenchErrorCopy(error)?.key).toBe("workbench.error_model_output");
  expect(wikiFailureResolution(error).settings).toBe("model");
});
