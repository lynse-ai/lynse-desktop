import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { computeSpecSha256, resolveSttRuntime } = require("../scripts/resolve-stt-runtime.cjs") as {
  computeSpecSha256: (repoRoot?: string) => string;
  resolveSttRuntime: (opts: {
    platform: string;
    repoRoot?: string;
    manifestPath?: string;
    updatesBase?: string;
    forceRebuild?: boolean;
    skipProbe?: boolean;
    probeUrl?: (url: string) => Promise<number | string>;
  }) => Promise<{
    mode: "reuse" | "rebuild";
    tag?: string;
    sha256?: string;
    shaEnvVar?: string;
    url?: string;
    specSha256: string;
    reason: string;
  }>;
};

const tempDirs: string[] = [];

function writeTempManifest(payload: unknown): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lynse-stt-runtime-test-"));
  tempDirs.push(dir);
  const file = path.join(dir, "stt-runtime.json");
  fs.writeFileSync(file, typeof payload === "string" ? payload : JSON.stringify(payload), "utf8");
  return file;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("resolve-stt-runtime", () => {
  it("reuses the checked-in manifest when the mirror archive returns HTTP 200", async () => {
    const probed: string[] = [];
    const result = await resolveSttRuntime({
      platform: "windows-x86_64",
      updatesBase: "https://dl.lynse.cn/updates",
      probeUrl: async (url) => {
        probed.push(url);
        return 200;
      },
    });
    expect(result.mode).toBe("reuse");
    expect(result.tag).toMatch(/^v\d+\.\d+\.\d+/);
    expect(result.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(result.shaEnvVar).toBe("LYNSE_RUNTIME_SHA_WINDOWS_X86_64");
    expect(probed).toEqual([
      `https://dl.lynse.cn/updates/${result.tag}/lynse-stt-runtime-windows-x86_64.tar.gz`,
    ]);
  });

  it("rebuilds when the STT sidecar spec hash no longer matches the pinned manifest", async () => {
    const manifestPath = writeTempManifest({
      tag: "v1.2.18",
      specSha256: "0".repeat(64),
      platforms: { "macos-aarch64": { sha256: "a".repeat(64) } },
    });
    const result = await resolveSttRuntime({
      platform: "macos-aarch64",
      manifestPath,
      probeUrl: async () => 200,
    });
    expect(result.mode).toBe("rebuild");
    expect(result.reason).toContain("spec changed");
  });

  it("rebuilds when forced or when the pinned mirror URL is unreachable", async () => {
    const specSha256 = computeSpecSha256();
    const manifestPath = writeTempManifest({
      tag: "v1.2.18",
      specSha256,
      platforms: { "macos-aarch64": { sha256: "a".repeat(64) } },
    });

    const forced = await resolveSttRuntime({
      platform: "macos-aarch64",
      manifestPath,
      forceRebuild: true,
      probeUrl: async () => 200,
    });
    expect(forced.mode).toBe("rebuild");
    expect(forced.reason).toContain("forced");

    const missingOnMirror = await resolveSttRuntime({
      platform: "macos-aarch64",
      manifestPath,
      probeUrl: async () => 404,
    });
    expect(missingOnMirror.mode).toBe("rebuild");
    expect(missingOnMirror.reason).toContain("404");
  });

  it("rebuilds when the platform digest is absent or malformed", async () => {
    const manifestPath = writeTempManifest({
      tag: "v1.2.18",
      specSha256: computeSpecSha256(),
      platforms: { "macos-aarch64": { sha256: "not-a-sha" } },
    });
    const result = await resolveSttRuntime({
      platform: "macos-aarch64",
      manifestPath,
      probeUrl: async () => 200,
    });
    expect(result.mode).toBe("rebuild");
    expect(result.reason).toContain("sha256");
  });
});
