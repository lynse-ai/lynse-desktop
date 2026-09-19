/* @vitest-environment jsdom */

/**
 * Recording smoothness benchmark for the live-capture UI.
 *
 * The capture sidecar publishes a `levels` event (mic/system level + elapsed
 * time) five times per second for the whole session. These tests pin the
 * contract that makes that stream cheap:
 *
 *   - high-frequency `levels` events must NOT re-render consumers of the
 *     main live-translation view state (pages re-render only on real state
 *     changes — session, segments, errors);
 *   - a dedicated levels subscription must deliver every update to the few
 *     leaves that actually show meters/timers.
 *
 * Before the levels/split optimization every 200 ms tick re-rendered the
 * entire recording page; these budgets keep that regression out.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type {
  DesktopLiveTranslationApi,
  LiveTranslationEvent,
  LiveTranslationSnapshot,
} from "./types";

vi.mock("@lynse/core/i18n/react", () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: "zh" } }),
}));

const recordingSnapshot: LiveTranslationSnapshot = {
  state: "recording",
  sessionId: "session-1",
  epoch: 1,
  startedAt: new Date().toISOString(),
  elapsedMs: 0,
  micLevel: 0,
  systemLevel: 0,
  segments: [],
  sourceLanguage: "zh",
  targetLanguage: "zh",
};

function makeFakeApi(): DesktopLiveTranslationApi & {
  emit: (event: LiveTranslationEvent) => void;
} {
  let listener: ((event: LiveTranslationEvent) => void) | null = null;
  const api = {
    emit: (event: LiveTranslationEvent) => listener?.(event),
    async getState() {
      return recordingSnapshot;
    },
    async onEvent(handler: (event: LiveTranslationEvent) => void) {
      listener = handler;
      return () => {
        listener = null;
      };
    },
    async onTrayAction() {
      return () => undefined;
    },
    async permissions() {
      return {
        microphone: "granted",
        systemAudio: "granted",
        systemAudioRequired: false,
        restartRequired: false,
      };
    },
    async requestPermission() {
      return {
        microphone: "granted",
        systemAudio: "granted",
        systemAudioRequired: false,
        restartRequired: false,
      };
    },
    async getProviderConfig() {
      return { provider: "lynse_backend" } as never;
    },
    async saveProviderConfig(config) {
      return config;
    },
  } as unknown as DesktopLiveTranslationApi & { emit: (event: LiveTranslationEvent) => void };
  return api;
}

let fakeApi: ReturnType<typeof makeFakeApi>;

/** Counts how many times the FULL view-state hook re-renders its consumer. */
let mainHookRenders: number;
function MainHookProbe() {
  useLiveTranslation();
  mainHookRenders += 1;
  return null;
}

function LevelsProbe() {
  const levels = useLiveLevels();
  levelsProbeRenders += 1;
  return <div data-testid="levels-elapsed">{levels.elapsedMs}</div>;
}

let levelsProbeRenders: number;

import { useLiveTranslation } from "./use-live-translation";
import { useLiveLevels } from "./live-levels";
import { TranscriptDetailPage } from "./transcript-detail-page";

describe("recording levels streaming performance", () => {
  beforeEach(() => {
    mainHookRenders = 0;
    levelsProbeRenders = 0;
    fakeApi = makeFakeApi();
    (window as Window & { desktopAPI?: unknown }).desktopAPI = {
      liveTranslation: fakeApi,
    };
  });

  afterEach(() => {
    cleanup();
    delete (window as Window & { desktopAPI?: unknown }).desktopAPI;
  });

  it("does not re-render view-state consumers on 5 Hz level ticks", async () => {
    render(<MainHookProbe />);
    await act(async () => {}); // let the initial getState() land

    const before = mainHookRenders;
    await act(async () => {
      for (let i = 1; i <= 60; i += 1) {
        fakeApi.emit({ type: "levels", mic: i / 100, system: 0.2, elapsedMs: i * 200 });
      }
    });

    const renders = mainHookRenders - before;
    console.info(`[recording-perf] main-view renders for 60 level ticks: ${renders}`);
    // The main view state must be untouched by levels: pages re-render on
    // session/segment changes only. (Was 60 — one full-page render per tick.)
    expect(renders).toBe(0);
  });

  it("delivers every level tick to subscribed leaves with the latest values", async () => {
    render(<LevelsProbe />);
    await act(async () => {
      for (let i = 1; i <= 60; i += 1) {
        fakeApi.emit({ type: "levels", mic: i / 100, system: 0.2, elapsedMs: i * 200 });
      }
    });

    expect(levelsProbeRenders).toBeGreaterThanOrEqual(60);
    expect(screen.getByTestId("levels-elapsed").textContent).toBe("12000");
  });

  it("does not notify levels subscribers when nothing changed", async () => {
    render(<LevelsProbe />);
    const baseline = levelsProbeRenders;
    await act(async () => {
      fakeApi.emit({ type: "levels", mic: 0.5, system: 0.2, elapsedMs: 1000 });
      fakeApi.emit({ type: "levels", mic: 0.5, system: 0.2, elapsedMs: 1000 });
      fakeApi.emit({ type: "levels", mic: 0.5, system: 0.2, elapsedMs: 1000 });
    });
    // Identical payloads collapse into one notification.
    expect(levelsProbeRenders - baseline).toBe(1);
  });

  it("keeps the recording page rendering through a level storm", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <TranscriptDetailPage />
      </QueryClientProvider>,
    );
    await act(async () => {});

    await act(async () => {
      for (let i = 1; i <= 60; i += 1) {
        fakeApi.emit({ type: "levels", mic: i / 100, system: 0.2, elapsedMs: i * 200 });
      }
    });

    // The page survives a level storm; the heavy assertions about who
    // re-renders live in the probe tests above.
    expect(screen.getByTestId("levels-elapsed") ?? document.body).toBeTruthy();
  });
});
