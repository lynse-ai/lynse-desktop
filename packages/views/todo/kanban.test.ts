import { describe, expect, it } from "vitest";
import { isGenericOwner, kanbanColumnFor, kanbanColumns } from "./kanban";
import { applyTodoOverride, type TodoItem } from "./todo-api";

function todo(patch: Partial<TodoItem>): TodoItem {
  return {
    id: "1",
    title: "t",
    completed: false,
    createdAt: "2026-11-01T00:00:00Z",
    updatedAt: "2026-11-01T00:00:00Z",
    ...patch,
  };
}

/** Local yyyy-mm-dd for a day offset from today (keeps date tests deterministic). */
function dayOffset(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

describe("kanbanColumnFor", () => {
  it("routes closed todos to the done column (cancelled included)", () => {
    expect(kanbanColumnFor(todo({ status: "done" }))).toBe("done");
    expect(kanbanColumnFor(todo({ status: "cancelled" }))).toBe("done");
    expect(kanbanColumnFor(todo({ completed: true }))).toBe("done");
  });

  it("defaults open todos to time triage: today/overdue → 今日, this week → 近期, rest → pool", () => {
    expect(kanbanColumnFor(todo({ dueDate: dayOffset(0) }))).toBe("today");
    expect(kanbanColumnFor(todo({ dueDate: dayOffset(-1) }))).toBe("today");
    expect(kanbanColumnFor(todo({}))).toBe("pool"); // undated
    expect(kanbanColumnFor(todo({ dueDate: dayOffset(10) }))).toBe("pool"); // beyond this week
    // A future day still inside the current week (today itself on Saturdays).
    const inWeekOffset = 6 - new Date().getDay();
    expect(kanbanColumnFor(todo({ dueDate: dayOffset(inWeekOffset) }))).toBe(
      inWeekOffset === 0 ? "today" : "week",
    );
  });

  it("an explicit lane pins open todos against the date triage", () => {
    expect(kanbanColumnFor(todo({ kanbanLane: "ready" }))).toBe("week"); // promoted, undated
    expect(kanbanColumnFor(todo({ kanbanLane: "pool", dueDate: dayOffset(0) }))).toBe("pool");
  });

  it("active work without a date sits in today's focus column", () => {
    expect(kanbanColumnFor(todo({ status: "doing" }))).toBe("today");
    expect(kanbanColumnFor(todo({ status: "doing", dueDate: dayOffset(10) }))).toBe("today");
    // Lanes don't touch closed todos.
    expect(kanbanColumnFor(todo({ completed: true, kanbanLane: "pool" }))).toBe("done");
  });
});

describe("kanbanColumns", () => {
  it("sorts the today column: overdue first, then dated, undated last", () => {
    const items = [
      todo({ id: "undated", status: "doing" }),
      todo({ id: "today1", dueDate: dayOffset(0) }),
      todo({ id: "old", dueDate: "2020-01-01" }), // overdue → today column
    ];
    const today = kanbanColumns(items).get("today")!;
    expect(today.map((x) => x.id)).toEqual(["old", "today1", "undated"]);
  });

  it("sorts the week column by due date ascending", () => {
    const items = [
      todo({ id: "later2", kanbanLane: "ready", dueDate: "2099-01-02" }),
      todo({ id: "later1", kanbanLane: "ready", dueDate: "2099-01-01" }),
    ];
    const week = kanbanColumns(items).get("week")!;
    expect(week.map((x) => x.id)).toEqual(["later1", "later2"]);
  });

  it("routes todos into pool, the two execution columns and done", () => {
    const items = [
      todo({ id: "a", status: "doing" }),
      todo({ id: "b", completed: true }),
      todo({ id: "c", status: "cancelled" }),
      todo({ id: "d", dueDate: dayOffset(0) }),
      todo({ id: "e", dueDate: dayOffset(10) }),
      todo({ id: "f", kanbanLane: "ready" }),
    ];
    const columns = kanbanColumns(items);
    expect(columns.get("pool")!.map((x) => x.id)).toEqual(["e"]);
    expect(columns.get("today")!.map((x) => x.id)).toEqual(["d", "a"]); // dated before undated
    expect(columns.get("week")!.map((x) => x.id)).toEqual(["f"]);
    expect(columns.get("done")!.map((x) => x.id)).toEqual(["b", "c"]);
  });
});

describe("isGenericOwner", () => {
  it("matches anonymous meeting-speaker labels in both languages", () => {
    expect(isGenericOwner("发言人 1")).toBe(true);
    expect(isGenericOwner("发言人12")).toBe(true);
    expect(isGenericOwner("说话人 3")).toBe(true);
    expect(isGenericOwner("Speaker 2")).toBe(true);
  });

  it("keeps real assignee names", () => {
    expect(isGenericOwner("张三")).toBe(false);
    expect(isGenericOwner("发言人")).toBe(false); // no number → could be a real nickname
    expect(isGenericOwner("")).toBe(false);
  });
});

describe("applyTodoOverride", () => {
  it("applies the status override onto a cloud item", () => {
    const item = todo({ backend: true, completed: false });
    const merged = applyTodoOverride(item, { status: "doing", completed: false });
    expect(merged.status).toBe("doing");
    expect(merged.completed).toBe(false);
  });

  it("lets a remotely-changed completed flag outrank a stale lane override", () => {
    // Override written here said "doing", but the cloud was toggled to
    // completed on another device afterwards.
    const item = todo({ backend: true, completed: true });
    const merged = applyTodoOverride(item, { status: "doing", completed: false });
    expect(merged.status).toBe("done");
    expect(merged.completed).toBe(true);
  });

  it("recomputes an open lane when the cloud completed flag regressed", () => {
    const item = todo({ backend: true, completed: false });
    const merged = applyTodoOverride(item, { status: "done", completed: true });
    expect(merged.status).toBe("open");
    expect(merged.completed).toBe(false);
  });

  it("passes local items through untouched by the remote-wins guard", () => {
    const item = todo({ backend: false, completed: true });
    const merged = applyTodoOverride(item, { status: "doing", completed: false });
    expect(merged.status).toBe("doing");
    expect(merged.completed).toBe(false);
  });

  it("returns the item unchanged without an override", () => {
    const item = todo({ backend: true });
    expect(applyTodoOverride(item, undefined)).toBe(item);
  });
});
