import { describe, expect, it } from "vitest";
import { CLOUDBASE_AGENT_URL, CLOUDBASE_MEMORY_URL, agentUrlForApiUrl, memoryUrlForApiUrl } from "./index";

describe("login environment service routing", () => {
  it("routes every gateway to the single production CloudBase deployment", () => {
    // The staging environment was shut down; the test gateway rides production too.
    expect(agentUrlForApiUrl("https://gapp.lynse.cn/")).toBe(CLOUDBASE_AGENT_URL);
    expect(memoryUrlForApiUrl("https://gapp.lynse.cn")).toBe(CLOUDBASE_MEMORY_URL);
    expect(agentUrlForApiUrl("https://api.lynse.cn")).toBe(CLOUDBASE_AGENT_URL);
    expect(memoryUrlForApiUrl("https://api.lynse.cn/")).toBe(CLOUDBASE_MEMORY_URL);
  });

  it("keeps an absent gateway unset and never routes to the shut-down staging hosts", () => {
    expect(agentUrlForApiUrl(null)).toBeNull();
    expect(agentUrlForApiUrl("https://gapp.lynse.cn.other.invalid")).not.toContain("336033");
    expect(memoryUrlForApiUrl("https://gapp.lynse.cn.other.invalid")).not.toContain("336033");
  });
});
