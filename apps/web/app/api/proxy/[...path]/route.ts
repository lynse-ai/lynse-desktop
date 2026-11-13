import { NextRequest, NextResponse } from "next/server";

const HOP_HEADERS = [
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
  "te", "trailer", "transfer-encoding", "upgrade",
];

function proxyHeaders(source: Headers, strip: string[]): Headers {
  const headers = new Headers(source);
  const hopHeaders = source.get("connection")?.split(",") ?? [];
  for (const name of [...HOP_HEADERS, ...hopHeaders, ...strip]) {
    const key = name.trim();
    if (/^[!#$%&'*+.^_`|~0-9a-z-]+$/i.test(key)) headers.delete(key);
  }
  return headers;
}

async function handler(req: NextRequest) {
  // No default target: the backend URL has a single source — the address the
  // user entered on the login/API-config page, forwarded in this header.
  const targetUrl = req.headers.get("x-lynse-api-url");
  if (!targetUrl) {
    return NextResponse.json(
      { error: "Missing x-lynse-api-url header" },
      { status: 400 },
    );
  }

  let base: URL;
  try {
    base = new URL(targetUrl);
    if (!["http:", "https:"].includes(base.protocol) || base.username || base.password || base.search || base.hash) {
      throw new Error("Invalid API origin");
    }
  } catch {
    return NextResponse.json({ error: "Invalid API URL" }, { status: 400 });
  }

  const path = req.nextUrl.pathname.replace(/^\/api\/proxy/, "");
  const upstream = `${base.href.replace(/\/+$/, "")}${path}${req.nextUrl.search}`;
  const headers = proxyHeaders(req.headers, ["host", "x-lynse-api-url", "accept-encoding"]);

  const method = req.method;
  const body = method !== "GET" && method !== "HEAD" ? req.body : null;
  const init = { method, headers, signal: req.signal, ...(body && { body, duplex: "half" as const }) };
  let upstreamRes: Response;
  try {
    upstreamRes = await fetch(upstream, init);
  } catch {
    return NextResponse.json({ error: "API server unavailable" }, { status: 502 });
  }
  const resHeaders = proxyHeaders(upstreamRes.headers, ["content-encoding"]);
  // Node fetch exposes the decoded body while preserving upstream headers.
  if (upstreamRes.headers.has("content-encoding")) resHeaders.delete("content-length");

  return new NextResponse(upstreamRes.body, {
    status: upstreamRes.status,
    headers: resHeaders,
  });
}

export const GET = handler;
export const HEAD = handler;
export const POST = handler;
export const PUT = handler;
export const PATCH = handler;
export const DELETE = handler;
