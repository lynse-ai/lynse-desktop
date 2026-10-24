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
  useKnowledgePolicy: () => ({ data: { capabilities: { available: true, policy: mock.policy } }, refetch: mock.refetch }),
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
