"use client";

/**
 * App appearance customization — Codex-style per-mode theme editor.
 *
 * The light/dark/system MODE stays owned by next-themes (the `.dark` class and
 * the `theme` localStorage key); this module layers a second dimension on top:
 * per-mode color/font customization and full-look presets (Linear, Notion, …).
 *
 * Everything here applies as inline CSS variables / data attributes on <html>,
 * which outrank the `:root` / `.dark` token blocks in packages/ui/styles/tokens.css.
 * State persists in localStorage under "lynse-theme-custom" as
 * `{ version, light, dark }`, storing only non-default fields.
 */

import { useEffect } from "react";
import { useTheme } from "@lynse/ui/components/common/theme-provider";

export type ThemeModeBucket = "light" | "dark";

export type AppThemePresetId =
  | "lynse"
  | "linear"
  | "notion"
  | "sepia"
  | "midnight"
  | "nord"
  | "custom";

export type UiFontId = "default" | "system" | "oppo";
export type UiFontWeightId = "light" | "regular" | "medium";
export type ContentFontId = "ui" | "serif";
export type CodeFontId = "default" | "apple" | "windows";

export interface AppThemeRecord {
  /** Active preset; "custom" once any control is touched off-preset. */
  preset: AppThemePresetId;
  accent?: string;
  background?: string;
  foreground?: string;
  uiFont?: UiFontId;
  uiFontWeight?: UiFontWeightId;
  contentFont?: ContentFontId;
  codeFont?: CodeFontId;
  translucentSidebar?: boolean;
  /** 0–100 text-contrast slider; 50 / undefined = tokens as authored. */
  contrast?: number;
}

export interface AppThemeState {
  light: AppThemeRecord;
  dark: AppThemeRecord;
}

export const APP_THEME_STORAGE_KEY = "lynse-theme-custom";
const STORAGE_VERSION = 1;

// ── Presets ─────────────────────────────────────────────────────────────────
//
// A preset is two things: the trio of values it fills the panel controls with
// (accent/background/foreground) and a full CSS-var override map so its
// surfaces (sidebar, cards, borders) carry the source material's feel — the
// panel only exposes the trio, the rest rides along until customized.

export interface AppThemePreset {
  id: Exclude<AppThemePresetId, "custom">;
  mode: ThemeModeBucket;
  colors: { accent: string; background: string; foreground: string };
  vars: Record<string, string>;
}

/** Each bucket's as-authored look, used as the panel display fallback. */
export const CANONICAL_COLORS: Record<
  ThemeModeBucket,
  { accent: string; background: string; foreground: string }
> = {
  light: { accent: "#5f67d8", background: "#fafafa", foreground: "#202023" },
  dark: { accent: "#e0b15c", background: "#17181b", foreground: "#f5f3ee" },
};

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

const accentFamily = (accent: string): Record<string, string> =>
  Object.fromEntries(ACCENT_FAMILY_KEYS.map((v) => [v, accent]));

const APP_THEME_PRESETS: AppThemePreset[] = [
  {
    id: "lynse",
    mode: "light",
    colors: CANONICAL_COLORS.light,
    vars: {},
  },
  {
    id: "lynse",
    mode: "dark",
    colors: CANONICAL_COLORS.dark,
    vars: {},
  },
  {
    id: "linear",
    mode: "light",
    colors: { accent: "#5e6ad2", background: "#fcfcfd", foreground: "#1b1b1b" },
    vars: {
      ...accentFamily("#5e6ad2"),
      "--primary-foreground": "#ffffff",
      "--background": "#fcfcfd",
      "--foreground": "#1b1b1b",
      "--card": "#ffffff",
      "--card-foreground": "#1b1b1b",
      "--popover": "#ffffff",
      "--popover-foreground": "#1b1b1b",
      "--secondary": "#f4f4f5",
      "--secondary-foreground": "#1b1b1b",
      "--muted": "#f4f4f5",
      "--muted-foreground": "#6b6f76",
      "--accent": "#f1f1f3",
      "--accent-foreground": "#1b1b1b",
      "--border": "rgb(0 0 0 / 8%)",
      "--input": "#e6e6e9",
      "--sidebar": "#f7f7f8",
      "--sidebar-foreground": "#1b1b1b",
      "--sidebar-border": "rgb(0 0 0 / 7%)",
    },
  },
  {
    id: "linear",
    mode: "dark",
    colors: { accent: "#5e6ad2", background: "#08090a", foreground: "#f7f8f8" },
    vars: {
      ...accentFamily("#5e6ad2"),
      "--primary-foreground": "#ffffff",
      "--background": "#08090a",
      "--foreground": "#f7f8f8",
      "--card": "#131316",
      "--card-foreground": "#f7f8f8",
      "--popover": "#17181b",
      "--popover-foreground": "#f7f8f8",
      "--secondary": "#1a1b1e",
      "--secondary-foreground": "#f7f8f8",
      "--muted": "#1a1b1e",
      "--muted-foreground": "#8a8f98",
      "--accent": "rgb(255 255 255 / 6%)",
      "--accent-foreground": "#f7f8f8",
      "--border": "rgb(255 255 255 / 8%)",
      "--input": "#1e1f23",
      "--sidebar": "#0f1011",
      "--sidebar-foreground": "#f7f8f8",
      "--sidebar-border": "rgb(255 255 255 / 8%)",
      "--sidebar-accent": "rgb(94 106 210 / 14%)",
      "--sidebar-accent-foreground": "#aab1e8",
      "--accent-brand": "rgb(94 106 210 / 14%)",
      "--accent-brand-strong": "rgb(94 106 210 / 20%)",
      "--accent-brand-text": "#aab1e8",
    },
  },
  {
    id: "notion",
    mode: "light",
    colors: { accent: "#2383e2", background: "#ffffff", foreground: "#37352f" },
    vars: {
      ...accentFamily("#2383e2"),
      "--primary-foreground": "#ffffff",
      "--background": "#ffffff",
      "--foreground": "#37352f",
      "--card": "#ffffff",
      "--card-foreground": "#37352f",
      "--popover": "#ffffff",
      "--popover-foreground": "#37352f",
      "--secondary": "#f1f1ef",
      "--secondary-foreground": "#37352f",
      "--muted": "#f1f1ef",
      "--muted-foreground": "#73726e",
      "--accent": "#f1f1ef",
      "--accent-foreground": "#37352f",
      "--border": "rgb(55 53 47 / 9%)",
      "--input": "rgb(55 53 47 / 13%)",
      "--sidebar": "#f7f7f5",
      "--sidebar-foreground": "#37352f",
      "--sidebar-border": "rgb(55 53 47 / 9%)",
    },
  },
  {
    id: "notion",
    mode: "dark",
    colors: { accent: "#2383e2", background: "#191919", foreground: "#d4d4d4" },
    vars: {
      ...accentFamily("#2383e2"),
      "--primary-foreground": "#ffffff",
      "--background": "#191919",
      "--foreground": "#d4d4d4",
      "--card": "#1f1f1f",
      "--card-foreground": "#d4d4d4",
      "--popover": "#252525",
      "--popover-foreground": "#d4d4d4",
      "--secondary": "#2f2f2f",
      "--secondary-foreground": "#d4d4d4",
      "--muted": "#2f2f2f",
      "--muted-foreground": "#9b9b9b",
      "--accent": "rgb(255 255 255 / 5.5%)",
      "--accent-foreground": "#d4d4d4",
      "--border": "rgb(255 255 255 / 9%)",
      "--input": "#2a2a2a",
      "--sidebar": "#202020",
      "--sidebar-foreground": "#d4d4d4",
      "--sidebar-border": "rgb(255 255 255 / 9%)",
      "--sidebar-accent": "rgb(35 131 226 / 12%)",
      "--sidebar-accent-foreground": "#529cca",
      "--accent-brand": "rgb(35 131 226 / 12%)",
      "--accent-brand-strong": "rgb(35 131 226 / 18%)",
      "--accent-brand-text": "#529cca",
    },
  },
  {
    id: "sepia",
    mode: "light",
    colors: { accent: "#a9683c", background: "#f6f0e4", foreground: "#43382b" },
    vars: {
      ...accentFamily("#a9683c"),
      "--primary-foreground": "#ffffff",
      "--background": "#f6f0e4",
      "--foreground": "#43382b",
      "--card": "#fbf7ee",
      "--card-foreground": "#43382b",
      "--popover": "#fbf7ee",
      "--popover-foreground": "#43382b",
      "--secondary": "#efe8da",
      "--secondary-foreground": "#43382b",
      "--muted": "#efe8da",
      "--muted-foreground": "#7a6f5e",
      "--accent": "#ece2cf",
      "--accent-foreground": "#43382b",
      "--border": "rgb(67 56 43 / 14%)",
      "--input": "rgb(67 56 43 / 18%)",
      "--sidebar": "#efe7d8",
      "--sidebar-foreground": "#43382b",
      "--sidebar-border": "rgb(67 56 43 / 12%)",
    },
  },
  {
    id: "midnight",
    mode: "dark",
    colors: { accent: "#e0b15c", background: "#000000", foreground: "#f5f3ee" },
    vars: {
      ...accentFamily("#e0b15c"),
      "--primary-foreground": "#15110a",
      "--background": "#000000",
      "--foreground": "#f5f3ee",
      "--card": "#0c0c0e",
      "--card-foreground": "#f5f3ee",
      "--popover": "#121215",
      "--popover-foreground": "#f5f3ee",
      "--secondary": "#17171a",
      "--secondary-foreground": "#f5f3ee",
      "--muted": "#17171a",
      "--muted-foreground": "#9c978e",
      "--accent": "rgb(255 255 255 / 6%)",
      "--accent-foreground": "#f5f3ee",
      "--border": "rgb(255 255 255 / 10%)",
      "--input": "#1c1c1f",
      "--sidebar": "#000000",
      "--sidebar-foreground": "#f5f3ee",
      "--sidebar-border": "rgb(255 255 255 / 10%)",
      "--sidebar-accent": "rgb(224 177 92 / 11%)",
      "--sidebar-accent-foreground": "#f3d08a",
      "--accent-brand": "rgb(224 177 92 / 10%)",
      "--accent-brand-strong": "rgb(224 177 92 / 16%)",
      "--accent-brand-text": "#f3d08a",
    },
  },
  {
    id: "nord",
    mode: "dark",
    colors: { accent: "#88c0d0", background: "#2e3440", foreground: "#eceff4" },
    vars: {
      ...accentFamily("#88c0d0"),
      "--primary-foreground": "#21262e",
      "--background": "#2e3440",
      "--foreground": "#eceff4",
      "--card": "#333b4a",
      "--card-foreground": "#eceff4",
      "--popover": "#3b4252",
      "--popover-foreground": "#eceff4",
      "--secondary": "#3b4252",
      "--secondary-foreground": "#eceff4",
      "--muted": "#3b4252",
      "--muted-foreground": "#aeb8c9",
      "--accent": "rgb(236 239 244 / 7%)",
      "--accent-foreground": "#eceff4",
      "--border": "rgb(216 222 233 / 12%)",
      "--input": "#3b4252",
      "--sidebar": "#272c36",
      "--sidebar-foreground": "#eceff4",
      "--sidebar-border": "rgb(216 222 233 / 12%)",
      "--sidebar-accent": "rgb(136 192 208 / 14%)",
      "--sidebar-accent-foreground": "#8fbcbb",
      "--accent-brand": "rgb(136 192 208 / 12%)",
      "--accent-brand-strong": "rgb(136 192 208 / 18%)",
      "--accent-brand-text": "#8fbcbb",
    },
  },
];

export function getPreset(id: AppThemePresetId, mode: ThemeModeBucket): AppThemePreset | undefined {
  if (id === "custom") return undefined;
  return APP_THEME_PRESETS.find((p) => p.id === id && p.mode === mode);
}

export function getPresetsForMode(mode: ThemeModeBucket): AppThemePreset[] {
  return APP_THEME_PRESETS.filter((p) => p.mode === mode);
}

// ── Font catalogs ───────────────────────────────────────────────────────────

export const UI_FONT_OPTIONS: { id: UiFontId; labelKey: string }[] = [
  { id: "default", labelKey: "settings.font_default" },
  { id: "system", labelKey: "settings.font_system" },
  { id: "oppo", labelKey: "settings.font_oppo" },
];

export const CODE_FONT_OPTIONS: { id: CodeFontId; labelKey: string }[] = [
  { id: "default", labelKey: "settings.font_default" },
  { id: "apple", labelKey: "settings.font_mono_apple" },
  { id: "windows", labelKey: "settings.font_mono_windows" },
];

export const UI_FONT_WEIGHT_OPTIONS: { id: UiFontWeightId; labelKey: string }[] = [
  { id: "light", labelKey: "settings.font_weight_light" },
  { id: "regular", labelKey: "settings.font_weight_regular" },
  { id: "medium", labelKey: "settings.font_weight_medium" },
];

const WEIGHT_VALUES: Record<UiFontWeightId, number> = {
  light: 300,
  regular: 400,
  medium: 500,
};

const SYSTEM_SANS_STACK =
  'ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif';
const OPPO_SANS_STACK =
  '"OPPO Sans", "OPPO Sans 4.0", "Inter", ui-sans-serif, system-ui, "PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif';
const APPLE_MONO_STACK =
  'ui-monospace, "SF Mono", Menlo, "PingFang SC", "Microsoft YaHei", monospace';
const WINDOWS_MONO_STACK =
  '"Cascadia Code", Consolas, "Courier New", "PingFang SC", "Microsoft YaHei", monospace';

// ── Color math ──────────────────────────────────────────────────────────────

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
  const clamp = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
  return `#${[r, g, b].map((v) => clamp(v).toString(16).padStart(2, "0")).join("")}`;
}

/** Linear mix of `a` toward `b` by t∈[0,1]. */
export function mixHex(a: string, b: string, t: number): string {
  const ca = hexToRgb(a);
  const cb = hexToRgb(b);
  return rgbToHex(
    ca.r + (cb.r - ca.r) * t,
    ca.g + (cb.g - ca.g) * t,
    ca.b + (cb.b - ca.b) * t,
  );
}

function relativeLuminance(hex: string): number {
  const { r, g, b } = hexToRgb(hex);
  const lin = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** Button/label color on top of an accent fill — dark text on light accents. */
export function readableForeground(accent: string): string {
  return relativeLuminance(accent) > 0.45 ? "#15110a" : "#ffffff";
}

const rgba = (hex: string, alpha: number): string => {
  const { r, g, b } = hexToRgb(hex);
  return `rgb(${r} ${g} ${b} / ${Math.round(alpha * 1000) / 10}%)`;
};

/** Lightens an accent toward the mode's foreground (dark modes only). */
const accentTint = (accent: string, fg: string): string => mixHex(accent, fg, 0.45);

function expandAccentVars(
  accent: string,
  mode: ThemeModeBucket,
  fg: string,
): Record<string, string> {
  const vars = accentFamily(accent);
  vars["--primary-foreground"] = readableForeground(accent);
  if (mode === "dark") {
    // Dark tokens hardcode the gold tints instead of deriving them, so a
    // non-gold accent must spell them out.
    vars["--accent-brand"] = rgba(accent, 0.1);
    vars["--accent-brand-strong"] = rgba(accent, 0.16);
    vars["--accent-brand-text"] = accentTint(accent, fg);
    vars["--sidebar-accent"] = rgba(accent, 0.11);
    vars["--sidebar-accent-foreground"] = accentTint(accent, fg);
  }
  return vars;
}

const FOREGROUND_FAMILY = [
  "--foreground",
  "--card-foreground",
  "--popover-foreground",
  "--sidebar-foreground",
  "--secondary-foreground",
  "--accent-foreground",
] as const;

function expandForegroundVars(fg: string): Record<string, string> {
  return Object.fromEntries(FOREGROUND_FAMILY.map((v) => [v, fg]));
}

/** Slider tames text greys: high = muted text closer to full foreground. */
export function contrastMutedForeground(fg: string, bg: string, contrast: number): string {
  const toward = Math.max(0.25, Math.min(0.88, 0.62 - (contrast - 50) * 0.0045));
  return mixHex(fg, bg, toward);
}

// ── Var application ─────────────────────────────────────────────────────────

/** Every inline variable this module may write — cleared before each apply. */
const MANAGED_VARS = [
  // Union of all preset surface overrides, so switching presets never leaves
  // stale vars behind (e.g. Linear's --sidebar after returning to Lynse).
  ...new Set(APP_THEME_PRESETS.flatMap((p) => Object.keys(p.vars))),
  "--primary-foreground",
  "--accent-brand",
  "--accent-brand-strong",
  "--accent-brand-text",
  "--sidebar-accent",
  "--sidebar-accent-foreground",
  ...FOREGROUND_FAMILY,
  "--muted-foreground",
  "--font-sans",
  "--font-mono",
  "--font-content",
  "--app-body-weight",
];

export function currentResolvedMode(): ThemeModeBucket {
  return typeof document !== "undefined" &&
    document.documentElement.classList.contains("dark")
    ? "dark"
    : "light";
}

/**
 * Paint the customization for `mode` onto <html>. Clears every managed
 * variable first, so switching presets/modes never leaves stale overrides.
 */
export function applyAppTheme(
  state: AppThemeState = getAppThemeState(),
  mode: ThemeModeBucket = currentResolvedMode(),
): void {
  if (typeof document === "undefined") return;
  const html = document.documentElement;
  for (const v of MANAGED_VARS) html.style.removeProperty(v);
  delete html.dataset.translucentSidebar;

  const rec = state[mode];
  if (!rec) return;
  const preset = getPreset(rec.preset, mode);

  // A non-Lynse preset ships its full authored look in vars (accent family,
  // surfaces, tints) — nothing to expand unless the user overrides a control.
  const vars: Record<string, string> = { ...preset?.vars };
  const activePreset = preset != null && preset.id !== "lynse";
  const hasExplicit =
    rec.accent != null || rec.background != null || rec.foreground != null;
  const contrastActive = rec.contrast != null && rec.contrast !== 50;

  if (activePreset || hasExplicit || contrastActive) {
    // Effective trio: explicit record overrides beat the preset's authored
    // look; the Lynse default falls back to the stock token values.
    const accent = rec.accent ?? preset?.colors.accent ?? CANONICAL_COLORS[mode].accent;
    const bg = rec.background ?? preset?.colors.background ?? CANONICAL_COLORS[mode].background;
    const fg = rec.foreground ?? preset?.colors.foreground ?? CANONICAL_COLORS[mode].foreground;
    if (rec.accent != null) Object.assign(vars, expandAccentVars(accent, mode, fg));
    if (rec.background != null) vars["--background"] = bg;
    if (rec.foreground != null) Object.assign(vars, expandForegroundVars(fg));
    if (contrastActive) vars["--muted-foreground"] = contrastMutedForeground(fg, bg, rec.contrast!);
  }

  if (rec.uiFont === "system") vars["--font-sans"] = SYSTEM_SANS_STACK;
  else if (rec.uiFont === "oppo") vars["--font-sans"] = OPPO_SANS_STACK;
  if (rec.contentFont === "serif") vars["--font-content"] = "var(--font-serif)";
  if (rec.codeFont === "apple") vars["--font-mono"] = APPLE_MONO_STACK;
  else if (rec.codeFont === "windows") vars["--font-mono"] = WINDOWS_MONO_STACK;
  if (rec.uiFontWeight) vars["--app-body-weight"] = String(WEIGHT_VALUES[rec.uiFontWeight]);

  for (const [k, v] of Object.entries(vars)) html.style.setProperty(k, v);
  if (rec.translucentSidebar) html.dataset.translucentSidebar = "true";
}

// ── Persistence ─────────────────────────────────────────────────────────────

function emptyRecord(): AppThemeRecord {
  return { preset: "lynse" };
}

function recordHasContent(rec: AppThemeRecord): boolean {
  return (
    rec.accent != null ||
    rec.background != null ||
    rec.foreground != null ||
    rec.uiFont != null ||
    rec.uiFontWeight != null ||
    rec.contentFont != null ||
    rec.codeFont != null ||
    rec.translucentSidebar != null ||
    rec.contrast != null
  );
}

/** True when any panel control deviates from the preset-authored look. */
export function isAppThemeCustomized(rec: AppThemeRecord): boolean {
  return recordHasContent(rec);
}

function sanitizeRecord(raw: unknown): AppThemeRecord {
  const rec = emptyRecord();
  if (typeof raw !== "object" || raw == null) return rec;
  const r = raw as Record<string, unknown>;
  if (isHexColor(r.accent)) rec.accent = normalizeHex(r.accent);
  if (isHexColor(r.background)) rec.background = normalizeHex(r.background);
  if (isHexColor(r.foreground)) rec.foreground = normalizeHex(r.foreground);
  if (r.uiFont === "system" || r.uiFont === "oppo" || r.uiFont === "default") rec.uiFont = r.uiFont;
  if (
    r.uiFontWeight === "light" ||
    r.uiFontWeight === "regular" ||
    r.uiFontWeight === "medium"
  ) {
    rec.uiFontWeight = r.uiFontWeight;
  }
  if (r.contentFont === "serif" || r.contentFont === "ui") rec.contentFont = r.contentFont;
  if (r.codeFont === "apple" || r.codeFont === "windows" || r.codeFont === "default") {
    rec.codeFont = r.codeFont;
  }
  if (typeof r.translucentSidebar === "boolean") rec.translucentSidebar = r.translucentSidebar;
  if (typeof r.contrast === "number" && Number.isFinite(r.contrast)) {
    rec.contrast = Math.max(0, Math.min(100, Math.round(r.contrast)));
    if (rec.contrast === 50) delete rec.contrast;
  }
  if (
    r.preset === "lynse" ||
    r.preset === "linear" ||
    r.preset === "notion" ||
    r.preset === "sepia" ||
    r.preset === "midnight" ||
    r.preset === "nord" ||
    r.preset === "custom"
  ) {
    rec.preset = r.preset;
  }
  // A record with only no-op fields collapses back to the clean default.
  if (!recordHasContent(rec) && rec.preset === "lynse") return emptyRecord();
  return rec;
}

export function getAppThemeState(): AppThemeState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(localStorage.getItem(APP_THEME_STORAGE_KEY) ?? "{}");
  } catch {
    return { light: emptyRecord(), dark: emptyRecord() };
  }
  const obj = (typeof parsed === "object" && parsed != null ? parsed : {}) as Record<
    string,
    unknown
  >;
  return {
    light: sanitizeRecord(obj.light),
    dark: sanitizeRecord(obj.dark),
  };
}

function persist(state: AppThemeState): void {
  try {
    localStorage.setItem(APP_THEME_STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Storage unavailable — theme still applies for this session.
  }
}

/**
 * Merge a patch into one mode's record, persist, and repaint. The selected
 * preset is preserved: explicit fields merely override the preset's authored
 * values (Codex semantics — the panel then shows 「自定义」 per control while
 * the preset's untouched surfaces keep applying).
 */
export function updateAppThemeRecord(
  mode: ThemeModeBucket,
  patch: Partial<Omit<AppThemeRecord, "preset">>,
): AppThemeState {
  const state = getAppThemeState();
  state[mode] = sanitizeRecord({ ...state[mode], ...patch });
  persist(state);
  applyAppTheme(state);
  return state;
}

export function resetAppThemeRecord(mode: ThemeModeBucket): AppThemeState {
  const state = getAppThemeState();
  state[mode] = emptyRecord();
  persist(state);
  applyAppTheme(state);
  return state;
}

export function selectAppThemePreset(mode: ThemeModeBucket, preset: AppThemePresetId): AppThemeState {
  const state = getAppThemeState();
  state[mode] = preset === "lynse" ? emptyRecord() : { preset };
  persist(state);
  applyAppTheme(state);
  return state;
}

// ── Import / export (Codex's 复制主题 / 导入) ────────────────────────────────

export function exportAppThemeState(state = getAppThemeState()): string {
  return JSON.stringify({ version: STORAGE_VERSION, ...state }, null, 2);
}

/** Parse + validate a pasted theme; on success persist, repaint, return true. */
export function importAppThemeState(json: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return false;
  }
  if (typeof parsed !== "object" || parsed == null) return false;
  const obj = parsed as Record<string, unknown>;
  const light = sanitizeRecord(obj.light);
  const dark = sanitizeRecord(obj.dark);
  // Nothing recognizable in either bucket — treat as invalid input rather
  // than silently resetting the user's current theme.
  if (!recordHasContent(light) && !recordHasContent(dark)) return false;
  const state = { light, dark };
  persist(state);
  applyAppTheme(state);
  return true;
}

// ── Boot + mode-change wiring ───────────────────────────────────────────────

/** Apply the persisted customization; call once before React mounts. */
export function initAppTheme(): void {
  applyAppTheme();
}

/**
 * Repaint when next-themes flips the resolved mode (system following day/
 * night): inline vars are per-mode, so each flip needs the other bucket.
 */
export function AppThemeSync(): null {
  const { resolvedTheme } = useTheme();
  useEffect(() => {
    if (resolvedTheme === "light" || resolvedTheme === "dark") {
      applyAppTheme(undefined, resolvedTheme);
    }
  }, [resolvedTheme]);
  return null;
}
