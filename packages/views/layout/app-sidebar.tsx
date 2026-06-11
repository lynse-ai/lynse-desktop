"use client";

import React from "react";
import { cn } from "@lynse/ui/lib/utils";
import { AppLink, useNavigation } from "../navigation";
import {
  Headphones,
  CalendarDays,
  BookOpen,
  FolderOpen,
  MessageSquare,
  Settings,
  Plus,
  Circle,
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
import { useTheme } from "@lynse/ui/components/common/theme-provider";
import { useTranslation, changeLanguage } from "@lynse/core/i18n/react";
import { useFolders } from "../workspace/hooks/use-folders";
import { useFiles } from "../workspace/hooks/use-files";
import { useWorkspaceStore } from "../workspace/store";

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

  const workspaceNav = [
    { key: "recordings", label: t("nav.recordings"), icon: Headphones, path: "/recordings" },
    { key: "meetings", label: t("nav.meetings"), icon: CalendarDays, path: "/meetings" },
    { key: "knowledge", label: t("nav.knowledge"), icon: BookOpen, path: "/knowledge" },
    { key: "files", label: t("nav.files"), icon: FolderOpen, path: "/files" },
  ];

  return (
    <Sidebar variant="inset" className="border-r-0">
      {topSlot}

      {/* ── Header: Create bar ─────────────────────────── */}
      <SidebarHeader className={cn("gap-2 px-3 pt-3 pb-1", headerClassName)} style={headerStyle}>
        {/* Search / Create bar */}
        <button className="flex w-full items-center gap-2 rounded-lg border border-border/60 bg-background px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-muted/60">
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
        <WorkspaceFolderTree />

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

      {/* ── Footer: User profile + Settings dropdown ───── */}
      <SidebarFooter className="border-t border-border/40 p-2">
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <button className="flex w-full items-center gap-2.5 rounded-lg px-2 py-2 transition-colors hover:bg-muted/60">
                <div className="flex size-7 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium text-muted-foreground">
                  JZ
                </div>
                <div className="flex-1 text-left min-w-0">
                  <p className="truncate text-[13px] font-medium leading-tight">johney zhao</p>
                  <p className="truncate text-[11px] text-muted-foreground/60">Community</p>
                </div>
                <Settings className="size-3.5 shrink-0 text-muted-foreground/50" />
              </button>
            }
          />
          <DropdownMenuContent align="start" side="top" sideOffset={4} className="w-52">
            {/* Settings */}
            <DropdownMenuItem onClick={() => push("/settings")}>
              <Settings className="size-3.5" />
              <span>{t("nav.settings")}</span>
            </DropdownMenuItem>

            {/* Language */}
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

            {/* Theme */}
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>
                <Moon className="size-3.5" />
                <span>{t("layout.theme")}</span>
              </DropdownMenuSubTrigger>
              <ThemeSubmenu />
            </DropdownMenuSub>

            <DropdownMenuSeparator />

            {/* Help & Info */}
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

            {/* Logout */}
            <DropdownMenuItem variant="destructive">
              <LogOut className="size-3.5" />
              <span>{t("layout.log_out")}</span>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarFooter>
      <SidebarRail />
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

/* ── Folder tree component ──────────────────────────────── */
function WorkspaceFolderTree() {
  const { pathname } = useNavigation();
  const { t } = useTranslation();
  const selectedFolderId = useWorkspaceStore((s) => s.selectedFolderId);
  const selectFolder = useWorkspaceStore((s) => s.selectFolder);
  const { data: folders } = useFolders();
  const { data: files } = useFiles({ pageNum: 1, pageSize: 200 });

  // Only show on workspace routes
  const workspaceRoutes = ["/recordings", "/meetings", "/knowledge", "/files"];
  const isWorkspace = workspaceRoutes.some((r) => pathname.startsWith(r));
  if (!isWorkspace) return null;

  const folderItems = Array.isArray(folders)
    ? folders.map((f) => {
        const obj = f as Record<string, unknown>;
        return {
          id: String(obj.id ?? ""),
          name: String(obj.folderName ?? ""),
          color: obj.color as string | undefined,
        };
      })
    : [];

  const countsByFolder = new Map<string, number>();
  let ungrouped = 0;
  if (Array.isArray(files)) {
    for (const f of files) {
      if (f.folderId) countsByFolder.set(f.folderId, (countsByFolder.get(f.folderId) ?? 0) + 1);
      else ungrouped++;
    }
  }

  return (
    <SidebarGroup className="py-1">
      <div className="px-2 py-1.5">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/70">
          {t("layout.folders")}
        </span>
      </div>
      <SidebarGroupContent>
        <div className="space-y-px px-1">
          {folderItems.map((folder) => (
            <button
              key={folder.id}
              onClick={() => selectFolder(folder.id)}
              className={cn(
                "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-[13px] transition-colors",
                selectedFolderId === folder.id
                  ? "bg-sidebar-accent text-sidebar-accent-foreground"
                  : "text-muted-foreground hover:bg-sidebar-accent/50"
              )}
            >
              {folder.color ? (
                <span className="size-2 shrink-0 rounded-full" style={{ backgroundColor: folder.color }} />
              ) : (
                <Circle className="size-2 shrink-0 fill-current" />
              )}
              <span className="flex-1 truncate text-left">{folder.name}</span>
              <span className="text-[10px] tabular-nums text-muted-foreground/50">
                {countsByFolder.get(folder.id) ?? 0}
              </span>
            </button>
          ))}
          <button
            onClick={() => selectFolder("__uncategorized__")}
            className={cn(
              "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-[13px] transition-colors",
              selectedFolderId === "__uncategorized__"
                ? "bg-sidebar-accent text-sidebar-accent-foreground"
                : "text-muted-foreground hover:bg-sidebar-accent/50"
            )}
          >
            <Circle className="size-2 shrink-0 fill-current opacity-40" />
            <span className="flex-1 truncate text-left">{t("layout.uncategorized")}</span>
            <span className="text-[10px] tabular-nums text-muted-foreground/50">{ungrouped}</span>
          </button>
        </div>
      </SidebarGroupContent>
    </SidebarGroup>
  );
}
