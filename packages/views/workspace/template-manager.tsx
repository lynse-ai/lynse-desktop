"use client";

import { useMemo } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@lynse/ui/components/ui/dialog";
import { ScrollArea } from "@lynse/ui/components/ui/scroll-area";
import { useTranslation } from "@lynse/core/i18n/react";
import { cn } from "@lynse/ui/lib/utils";
import { useTemplateCategories } from "./hooks/use-files";
import { Loader2, Sparkles } from "../icons";
import type { PromptTemplate } from "./types";

interface TemplateManagerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function TemplateManager({ open, onOpenChange }: TemplateManagerProps) {
  const { t } = useTranslation();
  const { data: categories, isLoading } = useTemplateCategories();

  const totalCount = useMemo(
    () => categories?.reduce((sum, c) => sum + c.count, 0) ?? 0,
    [categories],
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl max-h-[80vh]">
        <DialogHeader>
          <DialogTitle>{t("templates.title")}</DialogTitle>
          <DialogDescription>
            {t("templates.description", { count: totalCount })}
          </DialogDescription>
        </DialogHeader>

        {isLoading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <ScrollArea className="max-h-[60vh]">
            <div className="flex flex-col gap-4 pr-2">
              {categories?.map((cat) => (
                <CategorySection
                  key={cat.category}
                  category={cat.category}
                  templates={cat.templates}
                />
              ))}
            </div>
          </ScrollArea>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ── Category section ──

function CategorySection({
  category,
  templates,
}: {
  category: string;
  templates: PromptTemplate[];
}) {
  return (
    <div>
      <div className="flex items-center gap-2 px-1 py-1.5">
        <span className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/50">
          {category}
        </span>
        <div className="flex-1 h-px bg-border/40" />
        <span className="text-[10px] tabular-nums text-muted-foreground/40">
          {templates.length}
        </span>
      </div>
      <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3">
        {templates.map((tpl) => (
          <TemplateCard key={tpl.id} template={tpl} />
        ))}
      </div>
    </div>
  );
}

// ── Template card (display-only, matches selector style) ──

function TemplateCard({ template }: { template: PromptTemplate }) {
  const tags = template.tags
    ? template.tags.split(",").slice(0, 2).map((s) => s.trim()).filter(Boolean)
    : [];

  const isDefault = template.isDefault === 1;

  return (
    <div
      className={cn(
        "flex flex-col gap-1.5 rounded-xl border-2 px-3 py-2.5 transition-colors",
        isDefault
          ? "border-primary/30 bg-primary/5"
          : "border-transparent bg-card hover:border-border/60",
      )}
    >
      {/* Top row: icon + format badge */}
      <div className="flex items-center justify-between">
        <div
          className={cn(
            "flex size-9 items-center justify-center rounded-lg overflow-hidden",
            isDefault
              ? "bg-primary/10 text-primary"
              : "bg-muted/80 text-muted-foreground",
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
        {template.contentFormat && (
          <span className={cn(
            "text-[9px] font-medium px-1.5 py-0.5 rounded-md",
            isDefault
              ? "bg-primary/10 text-primary"
              : "bg-muted text-muted-foreground/70",
          )}>
            {template.contentFormat === "markdown" ? "MD" : "HTML"}
          </span>
        )}
      </div>

      {/* Name */}
      <p className={cn(
        "text-[13px] leading-snug font-medium line-clamp-2",
        isDefault ? "text-primary" : "text-foreground/90",
      )}>
        {template.name}
      </p>

      {/* Alias */}
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
                isDefault
                  ? "bg-primary/8 text-primary/80"
                  : "bg-muted/60 text-muted-foreground/60",
              )}
            >
              {tag}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
