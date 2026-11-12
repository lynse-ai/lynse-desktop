// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { upsertCustomModel } from "../custom-models";
import { generateCustomModelSummary } from "./custom-model-summary";
import type { LocalTranscriptionRecord } from "./types";

const original = "The team agreed that the north route needs a second test before rollout. The first delivery window remains open until Thursday.";
const record: LocalTranscriptionRecord = {
  id: "local:live:session",
  title: "Logistics review",
  sourcePath: "/recordings/session.wav",
  status: "completed",
  engine: "whisper",
  liveSessionId: "session",
  createdAt: "2026-11-06T01:00:00.000Z",
  startedAt: "2026-11-06T08:00:00.000Z",
  updatedAt: "2026-11-06T08:02:00.000Z",
  transcriptText: original,
  language: "en",
  segments: [{ id: "seg", text: original, speakerName: "Lina", startMs: 120250, endMs: 130000 }],
  markers: [{ id: "note", kind: "highlight", note: "Check the alternate route", startMs: 125000 }],
};
const profile = {
  id: "local-vllm", label: "Local vLLM",
  baseUrl: "http://127.0.0.1:8000/v1", model: "qwen3", createdAt: "2026-11-11T00:00:00.000Z",
};
const options = { profileId: "local-vllm", prompt: "Summarize as meeting minutes.", templateName: "Minutes" };

const get = vi.fn();
const saveSummary = vi.fn();
const complete = vi.fn();
type DesktopWindow = Window & { desktopAPI?: unknown };

describe("off-cloud summary with the user's own model", () => {
  beforeEach(() => {
    localStorage.clear();
    get.mockReset(); saveSummary.mockReset(); complete.mockReset();
    get.mockResolvedValue(record);
    saveSummary.mockResolvedValue(undefined);
    upsertCustomModel(profile);
    (window as DesktopWindow).desktopAPI = {
      localTranscription: { get, saveSummary },
      customModels: { complete, setKey: vi.fn(), hasKey: vi.fn(), testConnection: vi.fn() },
    };
  });
  afterEach(() => { localStorage.clear(); delete (window as DesktopWindow).desktopAPI; });

  it("sends the template and transcript straight to the profile and saves the result locally", async () => {
    complete.mockResolvedValue("# North route\n\nA second test is required.\n");
    await expect(generateCustomModelSummary(record.id, options)).resolves.toBe("# North route\n\nA second test is required.");
    expect(complete).toHaveBeenCalledTimes(1);
    const request = complete.mock.calls[0]![0];
    // Routing comes from the profile; no key is ever part of the request.
    expect(request).toMatchObject({ profileId: "local-vllm", baseUrl: "http://127.0.0.1:8000/v1", model: "qwen3", maxTokens: 8000 });
    expect(JSON.stringify(request)).not.toContain("apiKey");
    expect(request.messages[0]).toEqual({ role: "system", content: "Summarize as meeting minutes." });
    expect(request.messages[1].role).toBe("user");
    expect(request.messages[1].content).toContain("Lina:");
    expect(request.messages[1].content).toContain("Marked moments:\n- [00:02:05] Check the alternate route");
    expect(saveSummary).toHaveBeenCalledWith(record.id, "North route", "# North route\n\nA second test is required.");
  });

  it("falls back to the template name when the model returns no heading", async () => {
    complete.mockResolvedValue("Plain summary without a heading.");
    await generateCustomModelSummary(record.id, options);
    expect(saveSummary).toHaveBeenCalledWith(record.id, "Minutes", "Plain summary without a heading.");
  });

  it("rejects before any model call when the profile or transcript is unusable", async () => {
    await expect(generateCustomModelSummary(record.id, { ...options, profileId: "gone" }))
      .rejects.toThrow("customModels.summary_no_profile");
    get.mockResolvedValue({ ...record, status: "failed" });
    await expect(generateCustomModelSummary(record.id, options)).rejects.toThrow("customModels.summary_needs_transcript");
    get.mockResolvedValue({ ...record, transcriptText: "too short" });
    await expect(generateCustomModelSummary(record.id, options)).rejects.toThrow("customModels.summary_needs_transcript");
    expect(complete).not.toHaveBeenCalled();
    expect(saveSummary).not.toHaveBeenCalled();
  });

  it("never stores an empty result", async () => {
    complete.mockResolvedValue("   \n");
    await expect(generateCustomModelSummary(record.id, options)).rejects.toThrow("customModels.summary_empty");
    expect(saveSummary).not.toHaveBeenCalled();
  });

  it("preserves the provider failure reason for the summary dialog", async () => {
    complete.mockRejectedValue("access_denied");
    await expect(generateCustomModelSummary(record.id, options))
      .rejects.toThrow("customModels.connection_access_denied");
    expect(saveSummary).not.toHaveBeenCalled();
  });
});
