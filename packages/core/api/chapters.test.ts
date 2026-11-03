import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiClient, setApiInstance, setApiTransportMode } from "./client";
import { generateChapters } from "./chapters";

let client: ApiClient;
let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  client = new ApiClient("https://business.invalid");
  client.setAgentBaseUrl("https://agent.invalid");
  client.setToken("test-session");
  client.setApiKey("test-api-key");
  setApiInstance(client);
  setApiTransportMode("direct");
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => { vi.unstubAllGlobals(); setApiTransportMode("proxy"); });

const utterances = [
  { id: "seg001", text: "先介绍项目背景。", start_ms: 0, end_ms: 8500, speaker: "S1" },
  { id: "seg002", text: "再讨论技术方案。", start_ms: 8500, end_ms: 18000, speaker: "S2" },
];

describe("generateChapters", () => {
  it("posts snake_case utterances to the agent with the login token only", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      model: "deepseek-chat",
      prompt_version: "v1",
      chapters: [{
        title: "一章", summary: "s", keywords: ["背景"],
        start_segment_id: "seg001", end_segment_id: "seg002", start_ms: 0, end_ms: 18000,
      }],
    })));
    const controller = new AbortController();
    const result = await generateChapters(
      { utterances, language: "zh", recordingTime: "202401151430" },
      "test-session", controller.signal,
    );
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://agent.invalid/api/chapters/generate");
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: "POST", signal: controller.signal, headers: { Authorization: "test-session" } });
    expect(fetchMock.mock.calls[0]?.[1].headers["X-API-Key"]).toBeUndefined();
    expect(JSON.parse(fetchMock.mock.calls[0]?.[1].body)).toEqual({
      utterances,
      language: "zh",
      recording_time: "202401151430",
    });
    expect(result).toMatchObject({
      model: "deepseek-chat", promptVersion: "v1",
      chapters: [{ start_segment_id: "seg001", end_segment_id: "seg002" }],
    });
  });

  it("omits optional fields when absent", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ model: null, prompt_version: "v1", chapters: [] })));
    await generateChapters({ utterances }, "test-session");
    expect(JSON.parse(fetchMock.mock.calls[0]?.[1].body)).toEqual({ utterances });
  });

  it("rejects empty utterances locally and malformed responses", async () => {
    await expect(generateChapters({ utterances: [] }, "test-session")).rejects.toThrow("empty");
    expect(fetchMock).not.toHaveBeenCalled();
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ model: "x" })));
    await expect(generateChapters({ utterances }, "test-session")).rejects.toThrow("unavailable");
  });
});
