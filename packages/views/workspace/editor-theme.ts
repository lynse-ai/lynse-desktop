/**
 * Editor typography theme — selection + persistence.
 *
 * Themes are pure CSS, keyed off `<html data-editor-theme="…">` and defined
 * at the bottom of workspace/content-preview.css. The choice is persisted in
 * localStorage and restored on startup by initEditorTheme().
 */

export type EditorThemeId =
  | "lynse"
  | "github"
  | "newsprint"
  | "white"
  | "paper"
  | "mint"
  | "sepia"
  | "night"
  | "solarized";

export const EDITOR_THEMES: EditorThemeId[] = [
  "lynse",
  "github",
  "newsprint",
  "white",
  "paper",
  "mint",
  "sepia",
  "night",
  "solarized",
];

const STORAGE_KEY = "lynse-editor-theme";

function isEditorThemeId(value: string | null | undefined): value is EditorThemeId {
  return (EDITOR_THEMES as string[]).includes(value ?? "");
}

export function getEditorTheme(): EditorThemeId {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    // Migrate pre-rename ids ("vmark-paper" → "paper")
    const migrated = stored?.replace(/^vmark-/, "");
    return isEditorThemeId(migrated) ? migrated : "lynse";
  } catch {
    return "lynse";
  }
}

/** Apply a theme to the document root and persist the choice. */
export function setEditorTheme(theme: EditorThemeId): void {
  document.documentElement.dataset.editorTheme = theme;
  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    // Storage unavailable — theme still applies for this session.
  }
}

/** Restore the persisted theme on startup. Returns the active theme id. */
export function initEditorTheme(): EditorThemeId {
  const theme = getEditorTheme();
  document.documentElement.dataset.editorTheme = theme;
  return theme;
}
