import { describe, expect, it } from "vitest";
import {
  CLOUDBASE_AGENT_URL,
  CLOUDBASE_MEMORY_URL,
  agentUrlForApiUrl,
  defaultApiUrlForEdition,
  memoryUrlForApiUrl,
} from "./index";

describe("edition → gateway mapping", () => {
  it("sends each packaged edition to its own production account system", () => {
    // The two editions are separate account systems; DEFAULT_API_URL falls
    // back to this mapping whenever a build forgets NEXT_PUBLIC_API_URL.
    expect(defaultApiUrlForEdition("cn")).toBe("https://api.lynse.cn");
    expect(defaultApiUrlForEdition("intl")).toBe("https://api-en.lynse.ai");
  });
});

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
