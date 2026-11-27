import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./todo-api", () => ({
  fetchTodos: vi.fn(async () => ({
    items: [
      {
        id: "srv-1",
        title: "输出评审结论",
        completed: false,
        backend: true,
        createdAt: "2026-11-27T09:00:00.000Z",
        updatedAt: "2026-11-27T09:00:00.000Z",
      },
    ],
    cloudFailed: false,
  })),
  saveTodo: vi.fn(async (todo: { id: string }) => todo),
  deleteTodo: vi.fn(async () => {}),
  clearCloudCompleted: vi.fn(async () => {}),
  deleteCloudTodos: vi.fn(async () => {}),
  getLocalTodos: vi.fn(() => []),
  canCreateCloudTodos: vi.fn(() => true),
  createCloudTodos: vi.fn(async () => {}),
  // Mirrors the real gate — evidence notes and workbench refs stay local.
  todoIsCloudRepresentable: (todo: {
    notes?: unknown;
    sourceRef?: unknown;
    workbenchScope?: unknown;
    calendarEventId?: unknown;
  }) => !todo.notes && !todo.sourceRef && !todo.workbenchScope && !todo.calendarEventId,
}));

vi.mock("@lynse/core/auth", () => ({
  useAuthStore: (selector: (s: { isAuthenticated: boolean }) => unknown) =>
    selector({ isAuthenticated: true }),
  getAuthStore: () => ({ getState: () => ({ isAuthenticated: true }) }),
}));

import { createCloudTodos, saveTodo } from "./todo-api";
import { createTodosFromSeeds } from "./create-from-source";
import { useTodoStore } from "./use-todos";

afterEach(() => {
  vi.mocked(createCloudTodos).mockClear();
  vi.mocked(saveTodo).mockClear();
  useTodoStore.setState({
    todos: [],
    loading: false,
    refreshing: false,
    clearing: false,
    error: null,
    loaded: false,
    lastLoadedAt: 0,
    lastLoadedAuthed: null,
  });
});

describe("createTodosFromSeeds routing", () => {
  it("sends representable seeds through the cloud insert and reloads", async () => {
    const created = await createTodosFromSeeds([
      { title: "输出评审结论" },
      { title: "跟进接口联调", owner: "张三" },
    ]);
    expect(vi.mocked(createCloudTodos)).toHaveBeenCalledWith([
      { title: "输出评审结论", dueDate: undefined, owner: undefined },
      { title: "跟进接口联调", dueDate: undefined, owner: "张三" },
    ]);
    expect(vi.mocked(saveTodo)).not.toHaveBeenCalled();
    expect(created).toHaveLength(2);
    // The forced reload swapped the placeholders for the backend list.
    expect(useTodoStore.getState().todos.map((t) => t.id)).toEqual(["srv-1"]);
  });

  it("keeps evidence-note seeds in the local store", async () => {
    const created = await createTodosFromSeeds([
      { title: "整理证据", notes: "原话一\n原话二", sourceTitle: "产品评审会" },
    ]);
    expect(vi.mocked(createCloudTodos)).not.toHaveBeenCalled();
    expect(vi.mocked(saveTodo)).toHaveBeenCalledWith(
      expect.objectContaining({ title: "整理证据", notes: "原话一\n原话二" }),
    );
    expect(created).toHaveLength(1);
  });

  it("splits a mixed batch: representable seeds to the cloud, notes local", async () => {
    const created = await createTodosFromSeeds([
      { title: "普通待办" },
      { title: "带证据待办", notes: "证据" },
    ]);
    expect(vi.mocked(createCloudTodos)).toHaveBeenCalledWith([
      { title: "普通待办", dueDate: undefined, owner: undefined },
    ]);
    expect(vi.mocked(saveTodo)).toHaveBeenCalledWith(
      expect.objectContaining({ title: "带证据待办" }),
    );
    expect(created).toHaveLength(2);
  });

  it("falls back to saving the whole batch locally when the insert fails", async () => {
    vi.mocked(createCloudTodos).mockRejectedValueOnce(new Error("network down"));
    const created = await createTodosFromSeeds([{ title: "甲" }, { title: "乙" }]);
    expect(vi.mocked(saveTodo)).toHaveBeenCalledTimes(2);
    // upsert prepends, so only membership is asserted here.
    expect(useTodoStore.getState().todos.map((t) => t.title)).toEqual(
      expect.arrayContaining(["甲", "乙"]),
    );
    expect(created).toHaveLength(2);
  });
});
