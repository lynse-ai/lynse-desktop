/* @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import i18next from "i18next";
import { initI18n } from "@lynse/core/i18n";
import { fetchLatestReleaseNotes, useAppUpdate } from "./app-update";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("update notes at the UI boundary", () => {
  it("changes displayed notes immediately when the application language changes", async () => {
    initI18n({ locale: "en" });
    await i18next.changeLanguage("en");
    const check = vi.fn(async () => ({
      currentVersion: "1.1.15", latestVersion: "1.2.0", hasUpdate: true,
      releaseUrl: "https://www.lynse.cn/download", releaseNotes: "English",
      releaseNotesByLocale: { en: "English", "zh-Hans": "简体说明", "zh-Hant": "繁體說明", ja: "日本語", ko: "한국어" },
    }));
    Object.defineProperty(window, "desktopAPI", { configurable: true, value: { app: { checkForUpdate: check } } });
    vi.spyOn(globalThis, "setInterval").mockReturnValue(1 as unknown as ReturnType<typeof setInterval>);
    const { result } = renderHook(() => useAppUpdate());
    await act(async () => { await Promise.resolve(); });
    expect(result.current.update?.releaseNotes).toBe("English");
    for (const [language, text] of [["zh-Hans", "简体说明"], ["zh-Hant", "繁體說明"], ["ja", "日本語"], ["ko", "한국어"]]) {
      await act(async () => { await i18next.changeLanguage(language); });
      expect(result.current.update?.releaseNotes).toBe(text);
    }
    expect(check).toHaveBeenCalledTimes(1);
    Object.defineProperty(window, "desktopAPI", { configurable: true, value: undefined });
  });

  it("preserves the manifest translations for the About panel and ignores malformed fields", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({
      version: "1.2.0", notes: "English", notes_i18n: { en: "English", "zh-Hans": "简体说明", ja: 12 },
    }) })));
    expect(await fetchLatestReleaseNotes()).toMatchObject({ version: "1.2.0", notes: "English", notesByLocale: { en: "English", "zh-Hans": "简体说明" } });
  });
});
