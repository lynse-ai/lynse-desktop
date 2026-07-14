"use client";

import type { ReactNode } from "react";
import { SidebarProvider, SidebarInset, useSidebar } from "@lynse/ui/components/ui/sidebar";
import { useTranslation } from "@lynse/core/i18n/react";
import { PanelLeft } from "../icons";
import { AppSidebar } from "./app-sidebar";
import { DndProvider } from "../workspace/dnd-provider";

interface DashboardLayoutProps {
  children: ReactNode;
  extra?: ReactNode;
  searchSlot?: ReactNode;
  loadingIndicator?: ReactNode;
  topSlot?: ReactNode;
}

export function DashboardLayout({
  children,
  extra,
  searchSlot,
  topSlot,
}: DashboardLayoutProps) {
  return (
    <DndProvider>
      <SidebarProvider className="h-svh">
        <AppSidebar topSlot={topSlot} searchSlot={searchSlot} />
        <SidebarInset className="relative overflow-hidden">
          <SidebarReopenToggle />
          {children}
          {extra}
        </SidebarInset>
      </SidebarProvider>
    </DndProvider>
  );
}

/**
 * Floating button to re-open the left sidebar after it has been collapsed.
 * The in-sidebar collapse button disappears together with the sidebar, so we
 * surface this affordance in the content area, positioned just to the right of
 * the macOS traffic lights. Only rendered while the sidebar is collapsed.
 */
function SidebarReopenToggle() {
  const { state, toggleSidebar } = useSidebar();
  const { t } = useTranslation();
  if (state !== "collapsed") return null;
  return (
    <button
      type="button"
      onClick={toggleSidebar}
      title={t("workspace.expand_sidebar")}
      data-tauri-drag-region={false}
      className="absolute left-[72px] top-2 z-30 flex size-6 items-center justify-center rounded-sm text-muted-foreground/70 transition-colors hover:bg-black/[0.06] hover:text-foreground dark:hover:bg-white/[0.08]"
    >
      <PanelLeft className="size-3.5" />
    </button>
  );
}
