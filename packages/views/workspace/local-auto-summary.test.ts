import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiClient, setApiInstance, setApiTransportMode } from "@lynse/core/api/client";
import { generateLocalLynclawSummary, triggerLocalAutoSummary } from "./local-auto-summary";
import type { LocalTranscriptionRecord } from "./types";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const original = "The team agreed that the north route needs a second test before rollout. The first delivery window remains open until Thursday.";
const recordingStart = "2026-11-06T01:00:00.000Z";
const photoUrl = "https://storage.invalid/photo.png?signature=fresh";
const markedSummary = "## North route\n\n> <mark>Check the alternate route</mark> · 00:02:05\n\n![Marked image](data:image/png;base64,AAAA)";
const record: LocalTranscriptionRecord = {
  id: "local:live:session",
  title: "Logistics review",
  sourcePath: "/recordings/session.wav",
  status: "completed",
  engine: "whisper",
  liveSessionId: "session",
  cloudFileId: "cloud-file",
  createdAt: recordingStart,
  startedAt: "2026-11-06T08:00:00.000Z",
  updatedAt: "2026-11-06T08:02:00.000Z",
  transcriptText: original,
  language: "en",
  segments: [{ id: "seg", text: original, speakerName: "Lina", startMs: 120250, endMs: 130000 }],
  markers: [{ id: "note", kind: "highlight", note: "Check the alternate route", startMs: 125000 }],
};
const update = { id: record.id, title: record.title, status: "completed" as const };
const json = (value: unknown) => new Response(JSON.stringify(value));

let client: ApiClient;
let fetchMock: ReturnType<typeof vi.fn>;
const saveSummary = vi.fn();

beforeEach(() => {
  client = new ApiClient("https://business.invalid");
  client.setAgentBaseUrl("https://agent.invalid");
  client.setToken("test-session");
  setApiInstance(client);
  setApiTransportMode("direct");
  fetchMock = vi.fn();
  saveSummary.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("window", { desktopAPI: { localTranscription: { get: async () => record, saveSummary } } });
});

afterEach(() => {
  vi.unstubAllGlobals();
  setApiTransportMode("proxy");
});

describe("Desktop automatic meeting summary", () => {
  it("sends timed utterances and recording markers and saves the marked Markdown", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      const request = new URL(url);
      if (request.pathname === "/api/business/file/info") {
        expect(request.searchParams.get("fileId")).toBe("cloud-file");
        return json({
          id: "cloud-file",
          recordMarkResults: [{ title: "Delivery test", timeoffset: 124000 }],
          markImages: [{ imageId: "photo", timestamp: Date.parse(recordingStart) + 125000 }],
        });
      }
      if (request.pathname === "/api/business/file/mark/image/presign/download") {
        expect(request.searchParams.get("imageId")).toBe("photo");
        return json(photoUrl);
      }
      if (request.href === "https://agent.invalid/api/summarize") {
        return json({ title: "Route review", content: markedSummary });
      }
      throw new Error("Unexpected request");
    });

    expect(await triggerLocalAutoSummary(update)).toBe(true);
    const request = fetchMock.mock.calls.find(([url]) => url === "https://agent.invalid/api/summarize")?.[1];
    expect(request?.headers.Authorization).toBe("test-session");
    expect(JSON.parse(request?.body)).toMatchObject({
      transcription_text: "[00:02:00.250-00:02:10.000] Lina: " + original,
      recording_started_at: recordingStart,
      recordMarkResults: [
        { outline: "Check the alternate route", timeoffset: 125000 },
        { title: "Delivery test", timeoffset: 124000 },
      ],
      markImages: [{ imageId: "photo", timestamp: Date.parse(recordingStart) + 125000, url: photoUrl }],
    });
    expect(saveSummary).toHaveBeenCalledWith(record.id, "Route review", markedSummary);
  });

  it("returns the requested HTML for a separate note without writing the recording's summary", async () => {
    const html = "<!DOCTYPE html><html><body><h1>Route review</h1></body></html>";
    fetchMock.mockImplementation(async (url: string, request: RequestInit) => {
      if (new URL(url).pathname === "/api/business/file/info") return json({ id: "cloud-file" });
      expect(url).toBe("https://agent.invalid/api/summarize");
      expect(JSON.parse(String(request.body))).toMatchObject({ html: true });
      return json({ title: "Route review", content: markedSummary, html });
    });
    expect(await generateLocalLynclawSummary(record.id, "html")).toBe(html);
    expect(saveSummary).not.toHaveBeenCalled();
  });

  it("drops a pending summary when the login changes during marker lookup", async () => {
    fetchMock.mockImplementationOnce(async () => {
      client.setToken("other-session");
      return json({ id: "cloud-file" });
    });
    expect(await triggerLocalAutoSummary(update)).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(saveSummary).not.toHaveBeenCalled();
  });
});
