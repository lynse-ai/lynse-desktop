import { describe, expect, it } from "vitest";
import { agentUrlForApiUrl, memoryUrlForApiUrl } from "./index";

describe("login environment service routing", () => {
  it("routes the test gateway to the staging API and memory services", () => {
    expect(agentUrlForApiUrl("https://gapp.lynse.cn/")).toBe(
      "https://lynclaw-api-336033-11-1401959758.sh.run.tcloudbase.com",
    );
    expect(memoryUrlForApiUrl("https://gapp.lynse.cn")).toBe(
      "https://lynse-memory-336033-11-1401959758.sh.run.tcloudbase.com",
    );
  });

  it("routes production to its existing services", () => {
    expect(agentUrlForApiUrl("https://api.lynse.cn")).toBe(
      "https://lynclaw-api-319577-10-1401959758.sh.run.tcloudbase.com",
    );
    expect(memoryUrlForApiUrl("https://api.lynse.cn/")).toBe(
      "https://lynse-memory-319577-10-1401959758.sh.run.tcloudbase.com",
    );
  });

  it("does not select staging by a hostname substring or an empty gateway", () => {
    expect(agentUrlForApiUrl(null)).toBeNull();
    expect(agentUrlForApiUrl("https://gapp.lynse.cn.other.invalid")).not.toContain("336033");
  });
});
