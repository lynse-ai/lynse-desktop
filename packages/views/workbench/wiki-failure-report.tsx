"use client";

import { useTranslation } from "@lynse/core/i18n/react";
import { Button } from "@lynse/ui/components/ui/button";
import { openReportProblem } from "../diagnostics";
import type { WikiValidationDetails } from "./types";

export function WikiFailureReport({ title, message, stage, occurredAt, validation }: {
  title: string; message: string; stage?: string; occurredAt?: string; validation?: WikiValidationDetails | null;
}) {
  const { t } = useTranslation();
  return <Button size="sm" variant="outline" onClick={() => openReportProblem([
    t("workbench.wiki_failure_report_title", { title }),
    `${t("workbench.wiki_failure_stage")}: ${stage ?? ""}`,
    `${t("workbench.wiki_failure_time")}: ${occurredAt ?? ""}`,
    message,
    validation ? JSON.stringify(validation, null, 2) : "",
  ].filter(Boolean).join("\n"))}>{t("workbench.wiki_failure_report")}</Button>;
}
