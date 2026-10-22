import { describe, expect, it } from "vitest";
import { recordingLevel } from "./audio-sources";
import { initialLiveTranslationState, reduceLiveTranslationEvent } from "./state";

describe("recording source signals", () => {
  it("shows computer audio without a microphone and ignores disabled-source levels", () => {
    expect(recordingLevel({ audioSources: ["system"], micLevel: 0, systemLevel: 0.7 })).toBe(0.7);
    expect(recordingLevel({ audioSources: ["mic"], micLevel: 0.2, systemLevel: 0.9 })).toBe(0.2);
    expect(recordingLevel({ audioSources: [], micLevel: 1, systemLevel: 1 })).toBe(0);
    expect(recordingLevel({ audioSources: ["system", "mic"], micLevel: 1, systemLevel: 1, recordingLevel: 0.3 })).toBe(0.3);
  });

  it("does not let delayed source snapshots or level events reactivate a disabled source", () => {
    const state = { ...initialLiveTranslationState(), sessionId: "session", sourceRevision: 3, audioSources: ["system"] as const };
    const snapshot = { ...state, audioSources: ["system" as const] };
    const old = reduceLiveTranslationEvent(snapshot, { type: "levels", mic: 1, system: 1, elapsedMs: 10, sourceRevision: 2, sessionId: "session" });
    expect(old).toBe(snapshot);
    const other = reduceLiveTranslationEvent(snapshot, { type: "levels", mic: 1, system: 1, elapsedMs: 10, sourceRevision: 3, sessionId: "previous" });
    expect(other).toBe(snapshot);
    const current = reduceLiveTranslationEvent(snapshot, { type: "levels", mic: 1, system: 0.5, elapsedMs: 10, sourceRevision: 3, sessionId: "session" });
    expect(current.micLevel).toBe(0);
    expect(current.systemLevel).toBe(0.5);
    expect(reduceLiveTranslationEvent(snapshot, { type: "state", snapshot: { ...snapshot, sourceRevision: 2, audioSources: ["mic", "system"] } })).toBe(snapshot);
  });
});
