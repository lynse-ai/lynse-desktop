"use client";

/**
 * App appearance customization — theme presets + a single accent color.
 *
 * The light/dark/system MODE stays owned by next-themes (the `.dark` class and
 * the `theme` localStorage key); this module layers one simple choice on top:
 * a theme preset (applied to both light and dark) and an optional accent
 * override. Everything applies as inline CSS variables on <html>, which
 * outrank the `:root` / `.dark` token blocks in packages/ui/styles/tokens.css.
 *
 * State persists in localStorage under "lynse-theme-custom" as
 * `{ version, preset, accent? }`.
 */

import { useEffect } from "react";
import { useTheme } from "@lynse/ui/components/common/theme-provider";

export type ThemeModeBucket = "light" | "dark";

export type AppThemePresetId = "lynse" | "linear" | "notion";

export interface AppThemeState {
  preset: AppThemePresetId;
  /** Accent override; unset = the preset's own accent. */
  accent?: string;
}

export const APP_THEME_STORAGE_KEY = "lynse-theme-custom";
const STORAGE_VERSION = 2;

/** Each mode's as-authored look, used as the accent display fallback. */
export const CANONICAL_COLORS: Record<
  ThemeModeBucket,
  { accent: string; background: string; foreground: string }
> = {
  light: { accent: "#5f67d8", background: "#fafafa", foreground: "#202023" },
  dark: { accent: "#e0b15c", background: "#17181b", foreground: "#f5f3ee" },
};

// ── Presets ─────────────────────────────────────────────────────────────────
//
// A preset is two things: the accent it fills the picker with (same in both
// modes for Linear/Notion) and a full CSS-var override map so its surfaces
// (sidebar, cards, borders) carry the source material's feel.

export interface AppThemePreset {
  id: AppThemePresetId;
  mode: ThemeModeBucket;
  colors: { accent: string; background: string; foreground: string };
  vars: Record<string, string>;
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
];

export const APP_THEME_PRESET_IDS: AppThemePresetId[] = ["lynse", "linear", "notion"];

/** Full preset definition (colors + CSS-var override map) for one mode. */
export function getAppThemePreset(
  id: AppThemePresetId,
  mode: ThemeModeBucket,
): AppThemePreset {
  return (
    APP_THEME_PRESETS.find((p) => p.id === id && p.mode === mode) ?? {
      id,
      mode,
      colors: CANONICAL_COLORS[mode],
      vars: {},
    }
  );
}

function getPreset(id: AppThemePresetId, mode: ThemeModeBucket): AppThemePreset {
  return getAppThemePreset(id, mode);
}

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
function mixHex(a: string, b: string, t: number): string {
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

// ── Var application ─────────────────────────────────────────────────────────

/** Every inline variable this module may write — cleared before each apply. */
const MANAGED_VARS = [
  // Union of all preset surface overrides, so switching presets never leaves
  // stale vars behind (e.g. Notion's --sidebar after returning to Lynse).
  ...new Set(APP_THEME_PRESETS.flatMap((p) => Object.keys(p.vars))),
  "--primary-foreground",
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

/**
 * Paint the customization for `mode` onto <html>. Clears every managed
 * variable first, so switching presets/accents never leaves stale overrides.
 */
export function applyAppTheme(
  state: AppThemeState = getAppThemeState(),
  mode: ThemeModeBucket = currentResolvedMode(),
): void {
  if (typeof document === "undefined") return;
  const html = document.documentElement;
  for (const v of MANAGED_VARS) html.style.removeProperty(v);

  const preset = getPreset(state.preset, mode);
  const vars: Record<string, string> = { ...preset.vars };

  // Only an explicit accent override repaints the accent family — preset vars
  // already carry their own authored accent (family + dark brand tints), and
  // expanding over them would clobber the hand-tuned values.
  if (state.accent != null) {
    Object.assign(vars, expandAccentVars(state.accent, mode, preset.colors.foreground));
  }

  for (const [k, v] of Object.entries(vars)) html.style.setProperty(k, v);
}

// ── Persistence ─────────────────────────────────────────────────────────────

const DEFAULT_STATE: AppThemeState = { preset: "lynse" };

function sanitizeState(raw: unknown): AppThemeState {
  const state: AppThemeState = { ...DEFAULT_STATE };
  if (typeof raw !== "object" || raw == null) return state;
  const r = raw as Record<string, unknown>;
  if (APP_THEME_PRESET_IDS.includes(r.preset as AppThemePresetId)) {
    state.preset = r.preset as AppThemePresetId;
  }
  if (isHexColor(r.accent)) state.accent = normalizeHex(r.accent);
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
    localStorage.setItem(APP_THEME_STORAGE_KEY, JSON.stringify({ version: STORAGE_VERSION, ...state }));
  } catch {
    // Storage unavailable — theme still applies for this session.
  }
}

/** Select a theme preset; clears any accent override (the preset's own
 *  accent takes over). Persists and repaints. */
export function selectAppThemePreset(preset: AppThemePresetId): AppThemeState {
  const state: AppThemeState = { preset };
  persist(state);
  applyAppTheme(state);
  return state;
}

/** Set (or clear with undefined) the accent override. Persists and repaints. */
export function setAppThemeAccent(accent: string | undefined): AppThemeState {
  const state = getAppThemeState();
  if (accent != null && isHexColor(accent)) state.accent = normalizeHex(accent);
  else delete state.accent;
  persist(state);
  applyAppTheme(state);
  return state;
}

// ── Boot + mode-change wiring ───────────────────────────────────────────────

/** Apply the persisted customization; call once before React mounts. */
export function initAppTheme(): void {
  applyAppTheme();
}

/**
 * Repaint when next-themes flips the resolved mode (system following day/
 * night): inline vars are per-mode, so each flip needs the other mode's
 * preset look.
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
