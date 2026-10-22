"use client";

import { useEffect, useState } from "react";
import { cn } from "@lynse/ui/lib/utils";
import { Popover, PopoverContent, PopoverTrigger } from "@lynse/ui/components/ui/popover";
import { useTranslation } from "@lynse/core/i18n/react";
import { useNavigation } from "../navigation";
import { getDesktopInspirationApi } from "../inspiration";
import { isWebPlatform } from "../platform";
import { useAuthStore } from "@lynse/core/auth";
import { useContextInboxEnabled } from "../notifications/context-inbox-preferences";
import { useUserCredits } from "./use-user-credits";
import { useChatStore, selectChatUnreadCount } from "../workspace/hooks/use-chat-store";
import {
  useNotificationStore,
  selectUnreadByTypes,
} from "../notifications/use-notification-store";
import { AppUpdateDialog } from "../app-update-dialog";
import { featureFlags } from "../feature-flags";
import { BetaBadge } from "../beta-badge";
import { getWorkbenchApi, useWorkbench, useWikiEnabled } from "../workbench/api";
import { SettingsDialog } from "../settings/settings-dialog";
import { openAppUpdateDialog, useAppUpdate } from "../app-update";
import { UserProfileDropdown } from "./user-profile-dropdown";
import { useSidebarPreferences } from "./sidebar-preferences";
import {
  Bell,
  Download,
  House,
  Lightbulb,
  ListChecks,
  FolderOpen,
  Bot,
  BookOpen,
  MoreHorizontal,
  Pin,
} from "../icons";

// Module-level constants keep the notification selector identities stable across renders.
const selectSystemUnread = selectUnreadByTypes(["system"]);
const selectNotesUnread = selectUnreadByTypes(["transcription", "sync"]);
const selectContextCount = (state: ReturnType<typeof useNotificationStore.getState>) =>
  state.items.filter((item) => item.type === "context").length;

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
  beta?: boolean;
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
  const contextCount = useNotificationStore(selectContextCount);
  const contextUserId = useAuthStore((s) => s.isAuthenticated ? s.user?.id ?? null : null);
  const contextEnabled = useContextInboxEnabled(contextUserId);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const pinnedKeys = useSidebarPreferences((state) => state.pinnedItems);
  const togglePin = useSidebarPreferences((state) => state.togglePin);
  const hasWorkbenchStatus = useWorkbench((state) => !!state.status);
  const wikiEnabled = useWikiEnabled();
  // Shared update store (already polled by the mounted AppUpdateDialog) — the
  // rail badge is just another subscriber.
  const { update } = useAppUpdate();

  useEffect(() => {
    void useSidebarPreferences.persist.rehydrate();
  }, []);

  const nickname = (data?.nickname as string) || "User";
  const initials = nickname.slice(0, 2).toUpperCase();
  // Web uses the same navigation with a wider, label-first presentation.
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
  ].filter((item) =>
    item.key === "inspiration" ? featureFlags.inspiration && Boolean(getDesktopInspirationApi())
    : true,
  );

  // New optional destinations belong here so they share the More/pinning flow.
  const moreItems: NavItem[] = [
    { key: "wiki", label: t("nav.memory"), icon: BookOpen, path: "/memory", solid: false },
  ].filter((item) => item.key !== "wiki" || (!isWeb && wikiEnabled && (hasWorkbenchStatus || !!getWorkbenchApi())));
  const pinnedItems = pinnedKeys.flatMap((key) => moreItems.filter((item) => item.key === key));
  const moreActive = moreItems.some((item) =>
    !pinnedKeys.includes(item.key) && isNavActive(pathname, item.path ?? ""),
  );

  function renderNavItem(item: NavItem) {
    const Icon = item.icon;
    const active = isNavActive(pathname, item.path ?? "");
    const badgeCount = item.key === "chat" ? chatUnreadCount : 0;
    const dot = item.key === "home" ? systemUnread > 0
      : item.key === "notes" ? notesUnread > 0 : false;
    return (
      <NavButton
        key={item.key}
        active={active}
        badgeCount={badgeCount}
        dot={dot}
        onClick={() => (item.action ? item.action() : push(item.path ?? ""))}
        title={item.label}
        beta={item.beta}
      >
        <Icon className={cn("size-5", active && item.solid !== false && "fill-current")} />
        <span className={isWeb
          ? "whitespace-nowrap text-[13px] font-medium leading-none"
          : "mt-1 whitespace-nowrap text-3xs font-medium leading-none"}>
          {item.label}
        </span>
      </NavButton>
    );
  }

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
        {topItems.map(renderNavItem)}
        {moreItems.length > 0 && (
          <Popover open={moreOpen} onOpenChange={setMoreOpen}>
            <PopoverTrigger
              title={t("nav.more")}
              data-tauri-drag-region={false}
              className={cn(navButtonClassName(isWeb, moreActive), moreOpen && "bg-foreground/5 text-foreground")}
            >
              <MoreHorizontal className="size-5" />
              <span className={isWeb ? "text-[13px] font-medium" : "mt-1 text-3xs font-medium leading-none"}>
                {t("nav.more")}
              </span>
            </PopoverTrigger>
            <PopoverContent
              side="right"
              align="start"
              sideOffset={10}
              aria-label={t("nav.more")}
              className="w-60 gap-0.5 rounded-2xl p-1.5"
              data-tauri-drag-region={false}
            >
              {moreItems.map((item) => {
                const Icon = item.icon;
                const active = isNavActive(pathname, item.path ?? "");
                const pinned = pinnedKeys.includes(item.key);
                const pinLabel = t(pinned ? "nav.unpin_from_sidebar" : "nav.pin_to_sidebar", { name: item.label });
                return (
                  <div key={item.key} className="flex items-center rounded-xl hover:bg-foreground/5 focus-within:bg-foreground/5">
                    <button
                      type="button"
                      aria-label={item.label}
                      aria-current={active ? "page" : undefined}
                      onClick={() => {
                        setMoreOpen(false);
                        if (item.action) item.action();
                        else push(item.path ?? "");
                      }}
                      className={cn(
                        "flex min-h-10 min-w-0 flex-1 items-center gap-2.5 rounded-xl px-2.5 py-2 text-left text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
                        active ? "text-accent-brand-text" : "text-popover-foreground",
                      )}
                    >
                      <Icon className="size-[18px] shrink-0" />
                      <span className="truncate">{item.label}</span>
                      {item.beta && <span aria-hidden="true"><BetaBadge /></span>}
                    </button>
                    <button
                      type="button"
                      aria-label={pinLabel}
                      title={pinLabel}
                      aria-pressed={pinned}
                      onClick={() => togglePin(item.key)}
                      className={cn(
                        "mr-1 flex size-8 shrink-0 items-center justify-center rounded-lg outline-none transition-colors duration-150 hover:bg-foreground/10 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
                        pinned ? "text-foreground" : "text-muted-foreground",
                      )}
                    >
                      <Pin className={cn("size-4", pinned && "fill-current")} />
                    </button>
                  </div>
                );
              })}
            </PopoverContent>
          </Popover>
        )}
        {pinnedItems.length > 0 && (
          <>
            <div role="separator" className={cn("my-1 h-px shrink-0 bg-sidebar-border", isWeb ? "w-full" : "w-6")} />
            <div role="group" aria-label={t("nav.pinned")} className={cn("flex w-full flex-col", isWeb ? "gap-0.5" : "items-center gap-1")}>
              {pinnedItems.map(renderNavItem)}
            </div>
          </>
        )}
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
        {/* Context suggestions surface as a badge on the notifications entry
            only; the open / dismiss / snooze actions live in the notifications
            page, which is the single handler for the context inbox. */}
        {contextEnabled && (
          <NavButton
            active={isNavActive(pathname, "/notifications")}
            badgeCount={contextCount}
            onClick={() => push("/notifications")}
            title={t("nav.notifications")}
          >
            <Bell className="size-5" />
            <span className={isWeb ? "text-[13px] font-medium" : "mt-1 text-3xs font-medium"}>
              {t("nav.notifications")}
            </span>
          </NavButton>
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
                  : "flex size-8 shrink-0 items-center justify-center rounded-full bg-avatar-brand/15 text-xs font-medium text-avatar-brand-text ring-1 ring-inset ring-avatar-brand/20 transition-colors hover:bg-avatar-brand/20"
              }
            >
              <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-avatar-brand/15 text-xs font-medium text-avatar-brand-text ring-1 ring-inset ring-avatar-brand/20">
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

function navButtonClassName(isWeb: boolean, active: boolean): string {
  return cn(
    "relative flex rounded-lg transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
    isWeb ? "w-full items-center gap-2.5 px-2.5 py-2"
      : "w-[40px] shrink-0 flex-col items-center justify-center px-1 py-2",
    active ? "text-accent-brand-text"
      : "text-muted-foreground hover:bg-foreground/5 hover:text-foreground",
  );
}

function NavButton({
  active,
  badgeCount,
  dot,
  onClick,
  title,
  children,
  beta = false,
}: {
  active: boolean;
  /** Unread count shown as a numeric badge (IM-style). 0/undefined hides it. */
  badgeCount?: number;
  /** Unread marker shown as a small dot (module notifications). */
  dot?: boolean;
  onClick: () => void;
  title: string;
  children: React.ReactNode;
  beta?: boolean;
}) {
  const { t } = useTranslation();
  const isWeb = isWebPlatform();
  return (
    <button
      type="button"
      onClick={onClick}
      title={beta ? `${title} · ${t("settings.beta_badge")}` : title}
      aria-label={beta ? title : undefined}
      aria-description={beta ? t("settings.beta_badge") : undefined}
      aria-current={active ? "page" : undefined}
      data-tauri-drag-region={false}
      className={navButtonClassName(isWeb, active)}
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
      {beta && <span aria-hidden="true"><BetaBadge className={isWeb ? "ml-auto" : "mt-0.5 h-3 px-1 text-[8px]"} /></span>}
    </button>
  );
}
