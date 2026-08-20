/* @vitest-environment jsdom */

import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { StreamingMarkdown } from "@lynse/ui/markdown";

afterEach(cleanup);

describe("StreamingMarkdown GFM tables", () => {
  it("keeps prose after a streamed table outside the table", () => {
    const content = [
      "## 8 月会议记录（共 14 条）",
      "",
      "| # | 日期 | 标题 |",
      "|---|------|------|",
      "| 1 | 08-18 | (无标题) |",
      "| 14 | 08-03 | 版本规划会：手游版本排期与需求评审 |",
      "按主题分类来看，本月涉及硬件产品开发、面试招聘、电商运营等方面。",
      "",
      "需要我做什么？",
    ].join("\n");

    render(<StreamingMarkdown content={content} isStreaming mode="minimal" />);

    const table = screen.getByRole("table");
    expect(table.className).toContain("table-fixed");
    expect(table.className).toContain("[&_th:first-child]:w-14");
    expect(table.className).toContain("[&_th:nth-child(2)]:w-32");
    expect(within(table).getByText("版本规划会：手游版本排期与需求评审")).toBeTruthy();
    expect(within(table).queryByText(/按主题分类来看/)).toBeNull();
    expect(screen.getByText(/按主题分类来看/).closest("table")).toBeNull();
    expect(screen.getByText("需要我做什么？").closest("table")).toBeNull();
  });

  it("keeps summary lines after a completed table outside the table", () => {
    const content = [
      "以下是你最近 7 天的会议概览：",
      "| # | 日期 | 时长 | 标题 |",
      "|---|------|------|------|",
      "| 1 | 8/14 周四 14:00 | 2:20 | 产品需求评审 |",
      "| 6 | 8/19 周二 10:00 | 1:50 | 产品迭代周会 |",
      "**总计：6 场会议，共 11 小时 38 分钟**",
      "从标题来看，你这一周的会议集中在**产品方向**：",
      "- **3 场周会/迭代会**（常规对齐）",
    ].join("\n");

    render(<StreamingMarkdown content={content} isStreaming={false} mode="minimal" />);

    const table = screen.getByRole("table");
    expect(within(table).getByText("产品迭代周会")).toBeTruthy();
    expect(within(table).queryByText(/总计/)).toBeNull();
    expect(screen.getByText(/总计/).closest("table")).toBeNull();
    expect(screen.getByText(/从标题来看/).closest("table")).toBeNull();
    expect(screen.getByText(/3 场周会/).closest("table")).toBeNull();
  });

  it("keeps ordinary tables on content-aware automatic layout", () => {
    render(
      <StreamingMarkdown
        content={["| 项目 | 说明 |", "|------|------|", "| Lynse | 会议知识管理 |"].join("\n")}
        isStreaming={false}
        mode="minimal"
      />,
    );

    expect(screen.getByRole("table").className).not.toContain("table-fixed");
  });
});
