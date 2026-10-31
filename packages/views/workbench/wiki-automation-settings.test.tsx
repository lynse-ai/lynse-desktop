/* @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { memoryManagementEnglish } from "./memory-management-locales";
import { workbenchLocales } from "./locales";
import { WikiAutomationSettings } from "./wiki-automation-settings";

const mock = vi.hoisted(() => ({
  policy: {
    enrolled: false, range_version: 0, grant_version: 0, processing_version: 0,
    folder_ids: [] as string[], include_unfiled: false, excluded_source_ids: [],
    memory_consent: false, local_text_consent: false, chat_consent: false,
    email_consent: false, notifications_consent: false, extraction_paused: true,
    projections_enabled: false, timezone: "Asia/Shanghai",
  },
  configure: vi.fn(), save: vi.fn(), refetch: vi.fn(), invalidate: vi.fn(), setStatus: vi.fn(),
  cloudError: null as unknown, cloudPending: false, cloudFetching: false, cloudData: true, cloudAvailable: true, cloudPolicy: true,
}));

vi.mock("@lynse/core/i18n/react", () => ({
  useTranslation: () => ({ t: (key: string) => {
    const [namespace, name] = key.split(".");
    const strings = namespace === "memory_manager" ? memoryManagementEnglish : workbenchLocales.en;
    return strings[name as keyof typeof strings] ?? key;
  } }),
}));
vi.mock("@tanstack/react-query", () => ({ useQueryClient: () => ({ invalidateQueries: mock.invalidate }) }));
vi.mock("../workspace/hooks/use-folders", () => ({ useFolders: () => ({
  data: [{ id: "work", folderName: "Product meetings" }], isPending: false, isError: false,
}) }));
vi.mock("./knowledge-policy", () => ({
  useKnowledgePolicy: () => ({
    data: mock.cloudData ? { capabilities: { available: mock.cloudAvailable, policy: mock.cloudPolicy ? mock.policy : null } } : undefined,
    error: mock.cloudError, isPending: mock.cloudPending, isFetching: mock.cloudFetching, refetch: mock.refetch,
  }),
  updateKnowledgePolicy: (...args: unknown[]) => mock.save(...args),
}));
vi.mock("./api", () => ({
  getWorkbenchApi: () => ({ configure: mock.configure }), refreshWorkbench: vi.fn(),
  useWorkbench: Object.assign((select: (state: unknown) => unknown) => select({
    status: { enabled: false, allowAi: false, automation: null },
  }), { getState: () => ({ setStatus: mock.setStatus }) }),
}));

beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(mock, { cloudError: null, cloudPending: false, cloudFetching: false, cloudData: true, cloudAvailable: true, cloudPolicy: true });
  Object.assign(mock.policy, {
    enrolled: false, folder_ids: [], memory_consent: false, local_text_consent: false,
    extraction_paused: true, projections_enabled: false,
  });
  mock.configure.mockResolvedValue({ enabled: true, allowAi: true, automation: { folderIds: ["work"], includeUnfiled: false } });
  mock.save.mockResolvedValue(mock.policy);
});
afterEach(cleanup);

function submit() {
  fireEvent.click(screen.getByRole("checkbox", { name: "Product meetings" }));
  fireEvent.click(screen.getByRole("button", { name: "Enable automatic organization" }));
}

describe("optional AI memory settings", () => {
  it("waits for the initial capability read before allowing organization", () => {
    Object.assign(mock, { cloudPending: true, cloudFetching: true, cloudData: false });
    render(<WikiAutomationSettings />);
    expect(screen.getByText(memoryManagementEnglish.connection_loading)).toBeTruthy();
    expect(screen.queryByText(memoryManagementEnglish.unavailable)).toBeNull();
    submit();
    expect(mock.configure).not.toHaveBeenCalled();
    expect(mock.save).not.toHaveBeenCalled();
  });

  it("offers a read-only reconnect after a 503 and keeps draft choices on recovery", async () => {
    mock.cloudError = "Cloud knowledge request failed (HTTP 503)";
    const view = render(<WikiAutomationSettings />);
    expect(screen.getByText(memoryManagementEnglish.connection_failed)).toBeTruthy();
    expect(screen.queryByText(memoryManagementEnglish.unavailable)).toBeNull();
    fireEvent.click(screen.getByRole("checkbox", { name: "Product meetings" }));
    fireEvent.click(screen.getByRole("button", { name: memoryManagementEnglish.connection_retry }));
    await waitFor(() => expect(mock.refetch).toHaveBeenCalledOnce());
    expect(mock.configure).not.toHaveBeenCalled();
    expect(mock.save).not.toHaveBeenCalled();
    mock.cloudError = null;
    view.rerender(<WikiAutomationSettings />);
    expect(screen.queryByText(memoryManagementEnglish.connection_failed)).toBeNull();
    expect(screen.getByRole<HTMLInputElement>("checkbox", { name: "Product meetings" }).checked).toBe(true);
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Enable automatic organization" }).disabled).toBe(false);
    expect(mock.save).not.toHaveBeenCalled();
  });

  it("distinguishes incomplete and disabled service responses", () => {
    mock.cloudPolicy = false;
    const view = render(<WikiAutomationSettings />);
    expect(screen.getByText(memoryManagementEnglish.connection_invalid)).toBeTruthy();
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Enable automatic organization" }).disabled).toBe(true);
    mock.cloudAvailable = false;
    view.rerender(<WikiAutomationSettings />);
    expect(screen.getByText(memoryManagementEnglish.unavailable)).toBeTruthy();
    expect(screen.queryByText(memoryManagementEnglish.connection_invalid)).toBeNull();
  });

  it("shows a translated save failure without an Error prefix or automatic write retry", async () => {
    mock.save.mockRejectedValue(new Error("Cloud knowledge request failed (HTTP 503)"));
    render(<WikiAutomationSettings />);
    submit();
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe(memoryManagementEnglish.connection_failed));
    expect(mock.save).toHaveBeenCalledOnce();
    expect(mock.configure.mock.calls).toEqual([[false, false, { folderIds: ["work"], includeUnfiled: false }]]);
  });

  it("lets users organize meetings without granting memory or transcript upload", async () => {
    render(<WikiAutomationSettings />);
    expect(screen.queryByRole("checkbox", { name: "Update memories automatically" })).toBeNull();
    expect(screen.queryByRole("checkbox", { name: "Save local recording text in the cloud" })).toBeNull();
    submit();
    await waitFor(() => expect(mock.save).toHaveBeenCalledOnce());
    expect(mock.save.mock.calls[0]![1]).toMatchObject({
      memory_consent: false, local_text_consent: false, projections_enabled: false, extraction_paused: true,
    });
  });

  it("requires separate choices for automatic updates and uploading local text", async () => {
    render(<WikiAutomationSettings />);
    fireEvent.click(screen.getByRole("checkbox", { name: "Remember important information from meetings" }));
    const automatic = screen.getByRole<HTMLInputElement>("checkbox", { name: "Update memories automatically" });
    expect(automatic.checked).toBe(false);
    expect(screen.getByRole<HTMLInputElement>("checkbox", { name: "Save local recording text in the cloud" }).checked).toBe(false);
    expect(mock.save).not.toHaveBeenCalled();
    fireEvent.click(automatic);
    submit();
    await waitFor(() => expect(mock.save).toHaveBeenCalledOnce());
    expect(mock.save.mock.calls[0]![1]).toMatchObject({
      memory_consent: true, local_text_consent: false, projections_enabled: false, extraction_paused: false,
    });
  });

  it("maps turning automatic updates off to a pause while preserving other existing choices", async () => {
    Object.assign(mock.policy, { memory_consent: true, local_text_consent: true, projections_enabled: true, extraction_paused: false });
    render(<WikiAutomationSettings />);
    const automatic = screen.getByRole<HTMLInputElement>("checkbox", { name: "Update memories automatically" });
    expect(automatic.checked).toBe(true);
    fireEvent.click(automatic);
    submit();
    await waitFor(() => expect(mock.save).toHaveBeenCalledOnce());
    expect(mock.save.mock.calls[0]![1]).toMatchObject({
      memory_consent: true, local_text_consent: true, projections_enabled: true, extraction_paused: true,
    });
  });
});
