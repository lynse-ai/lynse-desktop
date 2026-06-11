"use client";

import type { ReactNode } from "react";
import { SidebarProvider, SidebarInset } from "@lynse/ui/components/ui/sidebar";
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
          {children}
          {extra}
        </SidebarInset>
      </SidebarProvider>
    </DndProvider>
  );
}
