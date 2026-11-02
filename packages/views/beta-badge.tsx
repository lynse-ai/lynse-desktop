"use client";

import { useSyncExternalStore } from "react";
import { Badge } from "@lynse/ui/components/ui/badge";
import { useTranslation } from "@lynse/core/i18n/react";
import { cn } from "@lynse/ui/lib/utils";
import { isBetaFeaturesUnlocked } from "./feature-flags";

function subscribeTestMode(changed: () => void) {
  window.addEventListener("lynse-test-mode-changed", changed);
  return () => window.removeEventListener("lynse-test-mode-changed", changed);
}

/**
 * Small "Beta" chip for work-in-progress features. Follows the beta gate
 * (`isBetaFeaturesUnlocked()` in feature-flags.ts): debug-channel builds, dev
 * shells and runtime test mode (login-logo 5-tap) show it; official builds
 * hide it so shipped UI never wears a Beta label. Re-renders when runtime
 * test mode flips — the build channel itself is fixed at startup.
 */
export function BetaBadge({ className }: { className?: string }) {
  const { t } = useTranslation();
  useSyncExternalStore(subscribeTestMode, isBetaFeaturesUnlocked, () => false);
  if (!isBetaFeaturesUnlocked()) return null;
  return (
    <Badge
      variant="secondary"
      className={cn("h-4 shrink-0 px-1.5 text-2xs font-normal text-muted-foreground", className)}
    >
      {t("settings.beta_badge")}
    </Badge>
  );
}
