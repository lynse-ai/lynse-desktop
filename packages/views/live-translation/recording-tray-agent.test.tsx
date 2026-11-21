/* @vitest-environment jsdom */

import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import i18next from "i18next";
import { initI18n } from "@lynse/core/i18n";
import { RESOURCES } from "../locales";
import { RecordingTrayAgent, autoSaveCompletedSession } from "./recording-tray-agent";
import { useRecordingCompleteStore } from "./recording-complete-store";
import type { CompletedLiveSession } from "./types";

const state = vi.hoisted(() => {
  const handlers: Array<(event: unknown) => void> = [];
  const fakeApi = {
    onEvent: (cb: (event: unknown) => void) => {
      handlers.push(cb);
      return Promise.resolve(() => undefined);
    },
    onTrayAction: () => Promise.resolve(() => undefined),
    getState: () => Promise.resolve({ sessionId: null }),
    getProviderConfig: () => Promise.resolve({}),
    listRecoveries: () => Promise.resolve([]),
    finalizeLocal: undefined as unknown as (id: string, synced: boolean) => Promise<void>,
  };
  return {
    handlers,
    fakeApi,
    finalizeLocal: vi.fn<(id: string, synced: boolean) => Promise<void>>(),
    syncCompletedSession: vi.fn(),
    workbenchSync: vi.fn(() => Promise.resolve()),
  };
});

vi.mock("./desktop-api", () => ({
  getDesktopLiveTranslationApi: () => state.fakeApi,
}));

vi.mock("./use-live-translation", () => ({
  useLiveTranslation: () => ({ api: state.fakeApi }),
}));

vi.mock("./use-recording-cloud-sync", () => ({
  useRecordingCloudSync: () => ({ syncCompletedSession: state.syncCompletedSession }),
}));

vi.mock("../navigation", () => ({
  useNavigation: () => ({ push: vi.fn() }),
}));

vi.mock("./api", () => ({
  audioModeSources: () => [],
}));

vi.mock("../workbench/api", () => ({
  getWorkbenchApi: () => ({ sync: state.workbenchSync }),
}));

const REMEMBER_KEY = "lynse_rec_save_to_cloud_pref";

function makeSession(id: string): CompletedLiveSession {
  return {
    sessionId: id,
    recordId: `record-${id}`,
    playbackPath: `/tmp/${id}.wav`,
    playbackUrl: "",
    transcriptPath: "",
    durationMs: 30_000,
    segments: [],
  };
}

function setPref(pref: { remember: boolean; saveToCloud: boolean }) {
  window.localStorage.setItem(REMEMBER_KEY, JSON.stringify(pref));
}

function renderAgent(): QueryClient {
  const queryClient = new QueryClient();
  render(
    <QueryClientProvider client={queryClient}>
      <RecordingTrayAgent />
    </QueryClientProvider>,
  );
  return queryClient;
}

async function fireCompleted(session: CompletedLiveSession) {
  const completedHandler = state.handlers[0];
  if (!completedHandler) throw new Error("completed listener not registered");
  await act(async () => {
    completedHandler({ type: "completed", session });
    // Let the auto-save chain settle (finalizeLocal → markSaved → cloud sync)
    // via a macrotask boundary — it crosses several microtask turns.
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

beforeEach(async () => {
  initI18n({ locale: "en", resources: RESOURCES });
  await i18next.changeLanguage("en");
  window.localStorage.clear();
  useRecordingCompleteStore.setState({ session: null, savedRecordId: null });
  state.handlers.length = 0;
  state.finalizeLocal.mockReset().mockResolvedValue(undefined);
  state.fakeApi.finalizeLocal = state.finalizeLocal;
  state.syncCompletedSession.mockReset();
  state.workbenchSync.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  window.localStorage.clear();
  useRecordingCompleteStore.setState({ session: null, savedRecordId: null });
});

describe("completed event handling with the remembered choice", () => {
  it("parks the session for the dialog when the user did not opt out of asking", async () => {
    setPref({ remember: false, saveToCloud: false });
    renderAgent();
    const session = makeSession("s1");
    await fireCompleted(session);

    expect(state.finalizeLocal).not.toHaveBeenCalled();
    expect(state.syncCompletedSession).not.toHaveBeenCalled();
    expect(useRecordingCompleteStore.getState().session).toBe(session);
  });

  it("auto-saves locally without opening the dialog when remember=true", async () => {
    setPref({ remember: true, saveToCloud: false });
    renderAgent();
    const session = makeSession("s2");
    await fireCompleted(session);

    expect(state.finalizeLocal).toHaveBeenCalledWith("s2", false);
    expect(state.syncCompletedSession).not.toHaveBeenCalled();
    expect(state.workbenchSync).toHaveBeenCalledWith(false);
    // No dialog hand-off; the header workbench button id is recorded.
    expect(useRecordingCompleteStore.getState().session).toBeNull();
    expect(useRecordingCompleteStore.getState().savedRecordId).toBe("record-s2");
  });

  it("starts the cloud upload as well when the remembered choice was save-to-cloud", async () => {
    setPref({ remember: true, saveToCloud: true });
    renderAgent();
    const session = makeSession("s3");
    await fireCompleted(session);

    expect(state.finalizeLocal).toHaveBeenCalledWith("s3", false);
    expect(state.syncCompletedSession).toHaveBeenCalledWith(session);
    expect(useRecordingCompleteStore.getState().session).toBeNull();
  });

  it("falls back to the dialog when the local finalize fails", async () => {
    setPref({ remember: true, saveToCloud: true });
    state.finalizeLocal.mockRejectedValue(new Error("disk full"));
    renderAgent();
    const session = makeSession("s4");
    await fireCompleted(session);

    expect(state.syncCompletedSession).not.toHaveBeenCalled();
    // The session must not be stranded: the dialog opens for a manual choice.
    expect(useRecordingCompleteStore.getState().session).toBe(session);
    expect(useRecordingCompleteStore.getState().savedRecordId).toBeNull();
  });
});

describe("autoSaveCompletedSession", () => {
  it("parks the session when there is no desktop bridge", async () => {
    const desktopApi = await import("./desktop-api");
    vi.spyOn(desktopApi, "getDesktopLiveTranslationApi").mockReturnValue(null);
    const session = makeSession("s5");
    const outcome = await autoSaveCompletedSession(session, false, state.syncCompletedSession);
    expect(outcome).toBe("parked");
    expect(useRecordingCompleteStore.getState().session).toBe(session);
    vi.mocked(desktopApi.getDesktopLiveTranslationApi).mockRestore();
  });
});
