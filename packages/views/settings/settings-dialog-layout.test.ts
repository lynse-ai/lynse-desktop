import { describe, expect, it } from "vitest";
import {
  SETTINGS_DIALOG_CONTENT_CLASS,
  SETTINGS_NAV_CLASS,
  SETTINGS_BODY_CLASS,
} from "./settings-dialog";

describe("settings dialog layout", () => {
  it("keeps the dialog at a fixed size so switching sections never resizes it", () => {
    expect(SETTINGS_DIALOG_CONTENT_CLASS).toContain("sm:max-w-3xl");
    expect(SETTINGS_DIALOG_CONTENT_CLASS).toContain("h-[min(90vh,760px)]");
    expect(SETTINGS_DIALOG_CONTENT_CLASS).not.toContain("max-h-");
    expect(SETTINGS_DIALOG_CONTENT_CLASS).toContain("overflow-hidden");
    expect(SETTINGS_DIALOG_CONTENT_CLASS).toContain("grid-rows-[auto_minmax(0,1fr)]");
  });

  it("uses a two-pane layout with a fixed-width nav and a scrollable body", () => {
    expect(SETTINGS_NAV_CLASS).toContain("shrink-0");
    expect(SETTINGS_NAV_CLASS).toContain("border-e");
    expect(SETTINGS_BODY_CLASS).toContain("flex-1");
    expect(SETTINGS_BODY_CLASS).toContain("overflow-y-auto");
    expect(SETTINGS_BODY_CLASS).toContain("min-h-0");
  });
});
