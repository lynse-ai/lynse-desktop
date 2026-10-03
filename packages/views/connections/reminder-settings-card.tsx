"use client";

import { useState } from "react";
import { Label } from "@lynse/ui/components/ui/label";
import { Switch } from "@lynse/ui/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@lynse/ui/components/ui/select";
import { useTranslation } from "@lynse/core/i18n/react";
import {
  DEFAULT_REMINDER_LEAD_MINUTES,
  loadCalendarReminderConfig,
  saveCalendarReminderConfig,
  type CalendarReminderConfig,
} from "./calendar-reminder";

/** Lead-time choices, in minutes. 1 matches Pocket's default. */
const LEAD_OPTIONS = [1, 3, 5, 10, 15, 30] as const;

/**
 * Pre-meeting reminder settings (PRD FR-1's Notify switch, user-facing half).
 *
 * Persisted in localStorage and read synchronously by the banner, mirroring
 * `lynse_auto_record_config` rather than zustand — the reminder policy is not
 * server state, and the auto-record card already established this shape.
 */
export function ReminderSettingsCard() {
  const { t } = useTranslation();
  const [config, setConfig] = useState<CalendarReminderConfig>(() => loadCalendarReminderConfig());

  const update = (next: CalendarReminderConfig) => {
    setConfig(next);
    saveCalendarReminderConfig(next);
  };

  return (
    <div className="space-y-2 rounded-lg border border-border/60 bg-card/40 p-3">
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1">
          <Label className="text-13 font-medium">{t("connections.reminder_settings")}</Label>
          <p className="text-2xs text-muted-foreground">{t("connections.reminder_settings_hint")}</p>
        </div>
        <Switch
          checked={config.enabled}
          onCheckedChange={(checked) => update({ ...config, enabled: checked })}
          aria-label={t("connections.reminder_settings")}
        />
      </div>

      {config.enabled && (
        <div className="flex items-center gap-2">
          <Label className="shrink-0 text-2xs text-muted-foreground">
            {t("connections.reminder_lead")}
          </Label>
          <Select
            value={String(config.leadMinutes)}
            onValueChange={(value) =>
              update({ ...config, leadMinutes: Number(value) || DEFAULT_REMINDER_LEAD_MINUTES })
            }
          >
            <SelectTrigger className="h-7 w-28 text-2xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {LEAD_OPTIONS.map((minutes) => (
                <SelectItem key={minutes} value={String(minutes)}>
                  {t("connections.reminder_lead_minutes", { minutes })}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      <p className="text-2xs text-muted-foreground">{t("connections.reminder_in_app_only")}</p>
    </div>
  );
}
