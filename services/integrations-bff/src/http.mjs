/**
 * HTTP helpers shared by every route. Error bodies keep the contract shape
 * `{ code, message: "error.integrations.<key>" }` — the desktop client's error
 * predicates were written against it.
 */

export function respond(res, status, body) {
  const payload = JSON.stringify(body ?? {});
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers":
      "Authorization, Content-Type, X-API-Key, X-Client-Platform, X-Lynse-Api-Url",
    "Cache-Control": "no-store",
  });
  res.end(payload);
}

export const notConfigured = (res, provider) =>
  respond(res, 503, { code: "not_configured", message: "error.integrations.not_configured", provider });

export const notConnected = (res) =>
  respond(res, 409, { code: "not_connected", message: "error.integrations.not_connected" });

export const unauthorized = (res) =>
  respond(res, 401, { code: "unauthorized", message: "error.integrations.unauthorized" });

export async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return {};
  }
}

/** High-entropy opaque id (plan step 5.1: request ids are unguessable). */
export function randomId(prefix = "") {
  return `${prefix}${crypto.randomUUID().replace(/-/g, "")}`;
}
