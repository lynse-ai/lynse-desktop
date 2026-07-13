import { describe, expect, it } from "vitest";
import { SETTINGS_DIALOG_CONTENT_CLASS } from "./settings-dialog";

describe("settings dialog layout", () => {
  it("keeps the dialog within the viewport and scrolls the content body", () => {
    expect(SETTINGS_DIALOG_CONTENT_CLASS).toContain("max-h-[min(90vh,760px)]");
    expect(SETTINGS_DIALOG_CONTENT_CLASS).toContain("overflow-hidden");
    expect(SETTINGS_DIALOG_CONTENT_CLASS).toContain("grid-rows-[auto_minmax(0,1fr)]");
  });
});
