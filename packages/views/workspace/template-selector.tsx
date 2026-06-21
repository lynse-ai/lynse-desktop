"use client";

import { useState, useMemo, useCallback } from "react";
import { ScrollArea } from "@lynse/ui/components/ui/scroll-area";
import {
  InputGroup,
  InputGroupAddon,
} from "@lynse/ui/components/ui/input-group";
import { Input } from "@lynse/ui/components/ui/input";
import { useTranslation } from "@lynse/core/i18n/react";
import { cn } from "@lynse/ui/lib/utils";
import { Search, Check, Sparkles } from "../icons";
import type { PromptTemplate, PromptTemplateCategory } from "./types";

/** Minimal shape needed for template selection */
type TemplateCategory = Pick<PromptTemplateCategory, "category" | "templates">;

interface TemplateSelectorProps {
  categories: TemplateCategory[];
  selectedId: string;
  onSelect: (id: string) => void;
  /** Max height of the scroll area (Tailwind class) */
  scrollHeight?: string;
}

export function TemplateSelector({
  categories,
  selectedId,
  onSelect,
  scrollHeight = "h-64",
}: TemplateSelectorProps) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");

  // Flat list for search matching
  const allTemplates = useMemo(
    () => categories.flatMap((c) => c.templates),
    [categories],
  );

  // Filtered categories based on search query
  const filteredCategories = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return categories;
    return categories
      .map((cat) => ({
        ...cat,
        templates: cat.templates.filter(
          (tpl) =>
            tpl.name.toLowerCase().includes(q) ||
            tpl.alias.toLowerCase().includes(q) ||
            tpl.tags.toLowerCase().includes(q) ||
            tpl.category.toLowerCase().includes(q),
        ),
      }))
      .filter((cat) => cat.templates.length > 0);
  }, [categories, query]);

  const selectedTemplate = useMemo(
    () => allTemplates.find((tpl) => tpl.id === selectedId),
    [allTemplates, selectedId],
  );

  const totalCount = allTemplates.length;
  const filteredCount = useMemo(
    () => filteredCategories.reduce((sum, c) => sum + c.templates.length, 0),
    [filteredCategories],
  );

  const handleClear = useCallback(() => setQuery(""), []);

  return (
    <div className="flex flex-col gap-2.5">
      {/* Label + count */}
      <div className="flex items-center justify-between">
        <label className="text-sm font-medium text-foreground">
          {t("upload.select_template")}
        </label>
        <span className="text-xs tabular-nums text-muted-foreground">
          {query.trim()
            ? `${filteredCount} / ${totalCount}`
            : `${totalCount} ${t("resummarize.templates_count")}`}
        </span>
      </div>

      {/* Search input */}
      <InputGroup className="h-8! rounded-lg! border-input/30 bg-input/30 shadow-none! *:data-[slot=input-group-addon]:pl-2!">
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t("template.search_placeholder")}
          className="h-full! border-0! bg-transparent! shadow-none! focus-visible:ring-0! text-sm"
        />
        {query ? (
          <InputGroupAddon align="inline-end">
            <button
              type="button"
              onClick={handleClear}
              className="text-muted-foreground/60 hover:text-foreground transition-colors"
              aria-label="Clear search"
            >
              <span className="text-xs font-medium px-1">✕</span>
            </button>
          </InputGroupAddon>
        ) : (
          <InputGroupAddon align="inline-end">
            <Search className="size-3.5 shrink-0 text-muted-foreground/50" />
          </InputGroupAddon>
        )}
      </InputGroup>

      {/* Template grid */}
      <ScrollArea
        className={cn(
          "rounded-lg border border-border/40 bg-muted/20",
          scrollHeight,
        )}
      >
        <div className="flex flex-col p-2">
          {filteredCategories.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-10 gap-2 text-muted-foreground">
              <Search className="size-5 opacity-40" />
              <p className="text-xs">{t("template.no_results")}</p>
            </div>
          ) : (
            filteredCategories.map((cat) => (
              <TemplateCategorySection
                key={cat.category}
                category={cat.category}
                templates={cat.templates}
                selectedId={selectedId}
                onSelect={onSelect}
              />
            ))
          )}
        </div>
      </ScrollArea>

      {/* Selected template info */}
      {selectedTemplate && (
        <SelectedTemplateInfo template={selectedTemplate} />
      )}
    </div>
  );
}

// ── Category section ─────────────────────────────────────────

function TemplateCategorySection({
  category,
  templates,
  selectedId,
  onSelect,
}: {
  category: string;
  templates: PromptTemplate[];
  selectedId: string;
  onSelect: (id: string) => void;
}) {
  return (
    <div className="mb-2 last:mb-0">
      {/* Category header */}
      <div className="flex items-center gap-2 px-1 py-1.5">
        <span className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/50">
          {category}
        </span>
        <div className="flex-1 h-px bg-border/40" />
        <span className="text-[10px] tabular-nums text-muted-foreground/40">
          {templates.length}
        </span>
      </div>

      {/* Card grid */}
      <div className="grid grid-cols-2 gap-1.5">
        {templates.map((tpl) => (
          <TemplateCard
            key={tpl.id}
            template={tpl}
            isSelected={selectedId === tpl.id}
            onSelect={onSelect}
          />
        ))}
      </div>
    </div>
  );
}

// ── Template card item ────────────────────────────────────────

function TemplateCard({
  template,
  isSelected,
  onSelect,
}: {
  template: PromptTemplate;
  isSelected: boolean;
  onSelect: (id: string) => void;
}) {
  const tags = template.tags
    ? template.tags.split(",").slice(0, 2).map((t) => t.trim()).filter(Boolean)
    : [];

  return (
    <button
      type="button"
      className={cn(
        "group relative flex flex-col gap-1.5 rounded-xl border-2 px-3 py-2.5 text-left transition-all duration-150",
        isSelected
          ? "border-primary bg-primary/5 shadow-sm shadow-primary/10"
          : "border-transparent bg-card hover:border-border/60 hover:bg-muted/50 active:bg-muted/70",
      )}
      onClick={() => onSelect(template.id)}
    >
      {/* Top row: icon + format badge */}
      <div className="flex items-center justify-between">
        <div
          className={cn(
            "flex size-9 items-center justify-center rounded-lg transition-colors overflow-hidden",
            isSelected
              ? "bg-primary/10 text-primary"
              : "bg-muted/80 text-muted-foreground group-hover:bg-muted group-hover:text-foreground",
          )}
        >
          {template.iconUrl ? (
            <img
              src={template.iconUrl}
              alt=""
              className="size-5 object-contain"
              onError={(e) => {
                (e.target as HTMLImageElement).style.display = "none";
                (e.target as HTMLImageElement).nextElementSibling?.classList.remove("hidden");
              }}
            />
          ) : null}
          <Sparkles className={cn("size-4", template.iconUrl ? "hidden" : "")} />
        </div>
        <div className="flex items-center gap-1">
          {template.contentFormat && (
            <span className={cn(
              "text-[9px] font-medium px-1.5 py-0.5 rounded-md",
              isSelected
                ? "bg-primary/10 text-primary"
                : "bg-muted text-muted-foreground/70",
            )}>
              {template.contentFormat === "markdown" ? "MD" : "HTML"}
            </span>
          )}
          {/* Check indicator */}
          <div
            className={cn(
              "flex size-4 items-center justify-center rounded-full border-2 transition-all duration-150",
              isSelected
                ? "border-primary bg-primary"
                : "border-border/50 opacity-0 group-hover:opacity-100",
            )}
          >
            {isSelected && <Check className="size-2.5 text-primary-foreground" strokeWidth={3} />}
          </div>
        </div>
      </div>

      {/* Name */}
      <p
        className={cn(
          "text-[13px] leading-snug font-medium line-clamp-2",
          isSelected ? "text-primary" : "text-foreground/90",
        )}
      >
        {template.name}
      </p>

      {/* Alias / description */}
      {template.alias && template.alias !== template.name && (
        <p className="text-[11px] leading-snug text-muted-foreground line-clamp-1">
          {template.alias}
        </p>
      )}

      {/* Tags */}
      {tags.length > 0 && (
        <div className="flex flex-wrap gap-1 mt-auto pt-0.5">
          {tags.map((tag) => (
            <span
              key={tag}
              className={cn(
                "text-[9px] px-1.5 py-0.5 rounded-md leading-none",
                isSelected
                  ? "bg-primary/8 text-primary/80"
                  : "bg-muted/60 text-muted-foreground/60",
              )}
            >
              {tag}
            </span>
          ))}
        </div>
      )}
    </button>
  );
}

// ── Selected template info footer ────────────────────────────

function SelectedTemplateInfo({ template }: { template: PromptTemplate }) {
  return (
    <div className="flex items-center gap-2 rounded-lg bg-primary/5 border border-primary/10 px-3 py-2">
      <Check className="size-3.5 text-primary shrink-0" />
      <p className="text-xs font-medium text-foreground/80 truncate">
        {template.name}
      </p>
      {template.alias && template.alias !== template.name && (
        <span className="text-[11px] text-muted-foreground truncate ml-auto">
          {template.alias}
        </span>
      )}
    </div>
  );
}
