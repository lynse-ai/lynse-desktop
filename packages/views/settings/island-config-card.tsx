"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@lynse/ui/components/ui/card";
import { Label } from "@lynse/ui/components/ui/label";
import { Switch } from "@lynse/ui/components/ui/switch";
import { useTranslation } from "@lynse/core/i18n/react";
import { getDesktopLiveTranslationApi } from "../live-translation/desktop-api";
import { useIslandPreferences } from "./island-preferences";

/**
 * Settings card for the notch-attached recording island (macOS "Dynamic
 * Island"). Desktop builds only — the actual style is decided per island
 * build by the display-cutout detection, so non-notch setups keep the
 * floating pill regardless of this toggle.
 */
export function IslandConfigCard() {
  const { t } = useTranslation();
  const api = getDesktopLiveTranslationApi();
  const notchIslandEnabled = useIslandPreferences((state) => state.notchIslandEnabled);
  const setNotchIslandEnabled = useIslandPreferences((state) => state.setNotchIslandEnabled);

  // macOS only: Windows has its own taskbar-anchored island with no notch
  // concept, so the toggle would be a no-op there.
  const isMac = /Mac/i.test(navigator.platform || navigator.userAgent);
  if (!api || !isMac) return null;

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-xs">{t("settings.notch_island_title")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <Label htmlFor="notch-island-enable" className="text-xs">
            {t("settings.notch_island_enable")}
          </Label>
          <Switch
            id="notch-island-enable"
            checked={notchIslandEnabled}
            onCheckedChange={setNotchIslandEnabled}
            aria-describedby="notch-island-hint"
          />
        </div>
        <p id="notch-island-hint" className="text-2xs leading-relaxed text-muted-foreground">
          {t("settings.notch_island_hint")}
        </p>
      </CardContent>
    </Card>
  );
}
