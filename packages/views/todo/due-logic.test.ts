/* @vitest-environment jsdom */

import { afterEach, describe, expect, it } from "vitest";
import {
  collectDueTodos,
  pickUnnotified,
  readNotifiedMap,
  todoDueAt,
  updateNotified,
  writeNotifiedMap,
  NOTIFIED_KEY,
  type NotifiedMap,
} from "./due-logic";
import type { TodoItem } from "./todo-api";

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

describe("todoDueAt", () => {
  it("lands date-only deadlines at 09:00 local", () => {
    const d = todoDueAt({ dueDate: "2026-11-27" })!;
    expect(d.getFullYear()).toBe(2026);
    expect(d.getMonth()).toBe(10);
    expect(d.getDate()).toBe(27);
    expect(d.getHours()).toBe(9);
    expect(d.getMinutes()).toBe(0);
  });

  it("keeps the instant of a full-ISO dueDate", () => {
    const due = todoDueAt({ dueDate: "2026-11-27T15:30:00" })!;
    expect(due.getHours()).toBe(15);
    expect(due.getMinutes()).toBe(30);
  });

  it("falls back to calendarStartAt when no dueDate", () => {
    const due = todoDueAt({ calendarStartAt: "2026-11-28T10:00:00" })!;
    expect(due.getDate()).toBe(28);
  });

  it("returns null for missing or unparseable dates", () => {
    expect(todoDueAt({})).toBeNull();
    expect(todoDueAt({ dueDate: "not-a-date" })).toBeNull();
  });
});

describe("collectDueTodos", () => {
  const now = new Date(2026, 10, 22, 12, 0, 0);

  it("collects open todos whose due instant passed", () => {
    const items = [
      todo({ id: "past", dueDate: "2026-11-22" }), // 09:00 today < now
      todo({ id: "future", dueDate: "2026-11-25" }),
      todo({ id: "undated" }),
    ];
    expect(collectDueTodos(items, now).map((c) => c.todo.id)).toEqual(["past"]);
  });

  it("skips closed todos", () => {
    const items = [todo({ id: "done", dueDate: "2026-11-01", completed: true })];
    expect(collectDueTodos(items, now)).toHaveLength(0);
  });
});

describe("notified ledger", () => {
  afterEach(() => {
    try { localStorage.removeItem(NOTIFIED_KEY); } catch { /* ignore */ }
  });

  it("round-trips through localStorage", () => {
    writeNotifiedMap({ "a": "2026-11-22T01:00:00.000Z" });
    expect(readNotifiedMap()).toEqual({ "a": "2026-11-22T01:00:00.000Z" });
  });

  it("tolerates corrupt storage", () => {
    localStorage.setItem(NOTIFIED_KEY, "{not json");
    expect(readNotifiedMap()).toEqual({});
  });

  it("re-arms when the due instant moves", () => {
    const fired: NotifiedMap = { "a": "2026-11-21T01:00:00.000Z" };
    const item = todo({ id: "a", dueDate: "2026-11-22" });
    const dueAt = todoDueAt(item)!;
    expect(pickUnnotified([{ todo: item, dueAt }], fired)).toHaveLength(1);
    // Same instant again → silent.
    expect(pickUnnotified([{ todo: item, dueAt }], { "a": dueAt.toISOString() })).toHaveLength(0);
  });

  it("prunes closed/deleted todos and stamps fired ones", () => {
    const ledger: NotifiedMap = { "old": "2026-11-01T01:00:00.000Z", "live": "2026-11-20T01:00:00.000Z" };
    const live = todo({ id: "live", dueDate: "2026-11-25" });
    const firedTodo = todo({ id: "fired", dueDate: "2026-11-22" });
    const next = updateNotified(
      [{ todo: firedTodo, dueAt: todoDueAt(firedTodo)! }],
      [live, firedTodo],
      ledger,
    );
    expect(next["old"]).toBeUndefined();
    expect(next["live"]).toBe("2026-11-20T01:00:00.000Z");
    expect(next["fired"]).toBe(todoDueAt(firedTodo)!.toISOString());
  });
});
