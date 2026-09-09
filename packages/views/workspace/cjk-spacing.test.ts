import { describe, expect, it } from "vitest";
import { wrapCjkSpacing } from "./cjk-spacing";

describe("wrapCjkSpacing", () => {
  it("wraps CJK runs in spans", () => {
    expect(wrapCjkSpacing("<p>你好world再见</p>")).toBe(
      '<p><span class="cjk-spacing">你好</span>world<span class="cjk-spacing">再见</span></p>',
    );
  });

  it("returns non-CJK html untouched", () => {
    expect(wrapCjkSpacing("<p>hello world</p>")).toBe("<p>hello world</p>");
  });

  it("skips code and pre content", () => {
    expect(wrapCjkSpacing("<pre><code>你好</code></pre>")).toBe("<pre><code>你好</code></pre>");
  });

  it("handles kana and hangul", () => {
    const out = wrapCjkSpacing("<p>こんにちは 안녕</p>");
    expect(out).toContain('<span class="cjk-spacing">こんにちは</span>');
    expect(out).toContain('<span class="cjk-spacing">안녕</span>');
  });

  it("does not touch attributes or empty input", () => {
    expect(wrapCjkSpacing("")).toBe("");
    expect(wrapCjkSpacing('<a title="你好" href="#中文">link</a>')).toBe(
      '<a title="你好" href="#中文">link</a>',
    );
  });
});
