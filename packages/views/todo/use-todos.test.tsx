/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useTodos, useTodoStore } from "./use-todos";

vi.mock("./todo-api", () => ({
  fetchTodos: vi.fn(async () => ({
    items: [
      {
        id: "t1",
        title: "写周报",
        completed: false,
        createdAt: "2026-09-13T09:00:00.000Z",
        updatedAt: "2026-09-13T09:00:00.000Z",
      },
    ],
    cloudFailed: false,
  })),
  saveTodo: vi.fn(async (todo: { id: string }) => todo),
  deleteTodo: vi.fn(async () => {}),
  clearCloudCompleted: vi.fn(async () => {}),
  deleteCloudTodos: vi.fn(async () => {}),
  getLocalTodos: vi.fn(() => []),
}));

vi.mock("@lynse/core/auth", () => ({
  useAuthStore: (selector: (s: { isAuthenticated: boolean }) => unknown) =>
    selector({ isAuthenticated: true }),
  getAuthStore: () => ({ getState: () => ({ isAuthenticated: true }) }),
}));

import { fetchTodos, saveTodo } from "./todo-api";

/** Stand-in for any page-level consumer (home page, home feed, todo page…):
 *  each mount used to hold its own isolated copy of the list. */
function Probe({ label }: { label: string }) {
  const { todos, toggle } = useTodos();
  const first = todos[0];
  return (
    <button type="button" onClick={() => first && void toggle(first)}>
      {label}:{first?.completed ? "done" : "open"}
    </button>
  );
}

afterEach(() => {
  cleanup();
  vi.mocked(fetchTodos).mockClear();
  vi.mocked(saveTodo).mockClear();
  useTodoStore.setState({
    todos: [],
    loading: false,
    refreshing: false,
    clearing: false,
    error: null,
    loaded: false,
  });
});

describe("useTodos shared store", () => {
  it("reflects a toggle from one consumer in every other consumer instantly", async () => {
    // Regression: the home page and its feed each instantiated their own
    // store, so checking a todo in the feed looked like a no-op.
    render(
      <>
        <Probe label="page" />
        <Probe label="feed" />
      </>,
    );

    // One shared fetch populates both consumers.
    await act(async () => {});
    expect(screen.getByText("page:open")).toBeTruthy();
    expect(screen.getByText("feed:open")).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByText("page:open"));
    });

    expect(screen.getByText("page:done")).toBeTruthy();
    expect(screen.getByText("feed:done")).toBeTruthy();
    expect(vi.mocked(saveTodo)).toHaveBeenCalledWith(
      expect.objectContaining({ id: "t1", completed: true }),
    );
  });

  it("skips the initial load for enabled:false mounts (heatmap gate)", () => {
    function GatedProbe() {
      useTodos({ enabled: false });
      return null;
    }
    render(<GatedProbe />);
    expect(vi.mocked(fetchTodos)).not.toHaveBeenCalled();
  });

  it("loads once when several consumers mount together", async () => {
    render(
      <>
        <Probe label="a" />
        <Probe label="b" />
        <Probe label="c" />
      </>,
    );
    await act(async () => {});
    expect(vi.mocked(fetchTodos)).toHaveBeenCalledTimes(1);
  });
});
