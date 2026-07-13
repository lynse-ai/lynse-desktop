import { describe, expect, it } from "vitest";
import { getDisplayTitle } from "./title-edit-state";

describe("getDisplayTitle", () => {
  it("uses the selected meeting title when an edit belongs to another meeting", () => {
    expect(
      getDisplayTitle("meeting-2", "商务销售会议", {
        itemId: "meeting-1",
        title: "",
      }),
    ).toBe("商务销售会议");
  });

  it("falls back to the selected item title when the list lookup has no title", () => {
    expect(getDisplayTitle("meeting-2", null, null, "06-25 产品：硬件文件同步功能设计")).toBe(
      "06-25 产品：硬件文件同步功能设计",
    );
  });
});
