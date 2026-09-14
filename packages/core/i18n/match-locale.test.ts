import { describe, expect, it } from "vitest";
import { matchLocale } from "./index";

describe("matchLocale", () => {
  it("matches supported locales exactly, case-insensitively", () => {
    expect(matchLocale("en")).toBe("en");
    expect(matchLocale("zh-Hans")).toBe("zh-Hans");
    expect(matchLocale("ZH-HANT")).toBe("zh-Hant");
    expect(matchLocale("ja")).toBe("ja");
    expect(matchLocale("ko")).toBe("ko");
  });

  it("accepts underscore separators", () => {
    expect(matchLocale("zh_CN")).toBe("zh-Hans");
  });

  it("maps regional tags onto their base locale", () => {
    expect(matchLocale("en-US")).toBe("en");
    expect(matchLocale("en-GB")).toBe("en");
    expect(matchLocale("ja-JP")).toBe("ja");
    expect(matchLocale("ko-KR")).toBe("ko");
  });

  it("branches Chinese on region script", () => {
    expect(matchLocale("zh")).toBe("zh-Hans");
    expect(matchLocale("zh-CN")).toBe("zh-Hans");
    expect(matchLocale("zh-SG")).toBe("zh-Hans");
    expect(matchLocale("zh-TW")).toBe("zh-Hant");
    expect(matchLocale("zh-HK")).toBe("zh-Hant");
    expect(matchLocale("zh-MO")).toBe("zh-Hant");
    expect(matchLocale("zh-Hant-HK")).toBe("zh-Hant");
    expect(matchLocale("zh-Hans-CN")).toBe("zh-Hans");
  });

  it("returns null for unsupported languages", () => {
    expect(matchLocale("fr")).toBeNull();
    expect(matchLocale("de-DE")).toBeNull();
    expect(matchLocale("")).toBeNull();
  });
});
