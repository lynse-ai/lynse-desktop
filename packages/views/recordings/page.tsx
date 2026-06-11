"use client";

import { PageHeader } from "../layout/page-header";
import { Headphones, Plus, Search, Filter } from "../icons";
import { Button } from "@lynse/ui/components/ui/button";
import { Input } from "@lynse/ui/components/ui/input";
import { useTranslation } from "@lynse/core/i18n/react";

export function RecordingsPage() {
  const { t } = useTranslation();

  return (
    <div className="flex h-full flex-col">
      <PageHeader>
        <div className="flex flex-1 items-center gap-3">
          <h1 className="text-sm font-semibold">{t("recordings.title")}</h1>
          <div className="relative max-w-xs flex-1">
            <Search className="absolute left-2.5 top-2.5 size-3.5 text-muted-foreground" />
            <Input
              placeholder={t("recordings.search")}
              className="h-8 pl-8 text-xs"
            />
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" className="h-7 gap-1.5 text-xs">
            <Filter className="size-3" />
            {t("recordings.filter")}
          </Button>
          <Button size="sm" className="h-7 gap-1.5 text-xs">
            <Plus className="size-3" />
            {t("recordings.upload")}
          </Button>
        </div>
      </PageHeader>

      <div className="flex flex-1 items-center justify-center">
        <div className="text-center">
          <div className="mx-auto mb-4 flex size-12 items-center justify-center rounded-full bg-muted">
            <Headphones className="size-5 text-muted-foreground" />
          </div>
          <h3 className="text-sm font-medium">{t("recordings.empty")}</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            {t("recordings.empty_hint")}
          </p>
          <Button size="sm" className="mt-4 h-8 gap-1.5 text-xs">
            <Plus className="size-3" />
            {t("recordings.upload_btn")}
          </Button>
        </div>
      </div>
    </div>
  );
}
