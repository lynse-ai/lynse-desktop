/* @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { memoryManagementEnglish } from "./memory-management-locales";
import { MemoryManagementPage } from "./memory-management";

const mock = vi.hoisted(() => ({
  error: null as unknown, pending: false, fetching: false, available: true, refetch: vi.fn(),
}));
vi.mock("@lynse/core/i18n/react", () => ({ useTranslation: () => ({
  t: (key: string) => memoryManagementEnglish[key.replace("memory_manager.", "") as keyof typeof memoryManagementEnglish] ?? key,
}) }));
vi.mock("@lynse/core/api", () => ({ api: () => ({ getBaseUrl: () => "https://test.example", getAgentBaseUrl: () => "https://agent.example" }) }));
vi.mock("@lynse/core/auth", () => ({ useAuthStore: (select: (state: unknown) => unknown) => select({ user: { id: "synthetic" }, isAuthenticated: true }) }));
vi.mock("../navigation", () => ({ useNavigation: () => ({ back: vi.fn(), replace: vi.fn() }) }));
vi.mock("./topic-memory-library", () => ({ TopicMemoryLibrary: () => <p>Memory files</p> }));
vi.mock("@tanstack/react-query", () => ({ useQuery: () => ({
  data: { available: mock.available, features: { memory_management: true, topic_files: true } },
  error: mock.error, isPending: mock.pending, isFetching: mock.fetching, refetch: mock.refetch,
}) }));

beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(mock, { error: null, pending: false, fetching: false, available: true });
});
afterEach(cleanup);

describe("memory connection recovery", () => {
  it("hides stale management controls after a failed capability check and reconnects read-only", () => {
    mock.error = { status: 503 };
    const view = render(<MemoryManagementPage />);
    expect(screen.getByText(memoryManagementEnglish.connection_failed)).toBeTruthy();
    expect(screen.queryByText(memoryManagementEnglish.unavailable)).toBeNull();
    expect(screen.queryByText("Memory files")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: memoryManagementEnglish.connection_retry }));
    expect(mock.refetch).toHaveBeenCalledOnce();
    mock.error = null;
    view.rerender(<MemoryManagementPage />);
    expect(screen.getByText("Memory files")).toBeTruthy();
    expect(screen.queryByText(memoryManagementEnglish.connection_failed)).toBeNull();
  });

  it("distinguishes missing capability from authentication failure", () => {
    mock.available = false;
    const view = render(<MemoryManagementPage />);
    expect(screen.getByText(memoryManagementEnglish.unavailable)).toBeTruthy();
    mock.error = { status: 401 };
    view.rerender(<MemoryManagementPage />);
    expect(screen.getByText(memoryManagementEnglish.connection_auth)).toBeTruthy();
    expect(screen.queryByText(memoryManagementEnglish.unavailable)).toBeNull();
  });

  it("does not report an unsupported server during the first read", () => {
    mock.pending = true;
    render(<MemoryManagementPage />);
    expect(screen.getByText(memoryManagementEnglish.loading)).toBeTruthy();
    expect(screen.queryByText(memoryManagementEnglish.unavailable)).toBeNull();
  });
});
