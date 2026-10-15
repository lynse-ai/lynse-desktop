"use client";

import React, { useRef, useState } from "react";
import { cn } from "@lynse/ui/lib/utils";
import { Input } from "@lynse/ui/components/ui/input";
import { AppLink, useNavigation } from "../navigation";
import {
  Lightbulb,
  Bot,
  Settings,
  Plus,
  Grid3X3,
  Globe,
  HelpCircle,
  Check,
  LogOut,
  Zap,
  Crown,
  ListChecks,
  Bell,
  X,
  Upload,
  ChevronDown,
  Mic,
  Pencil,
  Palette,
  UserCircle,
  Info,
  ArrowUp,
} from "lucide-react";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarRail,
} from "@lynse/ui/components/ui/sidebar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
  DropdownMenuTrigger,
} from "@lynse/ui/components/ui/dropdown-menu";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@lynse/ui/components/ui/popover";
import { useTheme } from "@lynse/ui/components/common/theme-provider";
import { useTranslation, changeLanguage } from "@lynse/core/i18n/react";
import { useAppUpdate, getAppInfoSync, openAppUpdateDialog } from "../app-update";
import { openAboutWindow } from "../about/open-about";
import { featureFlags } from "../feature-flags";
import { useUserCredits, useMembership, useUpdateNickname } from "./use-user-credits";
import { FolderTreeSection } from "../workspace/sidebar/folder-tree-section";
import { SettingsDialog } from "../settings/settings-dialog";
import { UploadDialog } from "../workspace/upload-dialog";
import { TemplateManager } from "../workspace/template-manager";
import { AppUpdateDialog } from "../app-update-dialog";
import { openReportProblem } from "../diagnostics";
import { openFeedbackWindow } from "../feedback/open-feedback";
import { ReportProblemDialog } from "../report-problem-dialog";
import { LayoutTemplate, MessageSquarePlus } from "lucide-react";

function isNavActive(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(href + "/");
}

interface AppSidebarProps {
  topSlot?: React.ReactNode;
  searchSlot?: React.ReactNode;
  headerClassName?: string;
  headerStyle?: React.CSSProperties;
}

export function AppSidebar({ topSlot, headerClassName, headerStyle }: AppSidebarProps = {}) {
  const { pathname, push } = useNavigation();
  const { t } = useTranslation();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [templateManagerOpen, setTemplateManagerOpen] = useState(false);

  const liveTranslationAvailable = typeof window !== "undefined" && Boolean(
    (window as Window & { desktopAPI?: { liveTranslation?: unknown } }).desktopAPI?.liveTranslation,
  );
  const workspaceNav = [
    { key: "inspiration", label: t("nav.inspiration"), icon: Lightbulb, path: "/inspiration" },
    { key: "chat", label: t("nav.chat"), icon: Bot, path: "/chat" },
  ].filter((item) => (item.key === "inspiration" ? featureFlags.inspiration : true));

  return (
    <Sidebar
      variant="inset"
      className="border-r-0 [&_[data-slot=sidebar-inner]]:border-r [&_[data-slot=sidebar-inner]]:border-sidebar-border/60 [&_[data-slot=sidebar-inner]]:bg-sidebar/90 [&_[data-slot=sidebar-inner]]:backdrop-blur-2xl"
    >
      {topSlot}

      {/* ── Header: Create bar ─────────────────────────── */}
      <SidebarHeader className={cn("gap-2 px-3 pt-3 pb-2", headerClassName)} style={headerStyle}>
        <DropdownMenu>
          <DropdownMenuTrigger
            className="group flex w-full items-center gap-2 rounded-lg border border-sidebar-border bg-card/70 px-2.5 py-1.5 text-sm text-muted-foreground shadow-sm transition-[border-color,background-color,color] hover:border-primary/35 hover:bg-card hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
          >
            <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-primary/[0.12] text-primary transition-colors group-hover:bg-primary/[0.18]">
              <Plus className="size-3.5 shrink-0" />
            </span>
            <span className="min-w-0 flex-1 truncate text-left text-13 font-medium">{t("layout.new_recording")}</span>
            <ChevronDown className="size-3.5 shrink-0 opacity-60" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" sideOffset={6} className="w-56">
            <DropdownMenuItem
              disabled={!liveTranslationAvailable}
              onClick={() => push("/recording")}
            >
              <Mic className="size-4 text-muted-foreground" strokeWidth={1.5} />
              <span>{t("layout.new_recording_start")}</span>
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => setUploadOpen(true)}>
              <Upload className="size-4 text-muted-foreground" strokeWidth={1.5} />
              <span>{t("layout.new_recording_import")}</span>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarHeader>

      {/* ── Main Content ───────────────────────────────── */}
      <SidebarContent className="gap-0 px-2">
        {/* Compact icon-tile navigation — icon on top, label below */}
        <SidebarGroup className="py-1">
          <div className="flex items-center justify-between px-1.5 py-1.5">
            <span className="text-3xs font-semibold uppercase tracking-[0.16em] text-muted-foreground/70">
              {t("layout.workspace_group")}
            </span>
            <div className="flex items-center gap-0.5">
              <button className="rounded-md p-1 text-muted-foreground/50 transition-colors hover:bg-accent hover:text-muted-foreground">
                <Grid3X3 className="size-3.5" />
              </button>
              <button className="rounded-md p-1 text-muted-foreground/50 transition-colors hover:bg-accent hover:text-muted-foreground">
                <Plus className="size-3.5" />
              </button>
            </div>
          </div>
          <SidebarGroupContent>
            <div className="grid grid-cols-3 gap-1 px-0.5 pb-1">
              {workspaceNav.map((item) => {
                const isActive = isNavActive(pathname, item.path);
                return (
                  <AppLink
                    key={item.key}
                    href={item.path}
                    title={item.label}
                    className={cn(
                      "flex flex-col items-center gap-1.5 rounded-lg px-1 py-2.5 text-3xs font-medium leading-none transition-[color,background-color,transform] duration-150 active:scale-[0.96]",
                      isActive
                        ? "bg-sidebar-accent text-sidebar-accent-foreground"
                        : "text-muted-foreground hover:bg-accent hover:text-foreground",
                    )}
                  >
                    <item.icon className="size-4 shrink-0" />
                    <span className="w-full truncate text-center">{item.label}</span>
                  </AppLink>
                );
              })}
              {/* Todo */}
              <AppLink
                href="/todo"
                title={t("nav.todo")}
                className={cn(
                  "flex flex-col items-center gap-1.5 rounded-lg px-1 py-2.5 text-3xs font-medium leading-none transition-[color,background-color,transform] duration-150 active:scale-[0.96]",
                  isNavActive(pathname, "/todo")
                    ? "bg-sidebar-accent text-sidebar-accent-foreground"
                    : "text-muted-foreground hover:bg-accent hover:text-foreground",
                )}
              >
                <ListChecks className="size-4 shrink-0" />
                <span className="w-full truncate text-center">{t("nav.todo")}</span>
              </AppLink>
              {/* Template manager — opens a dialog instead of navigating */}
              <button
                type="button"
                onClick={() => setTemplateManagerOpen(true)}
                title={t("templates.title")}
                className="flex flex-col items-center gap-1.5 rounded-lg px-1 py-2.5 text-3xs font-medium leading-none text-muted-foreground transition-[color,background-color,transform] duration-150 hover:bg-accent hover:text-foreground active:scale-[0.96]"
              >
                <LayoutTemplate className="size-4 shrink-0" />
                <span className="w-full truncate text-center">{t("templates.title")}</span>
              </button>
            </div>
          </SidebarGroupContent>
        </SidebarGroup>

        {/* Folder tree — shown on workspace routes */}
        <FolderTreeSection />
      </SidebarContent>

      {/* ── Footer: User profile + Credits icon ──────────── */}
      <SidebarFooter className="relative gap-0 p-2 pt-3 before:absolute before:left-4 before:right-4 before:top-0 before:h-px before:bg-gradient-to-r before:from-transparent before:via-sidebar-border/60 before:to-transparent">
        <div className="flex items-center gap-1">
          <div className="flex-1 min-w-0">
            <UserProfileDropdown onOpenSettings={() => setSettingsOpen(true)} />
          </div>
          <CreditsPopover />
        </div>
        {/* Update reminder — pops directly below the user/membership row on startup */}
        <UpdateReminder />
      </SidebarFooter>
      <SidebarRail />

      {/* Settings dialog */}
      <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
      <UploadDialog open={uploadOpen} onOpenChange={setUploadOpen} />
      <TemplateManager open={templateManagerOpen} onOpenChange={setTemplateManagerOpen} />
      <AppUpdateDialog />
      {/* In-app bug report dialog, opened from settings / help menus */}
      <ReportProblemDialog />
    </Sidebar>
  );
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

/* ── Credits popover triggered by Zap icon ────────────────── */
function CreditsPopover() {
  const { t } = useTranslation();
  const { data } = useUserCredits();
  const { data: membership } = useMembership();

  const plan = useLocalizedPlan(membership?.memberLevel || data?.benefitType);
  const totalMin = membership?.totalMinutes ?? 0;
  const usedMin = membership?.usedMinutes ?? 0;
  const remainingMin = membership?.remainingMinutes ?? Math.max(0, totalMin - usedMin);
  const isUnlimited = membership?.unlimited === true;
  const percentage = totalMin > 0 ? Math.min(100, Math.max(0, (remainingMin / totalMin) * 100)) : 0;

  // Also show points if available from customer/current
  const pointsTotal = data?.pointsAmount ?? 0;
  const pointsUsed = data?.usedPointsAmount ?? 0;
  const pointsRemaining = Math.max(0, pointsTotal - pointsUsed);
  const hasPoints = pointsTotal > 0;

  return (
    <Popover>
      <PopoverTrigger
        className="flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-lg transition-colors hover:bg-accent"
      >
        <Zap className="size-4 text-muted-foreground" />
      </PopoverTrigger>
      <PopoverContent side="top" align="end" sideOffset={8} alignOffset={-48} className="w-64 p-0">
        <div className="flex flex-col gap-3 p-3">
          {/* Membership tier */}
          <div className="flex items-center gap-2">
            <Crown className="size-4 text-warning" />
            <span className="text-sm font-medium">{plan}</span>
          </div>

          {/* Minutes quota (from membership API) */}
          {(totalMin > 0 || isUnlimited) && (
            <div className="flex flex-col gap-1.5">
              <div className="flex items-center justify-between">
                <span className="text-xs text-muted-foreground">{t("layout.minutes")}</span>
                <span className="text-xs tabular-nums font-medium">
                  {isUnlimited ? t("layout.unlimited") : `${remainingMin} / ${totalMin} min`}
                </span>
              </div>
              {!isUnlimited && (
                <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                  <div
                    className={cn(
                      "h-full rounded-full transition-[width,background-color]",
                      percentage <= 20 ? "bg-destructive/70" : "bg-primary/70"
                    )}
                    style={{ width: `${percentage}%` }}
                  />
                </div>
              )}
            </div>
          )}

          {/* Credits usage (from customer/current, if available) */}
          {hasPoints && (
            <div className="flex flex-col gap-1.5">
              <div className="flex items-center justify-between">
                <span className="text-xs text-muted-foreground">{t("layout.credits")}</span>
                <span className="text-xs tabular-nums font-medium">
                  {pointsRemaining.toLocaleString()} / {pointsTotal.toLocaleString()}
                </span>
              </div>
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                <div
                  className={cn(
                    "h-full rounded-full transition-[width,background-color]",
                    (pointsRemaining / pointsTotal) <= 0.2 ? "bg-destructive/70" : "bg-primary/70"
                  )}
                  style={{ width: `${Math.min(100, (pointsRemaining / pointsTotal) * 100)}%` }}
                />
              </div>
            </div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

/* ── User profile dropdown ─────────────────────────────── */
function UserProfileDropdown({ onOpenSettings }: { onOpenSettings: () => void }) {
  const { t } = useTranslation();
  const { data } = useUserCredits();
  const { data: membership } = useMembership();
  const { theme, setTheme } = useTheme();
  const { update } = useAppUpdate();
  const updateNickname = useUpdateNickname();

  const nickname = (data?.nickname as string) || "User";
  const plan = useLocalizedPlan(membership?.memberLevel || data?.benefitType);
  const initials = nickname.slice(0, 2).toUpperCase();

  // Version for the About row + the upgrade badge. Prefer the version the host
  // bridge injected at startup; fall back to the latest check's currentVersion.
  const hasUpdate = Boolean(update?.hasUpdate);
  const aboutVersion =
    getAppInfoSync()?.version ?? update?.currentVersion ?? null;
  const versionLabel = aboutVersion ? `v${aboutVersion}` : "—";

  // Inline nickname editing: the pencil swaps the name for an input; Enter or
  // blur commits, Escape cancels. `cancelRef` keeps the blur fired by Escape
  // (or by unmount) from committing the stale draft.
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(nickname);
  const cancelRef = useRef(false);

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
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
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
        }
      />
      <DropdownMenuContent align="start" side="top" sideOffset={4} className="w-72 overflow-y-auto p-0">

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
        </div>

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
        <DropdownMenuItem onClick={openReportProblem}>
          <HelpCircle className="size-4 text-muted-foreground" strokeWidth={1.5} />
          <span>{t("layout.user_help_feedback")}</span>
        </DropdownMenuItem>

        {/* ── Feature requests (FeedLog board) ────────── */}
        <DropdownMenuItem onClick={openFeedbackWindow}>
          <MessageSquarePlus className="size-4 text-muted-foreground" strokeWidth={1.5} />
          <span>{t("layout.user_feature_requests")}</span>
        </DropdownMenuItem>

        {/* ── About (version) — pops the standalone About window ── */}
        <DropdownMenuItem onClick={openAboutWindow}>
          <Info className="size-4 text-muted-foreground" strokeWidth={1.5} />
          <span>{t("layout.about")}</span>
          <span className="ml-auto flex items-center gap-1 text-2xs tabular-nums text-muted-foreground">
            {hasUpdate && (
              <ArrowUp className="size-3 text-success" strokeWidth={2.5} />
            )}
            {versionLabel}
          </span>
        </DropdownMenuItem>

        <DropdownMenuSeparator />

        {/* ── Log out ─────────────────────────────────── */}
        <DropdownMenuItem variant="destructive">
          <LogOut className="size-4 text-muted-foreground" strokeWidth={1.5} />
          <span>{t("layout.log_out")}</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/* ── Update reminder card — shown below the user row when a newer release exists ── */
function UpdateReminder() {
  const { t } = useTranslation();
  const { update, installState } = useAppUpdate();
  const [dismissed, setDismissed] = useState<string | null>(null);

  const installBusy =
    installState.phase === "downloading" ||
    installState.phase === "installing" ||
    installState.phase === "restarting";
  const percent =
    installState.total > 0 ? Math.min(100, Math.round((installState.downloaded / installState.total) * 100)) : 0;

  // Nothing to show until a newer release is detected (startup check runs
  // automatically inside useAppUpdate). Hide if the user dismissed this version.
  if (!update?.hasUpdate) return null;
  if (dismissed === update.latestVersion) return null;

  return (
    <div className="mt-1.5 flex items-start gap-2 rounded-lg border border-warning/30 bg-warning/10 px-2.5 py-2">
      <Bell className="mt-0.5 size-3.5 shrink-0 text-warning" />
      <div className="flex-1 min-w-0">
        <p className="text-xs font-medium leading-tight text-warning-text">
          {t("settings.update_available")}
        </p>
        <div className="mt-1 flex items-center gap-1.5 text-2xs tabular-nums">
          <span className="text-muted-foreground">v{update.currentVersion}</span>
          <span className="text-muted-foreground/50">→</span>
          <span className="font-semibold text-warning-text">
            v{update.latestVersion}
          </span>
        </div>
        <p className="mt-1 line-clamp-2 text-2xs leading-snug text-muted-foreground">
          {t("settings.update_available_desc")}
        </p>
        {installBusy ? (
          <div className="mt-1.5 space-y-1">
            <p className="text-2xs font-medium leading-snug text-warning-text tabular-nums">
              {installState.phase === "downloading"
                ? t("settings.update_downloading", { percent })
                : installState.phase === "installing"
                  ? t("settings.update_installing")
                  : t("settings.update_restarting")}
            </p>
            {installState.phase === "downloading" && installState.total > 0 && (
              <div className="h-1 w-full overflow-hidden rounded-full bg-warning/20">
                <div className="h-full rounded-full bg-warning transition-[width]" style={{ width: `${percent}%` }} />
              </div>
            )}
          </div>
        ) : (
          <>
            <button
              onClick={() => openAppUpdateDialog()}
              className="mt-1.5 inline-flex items-center gap-1 rounded-md bg-warning px-2 py-1 text-2xs font-medium text-white transition-colors hover:bg-warning/90"
            >
              {t("settings.install_update")}
            </button>
            {installState.phase === "failed" && (
              <p className="mt-1 text-2xs leading-snug text-destructive">
                {t("settings.update_install_failed", { error: installState.error ?? "" })}
              </p>
            )}
          </>
        )}
      </div>
      <button
        onClick={() => setDismissed(update.latestVersion)}
        className="flex size-5 shrink-0 items-center justify-center rounded-md text-muted-foreground/60 transition-colors hover:bg-muted/60 hover:text-foreground"
        title={t("chat.close")}
      >
        <X className="size-3" />
      </button>
    </div>
  );
}

