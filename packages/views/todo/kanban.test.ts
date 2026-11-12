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

  it("starred todos go to the watchlist regardless of date", () => {
    expect(kanbanColumnFor(todo({ starred: true }))).toBe("star");
    expect(kanbanColumnFor(todo({ starred: true, dueDate: dayOffset(0) }))).toBe("star");
  });

  it("dated open todos sit in near-term, undated ones stay unsorted", () => {
    expect(kanbanColumnFor(todo({ dueDate: dayOffset(0) }))).toBe("near"); // today
    expect(kanbanColumnFor(todo({ dueDate: dayOffset(-1) }))).toBe("near"); // overdue
    expect(kanbanColumnFor(todo({ dueDate: dayOffset(30) }))).toBe("near"); // far future, still dated
    expect(kanbanColumnFor(todo({}))).toBe("unsorted"); // undated
    expect(kanbanColumnFor(todo({ status: "doing" }))).toBe("unsorted"); // active but undated
    // The old lane pins are retired — they no longer move cards anywhere.
    expect(kanbanColumnFor(todo({ kanbanLane: "ready" }))).toBe("unsorted");
    expect(kanbanColumnFor(todo({ kanbanLane: "pool", dueDate: dayOffset(0) }))).toBe("near");
  });
});

describe("kanbanColumns", () => {
  it("sorts the near column: overdue first, then by due date ascending", () => {
    const items = [
      todo({ id: "far", dueDate: "2099-01-01" }),
      todo({ id: "old", dueDate: "2020-01-01" }), // overdue
      todo({ id: "today1", dueDate: dayOffset(0) }),
    ];
    const near = kanbanColumns(items).get("near")!;
    expect(near.map((x) => x.id)).toEqual(["old", "today1", "far"]);
  });

  it("routes todos into unsorted, near, the watchlist and done", () => {
    const items = [
      todo({ id: "a", status: "doing" }),
      todo({ id: "b", completed: true }),
      todo({ id: "c", status: "cancelled" }),
      todo({ id: "d", dueDate: dayOffset(0) }),
      todo({ id: "e", starred: true }),
    ];
    const columns = kanbanColumns(items);
    expect(columns.get("unsorted")!.map((x) => x.id)).toEqual(["a"]);
    expect(columns.get("near")!.map((x) => x.id)).toEqual(["d"]);
    expect(columns.get("star")!.map((x) => x.id)).toEqual(["e"]);
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
