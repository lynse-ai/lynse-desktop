// @vitest-environment jsdom
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  auth: { isAuthenticated: true, user: { id: "verified-user" } },
  status: null as Record<string, unknown> | null,
  bind: vi.fn(), unbind: vi.fn(), setTextModel: vi.fn(), onUpdate: vi.fn(), setError: vi.fn(),
  i18n: { language: "zh" },
}));
vi.mock("@lynse/core/auth", () => ({ useAuthStore: (selector: (state: typeof fixture.auth) => unknown) => selector(fixture.auth) }));
vi.mock("@lynse/core/api", async (original) => ({ ...await original<Record<string, unknown>>(), api: () => ({ getToken: () => "synthetic-token", getBaseUrl: () => "https://business.invalid", getAgentBaseUrl: () => "https://agent.invalid" }) }));
vi.mock("@lynse/core/i18n/react", () => ({ useTranslation: () => ({ t: (key: string) => key, i18n: fixture.i18n }) }));
vi.mock("./api", () => ({
  getWorkbenchApi: () => ({ bind: fixture.bind, unbind: fixture.unbind, setTextModel: fixture.setTextModel, onUpdate: fixture.onUpdate }),
  refreshWorkbench: vi.fn(), useWikiEnabled: () => true,
  useWorkbench: Object.assign(vi.fn(), {
    setState: (value: { status?: Record<string, unknown> | null }) => { if ("status" in value) fixture.status = value.status ?? null; },
    getState: () => ({ status: fixture.status, setStatus: (value: Record<string, unknown>) => { fixture.status = value; }, setError: fixture.setError }),
  }),
}));
vi.mock("../feature-flags", async original => ({ ...await original<Record<string, unknown>>(), isWikiEnabled: () => true }));

import { WorkbenchSupervisor } from "./components";
import { upsertCustomModel } from "../custom-models";
import { saveWorkbenchModelBinding, WORKBENCH_MODEL_STORAGE_KEY } from "./workbench-model";

const profile = {
  id: "deepseek", label: "DeepSeek",
  baseUrl: "https://api.deepseek.com", model: "deepseek-flash", createdAt: "2026-11-11T00:00:00.000Z",
};
// The session carries the explicit endpoint plus the profile reference — never a key.
const override = { baseUrl: "https://api.deepseek.com", model: "deepseek-flash", profileId: "deepseek" };

describe("graph and organize model lifecycle isolation", () => {
  beforeEach(() => {
    vi.clearAllMocks(); localStorage.clear(); fixture.status = null; fixture.auth.isAuthenticated = true;
    fixture.bind.mockResolvedValue({ scope: "verified-user" });
    fixture.unbind.mockResolvedValue(undefined);
    fixture.setTextModel.mockResolvedValue(undefined);
    fixture.onUpdate.mockResolvedValue(vi.fn());
  });
  afterEach(() => { cleanup(); localStorage.clear(); });
  it("updates only text settings on in-window and cross-window model changes", async () => {
    render(<WorkbenchSupervisor />);
    await waitFor(() => expect(fixture.setTextModel).toHaveBeenCalledWith(null));
    act(() => { upsertCustomModel(profile); saveWorkbenchModelBinding("deepseek"); });
    await waitFor(() => expect(fixture.setTextModel).toHaveBeenLastCalledWith(override));
    const calls = fixture.setTextModel.mock.calls.length;
    act(() => window.dispatchEvent(new StorageEvent("storage", { key: WORKBENCH_MODEL_STORAGE_KEY })));
    await waitFor(() => expect(fixture.setTextModel).toHaveBeenCalledTimes(calls + 1));
    expect(fixture.setTextModel).toHaveBeenLastCalledWith(override);
    expect(fixture.bind).toHaveBeenCalledTimes(1);
    expect(fixture.unbind).not.toHaveBeenCalled();
  });
  it("binds without a model until one is chosen and never forwards a key", async () => {
    render(<WorkbenchSupervisor />);
    await waitFor(() => expect(fixture.bind).toHaveBeenCalledWith(expect.objectContaining({ modelOverride: null })));
    act(() => { upsertCustomModel(profile); saveWorkbenchModelBinding("deepseek"); });
    await waitFor(() => expect(fixture.setTextModel).toHaveBeenLastCalledWith(override));
    for (const [value] of fixture.setTextModel.mock.calls) {
      expect(value === null || !("apiKey" in (value as object))).toBe(true);
    }
  });
  it("applies the latest choice after a slow bind and still cancels work on logout", async () => {
    let bound!: (status: { scope: string }) => void;
    fixture.bind.mockReturnValue(new Promise(resolve => { bound = resolve; }));
    const view = render(<WorkbenchSupervisor />);
    act(() => { upsertCustomModel(profile); saveWorkbenchModelBinding("deepseek"); });
    await act(async () => { bound({ scope: "verified-user" }); });
    expect(fixture.setTextModel).toHaveBeenLastCalledWith(override);
    expect(fixture.bind).toHaveBeenCalledTimes(1);
    expect(fixture.unbind).not.toHaveBeenCalled();
    fixture.auth.isAuthenticated = false;
    view.rerender(<WorkbenchSupervisor />);
    expect(fixture.unbind).toHaveBeenCalled();
  });
});
