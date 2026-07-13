"use client";

import { useMemo } from "react";
import {
  FolderOpen,
  ChevronRight,
  Search,
} from "../../icons";
import { Input } from "@lynse/ui/components/ui/input";
import { ScrollArea } from "@lynse/ui/components/ui/scroll-area";
import { Collapsible } from "@lynse/ui/components/ui/collapsible";
import { useAuthStore } from "@lynse/core/auth";
import { useWorkspaceStore } from "../store";
import { useFiles } from "../hooks/use-files";
import { useFolders } from "../hooks/use-folders";

interface GroupedItem {
  id: string;
  title: string;
  folderId?: string;
}

export function ItemDirectory() {
  const searchQuery = useWorkspaceStore((s) => s.searchQuery);
  const setSearchQuery = useWorkspaceStore((s) => s.setSearchQuery);
  const selectedItemId = useWorkspaceStore((s) => s.selectedItemId);
  const selectItem = useWorkspaceStore((s) => s.selectItem);
  const collapsedGroups = useWorkspaceStore((s) => s.collapsedGroups);
  const toggleGroup = useWorkspaceStore((s) => s.toggleGroup);
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);

  const { data: files } = useFiles({
    pageNum: 1,
    pageSize: 200,
    originalFilename: searchQuery || undefined,
  });

  const { data: folders } = useFolders();

  // Build folder lookup from API response
  const folderMap = useMemo(() => {
    const map = new Map<string, { name: string; color?: string }>();
    if (Array.isArray(folders)) {
      for (const f of folders) {
        if (f.id) map.set(f.id, { name: f.folderName, color: f.color });
      }
    }
    return map;
  }, [folders]);

  const items = files ?? [];

  // Group items by folderId; ungrouped go to "Uncategorized"
  const grouped = useMemo(() => {
    const groups = new Map<string, GroupedItem[]>();
    for (const item of items) {
      const key = item.folderId || "__uncategorized__";
      let list = groups.get(key);
      if (!list) {
        list = [];
        groups.set(key, list);
      }
      list.push(item);
    }
    return groups;
  }, [items]);

  // Ordered folder list: server folders first (in API order), then uncategorized
  const folderOrder = useMemo(() => {
    const order: string[] = [];
    if (Array.isArray(folders)) {
      for (const f of folders) {
        if (f.id) order.push(f.id);
      }
    }
    order.push("__uncategorized__");
    return order;
  }, [folders]);

  if (!isAuthenticated) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-4 text-center">
        <p className="text-xs font-medium text-muted-foreground">Not connected</p>
        <p className="text-[10px] text-muted-foreground">
          Go to Settings to connect your API key
        </p>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="border-b p-3">
        <div className="relative">
          <Search className="absolute left-2.5 top-2.5 size-3.5 text-muted-foreground" />
          <Input
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search files..."
            className="h-8 pl-8 text-xs"
          />
        </div>
      </div>
      <ScrollArea className="flex-1">
        <div className="p-2">
          {folderOrder.map((folderId) => {
            const groupItems = grouped.get(folderId) ?? [];
            // Skip empty folders in search results
            if (searchQuery && groupItems.length === 0) return null;

            const folderInfo = folderMap.get(folderId);
            const label = folderId === "__uncategorized__"
              ? "Uncategorized"
              : (folderInfo?.name || folderId);
            const color = folderInfo?.color;
            const isCollapsed = collapsedGroups.has(folderId);

            return (
              <Collapsible
                key={folderId}
                open={!isCollapsed}
                onOpenChange={() => toggleGroup(folderId)}
              >
                <button
                  onClick={() => toggleGroup(folderId)}
                  className="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-medium text-muted-foreground hover:bg-muted"
                >
                  <ChevronRight
                    className={`size-3 shrink-0 transition-transform ${
                      isCollapsed ? "" : "rotate-90"
                    }`}
                  />
                  {color ? (
                    <span
                      className="size-3 shrink-0 rounded"
                      style={{ backgroundColor: color }}
                    />
                  ) : (
                    <FolderOpen className="size-3.5 shrink-0" />
                  )}
                  <span className="truncate">{label}</span>
                  <span className="ml-auto text-[10px] tabular-nums shrink-0">
                    {groupItems.length}
                  </span>
                </button>
                {!isCollapsed && (
                  <div className="mt-0.5 space-y-0.5">
                    {groupItems.length === 0 ? (
                      <p className="px-7 py-1.5 text-[10px] text-muted-foreground">
                        No items
                      </p>
                    ) : (
                      groupItems.map((item) => (
                        <button
                          key={item.id}
                          onClick={() => selectItem(item.id, "file", item.title)}
                          className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-sidebar-accent ${
                            selectedItemId === item.id
                              ? "bg-sidebar-accent text-sidebar-accent-foreground"
                              : ""
                          }`}
                        >
                          <span className="truncate">{item.title}</span>
                        </button>
                      ))
                    )}
                  </div>
                )}
              </Collapsible>
            );
          })}
        </div>
      </ScrollArea>
    </div>
  );
}
