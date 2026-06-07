import { NextRequest, NextResponse } from "next/server";

const DEFAULT_API_URL = "http://119.97.160.133:10060";

async function handler(req: NextRequest) {
  const targetUrl = req.headers.get("x-lynse-api-url") || DEFAULT_API_URL;

  // Build the upstream path
  const path = req.nextUrl.pathname.replace(/^\/api\/proxy/, "");
  const search = req.nextUrl.search;
  const upstream = `${targetUrl.replace(/\/+$/, "")}${path}${search}`;

  // Forward relevant headers, skip hop-by-hop and encoding headers
  const headers = new Headers();
  req.headers.forEach((value, key) => {
    const lower = key.toLowerCase();
    if (
      lower === "host" ||
      lower === "x-lynse-api-url" ||
      lower === "accept-encoding" ||
      lower === "connection" ||
      lower === "keep-alive" ||
      lower === "transfer-encoding"
    )
      return;
    headers.set(key, value);
  });

  const method = req.method;
  const body =
    method !== "GET" && method !== "HEAD" ? await req.arrayBuffer() : undefined;

  const upstreamRes = await fetch(upstream, {
    method,
    headers,
    body,
  });

  // Build response, skip hop-by-hop headers
  const resHeaders = new Headers();
  upstreamRes.headers.forEach((value, key) => {
    const lower = key.toLowerCase();
    if (
      lower === "transfer-encoding" ||
      lower === "connection" ||
      lower === "keep-alive" ||
      lower === "content-encoding"
    )
      return;
    resHeaders.set(key, value);
  });

  return new NextResponse(upstreamRes.body, {
    status: upstreamRes.status,
    headers: resHeaders,
  });
}

export const GET = handler;
export const POST = handler;
export const PUT = handler;
export const PATCH = handler;
export const DELETE = handler;
