"use client";

import { Lightbulb } from "../icons";
import { useTranslation } from "@lynse/core/i18n/react";

export function InspirationPage() {
  const { t } = useTranslation();
  return (
    <div className="flex h-full flex-col items-center justify-center text-center">
      <div className="mx-auto mb-4 flex size-12 items-center justify-center rounded-full bg-muted">
        <Lightbulb className="size-5 text-muted-foreground" />
      </div>
      <h3 className="text-sm font-medium text-foreground">{t("inspiration.title")}</h3>
      <p className="mt-1 max-w-xs text-xs text-muted-foreground">{t("inspiration.empty_hint")}</p>
    </div>
  );
}
