/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ApiClient, setApiInstance, setApiTransportMode } from "@lynse/core/api/client";
import { createAuthStore, registerAuthStore } from "@lynse/core/auth";
import { HotwordLibraryCard } from "./hotword-library-card";

vi.mock("@lynse/core/i18n/react", () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) => {
      if (key === "settings.hotword_count_limit" && params) {
        return `已添加 ${params.count} / ${params.max} 个热词`;
      }
      return key;
    },
  }),
}));

vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

describe("HotwordLibraryCard", () => {
  let queryClient: QueryClient;
  let authStore: ReturnType<typeof createAuthStore>;
  let client: ApiClient;
  let fetchMock: ReturnType<typeof vi.fn>;

  const initialHotwords = [
    {
      id: "hw-1",
      content: "张伟明",
      weight: 3,
      createTime: "2026-09-11 19:30:00",
      updateTime: "2026-09-11 19:30:00",
    },
    {
      id: "hw-2",
      content: "智能语音",
      weight: 50,
      createTime: "2026-09-11 19:28:00",
      updateTime: "2026-09-11 19:28:00",
    },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false, gcTime: 0 },
        mutations: { retry: false },
      },
    });

    client = new ApiClient("https://business.invalid");
    client.setToken("session-token");
    setApiInstance(client);
    setApiTransportMode("direct");

    authStore = createAuthStore({
      api: client,
      storage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    });
    registerAuthStore(authStore);
    authStore.setState({
      isLoading: false,
      isAuthenticated: true,
      user: { id: "user-1", name: "User", email: "" },
    });

    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    // Mock confirm
    vi.stubGlobal("confirm", () => true);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    setApiTransportMode("proxy");
  });

  function renderCard() {
    return render(
      <QueryClientProvider client={queryClient}>
        <HotwordLibraryCard />
      </QueryClientProvider>,
    );
  }

  it("does not render when unauthenticated", () => {
    authStore.setState({ isAuthenticated: false });
    const { container } = renderCard();
    expect(container.firstChild).toBeNull();
  });

  it("renders hotword list and count badge", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ code: 200, msg: "操作成功", data: initialHotwords })),
    );

    renderCard();

    expect(screen.getByText("settings.hotword_library")).toBeDefined();

    await waitFor(() => {
      expect(screen.getByText("张伟明")).toBeDefined();
      expect(screen.getByText("智能语音")).toBeDefined();
      expect(screen.getByText("已添加 2 / 500 个热词")).toBeDefined();
    });
  });

  it("validates empty or duplicate content before adding", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ code: 200, msg: "操作成功", data: initialHotwords })),
    );

    renderCard();

    await waitFor(() => {
      expect(screen.getByText("张伟明")).toBeDefined();
    });

    const input = screen.getByPlaceholderText("settings.hotword_content_placeholder");
    const addButton = screen.getByRole("button", { name: /settings\.hotword_add_btn/ });

    // Empty content click
    fireEvent.change(input, { target: { value: "   " } });
    expect((addButton as HTMLButtonElement).disabled).toBe(true);

    // Duplicate content
    fireEvent.change(input, { target: { value: "张伟明" } });
    expect((addButton as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(addButton);

    await waitFor(() => {
      expect(screen.getByText("settings.hotword_error_duplicate")).toBeDefined();
    });
    // No add API call made
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("adds a hotword successfully", async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ code: 200, msg: "操作成功", data: initialHotwords })),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            code: 200,
            msg: "操作成功",
            data: {
              id: "hw-3",
              content: "新热词",
              weight: 4,
              createTime: "2026-09-11 19:40:00",
              updateTime: "2026-09-11 19:40:00",
            },
          }),
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            code: 200,
            msg: "操作成功",
            data: [
              ...initialHotwords,
              {
                id: "hw-3",
                content: "新热词",
                weight: 4,
                createTime: "2026-09-11 19:40:00",
                updateTime: "2026-09-11 19:40:00",
              },
            ],
          }),
        ),
      );

    renderCard();

    await waitFor(() => {
      expect(screen.getByText("张伟明")).toBeDefined();
    });

    const input = screen.getByPlaceholderText("settings.hotword_content_placeholder");
    const weightSelect = screen.getByTitle("settings.hotword_weight_hint");
    const addButton = screen.getByRole("button", { name: /settings\.hotword_add_btn/ });

    fireEvent.change(input, { target: { value: "新热词" } });
    fireEvent.change(weightSelect, { target: { value: "4" } });
    fireEvent.click(addButton);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "https://business.invalid/api/business/ai/hotword/add",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ content: "新热词", weight: 4 }),
        }),
      );
    });
  });

  it("updates an existing hotword inline", async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ code: 200, msg: "操作成功", data: initialHotwords })),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ code: 200, msg: "操作成功", data: true })),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            code: 200,
            msg: "操作成功",
            data: [
              { ...initialHotwords[0], content: "张伟明修改", weight: 5 },
              initialHotwords[1],
            ],
          }),
        ),
      );

    renderCard();

    await waitFor(() => {
      expect(screen.getByText("张伟明")).toBeDefined();
    });

    // Click edit button for the first item
    const editButtons = screen.getAllByTitle("settings.hotword_edit_btn");
    fireEvent.click(editButtons[0]!);

    // Find the inline edit input
    const editInput = screen.getByDisplayValue("张伟明");
    fireEvent.change(editInput, { target: { value: "张伟明修改" } });

    // Click save button
    const saveButton = screen.getByTitle("settings.hotword_save_btn");
    fireEvent.click(saveButton);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "https://business.invalid/api/business/ai/hotword/update",
        expect.objectContaining({
          method: "PUT",
          body: JSON.stringify({ id: "hw-1", content: "张伟明修改", weight: 3 }),
        }),
      );
    });
  });

  it("deletes a hotword", async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ code: 200, msg: "操作成功", data: initialHotwords })),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ code: 200, msg: "操作成功", data: true })),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            code: 200,
            msg: "操作成功",
            data: [initialHotwords[1]],
          }),
        ),
      );

    renderCard();

    await waitFor(() => {
      expect(screen.getByText("张伟明")).toBeDefined();
    });

    const deleteButtons = screen.getAllByTitle("settings.hotword_delete_btn");
    fireEvent.click(deleteButtons[0]!);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "https://business.invalid/api/business/ai/hotword/delete?id=hw-1",
        expect.objectContaining({
          method: "DELETE",
        }),
      );
    });
  });
});
