import { describe, expect, it } from "vitest";

import { canUploadToCloud } from "./membership-entitlement";

describe("canUploadToCloud", () => {
  it.each(["elite", "advanced", "premium"])("allows the %S tier", (memberLevel) => {
    expect(canUploadToCloud({ memberLevel }, null)).toBe(true);
  });

  it("normalizes case and surrounding space", () => {
    expect(canUploadToCloud({ memberLevel: " Advanced " }, null)).toBe(true);
  });

  it.each(["free", "trial", "standard", "basic"])("refuses the %S tier", (memberLevel) => {
    expect(canUploadToCloud({ memberLevel }, null)).toBe(false);
  });

  it("refuses an unknown tier rather than assuming it is paid", () => {
    expect(canUploadToCloud({ memberLevel: "lifetime-founders" }, null)).toBe(false);
  });

  it("refuses when nothing has answered yet", () => {
    expect(canUploadToCloud(undefined, undefined)).toBe(false);
    expect(canUploadToCloud({ memberLevel: "" }, { benefitType: "" })).toBe(false);
  });

  it("falls back to benefitType only when memberLevel is absent", () => {
    expect(canUploadToCloud({}, { benefitType: "elite" })).toBe(true);
    // The explicit level wins, so a free account is not lifted by an older
    // benefit string.
    expect(canUploadToCloud({ memberLevel: "free" }, { benefitType: "elite" })).toBe(false);
  });
});
