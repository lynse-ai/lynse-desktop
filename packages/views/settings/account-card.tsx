"use client";

import { useTranslation } from "@lynse/core/i18n/react";
import { useAuthStore } from "@lynse/core/auth";
import { Card, CardContent, CardHeader, CardTitle } from "@lynse/ui/components/ui/card";
import { cn } from "@lynse/ui/lib/utils";
import { Crown, UserCircle, Zap, Clock } from "../icons";
import { useMembership, useUserCredits, type MembershipQuota } from "../layout/use-user-credits";
import { useLocalizedPlan } from "../layout/user-profile-dropdown";

/** Renders minutes as "90 分钟" under two hours, hours above — quotas quoted in
 * raw minutes get unreadable once a monthly plan grants thousands. */
function useDurationText() {
  const { t } = useTranslation();
  return (minutes: number) => {
    if (minutes >= 120) return t("settings.account_hours_short", { n: Math.round((minutes / 60) * 10) / 10 });
    return t("settings.account_minutes_short", { n: Math.round(minutes) });
  };
}

/** "2026-09-12 00:00:00" / ISO → localized date, or the raw string when
 * unparseable (the backend owns the format and may change it). */
function formatExpiry(raw: string | undefined): string | null {
  if (!raw) return null;
  const date = new Date(raw.replace(" ", "T"));
  if (Number.isNaN(date.getTime())) return raw;
  return date.toLocaleDateString();
}

/** Small label/value quota row with an optional usage bar. */
function QuotaRow({
  icon: Icon,
  label,
  value,
  fraction,
  className,
}: {
  icon: typeof Zap;
  label: string;
  value: string;
  fraction: number | null;
  className?: string;
}) {
  return (
    <div className={cn("space-y-1.5", className)}>
      <div className="flex items-center justify-between gap-3">
        <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Icon className="size-3.5 shrink-0" />
          {label}
        </span>
        <span className="text-xs font-medium tabular-nums">{value}</span>
      </div>
      {fraction !== null && (
        <div className="h-1 overflow-hidden rounded-full bg-muted">
          <div
            className="h-full rounded-full bg-primary transition-[width]"
            style={{ width: `${Math.min(100, Math.max(2, Math.round(fraction * 100)))}%` }}
          />
        </div>
      )}
    </div>
  );
}

/**
 * Account summary for the settings "Account & Storage" page: identity
 * (nickname + masked phone), the localized membership plan with its expiry,
 * remaining credits and remaining transcription minutes. Reads the same
 * backend queries as the profile dropdown, so both stay in sync via the
 * TanStack Query cache.
 */
export function AccountCard() {
  const { t } = useTranslation();
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const { data: credits } = useUserCredits();
  const { data: membership } = useMembership();
  const durationText = useDurationText();
  const plan = useLocalizedPlan(membership?.memberLevel || credits?.benefitType);

  if (!isAuthenticated || !credits) {
    return (
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-xs">{t("settings.account_title")}</CardTitle>
        </CardHeader>
        <CardContent className="flex items-center gap-2.5">
          <UserCircle className="size-8 text-muted-foreground/50" />
          <p className="text-xs text-muted-foreground">{t("settings.account_not_logged_in")}</p>
        </CardContent>
      </Card>
    );
  }

  const nickname = (credits.nickname as string) || "User";
  const expiry = formatExpiry(membership?.purchaseExpireTime ?? membership?.cycleEndTime);

  // Phone: keep the prefix and last four digits, mask the rest.
  const phone = typeof credits.phone === "string" ? credits.phone : "";
  const maskedPhone = phone.length >= 7
    ? `${phone.slice(0, 3)}****${phone.slice(-4)}`
    : phone;

  const pointsTotal = credits.pointsAmount ?? 0;
  const pointsRemaining = Math.max(0, pointsTotal - (credits.usedPointsAmount ?? 0));

  const minutes = membershipQuotaRows(membership);
  const minutesTotal = minutes?.total ?? null;
  const minutesRemaining = minutes?.remaining ?? 0;
  const minutesUnlimited = minutes?.unlimited === true;

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-xs">{t("settings.account_title")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex items-center gap-2.5">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary/15 text-sm font-medium text-accent-brand-text ring-1 ring-inset ring-primary/20">
            {nickname.slice(0, 2).toUpperCase()}
          </div>
          <div className="min-w-0">
            <p className="truncate text-sm font-medium leading-tight">{nickname}</p>
            {maskedPhone && (
              <p className="truncate text-2xs text-muted-foreground">{maskedPhone}</p>
            )}
          </div>
        </div>

        <QuotaRow
          icon={Crown}
          label={t("settings.account_plan")}
          value={expiry ? t("settings.account_plan_expires", { date: expiry, plan }) : plan}
          fraction={null}
        />

        <QuotaRow
          icon={Zap}
          label={t("layout.credits_label")}
          value={t("settings.account_credits_quota", { remaining: pointsRemaining, total: pointsTotal })}
          fraction={pointsTotal > 0 ? pointsRemaining / pointsTotal : null}
        />

        {minutesTotal !== null && (
          <QuotaRow
            icon={Clock}
            label={t("settings.account_minutes")}
            value={
              minutesUnlimited
                ? `${durationText(minutesRemaining)} · ${t("settings.account_minutes_unlimited")}`
                : `${durationText(minutesRemaining)} / ${durationText(minutesTotal ?? 0)}`
            }
            fraction={minutesTotal > 0 ? minutesRemaining / minutesTotal : null}
          />
        )}
      </CardContent>
    </Card>
  );
}

/** Normalizes the membership quota payload into remaining/total minutes, or
 * nulls when the backend has no minute quota for this account. */
function membershipQuotaRows(membership: MembershipQuota | undefined): {
  remaining: number;
  total: number | null;
  unlimited: boolean;
} | null {
  if (!membership) return null;
  const remaining = membership.allRemainingMinutes ?? membership.remainingMinutes;
  if (typeof remaining !== "number") return null;
  const total = membership.totalMinutes;
  return {
    remaining,
    total: typeof total === "number" ? total : null,
    unlimited: membership.unlimited === true,
  };
}
