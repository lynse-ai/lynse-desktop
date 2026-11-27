/* @vitest-environment jsdom */

import React, { createContext, useContext } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ModelConfigCard } from "./model-config-card";
import { loadChatModelSetting, type ModelPreset } from "../workspace/model-override";

const mocks = vi.hoisted(() => ({
  fetchModelPresets: vi.fn<() => Promise<ModelPreset[]>>(),
}));

vi.mock("@lynse/core/i18n/react", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("@lynse/ui/components/ui/select", () => {
  const SelectCtx = createContext<{
    value?: string;
    disabled?: boolean;
    onValueChange?: (value: string) => void;
  }>({});

  function extractId(node: React.ReactNode): string | undefined {
    let found: string | undefined;
    React.Children.forEach(node, (child) => {
      if (found || !React.isValidElement<{ id?: string; children?: React.ReactNode }>(child)) return;
      if (child.props.id) {
        found = child.props.id;
        return;
      }
      if (child.props.children) found = extractId(child.props.children);
    });
    return found;
  }

  return {
    Select: ({
      value,
      disabled,
      onValueChange,
      children,
    }: {
      value?: string;
      disabled?: boolean;
      onValueChange?: (value: string) => void;
      children?: React.ReactNode;
    }) => {
      const id = extractId(children);
      return (
        <SelectCtx.Provider value={{ value, disabled, onValueChange }}>
          <select
            id={id}
            value={value ?? ""}
            disabled={disabled}
            onChange={(e) => onValueChange?.(e.target.value)}
          >
            {children}
          </select>
        </SelectCtx.Provider>
      );
    },
    SelectTrigger: () => null,
    SelectValue: () => null,
    SelectContent: ({ children }: { children?: React.ReactNode }) => {
      useContext(SelectCtx);
      return <>{children}</>;
    },
    SelectItem: ({ value, children }: { value: string; children?: React.ReactNode }) => (
      <option value={value}>{children}</option>
    ),
  };
});

vi.mock("../workspace/model-override", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../workspace/model-override")>();
  return {
    ...actual,
    fetchModelPresets: mocks.fetchModelPresets,
  };
});

const PRESETS: ModelPreset[] = [
  {
    id: "deepseek-official",
    label: "DeepSeek 官方",
    baseUrl: "https://api.deepseek.com/responses",
    models: ["deepseek-flash"],
    defaultModel: "deepseek-flash",
    requiresApiKey: false,
    note: "Official DeepSeek endpoint",
  },
  {
    id: "miaoyun-maas",
    label: "秒云 MaaS",
    baseUrl: "https://maas.example.com",
    models: ["qwen-max"],
    defaultModel: "qwen-max",
    requiresApiKey: false,
  },
];

beforeEach(() => {
  window.localStorage.clear();
  mocks.fetchModelPresets.mockResolvedValue(PRESETS);
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  vi.restoreAllMocks();
});

describe("ModelConfigCard", () => {
  it("lets the user pick a built-in model directly without choosing a provider preset", async () => {
    render(<ModelConfigCard />);
    await waitFor(() => expect(mocks.fetchModelPresets).toHaveBeenCalled());

    fireEvent.change(screen.getByLabelText("settings.model_mode_label"), {
      target: { value: "preset" },
    });

    expect(screen.queryByLabelText("settings.model_preset_label")).toBeNull();
    expect(screen.queryByText("DeepSeek 官方")).toBeNull();
    expect(screen.queryByText("秒云 MaaS")).toBeNull();
    expect(screen.queryByText("Official DeepSeek endpoint")).toBeNull();

    const modelSelect = await screen.findByLabelText("settings.model_model_label");
    expect(loadChatModelSetting()).toEqual({
      mode: "preset",
      presetId: "deepseek-official",
      model: "deepseek-flash",
    });

    fireEvent.change(modelSelect, { target: { value: "qwen-max" } });

    expect(loadChatModelSetting()).toEqual({
      mode: "preset",
      presetId: "miaoyun-maas",
      model: "qwen-max",
    });
  });
});
