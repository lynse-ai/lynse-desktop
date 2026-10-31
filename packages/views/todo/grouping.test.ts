import { describe, expect, it } from "vitest";
import { groupTodos } from "./grouping";
import type { TodoItem } from "./todo-api";

/** Local yyyy-MM-dd offset from today (negative = past). */
function dateOnly(offsetDays: number): string {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function todo(overrides: Partial<TodoItem>): TodoItem {
  return {
    id: "t",
    title: "Task",
    completed: false,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

describe("groupTodos", () => {
  it("puts open todos dated before today into overdue", () => {
    const groups = groupTodos([todo({ id: "a", dueDate: dateOnly(-1) })]);
    expect(groups.get("overdue")!.map((t) => t.id)).toEqual(["a"]);
  });

  it("keeps closed todos out of overdue", () => {
    const groups = groupTodos([
      todo({ id: "done", dueDate: dateOnly(-3), completed: true }),
      todo({ id: "cancelled", dueDate: dateOnly(-3), status: "cancelled" }),
    ]);
    expect(groups.get("overdue")).toHaveLength(0);
  });

  it("groups today's todos under today", () => {
    const groups = groupTodos([todo({ id: "a", dueDate: dateOnly(0) })]);
    expect(groups.get("today")!.map((t) => t.id)).toEqual(["a"]);
  });

  it("sends todos beyond this week to the catch-all group", () => {
    const groups = groupTodos([todo({ id: "a", dueDate: dateOnly(8) })]);
    expect(groups.get("later")!.map((t) => t.id)).toEqual(["a"]);
  });

  it("always files undated todos into the catch-all group regardless of createdAt", () => {
    const groups = groupTodos([todo({ id: "a", createdAt: new Date().toISOString() })]);
    expect(groups.get("later")!.map((t) => t.id)).toEqual(["a"]);
    expect(groups.get("today")).toHaveLength(0);
  });

  it("uses calendarStartAt when dueDate is missing", () => {
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const groups = groupTodos([todo({ id: "a", calendarStartAt: yesterday })]);
    expect(groups.get("overdue")!.map((t) => t.id)).toEqual(["a"]);
  });
});
