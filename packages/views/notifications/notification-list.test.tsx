/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { NotificationList } from "./notification-list";
import { useNotificationStore } from "./use-notification-store";

vi.mock("@lynse/core/i18n/react", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

afterEach(() => {
  cleanup();
  useNotificationStore.setState({ items: [] });
});

describe("NotificationList transcription rows", () => {
  it("uses the named completion text for pipeline completions (titled)", () => {
    useNotificationStore.getState().add({
      id: "trans-complete:f1:1",
      type: "transcription",
      title: "2026-08-20 14:01:54",
      href: "/notes",
    });
    render(<NotificationList />);

    expect(screen.getByText("notifications.transcription_complete_named")).toBeTruthy();
  });

  it("keeps the legacy upload text for untitled sync events", () => {
    useNotificationStore.getState().add({
      id: "transcription:s1",
      type: "transcription",
      title: "",
      href: "/notes",
    });
    render(<NotificationList />);

    expect(screen.getByText("notifications.transcription_done")).toBeTruthy();
  });
});
