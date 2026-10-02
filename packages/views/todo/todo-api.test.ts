import { describe, expect, it } from "vitest";
import { applySourceTitles, mapCloudTodo, noteTitleMapFromItems } from "./todo-api";
import type { TodoItem } from "./todo-api";
import type { WorkspaceItem } from "../workspace/types";
import { isLocalFileId } from "../workspace/local-transcription";

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

describe("noteTitleMapFromItems", () => {
  const item = (id: string, title: string): WorkspaceItem => ({
    id,
    type: "file",
    title,
    updatedAt: "",
    createdAt: "",
  });

  it("builds a fileId → title map and skips empty rows and local records", () => {
    const map = noteTitleMapFromItems([
      item("f1", "产品设计评审会"),
      item("f2", "周会"),
      item("", "no id"),
      item("f3", "   "),
      item("local:abc", "本地转写"),
    ]);
    expect(map.get("f1")).toBe("产品设计评审会");
    expect(map.get("f2")).toBe("周会");
    expect(map.size).toBe(2);
    expect(isLocalFileId("local:abc")).toBe(true);
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
