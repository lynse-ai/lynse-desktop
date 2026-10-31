/**
 * Visual presets for the share card (image & PDF export). Deliberately
 * independent of the app theme: the recipient sees the card as-is, so the
 * sender picks a style per share instead of inheriting their local skin
 * (flomo-style interaction).
 *
 * Following the sspai share-card roundup (sspai.com/post/85218): good themes
 * are complete designs — each pairs a palette with its own typeface (sans /
 * serif / kaiti) instead of only recoloring one background.
 *
 * Flat themes render the content directly on `background`; gradient themes
 * show the gradient around an inner translucent `surface` card.
 */
export type ShareCardFontId = "sans" | "serif" | "kai" | "round";

export interface ShareCardTheme {
  id: string;
  /** i18n key for the preset name (share.theme_<id>). */
  nameKey: string;
  /** CSS background of the exported image (color or gradient). */
  background: string;
  /** Inner surface for gradient backgrounds; content sits on this card. */
  surface?: string;
  foreground: string;
  muted: string;
  accent: string;
  border: string;
  /** Typeface family for this theme — themes are complete designs, not recolors. */
  font: ShareCardFontId;
  /** Small square preview for the theme picker. */
  swatch: string;
}

export const SHARE_CARD_THEMES: ShareCardTheme[] = [
  {
    id: "minimal",
    nameKey: "share.theme_minimal",
    background: "#ffffff",
    foreground: "#1f2328",
    muted: "#98a1a8",
    accent: "#4c6ef5",
    border: "#e9ebef",
    font: "sans",
    swatch: "#ffffff",
  },
  {
    id: "paper",
    nameKey: "share.theme_paper",
    background: "#f9f5ee",
    foreground: "#3f3629",
    muted: "#a29484",
    accent: "#c2703d",
    border: "#ecdfc8",
    font: "kai",
    swatch: "#f2e9d9",
  },
  {
    id: "sakura",
    nameKey: "share.theme_sakura",
    background: "#fdf3f4",
    foreground: "#4a2b31",
    muted: "#b39098",
    accent: "#e0616f",
    border: "#f6dde1",
    font: "round",
    swatch: "#fadfe3",
  },
  {
    id: "dusk",
    nameKey: "share.theme_dusk",
    background: "#eef2f9",
    foreground: "#26334d",
    muted: "#8391a8",
    accent: "#4271d6",
    border: "#dbe3f0",
    font: "serif",
    swatch: "#d7e1f2",
  },
  {
    // Black & gold — matches the visual-summary card style.
    id: "ink",
    nameKey: "share.theme_ink",
    background: "#161616",
    foreground: "#f2f2ef",
    muted: "#8f8f8a",
    accent: "#e8c56b",
    border: "#2e2e2c",
    font: "sans",
    swatch: "#161616",
  },
  {
    id: "coffee",
    nameKey: "share.theme_coffee",
    background: "#1f1a15",
    foreground: "#f2ebe2",
    muted: "#ab9f8f",
    accent: "#dba45f",
    border: "#372f27",
    font: "serif",
    swatch: "#1f1a15",
  },
  {
    id: "aurora",
    nameKey: "share.theme_aurora",
    background: "linear-gradient(160deg, #6d5df6 0%, #b16cea 48%, #ff8fb1 100%)",
    surface: "rgba(255, 255, 255, 0.94)",
    foreground: "#2c2444",
    muted: "#8f88aa",
    accent: "#6a5cff",
    border: "rgba(108, 92, 255, 0.16)",
    font: "round",
    swatch: "linear-gradient(135deg, #6d5df6, #b16cea, #ff8fb1)",
  },
  {
    id: "newsprint",
    nameKey: "share.theme_newsprint",
    background: "#fafaf8",
    foreground: "#1c1c1c",
    muted: "#8c8c88",
    accent: "#b5382c",
    border: "#e6e4de",
    font: "serif",
    swatch: "#fafaf8",
  },
  {
    id: "sage",
    nameKey: "share.theme_sage",
    background: "#e4ecd8",
    foreground: "#2e3a28",
    muted: "#7f8f74",
    accent: "#5f7f4c",
    border: "#cfdcbe",
    font: "sans",
    swatch: "#e4ecd8",
  },
  {
    // Navy with faint concentric-ring texture (repeating radial gradient).
    id: "navy",
    nameKey: "share.theme_navy",
    background:
      "repeating-radial-gradient(circle at 82% 10%, rgba(255,255,255,0.05) 0px, rgba(255,255,255,0.05) 1px, transparent 1px, transparent 30px), linear-gradient(160deg, #26375c 0%, #1a2440 60%, #131b31 100%)",
    surface: "rgba(16, 24, 44, 0.86)",
    foreground: "#e9eefb",
    muted: "#93a0bd",
    accent: "#7ea2f5",
    border: "rgba(255, 255, 255, 0.14)",
    font: "sans",
    swatch: "#1d2b45",
  },
];

export const DEFAULT_SHARE_CARD_THEME_ID = "minimal";

export function getShareCardTheme(id: string): ShareCardTheme {
  return SHARE_CARD_THEMES.find((theme) => theme.id === id) ?? SHARE_CARD_THEMES[0]!;
}
