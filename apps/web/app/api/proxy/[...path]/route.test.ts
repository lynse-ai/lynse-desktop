import { NextRequest } from "next/server";
import { afterEach, expect, it, vi } from "vitest";
import { GET, POST } from "./route";

afterEach(() => vi.unstubAllGlobals());

it("streams request bodies and forwards cancellation to the upstream", async () => {
  const controller = new AbortController();
  const request = new NextRequest("http://localhost/api/proxy/api/chat/stream?lang=zh", {
    method: "POST",
    headers: { "x-lynse-api-url": "https://example.test", connection: "x-hop", "x-hop": "skip" },
    body: '{"query":"hello"}',
    signal: controller.signal,
  });
  const upstream = vi.fn(async (_url: string, init: RequestInit) => {
    expect(init.body).toBe(request.body);
    expect(init).toMatchObject({ duplex: "half", signal: request.signal });
    expect(new Headers(init.headers).has("x-hop")).toBe(false);
    return new Response("decoded", { headers: { "content-encoding": "gzip", "content-length": "27" } });
  });
  vi.stubGlobal("fetch", upstream);
  const response = await POST(request);
  expect(upstream.mock.calls[0]?.[0]).toBe("https://example.test/api/chat/stream?lang=zh");
  expect(response.headers.has("content-encoding")).toBe(false);
  expect(response.headers.has("content-length")).toBe(false);
  expect(await response.text()).toBe("decoded");
});

it("returns a stable gateway error when the configured upstream is offline", async () => {
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
  const request = new NextRequest("http://localhost/api/proxy/api/file", {
    headers: { "x-lynse-api-url": "https://example.test" },
  });
  const response = await GET(request);
  expect(response.status).toBe(502);
});
