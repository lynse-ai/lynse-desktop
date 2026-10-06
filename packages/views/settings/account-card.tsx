"use client";

import { useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "@lynse/core/i18n/react";
import { useAuthStore } from "@lynse/core/auth";
import { Card, CardContent, CardHeader, CardTitle } from "@lynse/ui/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@lynse/ui/components/ui/dialog";
import { cn } from "@lynse/ui/lib/utils";
import { UserCircle, Zap, Clock } from "../icons";
import { useMembership, useUserCredits, usePointsLedger, type MembershipQuota, type PointsLogEntry } from "../layout/use-user-credits";
import { useLocalizedPlan } from "../layout/user-profile-dropdown";
import { memberBadgeSrc } from "./member-badges";

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

/** Flips one frame after mount so quota bars transition up from empty — the
 * card reads as filling in when the settings page opens. */
function useBarReveal() {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    let raf2 = 0;
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => setArmed(true));
    });
    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
    };
  }, []);
  return armed;
}

/** Bar tone tracks how much of the quota is left: brand while healthy,
 * warning under 20%, destructive once it is essentially spent. */
function usageTone(fraction: number): "brand" | "warning" | "destructive" {
  if (fraction <= 0.05) return "destructive";
  if (fraction <= 0.2) return "warning";
  return "brand";
}

const toneFillClass = {
  brand: "bg-gradient-to-r from-brand/55 to-brand",
  warning: "bg-warning",
  destructive: "bg-destructive",
} as const;

/** Usage quota row: tinted icon chip, the remaining figure emphasized with
 * the quota total de-emphasized beside it, and a bar that fills on mount.
 * `labelExtra` renders fine content right after the label (the points-history
 * entry point); `extra` renders colored chips between the emphasized figure
 * and the total (monthly gifts, booster balance) in consumption order. */
function QuotaRow({
  icon: Icon,
  label,
  labelExtra,
  emphasized,
  extra,
  suffix,
  fraction,
  className,
}: {
  icon: typeof Zap;
  label: string;
  labelExtra?: ReactNode;
  emphasized: ReactNode;
  extra?: ReactNode;
  suffix?: ReactNode;
  fraction: number | null;
  className?: string;
}) {
  const armed = useBarReveal();
  const pct = fraction === null ? null : Math.min(100, Math.max(2, Math.round(fraction * 100)));
  return (
    <div className={cn("space-y-2", className)}>
      <div className="flex items-center justify-between gap-3">
        <span className="flex items-center gap-2 text-xs text-muted-foreground">
          <span className="flex size-5 shrink-0 items-center justify-center rounded-[6px] bg-accent-brand text-accent-brand-text">
            <Icon className="size-3" />
          </span>
          {label}
          {labelExtra}
        </span>
        <span className="flex items-baseline gap-1.5 text-13 font-semibold tabular-nums">
          {emphasized}
          {extra}
          {suffix && (
            <span className="font-normal text-muted-foreground">{suffix}</span>
          )}
        </span>
      </div>
      {pct !== null && (
        <div
          role="progressbar"
          aria-label={label}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={pct}
          className="h-1.5 overflow-hidden rounded-full bg-muted ring-1 ring-inset ring-foreground/[0.04]"
        >
          <div
            className={cn(
              "h-full rounded-full transition-[width] duration-[var(--duration-moderate)] ease-out motion-reduce:transition-none",
              toneFillClass[usageTone(fraction ?? 0)]
            )}
            style={{ width: armed ? `${pct}%` : "0%" }}
          />
        </div>
      )}
    </div>
  );
}

/** Direction of one points-log row. The server's operationType ("+"/"-") is
 *  authoritative; changeType is the fallback for legacy rows lacking it. */
function pointsChangeSign(entry: PointsLogEntry): string {
  if (entry.operationType === "+") return "+";
  if (entry.operationType === "-") return "−";
  if (entry.changeType === 1) return "−";
  if (entry.changeType === 3) return "";
  return "+";
}

/** One recent-points-transaction row: type label (+ free-text detail, e.g.
 *  the booster-pack name on purchases), then signed amount and the date. */
function PointsLogRow({ entry }: { entry: PointsLogEntry }) {
  const { t } = useTranslation();
  const changeType = typeof entry.changeType === "number" ? entry.changeType : -1;
  const label =
    changeType >= 0 && changeType <= 7
      ? t(`layout.points_change_${changeType}`)
      : t("layout.points_change_unknown");
  const amount = typeof entry.pointsAmount === "number" ? entry.pointsAmount : Number(entry.pointsAmount) || 0;
  const time = typeof entry.createTime === "string" ? entry.createTime.slice(5, 16) : "";
  const detail = typeof entry.pointsDetails === "string" ? entry.pointsDetails : "";

  return (
    <div className="flex items-center justify-between gap-2 text-2xs">
      <span className="min-w-0 truncate text-muted-foreground">
        {label}
        {detail && <span className="text-muted-foreground/60"> · {detail}</span>}
      </span>
      <span className="flex shrink-0 items-center gap-1.5 tabular-nums">
        <span className={cn(pointsChangeSign(entry) === "−" ? "text-destructive/80" : "text-primary/80")}>
          {pointsChangeSign(entry)}
          {Math.abs(amount).toLocaleString()}
        </span>
        <span className="text-muted-foreground/60">{time}</span>
      </span>
    </div>
  );
}

/**
 * Account summary for the settings "Account & Storage" page: identity
 * (nickname + masked phone, with the tier medallion beside paid nicknames),
 * the localized plan carried in the badge tooltip, remaining credits and
 * remaining transcription minutes. Reads the same backend queries as the
 * profile dropdown, so both stay in sync via the TanStack Query cache.
 */
export function AccountCard() {
  const { t } = useTranslation();
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const { data: credits } = useUserCredits();
  const { data: membership } = useMembership();
  const { data: ledger } = usePointsLedger();
  const [historyOpen, setHistoryOpen] = useState(false);
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

  // Tier medallion beside the nickname for paid tiers; free/trial stay
  // unbadged (memberBadgeSrc nulls unrecognized levels too).
  const badgeSrc = memberBadgeSrc(membership?.memberLevel || credits?.benefitType);

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
      <CardContent className="space-y-4">
        <div className="flex items-center gap-3">
          <div className="flex size-10 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-primary/25 via-primary/15 to-primary/5 text-sm font-semibold text-accent-brand-text ring-1 ring-inset ring-primary/25">
            {nickname.slice(0, 2).toUpperCase()}
          </div>
          <div className="min-w-0">
            <p className="flex items-center gap-1.5 text-sm font-semibold leading-tight">
              <span className="min-w-0 truncate">{nickname}</span>
              {badgeSrc && (
                <img
                  src={badgeSrc}
                  alt={plan}
                  draggable={false}
                  title={expiry ? t("settings.account_plan_expires", { plan, date: expiry }) : plan}
                  className="size-5 shrink-0"
                />
              )}
            </p>
            {maskedPhone && (
              <p className="truncate text-2xs text-muted-foreground">{maskedPhone}</p>
            )}
          </div>
        </div>

        <QuotaRow
          icon={Zap}
          label={t("layout.credits_label")}
          labelExtra={
            ledger && ledger.recent.length > 0 ? (
              <button
                type="button"
                onClick={() => setHistoryOpen(true)}
                className="cursor-pointer text-2xs text-muted-foreground/70 underline decoration-dotted underline-offset-2 transition-colors hover:text-foreground"
              >
                {t("layout.points_history")}
              </button>
            ) : null
          }
          emphasized={<span className="text-warning">{pointsRemaining.toLocaleString()}</span>}
          extra={
            ledger && ledger.boosterRemaining !== null && ledger.boosterRemaining > 0 && (
              <span
                className="rounded-full bg-warning/15 px-1.5 py-0.5 text-2xs font-semibold text-warning"
                title={t("settings.account_booster_hint")}
              >
                +{ledger.boosterRemaining.toLocaleString()} {t("settings.account_booster")}
              </span>
            )
          }
          suffix={` / ${pointsTotal.toLocaleString()}`}
          fraction={pointsTotal > 0 ? pointsRemaining / pointsTotal : null}
        />

        {minutesTotal !== null && (
          <QuotaRow
            icon={Clock}
            label={t("settings.account_minutes")}
            emphasized={durationText(minutesRemaining)}
            suffix={
              minutesUnlimited
                ? ` · ${t("settings.account_minutes_unlimited")}`
                : ` / ${durationText(minutesTotal ?? 0)}`
            }
            fraction={minutesTotal > 0 ? minutesRemaining / minutesTotal : null}
          />
        )}
      </CardContent>

      {/* Secondary view: full points history, opened from the fine link on
          the credits label. Kept out of the card so the summary stays clean. */}
      <Dialog open={historyOpen} onOpenChange={setHistoryOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t("layout.points_history")}</DialogTitle>
            <DialogDescription>{t("settings.account_points_history_hint")}</DialogDescription>
          </DialogHeader>
          <div className="flex max-h-[50vh] flex-col gap-1.5 overflow-y-auto pr-1">
            {ledger?.recent.map((entry) => (
              <PointsLogRow key={entry.id ?? `${entry.createTime}-${entry.pointsAmount}`} entry={entry} />
            ))}
            {ledger && ledger.recent.length === 0 && (
              <p className="py-4 text-center text-xs text-muted-foreground">
                {t("settings.account_points_history_empty")}
              </p>
            )}
          </div>
        </DialogContent>
      </Dialog>
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
