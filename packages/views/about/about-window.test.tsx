/* @vitest-environment jsdom */

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { AboutWindow } from "./about-window";
import { formatAppBuildLabel, formatAppVersionFull } from "../app-version";

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, "desktopAPI");
});

// Regression: the About window renders outside CoreProvider and bootstraps
// i18n itself. The init must happen during render — an uninitialized hook
// captures no i18next instance and never re-renders, leaving raw keys
// ("about.website", "settings.open_logs_folder", …) on screen. The English
// default applies because jsdom's localStorage has no persisted locale.
describe("AboutWindow i18n bootstrap", () => {
  it("renders translated text on the first paint, not raw keys", () => {
    render(<AboutWindow />);

    expect(screen.getByText("Lynse")).toBeTruthy();
    expect(screen.getByText("Website")).toBeTruthy();
    expect(screen.getByText("Terms of Service")).toBeTruthy();
    expect(screen.getByText("Privacy Policy")).toBeTruthy();
    expect(screen.queryByText("Report an issue")).toBeNull();
  });

  it("renders the build number and commit sha underneath the version", () => {
    Object.assign(window, {
      desktopAPI: {
        appInfo: { version: "1.2.18", build: "107", gitSha: "a3f9c2d", platform: "darwin" },
      },
    });
    render(<AboutWindow />);

    expect(screen.getByText("v1.2.18")).toBeTruthy();
    expect(screen.getByText("Build 107 · a3f9c2d")).toBeTruthy();
  });
});

describe("app version formatting", () => {
  it("formats build label and full version across partial metadata", () => {
    expect(formatAppBuildLabel({ build: "107", gitSha: "a3f9c2d" })).toBe("Build 107 · a3f9c2d");
    expect(formatAppBuildLabel({ build: "107", gitSha: null })).toBe("Build 107");
    expect(formatAppBuildLabel({ build: null, gitSha: "a3f9c2d" })).toBe("a3f9c2d");
    expect(formatAppBuildLabel({ build: null, gitSha: null })).toBeNull();

    expect(formatAppVersionFull({ version: "1.2.18", build: "107", gitSha: "a3f9c2d" })).toBe(
      "v1.2.18 (Build 107 · a3f9c2d)",
    );
    expect(formatAppVersionFull({ version: "1.2.18" })).toBe("v1.2.18");
  });
});
