"use client";

import { PageHeader } from "../layout/page-header";
import { FolderOpen } from "../icons";
import { useTranslation } from "@lynse/core/i18n/react";

export function FilesPage() {
  const { t } = useTranslation();

  return (
    <div className="flex h-full flex-col">
      <PageHeader>
        <h1 className="text-sm font-semibold">{t("files.title")}</h1>
      </PageHeader>
      <div className="flex flex-1 items-center justify-center">
        <div className="text-center">
          <div className="mx-auto mb-4 flex size-12 items-center justify-center rounded-full bg-muted">
            <FolderOpen className="size-5 text-muted-foreground" />
          </div>
          <h3 className="text-sm font-medium">{t("files.empty")}</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            {t("files.empty_hint")}
          </p>
        </div>
      </div>
    </div>
  );
}
