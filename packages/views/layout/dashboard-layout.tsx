"use client";

import type { ReactNode } from "react";
import { LynseSidebar } from "./lynse-sidebar";
import { AppTitleBar } from "./app-title-bar";
import { CalendarReminderBanner } from "../connections";
import { DndProvider } from "../workspace/dnd-provider";
import { AboutDialog } from "../about/about-dialog";
import { useLocalTranscriptionUpdates } from "../workspace/hooks/use-files";

interface DashboardLayoutProps {
  children: ReactNode;
  extra?: ReactNode;
  searchSlot?: ReactNode;
  loadingIndicator?: ReactNode;
  topSlot?: ReactNode;
}

export function DashboardLayout({ children, extra }: DashboardLayoutProps) {
  useLocalTranscriptionUpdates();
  return (
    <DndProvider>
      {/* .lyse-shell: under light-mode vibrancy the CSS paints this shell with
          the opaque theme sidebar grey, so the title bar, the sidebar rail
          and the bare strips around the inset card share the same material
          instead of letting raw wallpaper hues bleed through; dark mode keeps
          them on raw frost (no-op on the web).
          data-tauri-drag-region makes those strips draggable. */}
      <div className="lyse-shell flex h-svh flex-col overflow-hidden" data-tauri-drag-region>
        {/* Unified window title bar (ChatGPT-desktop style): the native
            traffic lights overlay its left edge on macOS, and the sidebar +
            content card start below it. */}
        <AppTitleBar />
        <div className="flex min-h-0 flex-1 overflow-hidden">
          <LynseSidebar />
          {/* .lyse-content-card: under macOS window vibrancy the CSS turns this
              column into a rounded card inset on the frosted page (Codex-style);
              without vibrancy it stays a plain full-bleed column. */}
          <main
            className="lyse-content-card relative flex min-w-0 flex-1 flex-col overflow-hidden bg-background"
          >
            {children}
            {extra}
            {/* Pre-meeting reminder (Connections, in-app only in P0). */}
            <CalendarReminderBanner />
          </main>
        </div>
      </div>
      {/* About fallback dialog — on desktop the About entry pops a real OS
          window instead, so this stays closed there (see open-about.ts). */}
      <AboutDialog />
    </DndProvider>
  );
}
