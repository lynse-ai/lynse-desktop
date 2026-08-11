"use client";

import { PageHeader } from "../layout/page-header";
import { Headphones, Plus, Search, Filter } from "../icons";
import { Button } from "@lynse/ui/components/ui/button";
import { Input } from "@lynse/ui/components/ui/input";
import { useTranslation } from "@lynse/core/i18n/react";

export function RecordingsPage() {
  const { t } = useTranslation();

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-background">
      <PageHeader className="h-auto min-h-14 py-3">
        <div className="flex flex-1 items-center gap-4">
          <div className="min-w-0">
            <h1 className="text-[15px] font-semibold tracking-tight text-foreground">
              {t("recordings.title")}
            </h1>
            <p className="mt-0.5 text-[11px] text-muted-foreground">
              {t("recordings.empty_hint")}
            </p>
          </div>
          <div className="relative ml-3 w-full max-w-xs">
            <Search className="absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder={t("recordings.search")}
              className="h-8 rounded-lg border-border bg-card pl-8 text-xs shadow-sm placeholder:text-muted-foreground focus-visible:border-primary/50 focus-visible:ring-primary/15"
            />
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            className="h-8 gap-1.5 rounded-lg border-border bg-card text-xs text-muted-foreground shadow-sm hover:border-primary/30 hover:bg-accent hover:text-foreground"
          >
            <Filter className="size-3.5" />
            {t("recordings.filter")}
          </Button>
          <Button size="sm" className="h-8 gap-1.5 rounded-lg bg-primary text-xs text-primary-foreground shadow-sm hover:bg-primary/90">
            <Plus className="size-3.5" />
            {t("recordings.upload")}
          </Button>
        </div>
      </PageHeader>

      <main className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden px-6 py-12">
        <div className="relative flex w-full max-w-xl flex-col items-center text-center">
          <div className="relative mb-6 flex size-20 items-center justify-center rounded-[24px] border border-border bg-card text-primary shadow-sm">
            <Headphones className="size-9" strokeWidth={1.5} />
          </div>
          <h2 className="text-xl font-semibold tracking-tight text-foreground">
            {t("recordings.empty")}
          </h2>
          <p className="mt-2 max-w-sm text-sm leading-6 text-muted-foreground">
            {t("recordings.empty_hint")}
          </p>

          <div className="mt-7 grid w-full grid-cols-2 gap-3">
            <button
              type="button"
              className="group flex min-h-32 flex-col items-start justify-between rounded-xl border border-border bg-card p-4 text-left shadow-sm transition-[border-color,background-color,box-shadow] hover:border-primary/25 hover:bg-accent/50 hover:shadow-md"
            >
              <span className="flex size-10 items-center justify-center rounded-xl bg-primary/15 text-accent-brand-text ring-1 ring-inset ring-primary/20 transition-colors group-hover:bg-primary/20">
                <Plus className="size-[18px]" />
              </span>
              <span>
                <span className="block text-[13px] font-medium text-foreground">
                  {t("recordings.upload_btn")}
                </span>
                <span className="mt-1 block text-xs leading-5 text-muted-foreground">
                  {t("recordings.supported")}
                </span>
              </span>
            </button>

            <button
              type="button"
              className="group flex min-h-32 flex-col items-start justify-between rounded-xl border border-border bg-card p-4 text-left shadow-sm transition-[border-color,background-color,box-shadow] hover:border-primary/25 hover:bg-accent/50 hover:shadow-md"
            >
              <span className="flex size-10 items-center justify-center rounded-xl bg-white/[0.06] text-muted-foreground ring-1 ring-inset ring-white/[0.08] transition-colors group-hover:bg-primary/15 group-hover:text-accent-brand-text">
                <Headphones className="size-[18px]" />
              </span>
              <span>
                <span className="block text-[13px] font-medium text-foreground">
                  {t("recordings.title")}
                </span>
                <span className="mt-1 block text-xs leading-5 text-muted-foreground">
                  {t("recordings.empty_hint")}
                </span>
              </span>
            </button>
          </div>
        </div>
      </main>
    </div>
  );
}
