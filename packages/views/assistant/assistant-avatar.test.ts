import { afterEach, describe, expect, it, vi } from "vitest";
import { publicAssetUrl } from "./assistant-avatar";

// Same module-local declaration as the source file (no @types/node here).
declare const process: { env: Record<string, string | undefined> };

describe("publicAssetUrl", () => {
  const original = process.env.NEXT_PUBLIC_BASE_PATH;

  afterEach(() => {
    if (original === undefined) {
      delete process.env.NEXT_PUBLIC_BASE_PATH;
    } else {
      process.env.NEXT_PUBLIC_BASE_PATH = original;
    }
  });

  it("keeps root-relative paths when no base path is set (desktop / default)", () => {
    delete process.env.NEXT_PUBLIC_BASE_PATH;
    expect(publicAssetUrl("/assistant/default.gif")).toBe("/assistant/default.gif");
  });

  it("prefixes the web deployment base path when set", () => {
    process.env.NEXT_PUBLIC_BASE_PATH = "/app";
    expect(publicAssetUrl("/assistant/default.gif")).toBe("/app/assistant/default.gif");
  });

  it("applies the base path to every shipped avatar", async () => {
    process.env.NEXT_PUBLIC_BASE_PATH = "/app";
    vi.resetModules();
    const { ASSISTANT_AVATARS } = await import("./assistant-avatar");
    for (const avatar of ASSISTANT_AVATARS) {
      expect(avatar.src.startsWith("/app/assistant/")).toBe(true);
    }
  });

  it("ships the five mascot GIFs under /assistant/ by default", async () => {
    delete process.env.NEXT_PUBLIC_BASE_PATH;
    vi.resetModules();
    const { ASSISTANT_AVATARS } = await import("./assistant-avatar");
    expect(ASSISTANT_AVATARS.map((a) => a.src)).toEqual([
      "/assistant/default.gif",
      "/assistant/star-hat.gif",
      "/assistant/gentleman-hat.gif",
      "/assistant/bow.gif",
      "/assistant/beret.gif",
    ]);
  });
});
