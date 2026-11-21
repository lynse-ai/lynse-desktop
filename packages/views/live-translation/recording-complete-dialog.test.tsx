/* @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18next from "i18next";
import { initI18n } from "@lynse/core/i18n";
import { RESOURCES } from "../locales";
import { RecordingCompleteDialog } from "./recording-complete-dialog";
import type { CompletedLiveSession } from "./types";

vi.mock("./desktop-api", () => ({
  getDesktopLiveTranslationApi: () => null,
}));

vi.mock("../workspace/use-waveform-peaks", () => ({
  useWaveformPeaks: () => ({ peaks: [] }),
}));

vi.mock("../workspace/waveform-progress", () => ({
  WaveformProgress: () => null,
}));

function makeSession(id: string): CompletedLiveSession {
  return {
    sessionId: id,
    recordId: `record-${id}`,
    playbackPath: `/tmp/${id}.wav`,
    playbackUrl: "",
    transcriptPath: "",
    durationMs: 61_000,
    segments: [],
  };
}

beforeEach(async () => {
  initI18n({ locale: "en", resources: RESOURCES });
  await i18next.changeLanguage("en");
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  window.localStorage.clear();
});

describe("RecordingCompleteDialog remember choice", () => {
  it("persists the remembered save-to-cloud choice for the next dialog", () => {
    const onSavedLocal = vi.fn();
    const onOpenChange = vi.fn();

    // ── First recording: user ticks both boxes and saves ──
    const first = render(
      <RecordingCompleteDialog
        completedSession={makeSession("s1")}
        open
        onOpenChange={onOpenChange}
        onSavedLocal={onSavedLocal}
      />,
    );
    expect(screen.getByRole("checkbox", { name: /save to cloud/i }).getAttribute("aria-checked")).toBe("false");
    fireEvent.click(screen.getByRole("checkbox", { name: /save to cloud/i }));
    fireEvent.click(screen.getByRole("checkbox", { name: /remember/i }));
    fireEvent.click(screen.getByRole("button", { name: "Save to cloud" }));
    expect(onSavedLocal).toHaveBeenCalledTimes(1);
    expect(onOpenChange).toHaveBeenCalledWith(false);

    const raw = window.localStorage.getItem("lynse_rec_save_to_cloud_pref");
    expect(JSON.parse(raw ?? "{}")).toEqual({ remember: true, saveToCloud: true });
    first.unmount();

    // ── Second recording: dialog must open with the same selection ──
    render(
      <RecordingCompleteDialog
        completedSession={makeSession("s2")}
        open
        onOpenChange={vi.fn()}
        onSavedLocal={vi.fn()}
      />,
    );
    expect(screen.getByRole("checkbox", { name: /save to cloud/i }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("checkbox", { name: /remember/i }).getAttribute("aria-checked")).toBe("true");
  });
});
