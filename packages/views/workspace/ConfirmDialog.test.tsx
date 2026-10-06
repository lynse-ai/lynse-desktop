/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ConfirmDialog } from "./ConfirmDialog";
import { normalizePollConfirmation } from "./chat-transport";

vi.mock("@lynse/core/i18n/react", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
afterEach(() => cleanup());

describe("context confirmation preview", () => {
  it("renders frozen scope, source, intent, criteria and monitoring choices in the actual dialog", () => {
    const preview = {
      目标: "Release project A", 动作: "create", 关联会议: [{ title: "Review meeting", source_id: "meeting-1" }],
      关注意图: "Follow launch blockers", 验收条件: ["All launch blockers closed"],
      授权范围: [{ scope_type: "project", scope_id: "project-a" }], 后台分析: true,
      复盘节奏: "weekly", 时区: "Asia/Shanghai",
    };
    const card = normalizePollConfirmation({ kind: "context_action_confirm", title: "Confirm context operation", confirmToken: "frozen-token",
      params: { preview }, actions: [{ label: "Confirm", value: "confirm" }, { label: "Cancel", value: "cancel" }] });
    preview.关注意图 = "Changed after preparing";
    const select = vi.fn();
    render(<ConfirmDialog confirm={card} onSelect={select} onDismiss={vi.fn()} />);
    expect(screen.getByText("Release project A")).toBeTruthy();
    expect(screen.getByText("Review meeting (meeting-1)")).toBeTruthy();
    expect(screen.getByText("Follow launch blockers")).toBeTruthy();
    expect(screen.getByText("All launch blockers closed")).toBeTruthy();
    expect(screen.getByText("notifications.context_scope_project：project-a")).toBeTruthy();
    expect(screen.getByText("notifications.context_enabled")).toBeTruthy();
    expect(screen.getByText("weekly")).toBeTruthy();
    expect(screen.getByText("Asia/Shanghai")).toBeTruthy();
    expect(screen.queryByText("Changed after preparing")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    expect(select).toHaveBeenCalledWith("confirm");
    expect(card?.confirmToken).toBe("frozen-token");
  });

  it("shows explicit disabled and unspecified fields without promoting them to defaults", () => {
    const card = normalizePollConfirmation({ kind: "context_action_confirm", title: "Stop monitoring", params: { preview: { 后台分析: false, 验收条件: null } }, actions: [] });
    render(<ConfirmDialog confirm={card} onSelect={vi.fn()} onDismiss={vi.fn()} />);
    expect(screen.getByText("notifications.context_disabled")).toBeTruthy();
    expect(screen.getByText("notifications.context_unspecified")).toBeTruthy();
  });
});
