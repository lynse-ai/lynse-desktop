import { useTranslation } from "@lynse/core/i18n/react";

export function Loading() {
  const { t } = useTranslation();
  return (
    <div role="status" className="grid flex-1 place-items-center bg-background text-sm text-muted-foreground">
      <span>{t("workspace.loading")}</span>
    </div>
  );
}
