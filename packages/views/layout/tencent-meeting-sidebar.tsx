"use client";

import { useState } from "react";
import { cn } from "@lynse/ui/lib/utils";
import { useTranslation } from "@lynse/core/i18n/react";
import { useNavigation } from "../navigation";
import { useUserCredits } from "./use-user-credits";
import { SettingsDialog } from "../settings/settings-dialog";
import {
  Lightbulb,
  ListChecks,
  FolderOpen,
  MessageSquare,
  Bell,
  Settings,
} from "../icons";

interface NavItem {
  key: string;
  label: string;
  path?: string;
  icon: React.ComponentType<{ className?: string }>;
  action?: () => void;
}

function isNavActive(pathname: string, href: string): boolean {
  if (href === "/") return pathname === "/" || pathname === "/notes";
  return pathname === href || pathname.startsWith(href + "/");
}

export function TencentMeetingSidebar() {
  const { pathname, push } = useNavigation();
  const { t } = useTranslation();
  const { data } = useUserCredits();
  const [settingsOpen, setSettingsOpen] = useState(false);

  const nickname = (data?.nickname as string) || "User";
  const initials = nickname.slice(0, 2).toUpperCase();

  const topItems: NavItem[] = [
    { key: "inspiration", label: t("nav.inspiration"), icon: Lightbulb, path: "/inspiration" },
    { key: "todo", label: t("nav.todo"), icon: ListChecks, path: "/todo" },
    { key: "notes", label: t("nav.notes"), icon: FolderOpen, path: "/notes" },
    { key: "chat", label: t("nav.chat"), icon: MessageSquare, path: "/chat" },
  ];

  const bottomItems: NavItem[] = [
    { key: "notifications", label: t("nav.notifications"), icon: Bell, path: "/notifications" },
    { key: "settings", label: t("nav.settings"), icon: Settings, action: () => setSettingsOpen(true) },
  ];

  return (
    <>
      <aside
        className="flex h-full w-[68px] shrink-0 flex-col items-center border-r border-border/50 bg-sidebar pb-2 pt-10"
        data-tauri-drag-region
      >
      {/* User avatar at the top */}
      <button
        type="button"
        title={nickname}
        data-tauri-drag-region={false}
        className="mb-2 flex size-10 shrink-0 items-center justify-center rounded-full bg-primary/15 text-xs font-medium text-accent-brand-text ring-1 ring-inset ring-primary/20 transition-colors hover:bg-primary/20"
      >
        {initials}
      </button>

      <div className="flex w-full flex-1 flex-col items-center gap-1 overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {topItems.map((item) => {
          const Icon = item.icon;
          const active = item.key === "settings" ? settingsOpen : isNavActive(pathname, item.path ?? "");
          return (
            <NavButton
              key={item.key}
              active={active}
              onClick={() => (item.action ? item.action() : push(item.path ?? ""))}
              title={item.label}
            >
              <Icon className={cn("size-5", active ? "text-sidebar-accent-foreground" : "text-muted-foreground")} />
              <span className="mt-1 text-[10px] font-medium leading-none">{item.label}</span>
            </NavButton>
          );
        })}
      </div>

      <div className="flex w-full flex-col items-center gap-1 border-t border-sidebar-border/60 pt-2">
        {bottomItems.map((item) => {
          const Icon = item.icon;
          const active = item.key === "settings" ? settingsOpen : isNavActive(pathname, item.path ?? "");
          return (
            <NavButton
              key={item.key}
              active={active}
              onClick={() => (item.action ? item.action() : push(item.path ?? ""))}
              title={item.label}
            >
              <Icon className={cn("size-5", active ? "text-sidebar-accent-foreground" : "text-muted-foreground")} />
              <span className="mt-1 text-[10px] font-medium leading-none">{item.label}</span>
            </NavButton>
          );
        })}
      </div>
    </aside>
    <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
    </>
  );
}

function NavButton({
  active,
  onClick,
  title,
  children,
}: {
  active: boolean;
  onClick: () => void;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      data-tauri-drag-region={false}
      className={cn(
        "flex w-[56px] flex-col items-center justify-center rounded-lg px-1 py-2 transition-colors",
        active
          ? "bg-sidebar-accent text-sidebar-accent-foreground"
          : "text-muted-foreground hover:bg-white/[0.06] hover:text-foreground"
      )}
    >
      {children}
    </button>
  );
}
