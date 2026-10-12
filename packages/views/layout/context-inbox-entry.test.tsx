/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useNotificationStore } from "../notifications/use-notification-store";
import { LynseSidebar } from "./lynse-sidebar";
import { setContextInboxEnabled } from "../notifications/context-inbox-preferences";

const push = vi.hoisted(() => vi.fn());
vi.mock("@lynse/core/auth", () => ({ useAuthStore: (selector: (state: unknown) => unknown) => selector({ isAuthenticated: true, user: { id: "u1" } }) }));
vi.mock("../navigation", () => ({ useNavigation: () => ({ pathname: "/home", push }) }));
vi.mock("@lynse/core/i18n/react", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("./use-user-credits", () => ({ useUserCredits: () => ({ data: { nickname: "Alice" } }) }));
vi.mock("../inspiration", () => ({ getDesktopInspirationApi: () => null }));
vi.mock("../platform", () => ({ isWebPlatform: () => false }));
vi.mock("../workspace/hooks/use-chat-store", () => ({
  useChatStore: Object.assign(() => 0, { getState: () => ({ openLatestUnread: vi.fn() }) }),
  selectChatUnreadCount: () => 0,
}));
vi.mock("../settings/settings-dialog", () => ({ SettingsDialog: () => null }));
vi.mock("../app-update-dialog", () => ({ AppUpdateDialog: () => null }));
vi.mock("../app-update", () => ({ useAppUpdate: () => ({ update: null }), openAppUpdateDialog: vi.fn() }));
vi.mock("./user-profile-dropdown", () => ({ UserProfileDropdown: ({ trigger }: { trigger: React.ReactNode }) => trigger }));

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  useNotificationStore.setState({ items: [], contextUserId: null });
  push.mockClear();
});

describe("context inbox entry on the current sidebar", () => {
  it("keeps notifications discoverable after opt-in even when the inbox is empty", () => {
    setContextInboxEnabled("u1", true);
    useNotificationStore.setState({ items: [] });
    render(<LynseSidebar />);
    fireEvent.click(screen.getByRole("button", { name: /nav.notifications/ }));
    expect(push).toHaveBeenCalledWith("/notifications");
  });

  it("opens the existing notification page when a context item is available", () => {
    setContextInboxEnabled("u1", true);
    useNotificationStore.setState({ items: [{
      id: "context:one", type: "context", title: "Review",
      createdAt: Date.now(), read: false,
    }] });
    render(<LynseSidebar />);
    fireEvent.click(screen.getByRole("button", { name: /nav.notifications/ }));
    expect(push).toHaveBeenCalledWith("/notifications");
  });

  it("keeps the context entry hidden when no context item is available", () => {
    useNotificationStore.setState({ items: [] });
    render(<LynseSidebar />);
    expect(screen.queryByRole("button", { name: /nav.notifications/ })).toBeNull();
  });
});
