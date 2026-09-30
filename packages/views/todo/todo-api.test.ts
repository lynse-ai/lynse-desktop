import { describe, expect, it } from "vitest";
import { applySourceTitles, mapCloudTodo, noteTitleMapFromFiles } from "./todo-api";
import type { TodoItem } from "./todo-api";

describe("mapCloudTodo", () => {
  it("keeps the source file id the todo was extracted from", () => {
    const todo = mapCloudTodo({
      id: 42,
      todoContent: "跟进登录页改版",
      isCompleted: 0,
      expectedCompleteTime: "2026-09-30 15:30:00",
      fileId: "file-123",
      owner: "张三",
    });
    expect(todo.sourceFileId).toBe("file-123");
    expect(todo.backend).toBe(true);
  });

  it("leaves sourceFileId undefined when the cloud record has no fileId", () => {
    const todo = mapCloudTodo({ id: 1, todoContent: "手动待办" });
    expect(todo.sourceFileId).toBeUndefined();
  });
});

describe("noteTitleMapFromFiles", () => {
  it("builds a fileId → title map with the same fallbacks the notes page uses", () => {
    const map = noteTitleMapFromFiles([
      { id: "f1", originalFilename: "产品设计评审会" },
      { id: "f2", name: "周会" },
      { id: "f3", filename: "复盘" },
      { id: "", originalFilename: "no id" },
      { id: "f4", originalFilename: "   " },
    ]);
    expect(map.get("f1")).toBe("产品设计评审会");
    expect(map.get("f2")).toBe("周会");
    expect(map.get("f3")).toBe("复盘");
    expect(map.size).toBe(3);
  });
});

describe("applySourceTitles", () => {
  const titles = new Map([["file-123", "产品设计评审会"]]);

  function cloudTodo(patch: Partial<TodoItem>): TodoItem {
    return {
      id: "1",
      title: "t",
      completed: false,
      createdAt: "2026-09-30T00:00:00Z",
      updatedAt: "2026-09-30T00:00:00Z",
      backend: true,
      ...patch,
    };
  }

  it("fills sourceTitle for cloud todos from their sourceFileId", () => {
    const items = [cloudTodo({ sourceFileId: "file-123" })];
    applySourceTitles(items, titles);
    expect(items[0]!.sourceTitle).toBe("产品设计评审会");
  });

  it("leaves local todos and already-titled items untouched", () => {
    const items = [
      cloudTodo({ sourceFileId: "file-123", backend: false }),
      cloudTodo({ sourceFileId: "file-123", sourceTitle: "已有来源" }),
      cloudTodo({ sourceFileId: "missing-file" }),
    ];
    applySourceTitles(items, titles);
    expect(items[0]!.sourceTitle).toBeUndefined();
    expect(items[1]!.sourceTitle).toBe("已有来源");
    expect(items[2]!.sourceTitle).toBeUndefined();
  });
});
