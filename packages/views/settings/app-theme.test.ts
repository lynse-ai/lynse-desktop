/* @vitest-environment jsdom */

import { beforeEach, describe, expect, it } from "vitest";
import {
  APP_THEME_STORAGE_KEY,
  contrastMutedForeground,
  exportAppThemeState,
  getAppThemeState,
  importAppThemeState,
  isAppThemeCustomized,
  isHexColor,
  mixHex,
  readableForeground,
  resetAppThemeRecord,
  selectAppThemePreset,
  updateAppThemeRecord,
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

describe("isHexColor / color math", () => {
  it("accepts 3- and 6-digit hex only", () => {
    expect(isHexColor("#abc")).toBe(true);
    expect(isHexColor("#A1B2C3")).toBe(true);
    expect(isHexColor("blue")).toBe(false);
    expect(isHexColor("#12345")).toBe(false);
    expect(isHexColor("")).toBe(false);
  });

  it("mixes colors linearly and clamps", () => {
    expect(mixHex("#000000", "#ffffff", 0.5)).toBe("#808080");
    expect(mixHex("#112233", "#112233", 0.9)).toBe("#112233");
  });

  it("picks dark foreground text on light accents and vice versa", () => {
    expect(readableForeground("#e0e0e0")).toBe("#15110a");
    expect(readableForeground("#2383e2")).toBe("#ffffff");
  });

  it("raises muted-foreground toward the foreground at high contrast", () => {
    const washed = contrastMutedForeground("#1b1b1b", "#fcfcfd", 0);
    const neutral = contrastMutedForeground("#1b1b1b", "#fcfcfd", 50);
    const strong = contrastMutedForeground("#1b1b1b", "#fcfcfd", 100);
    // Distance from #1b1b1b shrinks as contrast grows.
    const dist = (hex: string) => Math.abs(parseInt(hex.slice(1, 3), 16) - 0x1b);
    expect(dist(strong)).toBeLessThan(dist(neutral));
    expect(dist(neutral)).toBeLessThan(dist(washed));
  });
});

describe("presets", () => {
  it("Linear preset paints its full look and persists the selection", () => {
    const state = selectAppThemePreset("light", "linear");
    expect(state.light.preset).toBe("linear");
    expect(inlineVar("--primary")).toBe("#5e6ad2");
    expect(inlineVar("--background")).toBe("#fcfcfd");
    expect(inlineVar("--foreground")).toBe("#1b1b1b");
    expect(inlineVar("--sidebar")).toBe("#f7f7f8");
    expect(inlineVar("--primary-foreground")).toBe("#ffffff");
    expect(JSON.parse(window.localStorage.getItem(APP_THEME_STORAGE_KEY)!).light.preset).toBe(
      "linear"
    );
  });

  it("Notion dark preset overrides the hardcoded gold brand tints", () => {
    html.classList.add("dark");
    selectAppThemePreset("dark", "notion");
    expect(inlineVar("--accent-brand-text")).toBe("#529cca");
    expect(inlineVar("--sidebar")).toBe("#202020");
  });

  it("returning to Lynse clears every preset variable", () => {
    selectAppThemePreset("light", "linear");
    expect(inlineVar("--sidebar")).not.toBe("");
    selectAppThemePreset("light", "lynse");
    expect(inlineVar("--sidebar")).toBe("");
    expect(inlineVar("--background")).toBe("");
    expect(inlineVar("--primary")).toBe("");
  });

  it("a dark accent derives brand tints instead of the gold literals", () => {
    html.classList.add("dark");
    updateAppThemeRecord("dark", { accent: "#88c0d0" });
    expect(inlineVar("--accent-brand")).toContain("136 192 208");
    expect(inlineVar("--primary-foreground")).toBe("#15110a");
  });
});

describe("record updates", () => {
  it("keeps the selected preset when a control is patched", () => {
    selectAppThemePreset("light", "notion");
    const state = updateAppThemeRecord("light", { accent: "#ff0000" });
    expect(state.light.preset).toBe("notion");
    expect(state.light.accent).toBe("#ff0000");
    // Explicit accent wins, untouched Notion surfaces keep applying.
    expect(inlineVar("--primary")).toBe("#ff0000");
    expect(inlineVar("--sidebar")).toBe("#f7f7f5");
  });

  it("clearing a field falls back to the preset look", () => {
    selectAppThemePreset("light", "notion");
    // Background goes back to Notion white: undefined drops the override and
    // the preset's authored value takes over again.
    updateAppThemeRecord("light", { background: undefined });
    expect(inlineVar("--background")).toBe("#ffffff");
  });

  it("normalizes 3-digit hex", () => {
    const state = updateAppThemeRecord("light", { accent: "#ABC" });
    expect(state.light.accent).toBe("#aabbcc");
  });

  it("contrast 50 writes nothing; other values repaint muted text", () => {
    updateAppThemeRecord("light", { contrast: 50 });
    expect(inlineVar("--muted-foreground")).toBe("");
    updateAppThemeRecord("light", { contrast: 80 });
    expect(inlineVar("--muted-foreground")).not.toBe("");
  });

  it("toggles the translucent sidebar attribute", () => {
    updateAppThemeRecord("light", { translucentSidebar: true });
    expect(html.dataset.translucentSidebar).toBe("true");
    resetAppThemeRecord("light");
    expect(html.dataset.translucentSidebar).toBeUndefined();
  });

  it("applies font stacks and weights", () => {
    updateAppThemeRecord("light", {
      uiFont: "system",
      codeFont: "apple",
      contentFont: "serif",
      uiFontWeight: "regular",
    });
    expect(inlineVar("--font-sans")).toContain("ui-sans-serif");
    expect(inlineVar("--font-mono")).toContain("SF Mono");
    expect(inlineVar("--font-content")).toBe("var(--font-serif)");
    expect(inlineVar("--app-body-weight")).toBe("400");
  });

  it("reset clears the whole bucket", () => {
    updateAppThemeRecord("light", { accent: "#123456", contrast: 90 });
    const state = resetAppThemeRecord("light");
    expect(state.light).toEqual({ preset: "lynse" });
    expect(inlineVar("--primary")).toBe("");
  });

  it("reports customization from any deviating control", () => {
    expect(isAppThemeCustomized(selectAppThemePreset("light", "linear").light)).toBe(false);
    expect(isAppThemeCustomized(updateAppThemeRecord("light", { uiFont: "system" }).light)).toBe(
      true
    );
  });
});

describe("import / export", () => {
  it("round-trips through export and import", () => {
    updateAppThemeRecord("light", { accent: "#5e6ad2" });
    updateAppThemeRecord("dark", { translucentSidebar: true });
    expect(importAppThemeState(exportAppThemeState())).toBe(true);
    expect(getAppThemeState().light.accent).toBe("#5e6ad2");
    expect(getAppThemeState().dark.translucentSidebar).toBe(true);
  });

  it("rejects malformed JSON and empty payloads", () => {
    expect(importAppThemeState("not json")).toBe(false);
    expect(importAppThemeState("{}")).toBe(false);
    expect(importAppThemeState('{"light":{"accent":"nope"}}')).toBe(false);
  });

  it("sanitizes hostile or junk fields on import", () => {
    const payload = JSON.stringify({
      light: { accent: "#5e6ad2", contrast: 9999, uiFont: "Comic Sans" },
      dark: { preset: "notion" },
    });
    expect(importAppThemeState(payload)).toBe(true);
    const state = getAppThemeState();
    expect(state.light.contrast).toBe(100);
    expect(state.light.uiFont).toBeUndefined();
    expect(state.dark.preset).toBe("notion");
  });
});
