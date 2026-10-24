import { describe, expect, it } from "vitest";
import { normalizeStored, todoClosed, todoStatus } from "./todo-api";
describe("todo state compatibility", () => {
  it.each(["open", "doing", "done", "cancelled"] as const)("maps %s without losing closed semantics", status => {
    const todo = normalizeStored({ id: "one", title: "Task", status, statusVersion: 3, completed: true });
    expect(todo.completed).toBe(status === "done"); expect(todoClosed(todo)).toBe(["done", "cancelled"].includes(status)); expect(todoStatus(todo)).toBe(status);
  });
  it("maps old completion records without manufacturing a new version", () => {
    const todo = normalizeStored({ id: "legacy", title: "Task", completed: true });
    expect(todoStatus(todo)).toBe("done"); expect(todo.statusVersion).toBeUndefined();
  });
});
