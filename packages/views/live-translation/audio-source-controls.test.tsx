/* @vitest-environment jsdom */

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18next from "i18next";
import { toast } from "sonner";
import { initI18n } from "@lynse/core/i18n";
import { RESOURCES } from "../locales";
import { AudioSourceControls } from "./audio-source-controls";
import { initialLiveTranslationState } from "./state";

vi.mock("sonner", () => ({
  toast: {
    warning: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
  },
}));

const mockApi = {
  getProviderConfig: vi.fn().mockResolvedValue({ audioSource: "both" }),
  permissions: vi.fn().mockResolvedValue({
    microphone: "granted",
    systemAudio: "denied",
    microphoneAvailable: true,
    systemAudioAvailable: false,
    systemAudioRequired: true,
    restartRequired: false,
  }),
};

const mockView: ReturnType<typeof initialLiveTranslationState> = {
  ...initialLiveTranslationState(),
  sessionId: "session-123",
  state: "recording",
  audioSources: ["mic", "system"],
  sourceErrors: { system: "permission" },
  micLevel: 0.5,
  systemLevel: 0,
};

vi.mock("./use-live-translation", () => ({
  useLiveTranslation: () => ({
    api: mockApi,
    view: mockView,
  }),
}));

beforeEach(async () => {
  initI18n({ locale: "zh-Hans", resources: RESOURCES });
  if (i18next.addResourceBundle) {
    i18next.addResourceBundle("zh-Hans", "translation", RESOURCES["zh-Hans"].translation, true, true);
  }
  await i18next.changeLanguage("zh-Hans");
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("AudioSourceControls", () => {
  it("does not fire toast warning in compact mode (dynamic island) when system audio needs permission", () => {
    render(<AudioSourceControls compact />);
    expect(toast.warning).not.toHaveBeenCalled();
  });

  it("renders status text when statusOnly is true", () => {
    render(<AudioSourceControls statusOnly />);
    expect(screen.getByRole("status").textContent).toContain("电脑声音：需要授权");
  });

  it("renders inline warning notice when compact is false", () => {
    render(<AudioSourceControls compact={false} />);
    expect(screen.getByRole("status").textContent).toContain("电脑声音：需要授权");
  });
});
