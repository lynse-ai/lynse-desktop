/* @vitest-environment jsdom */

import { beforeEach, describe, expect, it } from "vitest";
import {
  APP_THEME_STORAGE_KEY,
  applyAppTheme,
  getAppThemeState,
  isHexColor,
  readableForeground,
  selectAppThemePreset,
  setAppThemeAccent,
} from "./app-theme";

const html = document.documentElement;

function inlineVar(name: string): string {
  return html.style.getPropertyValue(name);
}

beforeEach(() => {
  window.localStorage.clear();
  html.removeAttribute("data-translucent-sidebar");
  html.style.cssText = "";
  html.classList.remove("dark");
});

describe("state parsing", () => {
  it("defaults to the Lynse preset with no accent", () => {
    expect(getAppThemeState()).toEqual({ preset: "lynse" });
  });

  it("drops junk fields and invalid hex from storage", () => {
    window.localStorage.setItem(
      APP_THEME_STORAGE_KEY,
      JSON.stringify({ preset: "notion", accent: "nope", fonts: "Comic Sans", version: 2 })
    );
    expect(getAppThemeState()).toEqual({ preset: "notion" });
    window.localStorage.setItem(APP_THEME_STORAGE_KEY, "{broken");
    expect(getAppThemeState()).toEqual({ preset: "lynse" });
  });
});

describe("presets", () => {
  it("Linear paints its full look in both modes and persists", () => {
    const state = selectAppThemePreset("linear");
    expect(state).toEqual({ preset: "linear" });
    expect(inlineVar("--primary")).toBe("#5e6ad2");
    expect(inlineVar("--background")).toBe("#fcfcfd");
    expect(inlineVar("--sidebar")).toBe("#f7f7f8");
    expect(JSON.parse(window.localStorage.getItem(APP_THEME_STORAGE_KEY)!).preset).toBe("linear");

    applyAppTheme(state, "dark");
    expect(inlineVar("--background")).toBe("#08090a");
    expect(inlineVar("--sidebar")).toBe("#0f1011");
    // Linear keeps the same accent in dark; brand tints derive from it.
    expect(inlineVar("--accent-brand-text")).toBe("#aab1e8");
  });

  it("Notion dark overrides the hardcoded gold brand tints", () => {
    html.classList.add("dark");
    selectAppThemePreset("notion");
    expect(inlineVar("--accent-brand-text")).toBe("#529cca");
    expect(inlineVar("--sidebar")).toBe("#202020");
    expect(inlineVar("--primary-foreground")).toBe("#ffffff");
  });

  it("returning to Lynse clears every preset variable", () => {
    selectAppThemePreset("linear");
    expect(inlineVar("--sidebar")).not.toBe("");
    selectAppThemePreset("lynse");
    expect(inlineVar("--sidebar")).toBe("");
    expect(inlineVar("--background")).toBe("");
    expect(inlineVar("--primary")).toBe("");
  });
});

describe("accent override", () => {
  it("repaints the accent family on top of the stock theme and derives tints", () => {
    html.classList.add("dark");
    setAppThemeAccent("#88c0d0");
    expect(inlineVar("--primary")).toBe("#88c0d0");
    expect(inlineVar("--primary-foreground")).toBe("#15110a");
    expect(inlineVar("--accent-brand")).toContain("136 192 208");
    // Surfaces stay stock (no preset active).
    expect(inlineVar("--sidebar")).toBe("");
    expect(inlineVar("--background")).toBe("");
  });

  it("keeps preset surfaces while overriding the accent", () => {
    selectAppThemePreset("notion");
    setAppThemeAccent("#ff0000");
    expect(inlineVar("--primary")).toBe("#ff0000");
    expect(inlineVar("--sidebar")).toBe("#f7f7f5");
  });

  it("clearing the accent falls back to the preset's own accent", () => {
    selectAppThemePreset("notion");
    setAppThemeAccent("#ff0000");
    setAppThemeAccent(undefined);
    expect(inlineVar("--primary")).toBe("#2383e2");
  });

  it("a 3-digit hex is normalized", () => {
    expect(setAppThemeAccent("#ABC").accent).toBe("#aabbcc");
  });
});

describe("color helpers", () => {
  it("isHexColor accepts 3- and 6-digit hex only", () => {
    expect(isHexColor("#abc")).toBe(true);
    expect(isHexColor("#A1B2C3")).toBe(true);
    expect(isHexColor("blue")).toBe(false);
    expect(isHexColor("#12345")).toBe(false);
  });

  it("picks dark foreground text on light accents and vice versa", () => {
    expect(readableForeground("#e0e0e0")).toBe("#15110a");
    expect(readableForeground("#2383e2")).toBe("#ffffff");
  });
});
