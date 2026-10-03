"use client";

import { useMemo, useState } from "react";
import { Button } from "@lynse/ui/components/ui/button";
import { useTranslation } from "@lynse/core/i18n/react";
import { useAuthStore } from "@lynse/core/auth";
import { X } from "../icons";
import { useNavigation } from "../navigation";
import { featureFlags } from "../feature-flags";
import { useIntegrationStatus } from "./use-connect-flow";
import { useCalendarEvents } from "./use-connections";
import {
  findReminderDueEvents,
  loadCalendarReminderConfig,
  minutesUntilStart,
} from "./calendar-reminder";

/**
 * Pre-meeting reminder banner (PRD FR-1, P0 shape).
 *
 * In-app only on purpose: without `tauri-plugin-notification` a reminder can
 * not reach a backgrounded app, so the banner states that limit instead of
 * implying OS delivery. Mounted once by the dashboard shell.
 *
 * The window is re-read on `REMINDER_POLL_MS`, matching the app's other
 * background-ish polls; dismissed events stay dismissed until their start time
 * passes, so a user who ignores a meeting never sees it again.
 */
export function CalendarReminderBanner() {
  const { t } = useTranslation();
  const push = useNavigation().push;
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const config = useMemo(() => loadCalendarReminderConfig(), []);
  const [dismissed, setDismissed] = useState<Map<string, number>>(() => new Map());

  const status = useIntegrationStatus("google-calendar", isAuthenticated && featureFlags.connections);
  const now = Date.now();
  const window = useMemo(
    () => ({
      from: new Date(now - 60 * 60_000).toISOString(),
      to: new Date(now + (config.leadMinutes + 15) * 60_000).toISOString(),
    }),
    // Recomputed on each poll tick via `enabled`/staleTime, not every render.
    [now, config.leadMinutes],
  );
  // No polling at all while the feature is off — the banner renders nothing,
// so an unrequested query would just be traffic on every authenticated page.
  const events = useCalendarEvents(window, featureFlags.connections);

  const notifyAccounts = useMemo(
    () =>
      new Set(
        (status.data?.accounts ?? []).filter((account) => account.notify_enabled).map((a) => a.id),
      ),
    [status.data],
  );

  const due = useMemo(
    () =>
      findReminderDueEvents(events.data?.events ?? [], Date.now(), config, notifyAccounts).filter(
        (event) => (dismissed.get(event.id) ?? 0) < Date.parse(event.start_time),
      ),
    [events.data, config, dismissed, notifyAccounts],
  );

  const next = due[0];
  if (!featureFlags.connections || !next) return null;

  const minutes = minutesUntilStart(next, Date.now());

  return (
    <div className="pointer-events-auto absolute inset-x-0 bottom-4 z-40 flex justify-center px-4">
      <div className="flex max-w-lg items-center gap-3 rounded-xl border border-border/60 bg-card/95 px-3.5 py-2.5 shadow-lg backdrop-blur-xl">
        <div className="min-w-0 flex-1">
          <p className="truncate text-13 font-medium">
            {t("connections.reminder_title", { minutes, title: next.title })}
          </p>
          <p className="truncate text-2xs text-muted-foreground">
            {t("connections.reminder_in_app_only")}
          </p>
        </div>
        <Button
          type="button"
          size="sm"
          className="h-7 shrink-0 text-2xs"
          onClick={() => push("/recording")}
        >
          {t("connections.reminder_start")}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 w-7 shrink-0 p-0"
          aria-label={t("connections.reminder_dismiss")}
          onClick={() =>
            setDismissed((prev) => {
              const nextMap = new Map(prev);
              nextMap.set(next.id, Date.now());
              return nextMap;
            })
          }
        >
          <X className="size-3.5" />
        </Button>
      </div>
    </div>
  );
}
