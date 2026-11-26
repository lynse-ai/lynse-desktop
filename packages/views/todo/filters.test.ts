import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyTodoFilter, collectOwners, matchesSmartFilter, searchTodos, type SmartFilter } from "./filters";
import type { TodoItem } from "./todo-api";

// Freeze "now" so relative date fixtures are deterministic: the week bucket
// spans Sunday-start and its edges (running on Thu/Sat/Sun) otherwise push
// fixed offsets into the wrong bucket.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-25T12:00:00")); // a Wednesday
});
afterEach(() => {
  vi.useRealTimers();
});

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

describe("matchesSmartFilter", () => {
  // Fixtures are built inside the frozen-clock beforeEach: relative offsets
  // must be computed against the pinned Wednesday, not collection time.
  let overdue: TodoItem;
  let today: TodoItem;
  let week: TodoItem;
  let undated: TodoItem;
  let starred: TodoItem;
  let owned: TodoItem;

  beforeEach(() => {
    overdue = todo({ id: "a", dueDate: dateOnly(-1) });
    today = todo({ id: "b", dueDate: dateOnly(0) });
    week = todo({ id: "c", dueDate: dateOnly(3) });
    undated = todo({ id: "d" });
    starred = todo({ id: "e", starred: true });
    owned = todo({ id: "f", owner: "发言人 1" });
  });

  it("overdue keeps only open past-due todos", () => {
    const filter: SmartFilter = { kind: "overdue" };
    expect(matchesSmartFilter(overdue, filter)).toBe(true);
    expect(matchesSmartFilter(today, filter)).toBe(false);
    expect(matchesSmartFilter(todo({ id: "x", dueDate: dateOnly(-2), completed: true }), filter)).toBe(false);
  });

  it("today matches only today's group", () => {
    const filter: SmartFilter = { kind: "today" };
    expect(matchesSmartFilter(today, filter)).toBe(true);
    expect(matchesSmartFilter(week, filter)).toBe(false);
    expect(matchesSmartFilter(overdue, filter)).toBe(false);
  });

  it("week matches this-week group", () => {
    const filter: SmartFilter = { kind: "week" };
    expect(matchesSmartFilter(week, filter)).toBe(true);
    expect(matchesSmartFilter(undated, filter)).toBe(false);
  });

  it("starred and owner filters keep closed todos visible", () => {
    const closed = todo({ id: "g", starred: true, completed: true });
    expect(matchesSmartFilter(closed, { kind: "starred" })).toBe(true);
    expect(matchesSmartFilter(owned, { kind: "owner", owner: "发言人 1" })).toBe(true);
    expect(matchesSmartFilter(owned, { kind: "owner", owner: "其他人" })).toBe(false);
  });

  it("starred excludes unstarred todos", () => {
    expect(matchesSmartFilter(undated, { kind: "starred" })).toBe(false);
    expect(matchesSmartFilter(starred, { kind: "starred" })).toBe(true);
  });
});

describe("searchTodos", () => {
  const items = [
    todo({ id: "a", title: "准备季度 Review 材料" }),
    todo({ id: "b", title: "回访客户", notes: "记得带合同" }),
    todo({ id: "c", title: "周报", owner: "发言人 2", sourceTitle: "产品评审会" }),
  ];

  it("matches title case-insensitively", () => {
    expect(searchTodos(items, "review").map((t) => t.id)).toEqual(["a"]);
  });

  it("matches notes, owner and source title", () => {
    expect(searchTodos(items, "合同").map((t) => t.id)).toEqual(["b"]);
    expect(searchTodos(items, "发言人 2").map((t) => t.id)).toEqual(["c"]);
    expect(searchTodos(items, "评审").map((t) => t.id)).toEqual(["c"]);
  });

  it("returns everything for blank queries", () => {
    expect(searchTodos(items, "  ")).toHaveLength(3);
  });
});

describe("collectOwners", () => {
  it("collects distinct owners in first-seen order, skipping blanks", () => {
    expect(collectOwners([
      todo({ id: "a", owner: "发言人 1" }),
      todo({ id: "b" }),
      todo({ id: "c", owner: "发言人 1" }),
      todo({ id: "d", owner: "张三" }),
      todo({ id: "e", owner: "" }),
    ])).toEqual(["发言人 1", "张三"]);
  });
});

describe("applyTodoFilter", () => {
  it("combines filter and query", () => {
    const items = [
      todo({ id: "a", title: "逾期周报", dueDate: dateOnly(-1) }),
      todo({ id: "b", title: "今天的周会", dueDate: dateOnly(0) }),
    ];
    expect(applyTodoFilter(items, { kind: "overdue" }, "周").map((t) => t.id)).toEqual(["a"]);
    expect(applyTodoFilter(items, { kind: "all" }, "今天").map((t) => t.id)).toEqual(["b"]);
  });
});
