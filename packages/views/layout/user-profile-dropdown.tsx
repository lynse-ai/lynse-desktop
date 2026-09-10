"use client";

import { useRef, useState, type ReactElement } from "react";
import { cn } from "@lynse/ui/lib/utils";
import { Input } from "@lynse/ui/components/ui/input";
import { useTranslation, changeLanguage } from "@lynse/core/i18n/react";
import { useAuthStore } from "@lynse/core/auth";
import { useTheme } from "@lynse/ui/components/common/theme-provider";
import { useAppUpdate, getAppInfoSync, openAppUpdateDialog } from "../app-update";
import { openReportProblemDialog } from "../diagnostics";
import { useUserCredits, useMembership, useUpdateNickname } from "./use-user-credits";
import { UserActivityHeatmap } from "./user-activity-heatmap";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@lynse/ui/components/ui/dropdown-menu";
import {
  Check,
  Settings,
  Palette,
  Globe,
  HelpCircle,
  Zap,
  LogOut,
  UserCircle,
  Info,
  ArrowUp,
  Download,
  Pencil,
} from "../icons";

/* ── Map API memberLevel to localized plan name ────────────── */
function useLocalizedPlan(rawLevel?: string) {
  const { t } = useTranslation();
  if (!rawLevel) return t("layout.default_plan");
  const key = rawLevel.toLowerCase();
  if (key === "elite") return t("layout.plan_elite");
  if (key === "advanced" || key === "premium") return t("layout.plan_advanced");
  if (key === "standard" || key === "basic") return t("layout.plan_standard");
  if (key === "free" || key === "trial") return t("layout.plan_free");
  // Unknown tier — return as-is
  return rawLevel;
}

/* ── Language item with active checkmark ─────────────── */
function LanguageItem({ code, label }: { code: string; label: string }) {
  const { i18n } = useTranslation();
  const isActive = i18n.language === code;

  return (
    <DropdownMenuItem onClick={() => changeLanguage(code)}>
      {isActive ? (
        <Check className="size-3 text-success" />
      ) : (
        <span className="w-3" />
      )}
      <span className={cn(!isActive && "text-muted-foreground")}>{label}</span>
    </DropdownMenuItem>
  );
}

/* ── User profile dropdown ───────────────────────────────
 * Renders the avatar as a DropdownMenu trigger. Pass a custom `trigger`
 * node (e.g. a compact circular avatar for the narrow rail) to override the
 * default wide row-style avatar. `side` controls where the menu opens. */
export function UserProfileDropdown({
  onOpenSettings,
  trigger,
  side = "top",
}: {
  onOpenSettings: () => void;
  trigger?: ReactElement;
  side?: "top" | "bottom" | "right";
}) {
  const { t } = useTranslation();
  const logout = useAuthStore((s) => s.logout);
  const { data } = useUserCredits();
  const { data: membership } = useMembership();
  const { theme, setTheme } = useTheme();
  const { update, checking } = useAppUpdate();
  const updateNickname = useUpdateNickname();

  const nickname = (data?.nickname as string) || "User";
  const plan = useLocalizedPlan(membership?.memberLevel || data?.benefitType);
  const initials = nickname.slice(0, 2).toUpperCase();

  // Remaining credits = total granted minus consumed (customer/current).
  // Null while logged out / loading — the row then shows the plan only.
  const pointsRemaining = data
    ? Math.max(0, (data.pointsAmount ?? 0) - (data.usedPointsAmount ?? 0))
    : null;

  // Version for the About row + the upgrade badge. Prefer the version the host
  // bridge injected at startup; fall back to the latest check's currentVersion.
  const hasUpdate = Boolean(update?.hasUpdate);
  const aboutVersion =
    getAppInfoSync()?.version ?? update?.currentVersion ?? null;
  const versionLabel = aboutVersion ? `v${aboutVersion}` : "—";

  // `open` drives the menu; `hasOpened` latches on the first open and gates the
  // heatmap's queries. Latching (rather than tracking `open` directly) keeps the
  // data alive during the menu's close animation instead of flashing back to 0.
  const [open, setOpen] = useState(false);
  const [hasOpened, setHasOpened] = useState(false);

  // Inline nickname editing: the pencil swaps the name for an input; Enter or
  // blur commits, Escape cancels. `cancelRef` keeps the blur fired by Escape
  // (or by unmount) from committing the stale draft.
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(nickname);
  const cancelRef = useRef(false);

  const handleOpenChange = (next: boolean) => {
    setOpen(next);
    if (next) setHasOpened(true);
  };

  const startEditName = () => {
    cancelRef.current = false;
    setDraft(nickname);
    setEditing(true);
  };

  const commitNickname = () => {
    if (cancelRef.current) return;
    const next = draft.trim();
    if (!next || next === nickname) {
      setEditing(false);
      return;
    }
    // On failure the input stays open so the user can retry.
    updateNickname.mutate(next, { onSuccess: () => setEditing(false) });
  };

  const cancelEditName = () => {
    cancelRef.current = true;
    setEditing(false);
  };

  return (
    <DropdownMenu open={open} onOpenChange={handleOpenChange}>
      <DropdownMenuTrigger
        render={
          trigger ?? (
            <button className="flex w-full items-center gap-2.5 rounded-lg px-2 py-2 transition-colors hover:bg-accent">
              <div className="relative shrink-0">
                <div className="flex size-7 items-center justify-center rounded-full bg-primary/15 text-xs font-medium text-accent-brand-text ring-1 ring-inset ring-primary/20">
                  {initials}
                </div>
                {hasUpdate && (
                  <span className="absolute -right-1 -top-1 flex size-3.5 items-center justify-center rounded-full bg-success text-white ring-2 ring-background">
                    <ArrowUp className="size-2.5" strokeWidth={3} />
                  </span>
                )}
              </div>
              <div className="min-w-0 flex-1 text-left">
                <p className="truncate text-13 font-medium leading-tight">{nickname}</p>
                <p className="truncate text-2xs text-muted-foreground/70">{plan}</p>
              </div>
            </button>
          )
        }
      />
      <DropdownMenuContent align="start" side={side} sideOffset={4} className="w-72 overflow-y-auto p-0">
        {/* ── Header: User name + inline edit ───────────── */}
        <div className="px-4 pt-4 pb-3">
          {editing ? (
            <Input
              autoFocus
              value={draft}
              disabled={updateNickname.isPending}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={commitNickname}
              onKeyDown={(e) => {
                if (e.key === "Enter") commitNickname();
                if (e.key === "Escape") cancelEditName();
              }}
              className="h-7 text-base font-semibold tracking-tight"
            />
          ) : (
            <div className="flex items-center gap-2">
              <span className="text-base font-semibold tracking-tight">{nickname}</span>
              <button
                onClick={startEditName}
                className="flex size-5 shrink-0 items-center justify-center rounded-md text-muted-foreground/50 transition-colors hover:bg-black/[0.05] hover:text-foreground"
                title={t("layout.edit_name")}
              >
                <Pencil className="size-3" />
              </button>
            </div>
          )}
        </div>

        {/* ── Plan / membership row ─────────────────────── */}
        <div className="flex items-center justify-between px-4 pb-3">
          <div className="flex items-center gap-2">
            <UserCircle className="size-4 text-muted-foreground" />
            <span className="text-sm">{plan}</span>
          </div>
          {pointsRemaining !== null && (
            <span
              className="flex items-center gap-1 text-2xs tabular-nums text-muted-foreground"
              title={t("layout.credits")}
            >
              <Zap className="size-3 text-warning" />
              {pointsRemaining}
            </span>
          )}
        </div>

        {/* ── Notes activity heatmap ─────────────────────
            Plain block (not a DropdownMenuItem) so it never steals
            keyboard focus from the menu navigation. */}
        <UserActivityHeatmap enabled={hasOpened} />

        <DropdownMenuSeparator />

        {/* ── Settings ─────────────────────────────────── */}
        <DropdownMenuItem onClick={onOpenSettings}>
          <Settings className="size-4 text-muted-foreground" strokeWidth={1.5} />
          <span>{t("layout.user_settings")}</span>
        </DropdownMenuItem>

        {/* ── Appearance: inline light/dark toggle ──────── */}
        <div className="flex items-center gap-2 px-2 py-1.5">
          <Palette className="size-4 shrink-0 text-muted-foreground" strokeWidth={1.5} />
          <span className="text-sm">{t("layout.user_appearance")}</span>
          <div className="ml-auto flex items-center gap-0.5 rounded-lg border bg-muted/60 p-0.5">
            <button
              onClick={() => setTheme("light")}
              className={cn(
                "rounded-md px-2.5 py-0.5 text-xs font-medium transition-colors",
                theme === "light"
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {t("layout.theme_light")}
            </button>
            <button
              onClick={() => setTheme("dark")}
              className={cn(
                "rounded-md px-2.5 py-0.5 text-xs font-medium transition-colors",
                theme === "dark"
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {t("layout.theme_dark")}
            </button>
          </div>
        </div>

        {/* ── Language submenu ─────────────────────────── */}
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            <Globe className="size-4 text-muted-foreground" strokeWidth={1.5} />
            <span>{t("layout.language")}</span>
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            <LanguageItem code="en" label={t("layout.lang_en")} />
            <LanguageItem code="zh-Hans" label={t("layout.lang_zh")} />
            <LanguageItem code="zh-Hant" label={t("layout.lang_zh_hant")} />
            <LanguageItem code="ja" label={t("layout.lang_ja")} />
            <LanguageItem code="ko" label={t("layout.lang_ko")} />
          </DropdownMenuSubContent>
        </DropdownMenuSub>

        {/* ── Help & Feedback ─────────────────────────── */}
        <DropdownMenuItem onClick={openReportProblemDialog}>
          <HelpCircle className="size-4 text-muted-foreground" strokeWidth={1.5} />
          <span>{t("layout.user_help_feedback")}</span>
        </DropdownMenuItem>

        {/* ── About (version) ─────────────────────────── */}
        <DropdownMenuItem onClick={onOpenSettings}>
          <Info className="size-4 text-muted-foreground" strokeWidth={1.5} />
          <span>{t("layout.about")}</span>
          <span className="ml-auto flex items-center gap-1 text-2xs tabular-nums text-muted-foreground">
            {hasUpdate && (
              <ArrowUp className="size-3 text-success" strokeWidth={2.5} />
            )}
            {versionLabel}
          </span>
        </DropdownMenuItem>

        {/* ── Update ─────────────────────────────────────
            Opens the update dialog directly — one click from here to a
            confirmed install, no detour through Settings → About. */}
        <DropdownMenuItem
          onClick={() => openAppUpdateDialog({ refresh: true })}
          disabled={checking}
        >
          {hasUpdate ? (
            <ArrowUp className="size-4 text-success" strokeWidth={2.5} />
          ) : (
            <Download className="size-4 text-muted-foreground" strokeWidth={1.5} />
          )}
          <span>
            {hasUpdate
              ? t("settings.install_update")
              : checking
                ? t("layout.checking_update")
                : t("layout.check_update")}
          </span>
          {hasUpdate && (
            <span className="ml-auto text-2xs tabular-nums text-muted-foreground">
              v{update?.latestVersion}
            </span>
          )}
        </DropdownMenuItem>

        <DropdownMenuSeparator />

        {/* ── Log out ─────────────────────────────────── */}
        <DropdownMenuItem variant="destructive" onClick={() => logout()}>
          <LogOut className="size-4 text-muted-foreground" strokeWidth={1.5} />
          <span>{t("layout.log_out")}</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
