"use client";

import type { ReactNode } from "react";
import { TencentMeetingSidebar } from "./tencent-meeting-sidebar";
import { DndProvider } from "../workspace/dnd-provider";

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
      <div className="flex h-svh overflow-hidden">
        <TencentMeetingSidebar />
        <main className="relative flex min-w-0 flex-1 flex-col overflow-hidden bg-background">
          {children}
          {extra}
        </main>
      </div>
    </DndProvider>
  );
}
