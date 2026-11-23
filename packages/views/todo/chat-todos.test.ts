import { describe, expect, it } from "vitest";
import { extractChatTodoTitles } from "./chat-todos";

describe("extractChatTodoTitles", () => {
  it("collects open checkbox items", () => {
    const md = [
      "以下是整理的待办：",
      "",
      "- [ ] 给客户发合同",
      "- [x] 预订会议室",
      "* [ ]  准备周报材料",
    ].join("\n");
    expect(extractChatTodoTitles(md)).toEqual(["给客户发合同", "准备周报材料"]);
  });

  it("collects numbered items under a todo-ish heading", () => {
    const md = [
      "## 待办事项",
      "",
      "1. 跟进设计稿评审",
      "2. 更新项目排期表",
      "",
      "如需调整请告诉我。",
    ].join("\n");
    expect(extractChatTodoTitles(md)).toEqual(["跟进设计稿评审", "更新项目排期表"]);
  });

  it("collects bullets after an inline keyword line", () => {
    const md = ["本次会议的行动项如下：", "- 完成报价单", "- 安排下周复会"].join("\n");
    expect(extractChatTodoTitles(md)).toEqual(["完成报价单", "安排下周复会"]);
  });

  it("ignores prose ending the section", () => {
    const md = ["待办：", "- 任务一", "", "顺便说一下，明天天气不错。", "- 不是任务的行"].join("\n");
    expect(extractChatTodoTitles(md)).toEqual(["任务一"]);
  });

  it("returns nothing for plain lists without todo context", () => {
    const md = ["- 第一点", "- 第二点"].join("\n");
    expect(extractChatTodoTitles(md)).toEqual([]);
  });

  it("returns nothing for messages without lists", () => {
    expect(extractChatTodoTitles("这是一个普通的回答。")).toEqual([]);
  });

  it("strips emphasis markers from titles", () => {
    const md = ["待办事项：", "- **提交合同**", "- `回复邮件`"].join("\n");
    expect(extractChatTodoTitles(md)).toEqual(["提交合同", "回复邮件"]);
  });

  it("restarts collection when a keyword appears after a list", () => {
    const md = ["- 背景列表项", "", "待办：", "- 真正的任务"].join("\n");
    expect(extractChatTodoTitles(md)).toEqual(["真正的任务"]);
  });
});
