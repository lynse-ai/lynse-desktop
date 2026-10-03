"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@lynse/ui/components/ui/card";
import { useTranslation } from "@lynse/core/i18n/react";
import { useAuthStore } from "@lynse/core/auth";
import type { IntegrationsProvider } from "@lynse/core/integrations";
import { ProviderRow, type ProviderKind } from "./provider-row";
import { ReminderSettingsCard } from "./reminder-settings-card";

/**
 * The Connections section host (PRD §4).
 *
 * Group order matches Pocket: Import / Calendar / Sync / Task / External AI.
 * P0 ships Calendar, Sync and Task only — Import is P2 (memory import + user
 * profile) and External AI is P3 (MCP), so their groups are not rendered at all
 * rather than shown as dead rows: a visible "coming soon" affordance invites
 * clicks that can only fail.
 */

interface ProviderSpec {
  provider: IntegrationsProvider;
  kind: ProviderKind;
  supportsAutoExport?: boolean;
}

const CALENDAR_PROVIDERS: ProviderSpec[] = [
  { provider: "google-calendar", kind: "calendar" },
  // Registered but not deployed server-side yet: the backend answers 503
  // `not_configured`, which the row renders as its own copy. Kept visible so
  // the gap is explicit rather than looking like a missing feature.
  { provider: "outlook-calendar", kind: "calendar" },
];

const SYNC_PROVIDERS: ProviderSpec[] = [{ provider: "notion", kind: "destination" }];

const TASK_PROVIDERS: ProviderSpec[] = [
  { provider: "todoist", kind: "destination", supportsAutoExport: true },
  { provider: "google-tasks", kind: "destination", supportsAutoExport: true },
];

export function ConnectionsCard() {
  const { t } = useTranslation();
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);

  return (
    <Card className="gap-0 overflow-hidden p-0">
      <CardHeader className="px-4 py-3">
        <CardTitle className="text-sm">{t("connections.title")}</CardTitle>
        <p className="text-2xs text-muted-foreground">{t("connections.subtitle")}</p>
      </CardHeader>
      <CardContent className="space-y-5 px-4 pb-4">
        <ReminderSettingsCard />
        <Group titleKey="connections.group_calendar" specs={CALENDAR_PROVIDERS} isAuthenticated={isAuthenticated} />
        <Group titleKey="connections.group_sync" specs={SYNC_PROVIDERS} isAuthenticated={isAuthenticated} />
        <Group titleKey="connections.group_task" specs={TASK_PROVIDERS} isAuthenticated={isAuthenticated} />
      </CardContent>
    </Card>
  );
}

function Group({
  titleKey,
  specs,
  isAuthenticated,
}: {
  titleKey: string;
  specs: ProviderSpec[];
  isAuthenticated: boolean;
}) {
  const { t } = useTranslation();
  return (
    <section className="space-y-2">
      <h4 className="text-2xs font-medium uppercase tracking-wide text-muted-foreground">
        {t(titleKey)}
      </h4>
      {specs.map((spec) => (
        <ProviderRow
          key={spec.provider}
          provider={spec.provider}
          kind={spec.kind}
          supportsAutoExport={spec.supportsAutoExport ?? false}
          isAuthenticated={isAuthenticated}
        />
      ))}
    </section>
  );
}
