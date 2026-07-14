"use client";

import { useMemo } from "react";
import { Filter, Check } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@lynse/ui/components/ui/popover";
import { useTranslation } from "@lynse/core/i18n/react";
import { useWorkspaceStore } from "./store";
import { useFiles } from "./hooks/use-files";

const DATE_OPTIONS: Array<"all" | "7d" | "30d"> = ["all", "7d", "30d"];

/**
 * Filter trigger rendered inside the desktop sidebar toolbar (the "Filter" icon).
 * Opens a popover to filter the file list by tag and creation date.
 */
export function FilterPopover() {
  const { t } = useTranslation();
  const filterTags = useWorkspaceStore((s) => s.filterTags);
  const filterDate = useWorkspaceStore((s) => s.filterDate);
  const setFilterTags = useWorkspaceStore((s) => s.setFilterTags);
  const setFilterDate = useWorkspaceStore((s) => s.setFilterDate);
  const resetFilters = useWorkspaceStore((s) => s.resetFilters);

  const { data: files } = useFiles({ pageSize: 200 });
  const availableTags = useMemo(() => {
    const set = new Set<string>();
    for (const f of files ?? []) for (const tag of f.tags ?? []) set.add(tag);
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [files]);

  const toggleTag = (tag: string) => {
    setFilterTags(
      filterTags.includes(tag) ? filterTags.filter((x) => x !== tag) : [...filterTags, tag],
    );
  };

  const active = filterTags.length > 0 || filterDate !== "all";

  return (
    <Popover>
      <PopoverTrigger
        className="flex size-6 items-center justify-center rounded-sm text-muted-foreground/70 transition-colors hover:text-foreground hover:bg-black/[0.06] dark:hover:bg-white/[0.08] data-popup-open:bg-accent data-popup-open:text-accent-foreground"
        title={t("workspace.filter")}
        data-tauri-drag-region={false}
      >
        <Filter className="size-3.5" />
        {active && (
          <span className="absolute -right-0.5 -top-0.5 size-1.5 rounded-full bg-primary" />
        )}
      </PopoverTrigger>
      <PopoverContent side="bottom" align="end" sideOffset={8} className="w-64 p-3">
        <div className="flex items-center justify-between pb-2">
          <span className="text-xs font-semibold">{t("workspace.filter_title")}</span>
          {active && (
            <button
              onClick={resetFilters}
              className="text-[11px] text-muted-foreground transition-colors hover:text-foreground"
            >
              {t("workspace.filter_reset")}
            </button>
          )}
        </div>

        <div className="space-y-3">
          {/* Tags */}
          <div>
            <p className="mb-1.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground/70">
              {t("workspace.filter_by_tag")}
            </p>
            {availableTags.length === 0 ? (
              <p className="text-[11px] text-muted-foreground/60">{t("workspace.no_items")}</p>
            ) : (
              <div className="flex flex-wrap gap-1">
                {availableTags.map((tag) => {
                  const selected = filterTags.includes(tag);
                  return (
                    <button
                      key={tag}
                      onClick={() => toggleTag(tag)}
                      className={`flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] transition-colors ${
                        selected
                          ? "bg-primary text-primary-foreground"
                          : "bg-muted text-muted-foreground hover:bg-muted/70"
                      }`}
                    >
                      {selected && <Check className="size-2.5" />}
                      {tag}
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {/* Date */}
          <div>
            <p className="mb-1.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground/70">
              {t("workspace.filter_by_date")}
            </p>
            <div className="flex gap-1">
              {DATE_OPTIONS.map((opt) => {
                const selected = filterDate === opt;
                return (
                  <button
                    key={opt}
                    onClick={() => setFilterDate(opt)}
                    className={`flex-1 rounded-md px-2 py-1 text-[11px] transition-colors ${
                      selected
                        ? "bg-accent text-accent-foreground font-medium"
                        : "bg-muted text-muted-foreground hover:bg-muted/70"
                    }`}
                  >
                    {t(`workspace.filter_${opt === "all" ? "all" : opt}`)}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
