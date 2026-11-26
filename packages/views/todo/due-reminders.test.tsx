/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";

const mocks = vi.hoisted(() => ({
  toast: vi.fn(),
  push: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: mocks.toast,
}));

vi.mock("@lynse/core/i18n/react", () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) => {
      if (key === "todo.due_batch_title") return `${params?.n} todos are due`;
      if (key === "todo.due_batch_more") return `+${params?.n} more`;
      if (key === "todo.due_toast_body") return `Due: ${params?.time}`;
      if (key === "todo.due_notification_title") return "Todo due";
      if (key === "todo.due_open_page") return "View";
      return key;
    },
  }),
}));

vi.mock("../navigation", () => ({
  useNavigation: () => ({ push: mocks.push }),
}));

vi.mock("./todo-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./todo-api")>();
  return {
    ...actual,
    fetchTodos: vi.fn(async () => ({ items: [], cloudFailed: false })),
    getLocalTodos: vi.fn(() => []),
  };
});

import {
  TodoDueRemindersWatcher,
  setTodoRemindersEnabled,
  truncateReminderText,
} from "./due-reminders";
import { NOTIFIED_KEY } from "./due-logic";
import { useTodoStore } from "./use-todos";
import type { TodoItem } from "./todo-api";

function makeDueTodo(id: string, title: string): TodoItem {
  return {
    id,
    title,
    completed: false,
    dueDate: "2020-01-01",
    createdAt: "2020-01-01T00:00:00Z",
    updatedAt: "2020-01-01T00:00:00Z",
  };
}

afterEach(() => {
  cleanup();
  localStorage.clear();
  mocks.toast.mockClear();
  mocks.push.mockClear();
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

describe("truncateReminderText", () => {
  it("collapses whitespace and truncates long strings with ellipsis", () => {
    expect(truncateReminderText("  hello\n\nworld  ", 20)).toBe("hello world");
    const long = "A".repeat(120);
    const result = truncateReminderText(long, 20);
    expect(result.length).toBe(20);
    expect(result.endsWith("…")).toBe(true);
  });
});

describe("TodoDueRemindersWatcher", () => {
  it("clamps a single long due todo title in the in-app toast", async () => {
    const longTitle = "会议待办".repeat(60);
    useTodoStore.setState({
      todos: [makeDueTodo("t1", longTitle)],
      loaded: true,
    });

    render(<TodoDueRemindersWatcher />);
    await act(async () => {});

    expect(mocks.toast).toHaveBeenCalledTimes(1);
    const [titleNode, options] = mocks.toast.mock.calls[0]!;
    const rendered = render(<>{titleNode}</>);
    const text = rendered.container.textContent ?? "";
    expect(text.length).toBeLessThanOrEqual(120);
    expect(text.endsWith("…")).toBe(true);
    expect(options.action.label).toBe("View");
  });

  it("caps multi-todo toast description to 3 preview items plus remainder count", async () => {
    const todos = Array.from({ length: 10 }, (_, idx) =>
      makeDueTodo(`t-${idx}`, `第 ${idx + 1} 条超长会议待办事项内容_${"测试".repeat(30)}`),
    );
    useTodoStore.setState({ todos, loaded: true });

    render(<TodoDueRemindersWatcher />);
    await act(async () => {});

    expect(mocks.toast).toHaveBeenCalledTimes(1);
    const [title, options] = mocks.toast.mock.calls[0]!;
    expect(title).toBe("10 todos are due");

    const rendered = render(<>{options.description}</>);
    const paragraphs = rendered.container.querySelectorAll("p");
    // 3 preview items + 1 "+7 more" line
    expect(paragraphs.length).toBe(4);
    expect(paragraphs[3]?.textContent).toBe("+7 more");
    for (let i = 0; i < 3; i++) {
      expect(paragraphs[i]?.textContent?.length).toBeLessThanOrEqual(82);
    }
  });

  it("does not fire when reminders are toggled off", async () => {
    setTodoRemindersEnabled(false);
    localStorage.removeItem(NOTIFIED_KEY);
    useTodoStore.setState({
      todos: [makeDueTodo("t1", "Overdue task")],
      loaded: true,
    });

    render(<TodoDueRemindersWatcher />);
    await act(async () => {});

    expect(mocks.toast).not.toHaveBeenCalled();
  });
});
