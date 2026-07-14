"use client";

import { useEffect, useState } from "react";
import { PanelLeft, Search } from "../icons";
import { useTranslation } from "@lynse/core/i18n/react";
import { useSidebar } from "@lynse/ui/components/ui/sidebar";
import { FilterPopover } from "../workspace/filter-popover";
import { GlobalSearchDialog } from "../workspace/search-dialog";

/**
 * Toolbar shown at the top of the desktop sidebar, directly to the right of
 * the macOS traffic lights (red / yellow / green). Function icons:
 *   [collapse-sidebar] [search] [filter]
 *
 * It is meant to sit ABOVE the Lynse wordmark inside the sidebar's topSlot.
 * The left padding clears the traffic-light cluster with extra breathing room.
 */
export function SidebarToolbar() {
  const { t } = useTranslation();
  const { toggleSidebar } = useSidebar();
  const [searchOpen, setSearchOpen] = useState(false);

  // ⌘K / Ctrl+K opens global search
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setSearchOpen(true);
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  return (
    <div
      className="flex h-10 -mt-[2px] items-center justify-end gap-1.5 pr-3"
      data-tauri-drag-region
    >
      <ToolbarButton title={t("workspace.collapse_sidebar")} onClick={toggleSidebar}>
        <PanelLeft className="size-3.5" />
      </ToolbarButton>
      <ToolbarButton title={t("workspace.search_files")} onClick={() => setSearchOpen(true)}>
        <Search className="size-3.5" />
      </ToolbarButton>
      <FilterPopover />

      <GlobalSearchDialog open={searchOpen} onOpenChange={setSearchOpen} />
    </div>
  );
}

/* ── Small toolbar button ─────────────────────────────── */
function ToolbarButton({
  title,
  children,
  onClick,
}: {
  title: string;
  children: React.ReactNode;
  onClick?: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="flex size-6 items-center justify-center rounded-sm text-muted-foreground/70 transition-colors hover:text-foreground hover:bg-black/[0.06] dark:hover:bg-white/[0.08]"
      title={title}
      data-tauri-drag-region={false}
    >
      {children}
    </button>
  );
}
