"use client";

import { useState, type ReactElement } from "react";
import { cn } from "@lynse/ui/lib/utils";
import { useTranslation, changeLanguage } from "@lynse/core/i18n/react";
import { useTheme } from "@lynse/ui/components/common/theme-provider";
import { useAppUpdate } from "../app-update";
import { useUserCredits, useMembership } from "./use-user-credits";
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
  Copy,
  Settings,
  Palette,
  Globe,
  HelpCircle,
  Download,
  LogOut,
  UserCircle,
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
        <Check className="size-3 text-green-500" />
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
  const { data } = useUserCredits();
  const { data: membership } = useMembership();
  const { theme, setTheme } = useTheme();
  const { update, checking, checkForUpdate } = useAppUpdate();

  const nickname = (data?.nickname as string) || "User";
  const plan = useLocalizedPlan(membership?.memberLevel || data?.benefitType);
  const initials = nickname.slice(0, 2).toUpperCase();

  const [copied, setCopied] = useState(false);

  const handleCopyName = () => {
    void navigator.clipboard.writeText(nickname).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          trigger ?? (
            <button className="flex w-full items-center gap-2.5 rounded-lg px-2 py-2 transition-colors hover:bg-white/[0.06]">
              <div className="flex size-7 shrink-0 items-center justify-center rounded-full bg-primary/15 text-xs font-medium text-accent-brand-text ring-1 ring-inset ring-primary/20">
                {initials}
              </div>
              <div className="min-w-0 flex-1 text-left">
                <p className="truncate text-[13px] font-medium leading-tight">{nickname}</p>
                <p className="truncate text-[11px] text-muted-foreground/70">{plan}</p>
              </div>
            </button>
          )
        }
      />
      <DropdownMenuContent align="start" side={side} sideOffset={4} className="w-72 overflow-hidden p-0">
        {/* ── Header: User name + copy ──────────────────── */}
        <div className="px-4 pt-4 pb-3">
          <div className="flex items-center gap-2">
            <span className="text-base font-semibold tracking-tight">{nickname}</span>
            <button
              onClick={handleCopyName}
              className="flex size-5 shrink-0 items-center justify-center rounded-md text-muted-foreground/50 transition-colors hover:bg-black/[0.05] hover:text-foreground"
              title={copied ? t("layout.copied") : t("layout.copy_name")}
            >
              {copied ? (
                <Check className="size-3 text-green-500" />
              ) : (
                <Copy className="size-3" />
              )}
            </button>
          </div>
        </div>

        {/* ── Plan / membership row ─────────────────────── */}
        <div className="flex items-center justify-between px-4 pb-3">
          <div className="flex items-center gap-2">
            <UserCircle className="size-4 text-muted-foreground" />
            <span className="text-sm">{plan}</span>
          </div>
        </div>

        <DropdownMenuSeparator />

        {/* ── Settings ─────────────────────────────────── */}
        <DropdownMenuItem onClick={onOpenSettings}>
          <Settings className="size-4" />
          <span>{t("layout.user_settings")}</span>
        </DropdownMenuItem>

        {/* ── Appearance: inline light/dark toggle ──────── */}
        <div className="flex items-center gap-2 px-2 py-1.5">
          <Palette className="size-4 shrink-0 text-muted-foreground" />
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
            <Globe className="size-4" />
            <span>{t("layout.language")}</span>
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            <LanguageItem code="en" label={t("layout.lang_en")} />
            <LanguageItem code="zh-Hans" label={t("layout.lang_zh")} />
            <LanguageItem code="ja" label={t("layout.lang_ja")} />
          </DropdownMenuSubContent>
        </DropdownMenuSub>

        {/* ── Help & Feedback ─────────────────────────── */}
        <DropdownMenuItem>
          <HelpCircle className="size-4" />
          <span>{t("layout.user_help_feedback")}</span>
        </DropdownMenuItem>

        {/* ── Check for Updates ────────────────────────── */}
        <DropdownMenuItem onClick={() => checkForUpdate()} disabled={checking}>
          <Download className={cn("size-4", checking && "animate-spin")} />
          <span>{checking ? t("layout.checking_update") : t("layout.check_update")}</span>
          {update?.hasUpdate && (
            <span className="ml-auto flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-medium text-white">
              !
            </span>
          )}
        </DropdownMenuItem>

        <DropdownMenuSeparator />

        {/* ── Log out ─────────────────────────────────── */}
        <DropdownMenuItem variant="destructive">
          <LogOut className="size-4" />
          <span>{t("layout.log_out")}</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
