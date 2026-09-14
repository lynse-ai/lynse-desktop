/* @vitest-environment jsdom */

import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { AboutWindow } from "./about-window";

// Regression: the About window renders outside CoreProvider and bootstraps
// i18n itself. The init must happen during render — an uninitialized hook
// captures no i18next instance and never re-renders, leaving raw keys
// ("about.website", "settings.report_issue", …) on screen. The English
// default applies because jsdom's localStorage has no persisted locale.
describe("AboutWindow i18n bootstrap", () => {
  it("renders translated text on the first paint, not raw keys", () => {
    render(<AboutWindow />);

    expect(screen.getByText("Lynse")).toBeTruthy();
    expect(screen.getByText("Website")).toBeTruthy();
    expect(screen.getByText("Terms of Service")).toBeTruthy();
    expect(screen.getByText("Privacy Policy")).toBeTruthy();
    expect(screen.getByText("Report an issue")).toBeTruthy();
  });
});
