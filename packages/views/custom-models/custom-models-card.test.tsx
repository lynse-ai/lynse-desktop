// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { CustomModelsCard } from "./custom-models-card";
import { getCustomModel, upsertCustomModel } from "./models";
import type { DesktopCustomModelsApi } from "./types";

vi.mock("@lynse/core/i18n/react", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("../workspace/model-override", async (original) => ({
  ...await original<typeof import("../workspace/model-override")>(),
  fetchModelPresets: async () => [],
}));

function setup(id: string) {
  const profile = {
    id,
    label: "My model",
    baseUrl: "https://model.example.test/v1",
    model: "test-model",
    createdAt: "2026-11-11T00:00:00.000Z",
  };
  const customModels = {
    hasKey: vi.fn(async () => true),
    setKey: vi.fn<DesktopCustomModelsApi["setKey"]>().mockResolvedValue(undefined),
    testConnection: vi.fn<DesktopCustomModelsApi["testConnection"]>().mockResolvedValue(undefined),
    complete: vi.fn(async () => "OK"),
  };
  vi.stubGlobal("desktopAPI", { customModels });
  upsertCustomModel(profile);
  const view = render(<CustomModelsCard />);
  return { profile, customModels, view };
}

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.unstubAllGlobals();
});

it("shows a saved model as untested and reports the result of a test and retry", async () => {
  const { profile, customModels, view } = setup("existing-model");
  await screen.findByText("customModels.connection_untested");
  expect(customModels.testConnection).not.toHaveBeenCalled();

  let rejectTest!: (reason: string) => void;
  customModels.testConnection.mockReturnValueOnce(new Promise((_, reject) => { rejectTest = reject; }));
  const testButton = screen.getByRole("button", { name: "customModels.connection_test" });
  fireEvent.click(testButton);
  expect(screen.getByText("customModels.connection_testing")).toBeTruthy();
  expect((testButton as HTMLButtonElement).disabled).toBe(true);
  expect(customModels.testConnection).toHaveBeenCalledWith({
    profileId: profile.id, baseUrl: profile.baseUrl, model: profile.model,
  });
  await act(async () => rejectTest("access_denied"));
  expect(screen.getByRole("alert").textContent).toBe("customModels.connection_access_denied");

  fireEvent.click(testButton);
  await screen.findByText("customModels.connection_passed");
  view.unmount();
  render(<CustomModelsCard />);
  await screen.findByText("customModels.connection_passed");
  expect(customModels.testConnection).toHaveBeenCalledTimes(2);
});

it("tests the updated profile after writing its key and keeps it available when the test fails", async () => {
  const { profile, customModels } = setup("updated-model");
  await screen.findByText("customModels.connection_untested");
  fireEvent.click(screen.getByRole("button", { name: "customModels.edit" }));
  fireEvent.change(screen.getByLabelText("settings.model_model_label"), { target: { value: "updated-id" } });
  fireEvent.change(screen.getByLabelText("settings.model_api_key_label"), { target: { value: "test-key" } });
  customModels.testConnection.mockImplementationOnce(async (endpoint) => {
    expect(customModels.setKey).toHaveBeenCalledWith(profile.id, "test-key");
    expect(getCustomModel(profile.id)?.model).toBe("updated-id");
    expect(endpoint.model).toBe("updated-id");
    throw "timeout";
  });
  fireEvent.click(screen.getByRole("button", { name: "customModels.save_and_test" }));
  await screen.findByText("customModels.connection_timeout");
  expect(getCustomModel(profile.id)?.model).toBe("updated-id");
  expect(screen.getByRole("button", { name: "customModels.connection_test" })).toBeTruthy();
});
