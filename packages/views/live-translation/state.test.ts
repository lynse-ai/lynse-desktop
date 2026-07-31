import { describe, expect, it } from "vitest";
import { initialLiveTranslationState, reduceLiveTranslationEvent } from "./state";
import type { LiveTranslationSegment } from "./types";

function segment(id: string, startMs: number, text: string, isFinal = false): LiveTranslationSegment {
  return {
    id,
    sessionId: "session",
    epoch: 0,
    source: "system",
    recognizedText: text,
    translatedText: "",
    startMs,
    isFinal,
  };
}

describe("live translation reducer", () => {
  it("replaces temporary results with the final result in place", () => {
    let state = initialLiveTranslationState();
    state = reduceLiveTranslationEvent(state, { type: "segment", segment: segment("a", 100, "临时") });
    state = reduceLiveTranslationEvent(state, { type: "segment", segment: segment("a", 100, "最终", true) });
    expect(state.segments).toHaveLength(1);
    expect(state.segments[0]?.recognizedText).toBe("最终");
    expect(state.segments[0]?.isFinal).toBe(true);
  });

  it("keeps the merged timeline sorted", () => {
    let state = initialLiveTranslationState();
    state = reduceLiveTranslationEvent(state, { type: "segment", segment: segment("later", 500, "later") });
    state = reduceLiveTranslationEvent(state, { type: "segment", segment: segment("earlier", 100, "earlier") });
    expect(state.segments.map((item) => item.id)).toEqual(["earlier", "later"]);
  });

  it("clears a transient connection error after the stream reconnects", () => {
    let state = initialLiveTranslationState();
    state = reduceLiveTranslationEvent(state, {
      type: "streamState",
      source: "mic",
      state: "reconnecting",
      epoch: 0,
    });
    state = reduceLiveTranslationEvent(state, {
      type: "error",
      source: "mic",
      message: "翻译连接中断",
    });
    state = reduceLiveTranslationEvent(state, {
      type: "streamState",
      source: "system",
      state: "connected",
      epoch: 0,
    });
    expect(state.lastError).toBe("翻译连接中断");
    state = reduceLiveTranslationEvent(state, {
      type: "streamState",
      source: "mic",
      state: "connected",
      epoch: 0,
    });
    expect(state.lastError).toBeUndefined();
  });

  it("keeps non-connection errors when a stream connects", () => {
    let state = initialLiveTranslationState();
    state = reduceLiveTranslationEvent(state, {
      type: "error",
      message: "音频采集失败",
    });
    state = reduceLiveTranslationEvent(state, {
      type: "streamState",
      source: "mic",
      state: "connected",
      epoch: 0,
    });
    expect(state.lastError).toBe("音频采集失败");
  });
});
