/* @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { computePeaks, useWaveformPeaks } from "./use-waveform-peaks";
import { waveformBars } from "@lynse/ui/components/ui/waveform";

const native = vi.hoisted(() => ({ waveformPeaks: vi.fn() }));
vi.mock("../live-translation/desktop-api", () => ({ getDesktopLiveTranslationApi: () => native }));
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("recording playback waveform", () => {
  it("keeps the end of the recording visible on narrow players", () => {
    const peaks = Array<number>(256).fill(0);
    peaks[255] = 0.8;
    expect(waveformBars(peaks, 20).at(-1)).toBe(0.8);
    expect(waveformBars([0, 1], 4)).toEqual([0, 0, 1, 1]);
  });
  it("includes a non-silent right channel and preserves true silence", () => {
    const audio = { numberOfChannels: 2, getChannelData: (index: number) => new Float32Array(index ? [0, 0, 0.5, 0.5] : [0, 0, 0, 0]) } as AudioBuffer;
    expect(computePeaks(audio, 2)).toEqual([0, 1]);
  });

  it("loads long local recordings through the native peak cache and immediately drops stale peaks", async () => {
    native.waveformPeaks.mockResolvedValueOnce({ peaks: [0, 0.8], durationMs: 7200000 });
    let finish!: (value: { peaks: number[]; durationMs: number }) => void;
    native.waveformPeaks.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const { result, rerender } = renderHook(({ src }) => useWaveformPeaks(src), { initialProps: { src: "local-media://localhost/first" } });
    await waitFor(() => expect(result.current.peaks).toEqual([0, 0.8]));
    rerender({ src: "local-media://localhost/second" });
    expect(result.current.peaks).toEqual([]);
    expect(result.current.loading).toBe(true);
    finish({ peaks: [0.4, 0], durationMs: 1000 });
    await waitFor(() => expect(result.current.peaks).toEqual([0.4, 0]));
    expect(fetchSpy).not.toHaveBeenCalled();
    rerender({ src: "" });
    expect(result.current.peaks).toEqual([]);
  });
});
