"use client";

import { ThemeProvider as NextThemesProvider } from "next-themes";
import { AppThemeSync } from "@lynse/views/settings/app-theme";

export function ThemeProvider({
  children,
  ...props
}: React.ComponentProps<typeof NextThemesProvider>) {
  return (
    <NextThemesProvider
      attribute="class"
      defaultTheme="system"
      enableSystem
      // Snap the theme flip instead of smearing: without this, every
      // color/box-shadow transition on the page fires at once on switch
      // (mirrors the desktop provider in packages/ui).
      disableTransitionOnChange
      {...props}
    >
      {/* Repaint the per-mode appearance customization whenever the resolved
          light/dark flips (system following day/night). */}
      <AppThemeSync />
      {children}
    </NextThemesProvider>
  );
}
