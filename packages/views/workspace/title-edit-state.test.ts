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
});
