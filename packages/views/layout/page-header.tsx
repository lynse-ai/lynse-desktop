"use client";

import { cn } from "@lynse/ui/lib/utils";
import { SidebarTrigger, useSidebar } from "@lynse/ui/components/ui/sidebar";

function MobileSidebarTrigger() {
  try {
    useSidebar();
  } catch {
    return null;
  }
  return <SidebarTrigger className="mr-2 md:hidden" />;
}

interface PageHeaderProps {
  children: React.ReactNode;
  className?: string;
}

export function PageHeader({ children, className }: PageHeaderProps) {
  return (
    <div className={cn("flex h-14 shrink-0 items-center border-b border-border/50 bg-background/80 px-5 backdrop-blur-xl", className)}>
      <MobileSidebarTrigger />
      {children}
    </div>
  );
}
