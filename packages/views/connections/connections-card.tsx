"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@lynse/ui/components/ui/card";
import { useTranslation } from "@lynse/core/i18n/react";
import { useAuthStore } from "@lynse/core/auth";
import { LYNSE_EDITION, DEV_BUILD, type LynseEdition } from "@lynse/core/config";
import { ProviderRow } from "./provider-row";
import { FeishuRow } from "./feishu-row";
import { ReminderSettingsCard } from "./reminder-settings-card";

/**
 * The Connections section host (PRD §4), split by build edition:
 *   - `intl`: Pocket-style service groups (Calendar / Sync / Task) — overseas
 *     platforms authorize per service.
 *   - `cn`: one row per domestic platform — Feishu (and later WeCom/DingTalk)
 *     authorize once and cover every service, so the capabilities render
 *     inline on the platform row instead of scattering across the groups.
 * Dev builds render both sections (and may flip either view via the
 * `lynse_edition` localStorage override) so both stay testable on one machine.
 */

const CALENDAR_PROVIDERS = ["google-calendar", "outlook-calendar"] as const;
const SYNC_PROVIDERS = ["notion"] as const;
const TASK_PROVIDERS = ["todoist", "google-tasks"] as const;

function visibleEdition(): LynseEdition | "all" {
  if (DEV_BUILD && typeof window !== "undefined") {
    const override = window.localStorage.getItem("lynse_edition");
    if (override === "cn" || override === "intl") return override;
    return "all";
  }
  return LYNSE_EDITION;
}

export function ConnectionsCard() {
  const { t } = useTranslation();
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const edition = visibleEdition();
  const showIntl = edition !== "cn";
  const showCn = edition !== "intl";

  return (
    <Card className="gap-0 overflow-hidden p-0">
      <CardHeader className="px-4 py-3">
        <CardTitle className="text-sm">{t("connections.title")}</CardTitle>
        <p className="text-2xs text-muted-foreground">{t("connections.subtitle")}</p>
      </CardHeader>
      <CardContent className="space-y-5 px-4 pb-4">
        <ReminderSettingsCard />
        {showIntl && (
          <>
            <Group titleKey="connections.group_calendar" providers={CALENDAR_PROVIDERS} kind="calendar" isAuthenticated={isAuthenticated} />
            <Group titleKey="connections.group_sync" providers={SYNC_PROVIDERS} kind="destination" isAuthenticated={isAuthenticated} />
            <Group titleKey="connections.group_task" providers={TASK_PROVIDERS} kind="destination" supportsAutoExport isAuthenticated={isAuthenticated} />
          </>
        )}
        {showCn && (
          <section className="space-y-2">
            <h4 className="text-2xs font-medium uppercase tracking-wide text-muted-foreground">
              {t("connections.group_cn")}
            </h4>
            <FeishuRow isAuthenticated={isAuthenticated} />
          </section>
        )}
      </CardContent>
    </Card>
  );
}

function Group({
  titleKey,
  providers,
  kind,
  supportsAutoExport = false,
  isAuthenticated,
}: {
  titleKey: string;
  providers: readonly string[];
  kind: "calendar" | "destination";
  supportsAutoExport?: boolean;
  isAuthenticated: boolean;
}) {
  const { t } = useTranslation();
  return (
    <section className="space-y-2">
      <h4 className="text-2xs font-medium uppercase tracking-wide text-muted-foreground">
        {t(titleKey)}
      </h4>
      {providers.map((provider) => (
        <ProviderRow
          key={provider}
          provider={provider as Parameters<typeof ProviderRow>[0]["provider"]}
          kind={kind}
          supportsAutoExport={supportsAutoExport}
          isAuthenticated={isAuthenticated}
        />
      ))}
    </section>
  );
}
