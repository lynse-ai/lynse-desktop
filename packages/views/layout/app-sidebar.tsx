"use client";

import React, { useState } from "react";
import { cn } from "@lynse/ui/lib/utils";
import { AppLink, useNavigation } from "../navigation";
import {
  Lightbulb,
  MessageSquare,
  Settings,
  Plus,
  Grid3X3,
  Sun,
  Moon,
  Monitor,
  Globe,
  HelpCircle,
  FileClock,
  MessageCircle,
  Check,
  LogOut,
  Zap,
  Crown,
  ListChecks,
} from "../icons";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
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
import { useUserCredits, useMembership } from "./use-user-credits";
import { FolderTreeSection } from "../workspace/sidebar/folder-tree-section";
import { SettingsDialog } from "../settings/settings-dialog";
import { UploadDialog } from "../workspace/upload-dialog";
import { TemplateManager } from "../workspace/template-manager";
import { LayoutTemplate } from "lucide-react";

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
  const { pathname } = useNavigation();
  const { t } = useTranslation();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [templateManagerOpen, setTemplateManagerOpen] = useState(false);

  const workspaceNav = [
    { key: "inspiration", label: t("nav.inspiration"), icon: Lightbulb, path: "/inspiration" },
  ];

  return (
    <Sidebar variant="inset" className="border-r-0">
      {topSlot}

      {/* ── Header: Create bar ─────────────────────────── */}
      <SidebarHeader className={cn("gap-2 px-3 pt-3 pb-1", headerClassName)} style={headerStyle}>
        {/* Search / Create bar */}
        <button
          className="flex w-full items-center gap-2 rounded-lg border border-border/60 bg-background px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-muted/60"
          onClick={() => setUploadOpen(true)}
        >
          <Plus className="size-4 shrink-0" />
          <span className="flex-1 text-left">{t("layout.new_recording")}</span>
          <kbd className="pointer-events-none inline-flex h-5 items-center gap-0.5 rounded border border-border/50 bg-muted/60 px-1.5 text-[10px] font-medium text-muted-foreground">
            ⌘N
          </kbd>
        </button>
      </SidebarHeader>

      {/* ── Main Content ───────────────────────────────── */}
      <SidebarContent className="gap-0 px-2">
        {/* Workspace section */}
        <SidebarGroup className="py-1">
          {/* Section header */}
          <div className="flex items-center justify-between px-2 py-1.5">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/70">
              {t("layout.workspace_group")}
            </span>
            <div className="flex items-center gap-0.5">
              <button className="rounded p-1 text-muted-foreground/50 transition-colors hover:bg-muted hover:text-muted-foreground">
                <Grid3X3 className="size-3.5" />
              </button>
              <button className="rounded p-1 text-muted-foreground/50 transition-colors hover:bg-muted hover:text-muted-foreground">
                <Plus className="size-3.5" />
              </button>
            </div>
          </div>
          <SidebarGroupContent>
            <SidebarMenu className="gap-px">
              {workspaceNav.map((item) => {
                const isActive = isNavActive(pathname, item.path);
                return (
                  <SidebarMenuItem key={item.key}>
                    <SidebarMenuButton
                      isActive={isActive}
                      render={<AppLink href={item.path} />}
                      className={cn(
                        "h-8 rounded-md px-2 text-[13px]",
                        isActive
                          ? "bg-sidebar-accent text-sidebar-accent-foreground font-medium"
                          : "text-muted-foreground hover:bg-sidebar-accent/50"
                      )}
                    >
                      <item.icon className="size-4 shrink-0" />
                      <span>{item.label}</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                );
              })}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        {/* Folder tree — shown on workspace routes */}
        <FolderTreeSection />

        {/* Template / Management section — above AI Assistant */}
        <SidebarGroup className="border-t border-border/40 py-1 mt-1">
          <SidebarGroupContent>
            <SidebarMenu className="gap-px">
              <SidebarMenuItem>
                <SidebarMenuButton
                  onClick={() => setTemplateManagerOpen(true)}
                  className="h-8 rounded-md px-2 text-[13px] text-muted-foreground hover:bg-sidebar-accent/50"
                >
                  <LayoutTemplate className="size-4 shrink-0" />
                  <span>{t("templates.title")}</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        {/* Todo section */}
        <SidebarGroup className="border-t border-border/40 py-1 mt-1">
          <SidebarGroupContent>
            <SidebarMenu className="gap-px">
              <SidebarMenuItem>
                <SidebarMenuButton
                  isActive={isNavActive(pathname, "/todo")}
                  render={<AppLink href="/todo" />}
                  className={cn(
                    "h-8 rounded-md px-2 text-[13px]",
                    isNavActive(pathname, "/todo")
                      ? "bg-sidebar-accent text-sidebar-accent-foreground font-medium"
                      : "text-muted-foreground hover:bg-sidebar-accent/50"
                  )}
                >
                  <ListChecks className="size-4 shrink-0" />
                  <span>{t("nav.todo")}</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        {/* Tools section */}
        <SidebarGroup className="border-t border-border/40 py-1 mt-1">
          <SidebarGroupContent>
            <SidebarMenu className="gap-px">
              <SidebarMenuItem>
                <SidebarMenuButton
                  isActive={isNavActive(pathname, "/chat")}
                  render={<AppLink href="/chat" />}
                  className={cn(
                    "h-8 rounded-md px-2 text-[13px]",
                    isNavActive(pathname, "/chat")
                      ? "bg-sidebar-accent text-sidebar-accent-foreground font-medium"
                      : "text-muted-foreground hover:bg-sidebar-accent/50"
                  )}
                >
                  <MessageSquare className="size-4 shrink-0" />
                  <span>{t("nav.chat")}</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      {/* ── Footer: User profile + Credits icon + Settings icon ── */}
      <SidebarFooter className="border-t border-border/40 p-2 gap-0">
        <div className="flex items-center gap-1">
          <div className="flex-1 min-w-0">
            <UserProfileDropdown />
          </div>
          <CreditsPopover />
          <button
            onClick={() => setSettingsOpen(true)}
            className="flex size-8 shrink-0 items-center justify-center rounded-lg transition-colors hover:bg-muted/60"
          >
            <Settings className="size-3.5 text-muted-foreground/50" />
          </button>
        </div>
      </SidebarFooter>
      <SidebarRail />

      {/* Settings dialog */}
      <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
      <UploadDialog open={uploadOpen} onOpenChange={setUploadOpen} />
      <TemplateManager open={templateManagerOpen} onOpenChange={setTemplateManagerOpen} />
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
        <Check className="size-3 text-green-500" />
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
        className="flex size-8 shrink-0 items-center justify-center rounded-lg transition-colors hover:bg-muted/60 cursor-pointer"
      >
        <Zap className="size-4 text-muted-foreground" />
      </PopoverTrigger>
      <PopoverContent side="top" align="end" sideOffset={8} alignOffset={-48} className="w-64 p-0">
        <div className="flex flex-col gap-3 p-3">
          {/* Membership tier */}
          <div className="flex items-center gap-2">
            <Crown className="size-4 text-amber-500" />
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
                      "h-full rounded-full transition-all",
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
                    "h-full rounded-full transition-all",
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
function UserProfileDropdown() {
  const { t } = useTranslation();
  const { data } = useUserCredits();
  const { data: membership } = useMembership();

  const nickname = (data?.nickname as string) || "User";
  const plan = useLocalizedPlan(membership?.memberLevel || data?.benefitType);
  const initials = nickname.slice(0, 2).toUpperCase();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <button className="flex w-full items-center gap-2.5 rounded-lg px-2 py-2 transition-colors hover:bg-muted/60">
            <div className="flex size-7 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium text-muted-foreground">
              {initials}
            </div>
            <div className="flex-1 text-left min-w-0">
              <p className="truncate text-[13px] font-medium leading-tight">{nickname}</p>
              <p className="truncate text-[11px] text-muted-foreground/60">{plan}</p>
            </div>
          </button>
        }
      />
      <DropdownMenuContent align="start" side="top" sideOffset={4} className="w-52">
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            <Globe className="size-3.5" />
            <span>{t("layout.language")}</span>
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            <LanguageItem code="en" label={t("layout.lang_en")} />
            <LanguageItem code="zh-Hans" label={t("layout.lang_zh")} />
            <LanguageItem code="ja" label={t("layout.lang_ja")} />
          </DropdownMenuSubContent>
        </DropdownMenuSub>

        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            <Moon className="size-3.5" />
            <span>{t("layout.theme")}</span>
          </DropdownMenuSubTrigger>
          <ThemeSubmenu />
        </DropdownMenuSub>

        <DropdownMenuSeparator />

        <DropdownMenuItem>
          <HelpCircle className="size-3.5" />
          <span>{t("layout.help_docs")}</span>
        </DropdownMenuItem>
        <DropdownMenuItem>
          <FileClock className="size-3.5" />
          <span>{t("layout.changelog")}</span>
        </DropdownMenuItem>
        <DropdownMenuItem>
          <MessageCircle className="size-3.5" />
          <span>{t("layout.feedback")}</span>
        </DropdownMenuItem>

        <DropdownMenuSeparator />

        <DropdownMenuItem variant="destructive">
          <LogOut className="size-3.5" />
          <span>{t("layout.log_out")}</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/* ── Theme submenu content ─────────────────────────────── */
function ThemeSubmenu() {
  const { theme, setTheme } = useTheme();
  const { t } = useTranslation();

  const options = [
    { value: "system" as const, label: t("layout.theme_system"), icon: Monitor },
    { value: "light" as const, label: t("layout.theme_light"), icon: Sun },
    { value: "dark" as const, label: t("layout.theme_dark"), icon: Moon },
  ];

  return (
    <DropdownMenuSubContent>
      {options.map((opt) => {
        const isActive = theme === opt.value;
        const Icon = opt.icon;
        return (
          <DropdownMenuItem key={opt.value} onClick={() => setTheme(opt.value)}>
            <Icon className="size-3.5" />
            <span className={cn(!isActive && "text-muted-foreground")}>{opt.label}</span>
            {isActive && <Check className="ml-auto size-3.5 text-green-500" />}
          </DropdownMenuItem>
        );
      })}
    </DropdownMenuSubContent>
  );
}
