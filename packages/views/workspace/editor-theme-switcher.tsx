"use client";

import { useEffect, useState } from "react";
import { useTranslation } from "@lynse/core/i18n/react";
import { cn } from "@lynse/ui/lib/utils";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@lynse/ui/components/ui/dropdown-menu";
import { Check, Palette } from "../icons";
import {
  EDITOR_THEMES,
  initEditorTheme,
  setEditorTheme,
  type EditorThemeId,
} from "./editor-theme";

const THEME_LABEL_KEYS: Record<EditorThemeId, string> = {
  lynse: "workspace.theme_lynse",
  github: "workspace.theme_github",
  newsprint: "workspace.theme_newsprint",
  white: "workspace.theme_white",
  paper: "workspace.theme_paper",
  mint: "workspace.theme_mint",
  sepia: "workspace.theme_sepia",
  night: "workspace.theme_night",
  solarized: "workspace.theme_solarized",
};

/**
 * Palette button + dropdown for switching the content typography theme.
 * Rendered in the TitleBar's right-hand action group.
 */
export function EditorThemeSwitcher() {
  const { t } = useTranslation();
  const [theme, setTheme] = useState<EditorThemeId>("lynse");

  // Restore the persisted choice once on mount.
  useEffect(() => setTheme(initEditorTheme()), []);

  const select = (next: EditorThemeId) => {
    setEditorTheme(next);
    setTheme(next);
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        title={t("workspace.editor_theme")}
        data-tauri-drag-region={false}
        className={cn(
          "flex size-7 items-center justify-center rounded-lg border border-transparent transition-colors",
          theme === "lynse"
            ? "text-muted-foreground hover:bg-accent/50"
            : "bg-accent text-accent-foreground",
        )}
      >
        <Palette className="size-3.5" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-44">
        {EDITOR_THEMES.map((id) => (
          <DropdownMenuItem key={id} onClick={() => select(id)}>
            {theme === id ? (
              <Check className="size-3 text-primary" />
            ) : (
              <span className="size-3" />
            )}
            <span className={cn(theme !== id && "text-muted-foreground")}>
              {t(THEME_LABEL_KEYS[id])}
            </span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
