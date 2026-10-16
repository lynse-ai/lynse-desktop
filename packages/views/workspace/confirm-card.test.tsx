/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ConfirmCard } from "./confirm-card";
import { normalizePollConfirmation } from "./chat-transport";

vi.mock("@lynse/core/i18n/react", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
afterEach(() => cleanup());

describe("ConfirmCard", () => {
  it("fires onSelect with the tapped option and onDismiss from the cancel row", () => {
    const select = vi.fn();
    const dismiss = vi.fn();
    render(<ConfirmCard confirm={{ question: "怎么继续？", options: [{ label: "改查官网", value: "official" }, { label: "直接试", value: "direct" }] }} onSelect={select} onDismiss={dismiss} />);
    fireEvent.click(screen.getByRole("button", { name: "改查官网" }));
    expect(select).toHaveBeenCalledWith("official");
    fireEvent.click(screen.getByRole("button", { name: "chat.confirm_cancel" }));
    expect(dismiss).toHaveBeenCalled();
  });

  it("collapses after answering: choice keeps a marked row, the rest dim and all rows disable", () => {
    const select = vi.fn();
    render(<ConfirmCard confirm={{ question: "怎么继续？", options: [{ label: "改查官网", value: "official" }, { label: "直接试", value: "direct" }], resolvedChoice: "official" }} onSelect={select} onDismiss={vi.fn()} />);
    const chosen = screen.getByRole("button", { name: "改查官网" });
    expect(chosen.hasAttribute("disabled")).toBe(true);
    expect(chosen.querySelector("svg")).not.toBeNull();
    expect(screen.getByRole("button", { name: "直接试" }).className).toContain("border-dashed");
    expect(screen.queryByRole("button", { name: "chat.confirm_cancel" })).toBeNull();
    fireEvent.click(chosen);
    expect(select).not.toHaveBeenCalled();
  });

  it("dims every option of a dismissed card", () => {
    render(<ConfirmCard confirm={{ question: "q", options: [{ label: "A", value: "a" }, { label: "B", value: "b" }], resolvedChoice: null }} onSelect={vi.fn()} onDismiss={vi.fn()} />);
    expect(screen.getByRole("button", { name: "A" }).className).toContain("border-dashed");
    expect(screen.getByRole("button", { name: "B" }).className).toContain("border-dashed");
  });

  it("requires answers for all WorkBuddy questions and submits single, multi and custom values", () => {
    const select = vi.fn();
    render(<ConfirmCard onSelect={select} onDismiss={vi.fn()} confirm={{ question: "Choose", options: [], workbuddy: {
      requestId: "questions-1", questions: [
        { id: "q_0", question: "Single", multiSelect: false, options: [{ label: "A", value: "A" }] },
        { id: "q_1", question: "Multiple", multiSelect: true, options: [{ label: "X", value: "X" }, { label: "Y", value: "Y" }] },
      ],
    } }} />);
    const submit = screen.getByRole("button", { name: "workbuddy.cloud_submit" });
    expect(submit.hasAttribute("disabled")).toBe(true);
    fireEvent.click(screen.getByRole("radio", { name: "A" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "X" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Y" }));
    fireEvent.change(screen.getByRole("textbox", { name: /^Single / }), { target: { value: "Custom" } });
    fireEvent.click(submit);
    expect(select).toHaveBeenCalledWith(JSON.stringify({ q_0: "Custom", q_1: ["X", "Y"] }));
  });

  it("summarizes answered WorkBuddy questions back to option labels", () => {
    const answers = JSON.stringify({ q_0: "A", q_1: ["X", "custom text"] });
    render(<ConfirmCard onSelect={vi.fn()} onDismiss={vi.fn()} confirm={{ question: "Choose", options: [], resolvedChoice: answers, workbuddy: {
      requestId: "questions-1", questions: [
        { id: "q_0", question: "Single", multiSelect: false, options: [{ label: "A", value: "A" }] },
        { id: "q_1", question: "Multiple", multiSelect: true, options: [{ label: "X", value: "X" }, { label: "Y", value: "Y" }] },
      ],
    } }} />);
    expect(screen.getByText("A")).toBeTruthy();
    expect(screen.getByText("X")).toBeTruthy();
    expect(screen.getByText("custom text")).toBeTruthy();
  });

  it("renders frozen scope, source, intent, criteria and monitoring choices in the inline card", () => {
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
    render(<ConfirmCard confirm={card!} onSelect={select} onDismiss={vi.fn()} />);
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
    render(<ConfirmCard confirm={card!} onSelect={vi.fn()} onDismiss={vi.fn()} />);
    expect(screen.getByText("notifications.context_disabled")).toBeTruthy();
    expect(screen.getByText("notifications.context_unspecified")).toBeTruthy();
  });
});
