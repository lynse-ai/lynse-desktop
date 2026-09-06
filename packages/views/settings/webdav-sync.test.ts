/* @vitest-environment jsdom */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { initI18n } from "@lynse/core/i18n";
import {
  applySettingsBundle,
  collectSettingsBundle,
  getDesktopWebdavSyncApi,
  syncNotesToWebdav,
} from "./webdav-sync";

declare global {
  // eslint-disable-next-line no-var
  var desktopAPI: Record<string, unknown> | undefined;
}

const saveSttConfig = vi.fn(async () => ({}));

beforeEach(() => {
  window.localStorage.clear();
  saveSttConfig.mockClear();
  delete globalThis.desktopAPI;
});

afterEach(() => {
  delete globalThis.desktopAPI;
});

describe("getDesktopWebdavSyncApi", () => {
  it("returns null when the bridge is absent", () => {
    expect(getDesktopWebdavSyncApi()).toBeNull();
  });
});

describe("collectSettingsBundle", () => {
  it("gathers theme, locale, live-translation entries, and STT config", async () => {
    window.localStorage.setItem("theme", "dark");
    window.localStorage.setItem("lynse_locale", "zh-Hans");
    window.localStorage.setItem("lynse_live_translation_provider", "qwen");
    window.localStorage.setItem("lynse_live_translation_volc_endpoint", "wss://example/volc");
    globalThis.desktopAPI = {
      localTranscription: {
        getSttConfig: async () => ({ default: { provider: "whisper" } }),
      },
    };

    const bundle = await collectSettingsBundle();

    expect(bundle.schemaVersion).toBe(1);
    expect(bundle.exportedAt).toBeTruthy();
    expect(bundle.preferences).toEqual({ theme: "dark", locale: "zh-Hans" });
    expect(bundle.liveTranslation).toEqual({
      lynse_live_translation_provider: "qwen",
      lynse_live_translation_volc_endpoint: "wss://example/volc",
    });
    expect(bundle.sttConfig).toEqual({ default: { provider: "whisper" } });
  });

  it("prefers an explicitly passed theme and omits empty sections", async () => {
    const bundle = await collectSettingsBundle("light");
    expect(bundle.preferences).toEqual({ theme: "light" });
    expect(bundle.liveTranslation).toBeUndefined();
    expect(bundle.sttConfig).toBeUndefined();
  });
});

describe("applySettingsBundle", () => {
  beforeAll(() => {
    initI18n({ locale: "en", resources: {} });
  });

  it("writes preferences and calls setTheme", async () => {
    const setTheme = vi.fn();
    await applySettingsBundle(
      {
        schemaVersion: 1,
        exportedAt: "2026-01-01T00:00:00Z",
        preferences: { theme: "light", locale: "zh-Hans" },
      },
      { setTheme },
    );
    expect(window.localStorage.getItem("theme")).toBe("light");
    expect(window.localStorage.getItem("lynse_locale")).toBe("zh-Hans");
    expect(setTheme).toHaveBeenCalledWith("light");
    expect(initI18n).toBeTruthy();
  });

  it("only writes allowlisted live-translation keys", async () => {
    await applySettingsBundle({
      schemaVersion: 1,
      exportedAt: "2026-01-01T00:00:00Z",
      liveTranslation: {
        lynse_live_translation_volc_endpoint: "wss://ok",
        lynse_arbitrary_injected_key: "hostile",
      },
    });
    expect(window.localStorage.getItem("lynse_live_translation_volc_endpoint")).toBe("wss://ok");
    expect(window.localStorage.getItem("lynse_arbitrary_injected_key")).toBeNull();
  });

  it("saves the STT config through the bridge when present", async () => {
    globalThis.desktopAPI = {
      localTranscription: { saveSttConfig },
    };
    const sttConfig = { default: { provider: "funasr" } };
    await applySettingsBundle({
      schemaVersion: 1,
      exportedAt: "2026-01-01T00:00:00Z",
      sttConfig,
    });
    expect(saveSttConfig).toHaveBeenCalledWith(sttConfig);
  });
});

describe("syncNotesToWebdav", () => {
  it("returns null instead of wiping the remote folder when nothing to push", async () => {
    const putNotes = vi.fn();
    globalThis.desktopAPI = { webdavSync: { putNotes } };
    // A local-only recording is filtered out before any cloud fetch, so the
    // batch ends up empty and the push is skipped.
    const result = await syncNotesToWebdav([{ id: "local:rec-1", title: "本地录音" }]);
    expect(result).toBeNull();
    expect(putNotes).not.toHaveBeenCalled();
  });
});
