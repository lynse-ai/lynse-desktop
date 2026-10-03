"use client";

import { useState } from "react";
import { cn } from "@lynse/ui/lib/utils";
import { useTranslation } from "@lynse/core/i18n/react";
import { useNavigation } from "../navigation";
import { getDesktopInspirationApi } from "../inspiration";
import { isWebPlatform } from "../platform";
import { useUserCredits } from "./use-user-credits";
import { useChatStore, selectChatUnreadCount } from "../workspace/hooks/use-chat-store";
import {
  useNotificationStore,
  selectUnreadByTypes,
} from "../notifications/use-notification-store";
import { AppUpdateDialog } from "../app-update-dialog";
import { featureFlags } from "../feature-flags";
import { SettingsDialog } from "../settings/settings-dialog";
import { openAppUpdateDialog, useAppUpdate } from "../app-update";
import { UserProfileDropdown } from "./user-profile-dropdown";
import {
  Download,
  House,
  Lightbulb,
  ListChecks,
  FolderOpen,
  Bot,
  Bluetooth,
} from "../icons";

// Module-scoped unread dots (the sidebar Bell was retired; each module's icon
// carries its own notification marker). Module-level constants keep the
// zustand selector identities stable across renders.
const selectSystemUnread = selectUnreadByTypes(["system"]);
const selectNotesUnread = selectUnreadByTypes(["transcription", "sync"]);

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
  const chatUnreadCount = useChatStore(selectChatUnreadCount);
  const systemUnread = useNotificationStore(selectSystemUnread);
  const notesUnread = useNotificationStore(selectNotesUnread);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Shared update store (already polled by the mounted AppUpdateDialog) — the
  // rail badge is just another subscriber.
  const { update } = useAppUpdate();

  const nickname = (data?.nickname as string) || "User";
  const initials = nickname.slice(0, 2).toUpperCase();
  // Web shell renders a wider, label-first sidebar; the desktop rail is untouched.
  const isWeb = isWebPlatform();

  const topItems: NavItem[] = [
    { key: "home", label: t("nav.home"), icon: House, path: "/home" },
    {
      key: "inspiration",
      label: t("nav.inspiration"),
      icon: Lightbulb,
      path: "/inspiration",
      // The rail entry lands directly on the full inspiration feed; quick
      // capture stays on the feed's bottom "+" (and the home page entry).
      // Web has no capture sheet (no desktop bridge), so the entry is
      // hidden there entirely.
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

  return (
    <>
      {/* .lyse-sidebar: no divider of its own — the rail and the strips around
          the inset content card share one flat frame material, and the card's
          own border does the separating. The traffic lights live in the app
          title bar above, so the rail keeps only a tight top padding. */}
      <aside
        className={cn(
          "lyse-sidebar flex h-full shrink-0 flex-col bg-sidebar",
          isWeb
            ? "w-[208px] items-stretch px-3 pt-4 pb-2"
            : "w-[48px] items-center pl-1 pt-4 pb-4",
        )}
        data-tauri-drag-region
      >
      {isWeb && (
        <div className="px-1.5 pb-3 text-[15px] font-semibold tracking-tight text-foreground">
          Lynse
        </div>
      )}

      <div className={cn("flex w-full flex-1 flex-col overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden", isWeb ? "items-stretch gap-0.5" : "items-center gap-1")}>
        {topItems.map((item) => {
          const Icon = item.icon;
          const active = isNavActive(pathname, item.path ?? "");
          // The AI-assistant (chat) icon carries its own unread badge so a new
          // assistant reply is visible at a glance; home/notes carry the
          // notification types that belong to their module as plain dots.
          const badgeCount = item.key === "chat" ? chatUnreadCount : 0;
          const dot =
            item.key === "home" ? systemUnread > 0
            : item.key === "notes" ? notesUnread > 0
            : false;
          return (
            <NavButton
              key={item.key}
              active={active}
              badgeCount={badgeCount}
              dot={dot}
              onClick={() => (item.action ? item.action() : push(item.path ?? ""))}
              title={item.label}
            >
              <Icon className={cn("size-5", active && item.solid !== false && "fill-current")} />
              {isWeb ? (
                <span className="whitespace-nowrap text-[13px] font-medium leading-none">{item.label}</span>
              ) : (
                <span className="mt-1 whitespace-nowrap text-3xs font-medium leading-none">{item.label}</span>
              )}
            </NavButton>
          );
        })}
      </div>

      {/* ── Bottom: avatar — profile menu (usage, appearance, settings,
          logout). Settings intentionally has no dedicated rail entry; it
          lives in this menu. ── */}
      <div
        className={cn(
          "flex w-full shrink-0 flex-col pt-2",
          // The desktop rail is too narrow for a divider to read well; only the
          // wide web sidebar keeps one above the account row.
          isWeb && "border-t border-sidebar-border/60",
          isWeb ? "items-stretch" : "items-center",
        )}
      >
        {/* Update badge — sits above the account row and opens the shared
            update dialog. Never renders on web (no desktop bridge → no
            update state). */}
        {update?.hasUpdate && (
          <button
            type="button"
            onClick={() => openAppUpdateDialog()}
            title={t("notifications.update_available", { version: update.latestVersion })}
            aria-label={t("notifications.update_available", { version: update.latestVersion })}
            data-tauri-drag-region={false}
            className="mb-2 flex size-7 shrink-0 items-center justify-center rounded-full bg-sidebar-primary text-sidebar-primary-foreground shadow-sm transition-transform duration-150 hover:scale-105 active:scale-95"
          >
            <Download className="size-3.5" strokeWidth={2.5} />
          </button>
        )}
        <UserProfileDropdown
          onOpenSettings={() => setSettingsOpen(true)}
          side={isWeb ? "top" : "right"}
          trigger={
            <button
              type="button"
              title={nickname}
              data-tauri-drag-region={false}
              className={
                isWeb
                  ? "flex h-11 w-full shrink-0 items-center gap-2.5 rounded-xl px-1.5 transition-colors hover:bg-foreground/5"
                  : "flex size-8 shrink-0 items-center justify-center rounded-full bg-primary/15 text-xs font-medium text-accent-brand-text ring-1 ring-inset ring-primary/20 transition-colors hover:bg-primary/20"
              }
            >
              <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary/15 text-xs font-medium text-accent-brand-text ring-1 ring-inset ring-primary/20">
                {initials}
              </span>
              {isWeb && (
                <span className="truncate text-[13px] font-medium text-foreground">{nickname}</span>
              )}
            </button>
          }
        />
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
  dot,
  onClick,
  title,
  children,
}: {
  active: boolean;
  /** Unread count shown as a numeric badge (IM-style). 0/undefined hides it. */
  badgeCount?: number;
  /** Unread marker shown as a small dot (module notifications). */
  dot?: boolean;
  onClick: () => void;
  title: string;
  children: React.ReactNode;
}) {
  const { t } = useTranslation();
  const isWeb = isWebPlatform();
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      data-tauri-drag-region={false}
      className={cn(
        "relative flex rounded-lg transition-colors",
        isWeb
          ? "w-full items-center gap-2.5 px-2.5 py-2"
          : "w-[40px] flex-col items-center justify-center px-1 py-2",
        // Selected = accent-colored icon+label, no pill behind them; the solid
        // glyph alone carries the selected state.
        active
          ? "text-accent-brand-text"
          : "text-muted-foreground hover:bg-foreground/5 hover:text-foreground"
      )}
    >
      {!!badgeCount && (
        <span
          aria-label={t("layout.unread_replies", { count: badgeCount })}
          className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-3xs font-semibold leading-none text-destructive-foreground ring-2 ring-sidebar"
        >
          {badgeCount > 99 ? "99+" : badgeCount}
        </span>
      )}
      {!badgeCount && dot && (
        <span
          aria-hidden="true"
          className="absolute -right-0.5 -top-0.5 size-2 rounded-full bg-primary ring-2 ring-sidebar"
        />
      )}
      {children}
    </button>
  );
}
