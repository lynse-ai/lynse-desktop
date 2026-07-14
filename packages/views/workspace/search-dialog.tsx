"use client";

import { useEffect, useMemo, useState } from "react";
import { FileText } from "lucide-react";
import {
  CommandDialog,
  Command,
  CommandInput,
  CommandList,
  CommandGroup,
  CommandItem,
} from "@lynse/ui/components/ui/command";
import { useTranslation } from "@lynse/core/i18n/react";
import { useWorkspaceStore } from "./store";
import { useFiles } from "./hooks/use-files";
import type { WorkspaceItem } from "./types";

/**
 * Global file search palette (⌘K). Searches across all folders by file name
 * via the existing `/api/business/file/page` endpoint (originalFilename param).
 */
export function GlobalSearchDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const selectItem = useWorkspaceStore((s) => s.selectItem);
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");

  useEffect(() => {
    const id = setTimeout(() => setDebounced(query), 250);
    return () => clearTimeout(id);
  }, [query]);

  const { data: results } = useFiles({
    originalFilename: debounced.trim() || undefined,
    pageSize: 100,
    enabled: debounced.trim().length > 0,
  });

  const items = useMemo(() => (results ?? []) as WorkspaceItem[], [results]);

  // Reset query when the dialog closes
  useEffect(() => {
    if (!open) {
      setQuery("");
      setDebounced("");
    }
  }, [open]);

  const handleSelect = (item: WorkspaceItem) => {
    selectItem(item.id, item.type, item.title);
    onOpenChange(false);
  };

  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t("workspace.search_title")}
      description={t("workspace.search_placeholder")}
    >
      <Command shouldFilter={false} className="h-80">
        <CommandInput
          value={query}
          onValueChange={setQuery}
          autoFocus
          placeholder={t("workspace.search_placeholder")}
        />
        <CommandList>
          {!debounced.trim() ? (
            <div className="py-8 text-center text-sm text-muted-foreground">
              {t("workspace.search_global_hint")}
            </div>
          ) : items.length === 0 ? (
            <div className="py-8 text-center text-sm text-muted-foreground">
              {t("workspace.search_no_results")}
            </div>
          ) : (
            <CommandGroup heading={t("workspace.files")}>
              {items.map((item) => (
                <CommandItem
                  key={item.id}
                  value={item.id}
                  onSelect={() => handleSelect(item)}
                  className="gap-2"
                >
                  <FileText className="size-4 shrink-0 text-muted-foreground" />
                  <span className="flex-1 truncate">{item.title}</span>
                  {item.tags && item.tags.length > 0 && (
                    <span className="shrink-0 truncate text-[10px] text-muted-foreground/60">
                      {item.tags.slice(0, 2).join(", ")}
                    </span>
                  )}
                </CommandItem>
              ))}
            </CommandGroup>
          )}
        </CommandList>
      </Command>
    </CommandDialog>
  );
}
