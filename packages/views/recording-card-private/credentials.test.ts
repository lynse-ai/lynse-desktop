/* @vitest-environment jsdom */

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_PRODUCT_ID,
  DEFAULT_VENDOR_ID,
  fetchRecordingCardConfig,
  resetRecordingCardConfigCache,
} from "./credentials";

/**
 * Recording-card pairing credentials are issued by the site-matching
 * lynse-agent-auth gateway (`/platform/oauth/api/agent/device/recording-card/credential`).
 * Gateway shells answering plain text must surface a readable error, not a raw
 * JSON.parse failure.
 */

const apiMock = vi.hoisted(() => ({
  baseUrl: "https://api.lynse.cn",
  token: "token-abc" as string | null,
}));

vi.mock("@lynse/core/api", () => ({
  api: () => ({
    getBaseUrl: () => apiMock.baseUrl,
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
  apiMock.baseUrl = "https://api.lynse.cn";
  apiMock.token = "token-abc";
  vi.unstubAllGlobals();
});

describe("recording card credentials fetch", () => {
  it("calls the site-matching lynse-agent-auth gateway with the bearer token", async () => {
    const cases: Array<[string, string]> = [
      ["https://api.lynse.cn", "https://www.lynse.cn"],
      ["https://gapp.lynse.cn", "https://www.lynse.cn"],
      ["https://api-en.lynse.ai", "https://www.lynse.ai"],
    ];
    for (const [apiBase, siteOrigin] of cases) {
      resetRecordingCardConfigCache();
      apiMock.baseUrl = apiBase;
      const fetchMock = stubFetch(JSON.stringify({ password: "paired-key-123" }));
      const config = await fetchRecordingCardConfig();
      expect(config).toEqual({ password: "paired-key-123" });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
      expect(url).toBe(`${siteOrigin}/platform/oauth/api/agent/device/recording-card/credential`);
      expect(init.method).toBe("POST");
      expect((init.headers as Record<string, string>).Authorization).toBe("Bearer token-abc");
    }
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

  it("maps 401 responses to recording_card_account_required", async () => {
    stubFetch(JSON.stringify({ detail: "Sign in again" }), { status: 401, ok: false });
    await expect(fetchRecordingCardConfig()).rejects.toThrow("recording_card_account_required");
  });

  it("invalidates the cached config when the business server base URL changes", async () => {
    const fetchMock = stubFetch(JSON.stringify({ password: "paired-key-123" }));
    await fetchRecordingCardConfig();
    apiMock.baseUrl = "https://api-en.lynse.ai";
    await fetchRecordingCardConfig();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("fails fast without a session or recognized account gateway", async () => {
    const fetchMock = stubFetch("{}");
    apiMock.token = null;
    await expect(fetchRecordingCardConfig()).rejects.toThrow("no signed-in session");
    apiMock.token = "token-abc";
    apiMock.baseUrl = "https://unknown.example.com";
    await expect(fetchRecordingCardConfig()).rejects.toThrow("recording_card_verification_unavailable");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
