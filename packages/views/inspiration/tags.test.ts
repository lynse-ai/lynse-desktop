import { describe, expect, it } from "vitest";
import { collectTags, parseHashtags, splitByHashRuns, splitByHashtags } from "./tags";

describe("parseHashtags", () => {
  it("extracts simple latin tags", () => {
    expect(parseHashtags("hello #world foo")).toEqual(["world"]);
  });

  it("extracts multiple distinct tags and dedupes", () => {
    expect(parseHashtags("#a and #b plus #a again")).toEqual(["a", "b"]);
  });

  it("supports CJK tags without spaces", () => {
    expect(parseHashtags("今天开了个会#会议纪要，记得跟进")).toEqual(["会议纪要"]);
  });

  it("supports mixed CJK and latin tags", () => {
    expect(parseHashtags("#产品 #roadmap Q3 计划")).toEqual(["产品", "roadmap"]);
  });

  it("ignores hashes glued to latin words or url fragments", () => {
    expect(parseHashtags("anchor in url https://example.com/#section")).toEqual([]);
    expect(parseHashtags("glued#inside")).toEqual([]);
    expect(parseHashtags("nested ##double")).toEqual(["#double"]);
  });

  it("allows numeric tags after a boundary (flomo behaviour)", () => {
    expect(parseHashtags("issue #123")).toEqual(["123"]);
  });

  it("supports hash at start of text and after punctuation", () => {
    expect(parseHashtags("#起步")).toEqual(["起步"]);
    expect(parseHashtags("（括号内)#标签：后跟标点")).toEqual(["标签"]);
  });

  it("returns empty for hash alone", () => {
    expect(parseHashtags("a # b")).toEqual([]);
    expect(parseHashtags("#")).toEqual([]);
  });

  it("stops tags at western punctuation", () => {
    expect(parseHashtags("see #tag, then done")).toEqual(["tag"]);
  });
});

describe("splitByHashtags", () => {
  it("splits plain and tag segments", () => {
    expect(splitByHashtags("idea #tag end")).toEqual([
      { text: "idea ", tag: null },
      { text: "#tag", tag: "tag" },
      { text: " end", tag: null },
    ]);
  });

  it("keeps a leading tag without leading plain segment", () => {
    expect(splitByHashtags("#tag only")).toEqual([
      { text: "#tag", tag: "tag" },
      { text: " only", tag: null },
    ]);
  });

  it("passes plain text through", () => {
    expect(splitByHashtags("no tags")).toEqual([{ text: "no tags", tag: null }]);
  });
});

describe("collectTags", () => {
  it("unions tags across texts in first-appearance order", () => {
    expect(collectTags(["#b x", "y #a #b"])).toEqual(["b", "a"]);
  });
});

describe("splitByHashRuns", () => {
  it("colors from # to the next whitespace, ignoring preceding characters", () => {
    expect(splitByHashRuns("glued#标签 rest")).toEqual([
      { text: "glued", tag: null },
      { text: "#标签", tag: "标签" },
      { text: " rest", tag: null },
    ]);
  });

  it("keeps punctuation inside the run until whitespace", () => {
    expect(splitByHashRuns("#标签,。 end")).toEqual([
      { text: "#标签,。", tag: "标签,。" },
      { text: " end", tag: null },
    ]);
  });

  it("swallows consecutive hashes into one run", () => {
    expect(splitByHashRuns("x ##double y")).toEqual([
      { text: "x ", tag: null },
      { text: "##double", tag: "#double" },
      { text: " y", tag: null },
    ]);
  });

  it("ignores a lone hash with nothing attached", () => {
    expect(splitByHashRuns("a # b")).toEqual([{ text: "a # b", tag: null }]);
    expect(splitByHashRuns("trailing #")).toEqual([{ text: "trailing #", tag: null }]);
  });

  it("colors a run that ends at end of text", () => {
    expect(splitByHashRuns("note #测试标签")).toEqual([
      { text: "note ", tag: null },
      { text: "#测试标签", tag: "测试标签" },
    ]);
  });
});
