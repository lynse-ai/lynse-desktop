"use client";

/**
 * App appearance: light/dark mode plus a layered theme customization.
 *
 * next-themes owns the `.dark` class. This module layers a named theme
 * (painting both modes), optional color overrides, and a UI font choice.
 * Everything applies as inline CSS variables on <html>, which outrank the
 * `:root` / `.dark` token blocks in packages/ui/styles/tokens.css.
 */

import { useEffect } from "react";
import { useTheme } from "@lynse/ui/components/common/theme-provider";

export type ThemeModeBucket = "light" | "dark";
export type AppFontId = "system" | "sans" | "serif" | "mono" | "geist";
export type AppThemeGroupId = "lynse" | "chatgpt" | "codex";

export type AppThemePresetId =
  | "lynse"
  | "chatgpt"
  | "absolutely"
  | "ayu"
  | "catppuccin"
  | "dracula"
  | "everforest"
  | "github"
  | "gruvbox"
  | "linear"
  | "lobster"
  | "notion"
  | "oscurange";

export interface AppThemeState {
  preset: AppThemePresetId;
  /** Optional override; unset means the theme's own color. */
  accent?: string;
  background?: string;
  foreground?: string;
  font?: AppFontId;
}

export const APP_THEME_STORAGE_KEY = "lynse-theme-custom";
const STORAGE_VERSION = 3;

/** As-authored default trio for the stock Lynse theme. */
export const CANONICAL_COLORS: Record<
  ThemeModeBucket,
  { accent: string; background: string; foreground: string }
> = {
  light: { accent: "#5f67d8", background: "#fafafa", foreground: "#202023" },
  dark: { accent: "#e0b15c", background: "#17181b", foreground: "#f5f3ee" },
};

export interface AppThemePreset {
  id: AppThemePresetId;
  mode: ThemeModeBucket;
  colors: { accent: string; background: string; foreground: string };
}

const ACCENT_FAMILY_KEYS = [
  "--primary",
  "--ring",
  "--brand",
  "--info",
  "--waveform-active",
  "--sidebar-primary",
  "--sidebar-ring",
  "--chart-1",
] as const;

const APP_FONT_STACKS: Record<AppFontId, string | null> = {
  system: null,
  sans: `"Inter", "OPPO Sans", "OPPO Sans 4.0", ui-sans-serif, system-ui, sans-serif`,
  serif: `"Noto Serif SC Variable", "Songti SC", "SimSun", serif`,
  mono: `ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace`,
  geist: `"Geist Variable", "Inter", "OPPO Sans", "OPPO Sans 4.0", ui-sans-serif, system-ui, sans-serif`,
};

const PRESET_PAIRS: Array<[
  AppThemePresetId,
  { accent: string; background: string; foreground: string },
  { accent: string; background: string; foreground: string },
]> = [
  ["lynse", CANONICAL_COLORS.light, CANONICAL_COLORS.dark],
  ["chatgpt", { accent: "#10a37f", background: "#ffffff", foreground: "#0d0d0d" }, { accent: "#19c37d", background: "#212121", foreground: "#ececec" }],
  ["absolutely", { accent: "#f97316", background: "#fff7ed", foreground: "#431407" }, { accent: "#cc7d5e", background: "#2d2d2b", foreground: "#f9f9f7" }],
  ["ayu", { accent: "#ff9940", background: "#faf8f5", foreground: "#575653" }, { accent: "#e6b450", background: "#10141c", foreground: "#bfbbb6" }],
  ["catppuccin", { accent: "#8839ef", background: "#eff1f5", foreground: "#4c4f69" }, { accent: "#f5bde6", background: "#1e2030", foreground: "#cad3f5" }],
  ["dracula", { accent: "#7c3aed", background: "#f8f8f2", foreground: "#282a36" }, { accent: "#bd93f9", background: "#282a36", foreground: "#f8f8f2" }],
  ["everforest", { accent: "#8da101", background: "#fdf6e3", foreground: "#47523d" }, { accent: "#a7c080", background: "#2f383e", foreground: "#d3c6aa" }],
  ["github", { accent: "#0969da", background: "#ffffff", foreground: "#1f2328" }, { accent: "#4493f8", background: "#0d1117", foreground: "#e6edf3" }],
  ["gruvbox", { accent: "#b16286", background: "#fbf1c7", foreground: "#3c3836" }, { accent: "#d3869b", background: "#282828", foreground: "#ebdbb2" }],
  ["linear", { accent: "#5e6ad2", background: "#fcfcfd", foreground: "#1b1b1b" }, { accent: "#5e6ad2", background: "#08090a", foreground: "#f7f8f8" }],
  ["lobster", { accent: "#e8425a", background: "#fff5f4", foreground: "#44121a" }, { accent: "#ff6b81", background: "#231014", foreground: "#ffe8ea" }],
  ["notion", { accent: "#2383e2", background: "#ffffff", foreground: "#37352f" }, { accent: "#2383e2", background: "#191919", foreground: "#d4d4d4" }],
  ["oscurange", { accent: "#ff8a3d", background: "#141210", foreground: "#f4ede7" }, { accent: "#ffa060", background: "#0e0d0b", foreground: "#f4ede7" }],
];

const APP_THEME_PRESETS: AppThemePreset[] = PRESET_PAIRS.flatMap(([id, light, dark]) => [
  { id, mode: "light", colors: light },
  { id, mode: "dark", colors: dark },
]);

export const APP_THEME_PRESET_IDS = PRESET_PAIRS.map(([id]) => id);

export const APP_THEME_GROUPS: Array<{ id: AppThemeGroupId; ids: AppThemePresetId[] }> = [
  { id: "lynse", ids: ["lynse"] },
  { id: "chatgpt", ids: ["chatgpt"] },
  {
    id: "codex",
    ids: APP_THEME_PRESET_IDS.filter((id) => id !== "lynse" && id !== "chatgpt"),
  },
];

const THEME_DISPLAY_NAMES: Record<AppThemePresetId, string> = {
  lynse: "Lynse",
  chatgpt: "ChatGPT",
  absolutely: "Absolutely",
  ayu: "Ayu",
  catppuccin: "Catppuccin",
  dracula: "Dracula",
  everforest: "Everforest",
  github: "GitHub",
  gruvbox: "Gruvbox",
  linear: "Linear",
  lobster: "Lobster",
  notion: "Notion",
  oscurange: "Oscurange",
};

export function getAppThemePresetName(id: AppThemePresetId): string {
  return THEME_DISPLAY_NAMES[id];
}

export function getAppThemePreset(
  id: AppThemePresetId,
  mode: ThemeModeBucket,
): AppThemePreset {
  return APP_THEME_PRESETS.find((preset) => preset.id === id && preset.mode === mode) ?? {
    id,
    mode,
    colors: CANONICAL_COLORS[mode],
  };
}

// ── Color math ─────────────────────────────────────────────────────────────

const HEX_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

export function isHexColor(value: unknown): value is string {
  return typeof value === "string" && HEX_RE.test(value);
}

function normalizeHex(hex: string): string {
  const body = hex.slice(1);
  if (body.length === 3) {
    return `#${body[0]}${body[0]}${body[1]}${body[1]}${body[2]}${body[2]}`.toLowerCase();
  }
  return `#${body.toLowerCase()}`;
}

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const body = normalizeHex(hex).slice(1);
  return {
    r: parseInt(body.slice(0, 2), 16),
    g: parseInt(body.slice(2, 4), 16),
    b: parseInt(body.slice(4, 6), 16),
  };
}

function rgbToHex(r: number, g: number, b: number): string {
  const clamp = (value: number) => Math.max(0, Math.min(255, Math.round(value)));
  return `#${[r, g, b].map((value) => clamp(value).toString(16).padStart(2, "0")).join("")}`;
}

function mixHex(a: string, b: string, amount: number): string {
  const from = hexToRgb(a);
  const to = hexToRgb(b);
  return rgbToHex(
    from.r + (to.r - from.r) * amount,
    from.g + (to.g - from.g) * amount,
    from.b + (to.b - from.b) * amount,
  );
}

function relativeLuminance(hex: string): number {
  const { r, g, b } = hexToRgb(hex);
  const linear = (value: number) => {
    const channel = value / 255;
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

export function readableForeground(accent: string): string {
  return relativeLuminance(accent) > 0.45 ? "#15110a" : "#ffffff";
}

const rgba = (hex: string, alpha: number): string => {
  const { r, g, b } = hexToRgb(hex);
  return `rgb(${r} ${g} ${b} / ${Math.round(alpha * 1000) / 10}%)`;
};

const accentTint = (accent: string, foreground: string): string =>
  mixHex(accent, foreground, 0.3);

const ACCENT_TEXT_TINTS: Partial<Record<AppThemePresetId, number>> = {
  linear: 0.5,
  notion: 0.25,
};

function expandAccentVars(
  accent: string,
  mode: ThemeModeBucket,
  foreground: string,
  presetId?: AppThemePresetId,
) {
  const vars: Record<string, string> = Object.fromEntries(
    ACCENT_FAMILY_KEYS.map((variable) => [variable, accent]),
  );
  const textTint = presetId ? ACCENT_TEXT_TINTS[presetId] : undefined;
  vars["--primary-foreground"] = readableForeground(accent);
  vars["--chart-2"] = mixHex(accent, foreground, 0.16);
  vars["--chart-3"] = mixHex(accent, foreground, 0.32);
  vars["--chart-4"] = mixHex(accent, foreground, 0.48);
  vars["--chart-5"] = mixHex(accent, foreground, 0.64);
  vars["--accent-brand"] = rgba(accent, 0.1);
  vars["--accent-brand-strong"] = rgba(accent, 0.16);
  vars["--accent-brand-text"] = mode === "dark"
    ? mixHex(accent, foreground, textTint ?? 0.3)
    : accent;
  vars["--sidebar-accent"] = rgba(accent, mode === "dark" ? 0.11 : 0.09);
  vars["--sidebar-accent-foreground"] =
    mode === "dark" ? accentTint(accent, foreground) : accent;
  return vars;
}

function generateThemeVars(
  preset: AppThemePreset,
  forceSurfaces = false,
): Record<string, string> {
  const { accent, background, foreground } = preset.colors;
  const light = preset.mode === "light";
  if (preset.id === "lynse" && !forceSurfaces) {
    return {};
  }
  const whiteSurface = light ? "#ffffff" : mixHex(background, foreground, 0.06);
  const popover = light ? "#ffffff" : mixHex(background, foreground, 0.08);
  const secondary = light ? mixHex(background, foreground, 0.05) : mixHex(background, foreground, 0.09);
  const hoverSurface = light ? mixHex(background, foreground, 0.03) : rgba("#ffffff", 0.06);
  const border = light ? rgba("#000000", 0.09) : rgba("#ffffff", 0.09);
  const mutedForeground = light ? mixHex(foreground, background, 0.42) : mixHex(foreground, background, 0.31);
  const sidebar = light ? mixHex(background, "#000000", 0.02) : mixHex(background, foreground, 0.03);

  return {
    ...expandAccentVars(accent, preset.mode, foreground, preset.id),
    "--background": background,
    "--foreground": foreground,
    "--card": whiteSurface,
    "--card-foreground": foreground,
    "--popover": popover,
    "--popover-foreground": foreground,
    "--secondary": secondary,
    "--secondary-foreground": foreground,
    "--muted": secondary,
    "--muted-foreground": mutedForeground,
    "--accent": hoverSurface,
    "--accent-foreground": foreground,
    "--border": border,
    "--input": light ? rgba("#000000", 0.12) : mixHex(background, foreground, 0.14),
    "--stroke-primary": light ? rgba("#000000", 0.2) : rgba("#ffffff", 0.2),
    "--stroke-secondary": light ? rgba("#000000", 0.13) : rgba("#ffffff", 0.14),
    "--stroke-tertiary": border,
    "--stroke-quaternary": light ? rgba("#000000", 0.04) : rgba("#ffffff", 0.06),
    "--sidebar": sidebar,
    "--sidebar-foreground": foreground,
    "--sidebar-border": border,
    "--scrollbar-thumb": light ? rgba("#000000", 0.1) : rgba("#ffffff", 0.08),
    "--scrollbar-thumb-hover": light ? rgba("#000000", 0.18) : rgba("#ffffff", 0.18),
  };
}

// ── Var application ────────────────────────────────────────────────────────

const MANAGED_VARS = [
  ...new Set(APP_THEME_PRESETS.flatMap((preset) => Object.keys(generateThemeVars(preset)))),
  "--primary-foreground",
  "--font-sans",
  "--font-heading",
  "--accent-brand",
  "--accent-brand-strong",
  "--accent-brand-text",
  "--sidebar-accent",
  "--sidebar-accent-foreground",
];

export function currentResolvedMode(): ThemeModeBucket {
  return typeof document !== "undefined" &&
    document.documentElement.classList.contains("dark")
    ? "dark"
    : "light";
}

export function applyAppTheme(
  state: AppThemeState = getAppThemeState(),
  mode: ThemeModeBucket = currentResolvedMode(),
): void {
  if (typeof document === "undefined") return;
  const html = document.documentElement;
  for (const variable of MANAGED_VARS) html.style.removeProperty(variable);

  const preset = getAppThemePreset(state.preset, mode);
  const hasColorOverride = isHexColor(state.background) || isHexColor(state.foreground);
  const vars = generateThemeVars(preset, preset.id === "lynse" && hasColorOverride);

  if (isHexColor(state.accent)) {
    Object.assign(vars, expandAccentVars(normalizeHex(state.accent), mode, preset.colors.foreground));
  }
  if (isHexColor(state.background)) vars["--background"] = normalizeHex(state.background);
  if (isHexColor(state.foreground)) {
    const foreground = normalizeHex(state.foreground);
    Object.assign(vars, {
      "--foreground": foreground,
      "--card-foreground": foreground,
      "--popover-foreground": foreground,
      "--sidebar-foreground": foreground,
      "--secondary-foreground": foreground,
      "--accent-foreground": foreground,
    });
  }

  const font = APP_FONT_STACKS[state.font ?? "system"];
  if (font) vars["--font-sans"] = font;

  for (const [variable, value] of Object.entries(vars)) {
    html.style.setProperty(variable, value);
  }
}

// ── Persistence ────────────────────────────────────────────────────────────

const DEFAULT_STATE: AppThemeState = { preset: "lynse" };
const APP_FONT_IDS = Object.keys(APP_FONT_STACKS) as AppFontId[];

function sanitizeState(raw: unknown): AppThemeState {
  const state: AppThemeState = { ...DEFAULT_STATE };
  if (typeof raw !== "object" || raw == null) return state;
  const record = raw as Record<string, unknown>;
  if (APP_THEME_PRESET_IDS.includes(record.preset as AppThemePresetId)) {
    state.preset = record.preset as AppThemePresetId;
  }
  if (isHexColor(record.accent)) state.accent = normalizeHex(record.accent);
  if (isHexColor(record.background)) state.background = normalizeHex(record.background);
  if (isHexColor(record.foreground)) state.foreground = normalizeHex(record.foreground);
  if (APP_FONT_IDS.includes(record.font as AppFontId)) state.font = record.font as AppFontId;
  return state;
}

export function getAppThemeState(): AppThemeState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(localStorage.getItem(APP_THEME_STORAGE_KEY) ?? "{}");
  } catch {
    return { ...DEFAULT_STATE };
  }
  return sanitizeState(parsed);
}

function persist(state: AppThemeState): void {
  try {
    localStorage.setItem(
      APP_THEME_STORAGE_KEY,
      JSON.stringify({ version: STORAGE_VERSION, ...state }),
    );
  } catch {
    // Storage unavailable; the theme still applies for this session.
  }
}

function commit(state: AppThemeState): AppThemeState {
  persist(state);
  applyAppTheme(state);
  return state;
}

export function selectAppThemePreset(preset: AppThemePresetId): AppThemeState {
  const previous = getAppThemeState();
  return commit({ preset, font: previous.font });
}

export function setAppThemeAccent(accent: string | undefined): AppThemeState {
  const state = getAppThemeState();
  if (accent != null && isHexColor(accent)) state.accent = normalizeHex(accent);
  else delete state.accent;
  return commit(state);
}

export function setAppThemeBackground(background: string | undefined): AppThemeState {
  const state = getAppThemeState();
  if (background != null && isHexColor(background)) state.background = normalizeHex(background);
  else delete state.background;
  return commit(state);
}

export function setAppThemeForeground(foreground: string | undefined): AppThemeState {
  const state = getAppThemeState();
  if (foreground != null && isHexColor(foreground)) state.foreground = normalizeHex(foreground);
  else delete state.foreground;
  return commit(state);
}

export function setAppThemeFont(font: AppFontId): AppThemeState {
  const state = getAppThemeState();
  state.font = APP_FONT_IDS.includes(font) ? font : "system";
  return commit(state);
}

export function resetAppTheme(): AppThemeState {
  return commit({ ...DEFAULT_STATE });
}

export function getAppThemePresetAccent(id: AppThemePresetId, mode: ThemeModeBucket): string {
  return getAppThemePreset(id, mode).colors.accent;
}

// ── Boot + mode-change wiring ──────────────────────────────────────────────

export function initAppTheme(): void {
  applyAppTheme();
}

export function AppThemeSync(): null {
  const { resolvedTheme } = useTheme();
  useEffect(() => {
    if (resolvedTheme === "light" || resolvedTheme === "dark") {
      applyAppTheme(undefined, resolvedTheme);
    }
  }, [resolvedTheme]);
  return null;
}
