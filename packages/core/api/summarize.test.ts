import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiClient, setApiInstance, setApiTransportMode } from "./client";
import { summarizeTranscript } from "./summarize";

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

const transcript = "Speaker1: 今天对齐一下 Q1 产品评审和需求范围。Speaker2: 先把文档缺口列出来。";

describe("summarizeTranscript", () => {
  it("posts the transcript to the agent with the login token only and omits html style unless requested", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ title: "产品评审", content: "## 纪要" })));
    const controller = new AbortController();
    const result = await summarizeTranscript(
      { transcriptionText: ` ${transcript} `, recordingTime: "202401151430", language: "zh", style: "infographic" },
      "test-session", controller.signal,
    );
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://agent.invalid/api/summarize");
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: "POST", signal: controller.signal, headers: { Authorization: "test-session" } });
    expect(fetchMock.mock.calls[0]?.[1].headers["X-API-Key"]).toBeUndefined();
    expect(JSON.parse(fetchMock.mock.calls[0]?.[1].body)).toEqual({
      transcription_text: transcript, recording_time: "202401151430", language: "zh", html: false,
    });
    expect(result).toEqual({ title: "产品评审", content: "## 纪要" });
  });

  it("requests the styled HTML document and surfaces a degraded rendering without losing the Markdown", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      title: "产品评审", content: "## 纪要", html: "<!doctype html><html></html>", style: "document", degraded: false,
    })));
    const rendered = await summarizeTranscript({ transcriptionText: transcript, html: true, style: "document" }, "test-session");
    expect(JSON.parse(fetchMock.mock.calls[0]?.[1].body)).toMatchObject({ html: true, style: "document" });
    expect(rendered.html).toBe("<!doctype html><html></html>");
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ content: "## 纪要", style: "editorial", html_error: "html_model_unavailable" })));
    const degraded = await summarizeTranscript({ transcriptionText: transcript, html: true }, "test-session");
    expect(degraded).toEqual({ title: null, content: "## 纪要", style: "editorial", html_error: "html_model_unavailable" });
  });

  it("rejects empty transcripts locally and malformed or cross-session responses", async () => {
    await expect(summarizeTranscript({ transcriptionText: "   " }, "test-session")).rejects.toThrow("empty");
    expect(fetchMock).not.toHaveBeenCalled();
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ title: "x" })));
    await expect(summarizeTranscript({ transcriptionText: transcript }, "test-session")).rejects.toThrow("unavailable");
    client.setToken("other-session");
    await expect(summarizeTranscript({ transcriptionText: transcript }, "test-session")).rejects.toThrow("Session changed");
  });
});
