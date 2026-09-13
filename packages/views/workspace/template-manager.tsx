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
import { Sparkles } from "../icons";
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
          <div className="flex flex-col gap-6 py-2" aria-hidden>
            {[0, 1].map((cat) => (
              <div key={cat}>
                <span className="block h-4 w-24 animate-pulse rounded bg-muted-foreground/10" />
                <div className="mt-3 grid grid-cols-2 gap-3">
                  {[0, 1].map((card) => (
                    <div
                      key={card}
                      className="rounded-xl border border-border/60 p-4"
                    >
                      <span className="block h-3.5 w-3/5 animate-pulse rounded bg-muted-foreground/10" />
                      <span className="mt-2.5 block h-3 w-full animate-pulse rounded bg-muted-foreground/10" />
                      <span className="mt-2 block h-3 w-4/5 animate-pulse rounded bg-muted-foreground/10" />
                    </div>
                  ))}
                </div>
              </div>
            ))}
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
        <span className="text-3xs font-semibold uppercase tracking-widest text-muted-foreground/50">
          {category}
        </span>
        <div className="flex-1 h-px bg-border/40" />
        <span className="text-3xs tabular-nums text-muted-foreground/40">
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
              decoding="async"
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
            "text-3xs font-medium px-1.5 py-0.5 rounded-md",
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
        "text-13 leading-snug font-medium line-clamp-2",
        isDefault ? "text-primary" : "text-foreground/90",
      )}>
        {template.name}
      </p>

      {/* Alias */}
      {template.alias && template.alias !== template.name && (
        <p className="text-2xs leading-snug text-muted-foreground line-clamp-1">
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
                "text-3xs px-1.5 py-0.5 rounded-md leading-none",
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
