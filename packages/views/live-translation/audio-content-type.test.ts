import { describe, expect, it } from "vitest";
import { audioContentType } from "./audio-content-type";

describe("audioContentType", () => {
  it("maps the M4A recording default to the registered audio/mp4 type", () => {
    expect(audioContentType("20260101_120000.m4a")).toBe("audio/mp4");
    expect(audioContentType("/vault/Recordings/s1/20260101_120000.M4A")).toBe("audio/mp4");
    expect(audioContentType("clip.mp4")).toBe("audio/mp4");
    expect(audioContentType("clip.mp4a")).toBe("audio/mp4");
  });

  it("keeps WAV for older saves and the no-ffmpeg fallback", () => {
    expect(audioContentType("20251001_090000.wav")).toBe("audio/wav");
    expect(audioContentType("20251001_090000.pcm.wav")).toBe("audio/wav");
  });

  it("maps other accepted upload formats", () => {
    expect(audioContentType("voice.mp3")).toBe("audio/mpeg");
    expect(audioContentType("voice.aac")).toBe("audio/aac");
    expect(audioContentType("voice.ogg")).toBe("audio/ogg");
    expect(audioContentType("voice.flac")).toBe("audio/flac");
  });

  it("falls back to audio/wav when no extension is parseable", () => {
    expect(audioContentType("no-extension")).toBe("audio/wav");
    expect(audioContentType("")).toBe("audio/wav");
    expect(audioContentType("file.unknown")).toBe("audio/wav");
  });
});
