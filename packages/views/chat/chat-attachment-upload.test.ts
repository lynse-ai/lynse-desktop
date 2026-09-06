import { describe, expect, it } from "vitest";
import {
  attachmentKind,
  formatFileSize,
  isAcceptedAttachment,
  isAttachmentTooLarge,
  mergeContextFileIds,
} from "./chat-attachment-upload";

function file(name: string, type = "", size = 10): File {
  const f = new File(["x"], name, { type });
  // The File constructor derives `size` from the content; override it so the
  // size-cap logic can be tested without a 50 MB blob.
  if (size !== 1) Object.defineProperty(f, "size", { value: size });
  return f;
}

describe("isAcceptedAttachment", () => {
  it("accepts images and documents by extension", () => {
    expect(isAcceptedAttachment(file("photo.png", "image/png"))).toBe(true);
    expect(isAcceptedAttachment(file("notes.md"))).toBe(true);
    expect(isAcceptedAttachment(file("spec.docx"))).toBe(true);
    expect(isAcceptedAttachment(file("report.pdf", "application/pdf"))).toBe(true);
    expect(isAcceptedAttachment(file("data.csv"))).toBe(true);
  });

  it("rejects non-document files like executables and audio", () => {
    expect(isAcceptedAttachment(file("app.exe"))).toBe(false);
    expect(isAcceptedAttachment(file("song.mp3", "audio/mpeg"))).toBe(false);
    expect(isAcceptedAttachment(file("no-extension"))).toBe(false);
  });
});

describe("isAttachmentTooLarge", () => {
  it("rejects files above the 50 MB cap", () => {
    expect(isAttachmentTooLarge(file("a.png", "image/png", 49 * 1024 * 1024))).toBe(false);
    expect(isAttachmentTooLarge(file("a.png", "image/png", 51 * 1024 * 1024))).toBe(true);
  });
});

describe("attachmentKind", () => {
  it("classifies by extension, falling back to the MIME type", () => {
    expect(attachmentKind("a.png", "image/png")).toBe("image");
    expect(attachmentKind("a.pdf", "application/pdf")).toBe("pdf");
    expect(attachmentKind("a.docx")).toBe("doc");
    expect(attachmentKind("noext", "image/webp")).toBe("image");
  });
});

describe("mergeContextFileIds", () => {
  it("merges groups in order, skipping empty ids and duplicates", () => {
    expect(
      mergeContextFileIds([["n1", "n2"], [undefined, "n2", "a1"], ["a1", "n3"]]),
    ).toEqual(["n1", "n2", "a1", "n3"]);
    expect(mergeContextFileIds([])).toEqual([]);
  });
});

describe("formatFileSize", () => {
  it("formats bytes compactly", () => {
    expect(formatFileSize(512)).toBe("512 B");
    expect(formatFileSize(2048)).toBe("2.0 KB");
    expect(formatFileSize(5 * 1024 * 1024)).toBe("5.0 MB");
  });
});
