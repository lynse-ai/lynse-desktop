"use client";

import { PageHeader } from "../layout/page-header";
import { CalendarDays, Plus } from "../icons";
import { Button } from "@lynse/ui/components/ui/button";
import { useTranslation } from "@lynse/core/i18n/react";

export function MeetingsPage() {
  const { t } = useTranslation();

  return (
    <div className="flex h-full flex-col">
      <PageHeader>
        <div className="flex flex-1 items-center gap-3">
          <h1 className="text-sm font-semibold">{t("meetings.title")}</h1>
        </div>
        <Button size="sm" className="h-7 gap-1.5 text-xs">
          <Plus className="size-3" />
          {t("meetings.new")}
        </Button>
      </PageHeader>

      <div className="flex flex-1 items-center justify-center">
        <div className="text-center">
          <div className="mx-auto mb-4 flex size-12 items-center justify-center rounded-full bg-muted">
            <CalendarDays className="size-5 text-muted-foreground" />
          </div>
          <h3 className="text-sm font-medium">{t("meetings.empty")}</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            {t("meetings.empty_hint")}
          </p>
        </div>
      </div>
    </div>
  );
}
