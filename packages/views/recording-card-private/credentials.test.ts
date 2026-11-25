/* @vitest-environment jsdom */

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_PRODUCT_ID,
  DEFAULT_VENDOR_ID,
  fetchRecordingCardConfig,
  resetRecordingCardConfigCache,
} from "./credentials";

/**
 * The credentials fetch must target the lynclaw assistant origin (its own
 * CloudRun host, reached via the client's agent base URL) — the account API
 * base routes /api/desktop/* to a different backend that never reaches
 * lynclaw. Gateway shells answering plain text must surface a readable
 * error, not a raw JSON.parse failure.
 */

const apiMock = vi.hoisted(() => ({
  agentBase: "https://lynclaw-api.example.sh.run.tcloudbase.com",
  token: "token-abc" as string | null,
}));

vi.mock("@lynse/core/api", () => ({
  api: () => ({
    getAgentBaseUrl: () => apiMock.agentBase,
    getToken: () => apiMock.token,
  }),
}));

function stubFetch(body: string, init?: { status?: number; ok?: boolean }) {
  const fetchMock = vi.fn(async () => new Response(body, {
    status: init?.status ?? 200,
    headers: { "Content-Type": "application/json" },
  }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

beforeEach(() => {
  resetRecordingCardConfigCache();
  apiMock.agentBase = "https://lynclaw-api.example.sh.run.tcloudbase.com";
  apiMock.token = "token-abc";
  vi.unstubAllGlobals();
});

describe("recording card credentials fetch", () => {
  it("calls the lynclaw agent origin with the bearer token", async () => {
    const fetchMock = stubFetch(JSON.stringify({ password: "paired-key-123" }));
    const config = await fetchRecordingCardConfig();
    expect(config).toEqual({ password: "paired-key-123" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://lynclaw-api.example.sh.run.tcloudbase.com/api/desktop/recording-card/config");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer token-abc");
  });

  it("prefills descriptors only when both halves arrive", async () => {
    stubFetch(JSON.stringify({ password: "paired-key-123", vendorId: 0x3654, productId: 0x4155 }));
    const config = await fetchRecordingCardConfig();
    expect(config).toMatchObject({ vendorId: 0x3654, productId: 0x4155 });
    // Reference defaults stay exported for the page inputs.
    expect(DEFAULT_VENDOR_ID).toBe(0x3654);
    expect(DEFAULT_PRODUCT_ID).toBe(0x4155);
  });

  it("reports a readable error when a gateway answers with plain text", async () => {
    stubFetch("gateway.internal error");
    await expect(fetchRecordingCardConfig()).rejects.toThrow(/non-JSON response: gateway\.internal/);
  });

  it("surfaces the server detail on http errors", async () => {
    stubFetch(JSON.stringify({ detail: "Recording card access is not configured on this server yet" }), { status: 404, ok: false });
    await expect(fetchRecordingCardConfig()).rejects.toThrow("not configured on this server");
  });

  it("maps the server-side no-binding denial to the localizable code", async () => {
    stubFetch(JSON.stringify({ detail: "recording_card_not_bound" }), { status: 403, ok: false });
    await expect(fetchRecordingCardConfig()).rejects.toThrow("recording_card_not_bound");
  });

  it("fails fast without a session or agent address", async () => {
    const fetchMock = stubFetch("{}");
    apiMock.token = null;
    await expect(fetchRecordingCardConfig()).rejects.toThrow("no signed-in session");
    apiMock.token = "token-abc";
    apiMock.agentBase = "";
    await expect(fetchRecordingCardConfig()).rejects.toThrow("assistant service address is not ready");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
