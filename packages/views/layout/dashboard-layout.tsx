"use client";

import type { ReactNode } from "react";
import { LynseSidebar } from "./lynse-sidebar";
import { DndProvider } from "../workspace/dnd-provider";
import { AboutDialog } from "../about/about-dialog";

interface DashboardLayoutProps {
  children: ReactNode;
  extra?: ReactNode;
  searchSlot?: ReactNode;
  loadingIndicator?: ReactNode;
  topSlot?: ReactNode;
}

export function DashboardLayout({ children, extra }: DashboardLayoutProps) {
  return (
    <DndProvider>
      {/* .lyse-shell: under light-mode vibrancy the CSS washes this shell with
          one veil of the theme background, so the sidebar rail and the bare
          strips around the inset card share the same material instead of
          letting raw wallpaper hues bleed through; dark mode keeps the rail
          and strips on raw frost (no-op on the web).
          data-tauri-drag-region makes those strips draggable. */}
      <div className="lyse-shell flex h-svh overflow-hidden" data-tauri-drag-region>
        <LynseSidebar />
        {/* .lyse-content-card: under macOS window vibrancy the CSS turns this
            column into a rounded card inset on the frosted page (Codex-style);
            without vibrancy it stays a plain full-bleed column. */}
        <main
          className="lyse-content-card relative flex min-w-0 flex-1 flex-col overflow-hidden bg-background"
        >
          {children}
          {extra}
        </main>
      </div>
      {/* About fallback dialog — on desktop the About entry pops a real OS
          window instead, so this stays closed there (see open-about.ts). */}
      <AboutDialog />
    </DndProvider>
  );
}
