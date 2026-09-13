/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AudioEditorPage } from "./audio-editor-page";
import { useAudioEditorStore } from "./store";

vi.mock("@lynse/core/i18n/react", () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) =>
      params ? `${key}:${JSON.stringify(params)}` : key,
    i18n: { language: "en" },
  }),
}));

vi.mock("../navigation", () => ({
  useNavigation: () => ({ push: vi.fn(), pathname: "/audio-editor" }),
}));

// Desktop bridge: runtime present, no audio URL resolvable (waveform falls
// back to its unavailable state — fine for a smoke test).
beforeEach(() => {
  (window as unknown as { desktopAPI: unknown }).desktopAPI = {
    audioEditor: {
      status: () => Promise.resolve({ ffmpegAvailable: true }),
      ensureRuntime: () => Promise.resolve({ ffmpegAvailable: true }),
      trim: vi.fn(),
      merge: vi.fn(),
      removeSilence: vi.fn(),
      enhanceVoice: vi.fn(),
      cancel: vi.fn(),
      onProgress: () => Promise.resolve(() => undefined),
    },
    localTranscription: {
      getAudioUrl: () => Promise.resolve(null),
    },
  };
});

afterEach(() => {
  cleanup();
  useAudioEditorStore.getState().clear();
  delete (window as unknown as { desktopAPI?: unknown }).desktopAPI;
});

function renderEditor() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <AudioEditorPage />
    </QueryClientProvider>,
  );
}

describe("AudioEditorPage", () => {
  it("renders the single-file editor (trim mode) for a local recording", () => {
    useAudioEditorStore.getState().openEditor([{ id: "local-1", title: "Recording A" }]);
    renderEditor();

    // Trim header: file title + back button. The ✓ (done) button only
    // exists while an edit is pending — a fresh trim state has none.
    expect(screen.getByText("Recording A")).toBeTruthy();
    expect(screen.getByLabelText("audio_editor.back_to_notes")).toBeTruthy();
    expect(screen.queryByLabelText("audio_editor.done")).toBeNull();
    // Mode pill + transport are present.
    expect(screen.getByText("audio_editor.trim")).toBeTruthy();
    expect(screen.getByLabelText("audio_editor.play")).toBeTruthy();
    expect(screen.getByText("audio_editor.save_overwrite")).toBeTruthy();
  });

  it("opens in merge mode with the order rail when several files are handed over", () => {
    useAudioEditorStore
      .getState()
      .openEditor([
        { id: "local-1", title: "Recording A" },
        { id: "local-2", title: "Recording B" },
      ]);
    renderEditor();

    expect(screen.getByText("audio_editor.merge_order")).toBeTruthy();
    expect(screen.getAllByText("Recording A").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Recording B").length).toBeGreaterThan(0);
    // Merge always exports a new note — no save-target toggle.
    expect(screen.queryByText("audio_editor.save_overwrite")).toBeNull();
    // Merging is itself a pending edit — the ✓ (done) button is available.
    expect(screen.getByLabelText("audio_editor.done")).toBeTruthy();
  });

  it("shows the empty state when no request is pending", () => {
    renderEditor();
    expect(screen.getByText("audio_editor.empty")).toBeTruthy();
  });
});
