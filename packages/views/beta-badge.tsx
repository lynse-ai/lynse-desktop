"use client";

import { Badge } from "@lynse/ui/components/ui/badge";
import { useTranslation } from "@lynse/core/i18n/react";

/**
 * Small "Beta" chip for work-in-progress features gated by
 * `isBetaFeaturesUnlocked()` (see feature-flags.ts). Shown wherever a Beta
 * surface is visible — debug-channel builds, dev shells, or test mode.
 */
export function BetaBadge({ className }: { className?: string }) {
  const { t } = useTranslation();
  return (
    <Badge
      variant="secondary"
      className={
        "h-4 shrink-0 px-1.5 text-2xs font-normal text-muted-foreground" +
        (className ? ` ${className}` : "")
      }
    >
      {t("settings.beta_badge")}
    </Badge>
  );
}
