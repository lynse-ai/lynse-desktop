#!/usr/bin/env node
/**
 * Langfuse trace report for the real-backend e2e profile.
 *
 * Given a run id (the sessionId convention used by playwright.real-backend
 * config), queries the Langfuse project for matching traces and renders a
 * markdown + JSON summary: turn count, per-trace latency, errors, and tool
 * usage. Exit code 1 when zero traces match — so CI fails a run whose turns
 * never landed server-side.
 *
 * Usage:
 *   node scripts/langfuse-report.mjs --run-id e2e-real-20260919-ab12 [--out test-results]
 *   node scripts/langfuse-report.mjs --session-id agent-chat-20260916-233802-8cb7da
 *
 * Credentials come from env (LANGFUSE_HOST / LANGFUSE_PUBLIC_KEY /
 * LANGFUSE_SECRET_KEY) or the local e2e/.env.langfuse file (gitignored).
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

// ── args ────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
function argOf(name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}
const runId = argOf("--run-id");
const sessionId = argOf("--session-id");
const outDir = argOf("--out") ?? "test-results";
const limit = Number(argOf("--limit") ?? 50);

if (!runId && !sessionId) {
  console.error("usage: langfuse-report.mjs --run-id <id> | --session-id <id> [--out dir]");
  process.exit(2);
}

// ── credentials ─────────────────────────────────────────────────────────────
let { LANGFUSE_HOST, LANGFUSE_PUBLIC_KEY, LANGFUSE_SECRET_KEY } = process.env;
if (!LANGFUSE_PUBLIC_KEY || !LANGFUSE_SECRET_KEY) {
  const envFile = join(here, "..", ".env.langfuse");
  if (existsSync(envFile)) {
    for (const line of readFileSync(envFile, "utf8").split("\n")) {
      const m = /^([A-Z_]+)=(.+)$/.exec(line.trim());
      if (!m || line.trim().startsWith("#")) continue;
      if (m[1] === "LANGFUSE_HOST") LANGFUSE_HOST ??= m[2];
      if (m[1] === "LANGFUSE_PUBLIC_KEY") LANGFUSE_PUBLIC_KEY ??= m[2];
      if (m[1] === "LANGFUSE_SECRET_KEY") LANGFUSE_SECRET_KEY ??= m[2];
    }
  }
}
if (!LANGFUSE_HOST || !LANGFUSE_PUBLIC_KEY || !LANGFUSE_SECRET_KEY) {
  console.error("Langfuse credentials missing: set LANGFUSE_HOST/PUBLIC_KEY/SECRET_KEY or create e2e/.env.langfuse");
  process.exit(2);
}

const auth = Buffer.from(`${LANGFUSE_PUBLIC_KEY}:${LANGFUSE_SECRET_KEY}`).toString("base64");
async function langfuseGet(path) {
  const res = await fetch(`${LANGFUSE_HOST}${path}`, {
    headers: { Authorization: `Basic ${auth}` },
  });
  if (!res.ok) throw new Error(`Langfuse ${path} → ${res.status} ${await res.text()}`);
  return res.json();
}

// ── query ───────────────────────────────────────────────────────────────────
const targetSession = sessionId ?? runId;
const list = await langfuseGet(
  `/api/public/traces?sessionId=${encodeURIComponent(targetSession)}&limit=${limit}`,
);
const traces = list.data ?? [];
if (traces.length === 0) {
  console.error(`No Langfuse traces found for sessionId "${targetSession}".`);
  process.exit(1);
}

// Observations carry model calls / tool spans with latencies.
const detailed = [];
for (const trace of traces.slice(0, 10)) {
  const obs = await langfuseGet(`/api/public/observations?traceId=${trace.id}&limit=100`);
  const observations = obs.data ?? [];
  detailed.push({
    id: trace.id,
    name: trace.name,
    timestamp: trace.timestamp,
    latencyMs: trace.latency != null ? Math.round(trace.latency * 1000) : null,
    totalCost: trace.totalCost,
    observationCount: observations.length,
    models: [...new Set(observations.map((o) => o.model).filter(Boolean))],
    toolNames: [
      ...new Set(
        observations
          .filter((o) => o.type === "TOOL_CALL" || /tool/i.test(o.name ?? ""))
          .map((o) => o.name),
      ),
    ],
    errorCount: observations.filter((o) => o.level === "ERROR").length,
  });
}

const summary = {
  sessionId: targetSession,
  host: LANGFUSE_HOST,
  traceCount: traces.length,
  traces: detailed,
  generatedAt: new Date().toISOString(),
};

mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, "langfuse-report.json"), JSON.stringify(summary, null, 2));

const lines = [
  `# Langfuse report — \`${targetSession}\``,
  "",
  `- host: ${LANGFUSE_HOST}`,
  `- traces: ${traces.length}`,
  `- generated: ${summary.generatedAt}`,
  "",
  "| trace | time | latency | observations | models | errors |",
  "| --- | --- | --- | --- | --- | --- |",
  ...detailed.map(
    (t) =>
      `| ${t.name} | ${t.timestamp} | ${t.latencyMs ?? "?"}ms | ${t.observationCount} | ${t.models.join(", ") || "-"} | ${t.errorCount} |`,
  ),
  "",
];
writeFileSync(join(outDir, "langfuse-report.md"), lines.join("\n"));
console.log(lines.join("\n"));
console.log(`written: ${outDir}/langfuse-report.{md,json}`);
