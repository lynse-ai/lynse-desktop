import { describe, expect, it } from "vitest";
import { editorWaveformBars } from "./waveform-display";

describe("editorWaveformBars", () => {
  it("preserves quiet stretches and limits the effect of an isolated peak", () => {
    const peaks = [1, 0, 0, 0, 0.75, 0.75, 0.75, 0.75, 0, 0, 0, 0];
    expect(Array.from(editorWaveformBars(peaks, 12, 0, 12, 9))).toEqual([0.5, 0.75, 0]);
  });

  it("uses only peaks inside the visible time range, including the final partial column", () => {
    const peaks = [1, 0.25, 0.25, 0.5, 0.5, 1];
    expect(Array.from(editorWaveformBars(peaks, 6, 1, 5, 5))).toEqual([0.25, 0.5]);
  });
});
