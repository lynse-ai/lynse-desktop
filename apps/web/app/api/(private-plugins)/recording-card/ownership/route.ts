import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { defaultApiUrlForEdition, TEST_API_URL } from "@lynse/core/config";

const gateways = new Set([defaultApiUrlForEdition("cn"), defaultApiUrlForEdition("intl"), TEST_API_URL]);
const encoder = new TextEncoder();
let verifier: WebAssembly.Module | undefined;

function reply(status: number) {
  return new Response(null, { status, headers: { "Cache-Control": "no-store" } });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function matchesBinding(authSn: string, bleMac: string, rows: unknown[]) {
  verifier ??= await WebAssembly.compile(
    await readFile(join(process.cwd(), "app/api/(private-plugins)/recording-card/ownership/verify.wasm")),
  );
  const { memory, rc_owner_input_v1: input, rc_owner_match_v1: match } =
    new WebAssembly.Instance(verifier).exports;
  if (!(memory instanceof WebAssembly.Memory) || typeof input !== "function" || typeof match !== "function") {
    throw new Error("Recording card verifier is unavailable");
  }
  const offset: unknown = input();
  if (typeof offset !== "number") throw new Error("Invalid recording card verifier");
  const buffer = new Uint8Array(memory.buffer, offset, 516);

  return rows.some((row) => {
    if (!isRecord(row) || typeof row.macAddress !== "string" || typeof row.bindStatus !== "number") return false;
    if (row.authSn != null && typeof row.authSn !== "string") return false;
    if (!Number.isInteger(row.bindStatus) || (row.bindStatus | 0) !== row.bindStatus) return false;
    const fields = [authSn, bleMac, row.authSn ?? "", row.macAddress];
    if (fields.some((value) => value.includes("\0"))) return false;
    const bytes = encoder.encode(fields.join("\0") + "\0");
    if (bytes.length > buffer.length) return false;
    buffer.set(bytes);
    return match(offset, bytes.length, row.bindStatus) === 1;
  });
}

export async function POST(request: Request) {
  const token = request.headers.get("Authorization")?.trim();
  if (!token) return reply(401);

  const body: unknown = await request.json().catch(() => null);
  if (!isRecord(body) || typeof body.apiBaseUrl !== "string" ||
      typeof body.authSn !== "string" || !body.authSn || body.authSn.length > 128 ||
      typeof body.bleMac !== "string" || !body.bleMac || body.bleMac.length > 128) {
    return reply(400);
  }
  const gateway = body.apiBaseUrl.replace(/\/+$/, "");
  if (!gateways.has(gateway)) return reply(400);

  try {
    const response = await fetch(`${gateway}/api/business/device/mine`, {
      headers: { Authorization: token, "Cache-Control": "no-cache, no-store" },
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(8_000)]),
    });
    if (response.status === 401 || response.status === 403) return reply(401);
    if (!response.ok) return reply(503);
    const payload: unknown = await response.json();
    if (!isRecord(payload)) return reply(503);
    if (payload.code === 2000 || payload.code === 2013) return reply(401);
    if (payload.code !== 200 || !Array.isArray(payload.data)) return reply(503);
    return reply(await matchesBinding(body.authSn, body.bleMac, payload.data) ? 204 : 403);
  } catch {
    return reply(503);
  }
}
