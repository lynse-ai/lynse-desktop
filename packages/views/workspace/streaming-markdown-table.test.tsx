/* @vitest-environment jsdom */

import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { StreamingMarkdown, completeStreamingMarkdown } from "@lynse/ui/markdown";

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
    expect(table.className).not.toContain("table-fixed");
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

describe("StreamingMarkdown live formatting & stability", () => {
  it("uses one shared .markdown-content wrapper and keeps completed DOM nodes mounted when streaming ends", () => {
    const content = ["## 结论", "", "第一段说明。", "", "第二段说明。"].join("\n");
    const { container, rerender } = render(
      <StreamingMarkdown content={content} isStreaming mode="minimal" />,
    );

    expect(container.querySelectorAll(".markdown-content")).toHaveLength(1);
    const headingDuring = screen.getByRole("heading", { name: "结论" });
    const firstParaDuring = screen.getByText("第一段说明。");

    rerender(<StreamingMarkdown content={content} isStreaming={false} mode="minimal" />);

    expect(container.querySelectorAll(".markdown-content")).toHaveLength(1);
    expect(screen.getByRole("heading", { name: "结论" })).toBe(headingDuring);
    expect(screen.getByText("第一段说明。")).toBe(firstParaDuring);
  });

  it("formats unclosed bold, inline code, links, tables, and fenced code blocks while streaming", () => {
    const { rerender, container } = render(
      <StreamingMarkdown content="这是 **正在加粗" isStreaming mode="minimal" />,
    );
    expect(container.querySelector("strong")?.textContent).toBe("正在加粗");
    expect(container.textContent).not.toContain("**");

    rerender(<StreamingMarkdown content="运行 `pnpm test" isStreaming mode="minimal" />);
    expect(container.querySelector("code")?.textContent).toBe("pnpm test");

    rerender(
      <StreamingMarkdown content="详见 [项目周会](https://app.lynse.ai/meet" isStreaming mode="minimal" />,
    );
    const link = screen.getByRole("link", { name: "项目周会" });
    expect(link.getAttribute("href")).toBe("#");
    expect(container.textContent).not.toContain("https://app.lynse.ai");

    rerender(
      <StreamingMarkdown content="图片 ![卡片](https://cdn.lynse.ai/part" isStreaming mode="minimal" />,
    );
    expect(container.querySelector("img")).toBeNull();

    rerender(
      <StreamingMarkdown content={"| 阶段 | 状态 |\n| --"} isStreaming mode="minimal" />,
    );
    expect(screen.getByRole("table")).toBeTruthy();
    expect(screen.getByText("阶段")).toBeTruthy();

    rerender(
      <StreamingMarkdown content={"```ts\nconst url = 'https://example.com';"} isStreaming mode="minimal" />,
    );
    expect(container.querySelector("a")).toBeNull();
    expect(container.textContent).toContain("https://example.com");
  });

  it("keeps loose ordered lists continuous during streaming without resetting numbering", () => {
    const content = ["1. 第一项", "", "2. 第二项", "", "3. 第三项"].join("\n");
    const { container } = render(
      <StreamingMarkdown content={content} isStreaming mode="minimal" />,
    );
    expect(container.querySelectorAll("ol")).toHaveLength(1);
    expect(container.querySelectorAll("li")).toHaveLength(3);
  });

  it("keeps a fenced code block in its ordered-list item during and after streaming", () => {
    const codeLines = ["curl https://example.com/install", "", "printf '```'"];
    const code = codeLines.join("\n");
    const lines = ["1. 安装", "", "   ```sh", ...codeLines.map((line) => line ? "   " + line : line)];
    const { rerender } = render(<StreamingMarkdown content={lines.join("\n")} isStreaming />);
    const item = screen.getByRole("listitem");
    expect(item.querySelector("pre code")?.textContent?.trimEnd()).toBe(code);

    const continued = [...lines, "   ```", "", "1. **启动"].join("\n");
    rerender(<StreamingMarkdown content={continued} isStreaming />);
    expect(screen.getByText("启动").tagName).toBe("STRONG");
    const list = screen.getByRole("list");
    expect(within(list).getAllByRole("listitem")).toHaveLength(2);

    rerender(<StreamingMarkdown content={continued + "**"} isStreaming={false} />);
    expect(screen.getByRole("list")).toBe(list);
    expect(list.querySelector("li pre code")?.textContent?.trimEnd()).toBe(code);
  });

  it("resolves reference-style links across blocks", () => {
    const content = ["参考 [官方文档][docs]。", "", "[docs]: https://example.com/docs"].join("\n");
    render(<StreamingMarkdown content={content} isStreaming={false} mode="minimal" />);
    const link = screen.getByRole("link", { name: "官方文档" });
    expect(link.getAttribute("href")).toBe("https://example.com/docs");
  });

  it("handles dangling opening markers and half-typed closing delimiters cleanly", () => {
    expect(completeStreamingMarkdown("这是 **")).toBe("这是 ");
    expect(completeStreamingMarkdown("这是 **重点*")).toBe("这是 **重点**");
    expect(completeStreamingMarkdown("~~旧方案~")).toBe("~~旧方案~~");
    expect(completeStreamingMarkdown("**嵌套 `代码")).toBe("**嵌套 `代码`**");
    expect(completeStreamingMarkdown("- 列表项 *斜体")).toBe("- 列表项 *斜体*");
    expect(completeStreamingMarkdown("* 普通无序列表")).toBe("* 普通无序列表");
  });
});
