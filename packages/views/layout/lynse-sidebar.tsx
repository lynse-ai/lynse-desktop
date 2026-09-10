"use client";

import { useState } from "react";
import { cn } from "@lynse/ui/lib/utils";
import { useTranslation } from "@lynse/core/i18n/react";
import { useNavigation } from "../navigation";
import { useInspirationCaptureStore, getDesktopInspirationApi } from "../inspiration";
import { useUserCredits } from "./use-user-credits";
import { useNotificationStore, selectUnreadCount } from "../notifications/use-notification-store";
import { useChatStore, selectChatUnreadCount } from "../workspace/hooks/use-chat-store";
import { openExternalUrl, openAppUpdateDialog } from "../app-update";
import { AppUpdateDialog } from "../app-update-dialog";
import { featureFlags } from "../feature-flags";
import { NotificationList } from "../notifications/notification-list";
import { SettingsDialog } from "../settings/settings-dialog";
import { UserProfileDropdown } from "./user-profile-dropdown";
import { isTauri } from "./use-maximized";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@lynse/ui/components/ui/dropdown-menu";
import {
  House,
  Lightbulb,
  ListChecks,
  FolderOpen,
  Bot,
  Bell,
  Settings,
  Bluetooth,
} from "../icons";

interface NavItem {
  key: string;
  label: string;
  path?: string;
  icon: React.ComponentType<{ className?: string }>;
  action?: () => void;
  /**
   * Selected glyphs render solid via `fill-current`. Lucide icons whose
   * strokes don't close into a sensible filled shape set this to false and
   * stay outlined when selected.
   */
  solid?: boolean;
}

function isNavActive(pathname: string, href: string): boolean {
  if (href === "/home") return pathname === "/" || pathname === "/home";
  return pathname === href || pathname.startsWith(href + "/");
}

export function LynseSidebar() {
  const { pathname, push } = useNavigation();
  const { t } = useTranslation();
  const { data } = useUserCredits();
  const unreadCount = useNotificationStore(selectUnreadCount);
  const chatUnreadCount = useChatStore(selectChatUnreadCount);
  const markAllRead = useNotificationStore((s) => s.markAllRead);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [notifOpen, setNotifOpen] = useState(false);

  const nickname = (data?.nickname as string) || "User";
  const initials = nickname.slice(0, 2).toUpperCase();

  const topItems: NavItem[] = [
    { key: "home", label: t("nav.home"), icon: House, path: "/home" },
    {
      key: "inspiration",
      label: t("nav.inspiration"),
      icon: Lightbulb,
      path: "/inspiration",
      // flomo-style: the rail icon pops the capture sheet over the current
      // page instead of navigating; the full feed lives at /inspiration and
      // is reached from the sheet's "view all" link. Web has no capture sheet
      // (no desktop bridge), so the entry is hidden there entirely.
      action: () => useInspirationCaptureStore.getState().openCapture(),
    },
    { key: "todo", label: t("nav.todo"), icon: ListChecks, path: "/todo" },
    { key: "notes", label: t("nav.notes"), icon: FolderOpen, path: "/notes" },
    {
      key: "chat",
      label: t("nav.chat"),
      icon: Bot,
      path: "/chat",
      // Opening the chat from the sidebar lands on the conversation the
      // unread badge points at (latest unread, else latest) — never a blank
      // new-chat view.
      action: () => {
        useChatStore.getState().openLatestUnread();
        push("/chat");
      },
    },
    {
      key: "devices",
      label: t("nav.devices"),
      icon: Bluetooth,
      path: "/devices",
      // Open stroke path — filling it closes into a solid blob.
      solid: false,
    },
  ].filter((item) =>
    item.key === "inspiration" ? featureFlags.inspiration && Boolean(getDesktopInspirationApi())
    : item.key === "devices" ? featureFlags.devices
    : true,
  );

  const bottomItems: NavItem[] = [
    { key: "notifications", label: t("nav.notifications"), icon: Bell, path: "/notifications" },
    { key: "settings", label: t("nav.settings"), icon: Settings, action: () => setSettingsOpen(true) },
  ];

  return (
    <>
      {/* .lyse-sidebar: vibrancy CSS drops the divider — the inset content
          card's own edge separates it from the frosted rail. */}
      <aside
        className={cn(
          "lyse-sidebar flex h-full w-[68px] shrink-0 flex-col items-center border-r border-border/50 bg-sidebar pb-2",
          // On desktop the macOS traffic lights overlay the window top (bottom
          // edge ≈ 39px) — keep the avatar below with clear breathing room.
          // Web has no lights and keeps the tighter padding.
          isTauri ? "pt-[54px]" : "pt-10"
        )}
        data-tauri-drag-region
      >
      {/* User avatar at the top — opens the profile menu. It opens to the
          right of the rail (not on top of it) and its top edge aligns with the
          avatar's, so the tall menu starts as high as possible and the log-out
          row at the bottom stays inside the window. */}
      <UserProfileDropdown
        onOpenSettings={() => setSettingsOpen(true)}
        side="right"
        trigger={
          <button
            type="button"
            title={nickname}
            data-tauri-drag-region={false}
            className="mb-2 flex size-10 shrink-0 items-center justify-center rounded-full bg-primary/15 text-xs font-medium text-accent-brand-text ring-1 ring-inset ring-primary/20 transition-colors hover:bg-primary/20"
          >
            {initials}
          </button>
        }
      />

      <div className="flex w-full flex-1 flex-col items-center gap-1 overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {topItems.map((item) => {
          const Icon = item.icon;
          const active = item.key === "settings" ? settingsOpen : isNavActive(pathname, item.path ?? "");
          // The AI-assistant (chat) icon carries its own unread badge so a new
          // assistant reply is visible at a glance — the Bell stays the unified
          // center, this is a direct shortcut back to the chat.
          const badgeCount = item.key === "chat" ? chatUnreadCount : 0;
          return (
            <NavButton
              key={item.key}
              active={active}
              badgeCount={badgeCount}
              onClick={() => (item.action ? item.action() : push(item.path ?? ""))}
              title={item.label}
            >
              <Icon className={cn("size-5", active && item.solid !== false && "fill-current")} />
              <span className="mt-1 text-3xs font-medium leading-none">{item.label}</span>
            </NavButton>
          );
        })}
      </div>

      <div className="flex w-full flex-col items-center gap-1 border-t border-sidebar-border/60 pt-2">
        {bottomItems.map((item) => {
          const Icon = item.icon;
          const active = item.key === "settings" ? settingsOpen : isNavActive(pathname, item.path ?? "");

          // Notifications open a slide-in drawer (the unified notification center),
          // instead of navigating to the bare /notifications route.
          if (item.key === "notifications") {
            return (
              <DropdownMenu key={item.key} open={notifOpen} onOpenChange={setNotifOpen}>
                <DropdownMenuTrigger
                  type="button"
                  title={t("nav.notifications")}
                  data-tauri-drag-region={false}
                  className="relative flex w-[56px] flex-col items-center justify-center rounded-lg px-1 py-2 transition-colors text-muted-foreground hover:bg-accent hover:text-foreground"
                >
                  <Bell className="size-5" />
                  <span className="mt-1 text-3xs font-medium leading-none">{item.label}</span>
                  {!!unreadCount && (
                    <span
                      aria-label={t("layout.unread_replies", { count: unreadCount })}
                      className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-3xs font-semibold leading-none text-white ring-2 ring-card"
                    >
                      {unreadCount > 99 ? "99+" : unreadCount}
                    </span>
                  )}
                </DropdownMenuTrigger>
                <DropdownMenuContent side="right" align="start" sideOffset={10} className="w-80 p-0">
                  <div className="flex items-center justify-between border-b border-border/50 px-3 py-2">
                    <span className="text-sm font-medium text-foreground">{t("notifications.title")}</span>
                    <button
                      type="button"
                      onClick={() => markAllRead()}
                      className="text-xs text-muted-foreground transition-colors hover:text-foreground"
                    >
                      {t("notifications.mark_all_read")}
                    </button>
                  </div>
                  <div className="max-h-[60vh] overflow-y-auto">
                    <NotificationList
                      onItemClick={(n) => {
                        // The app-update row opens the in-app update dialog
                        // instead of bouncing the user to the release page.
                        if (n.id === "system:app-update") {
                          setNotifOpen(false);
                          openAppUpdateDialog();
                          return;
                        }
                        // Chat notifications carry their conversation id —
                        // select it so the user lands in that conversation.
                        if (n.id.startsWith("chat:")) {
                          useChatStore.getState().openLatestUnread(n.id.slice("chat:".length));
                        }
                        if (n.href) {
                          if (n.external) openExternalUrl(n.href);
                          else push(n.href);
                        }
                        setNotifOpen(false);
                      }}
                    />
                  </div>
                </DropdownMenuContent>
              </DropdownMenu>
            );
          }

          return (
            <NavButton
              key={item.key}
              active={active}
              onClick={() => (item.action ? item.action() : push(item.path ?? ""))}
              title={item.label}
            >
              <Icon className={cn("size-5", active && item.solid !== false && "fill-current")} />
              <span className="mt-1 text-3xs font-medium leading-none">{item.label}</span>
            </NavButton>
          );
        })}
      </div>
    </aside>
    <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
    <AppUpdateDialog />
    </>
  );
}

function NavButton({
  active,
  badgeCount,
  onClick,
  title,
  children,
}: {
  active: boolean;
  /** Unread count shown as a numeric badge (IM-style). 0/undefined hides it. */
  badgeCount?: number;
  onClick: () => void;
  title: string;
  children: React.ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      data-tauri-drag-region={false}
      className={cn(
        "relative flex w-[56px] flex-col items-center justify-center rounded-lg px-1 py-2 transition-colors",
        // Selected = accent-colored icon+label, no pill behind them; the solid
        // glyph alone carries the selected state.
        active
          ? "text-accent-brand-text"
          : "text-muted-foreground hover:bg-accent hover:text-foreground"
      )}
    >
      {!!badgeCount && (
        <span
          aria-label={t("layout.unread_replies", { count: badgeCount })}
          className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-3xs font-semibold leading-none text-white ring-2 ring-sidebar"
        >
          {badgeCount > 99 ? "99+" : badgeCount}
        </span>
      )}
      {children}
    </button>
  );
}
