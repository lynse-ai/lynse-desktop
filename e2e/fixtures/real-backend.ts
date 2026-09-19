import type { Page } from "@playwright/test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Real-backend bootstrap: same localStorage contract as the mock suite
 * (lynse_api_url + lynse_token) but pointed at the LIVE API.
 */
export function bootstrapRealBackend(page: Page): void {
  const apiUrl = process.env.LYNSE_E2E_API_URL ?? "https://api.lynse.cn";
  const token = process.env.LYNSE_E2E_TOKEN;
  if (!token) throw new Error("LYNSE_E2E_TOKEN is required for the real-backend profile");
  page.addInitScript(
    ([url, tok]) => {
      localStorage.setItem("lynse_api_url", url!);
      localStorage.setItem("lynse_token", tok!);
      localStorage.setItem("lynse_locale", "en");
    },
    [apiUrl, token],
  );
}

/**
 * Rewrite every chat submit's sessionId to `<runId>-<n>` and record the
 * mapping. The backend threads the caller sessionId into its lynclaw
 * Langfuse traces, so this makes each run queryable by one id via
 * scripts/langfuse-report.mjs.
 */
export function tagChatSessionsWithRunId(page: Page, runId: string): void {
  const mappingFile = join(process.cwd(), "test-results", "langfuse-session-ids.json");
  const readMap = (): Record<string, string> => {
    try {
      return existsSync(mappingFile)
        ? (JSON.parse(readFileSync(mappingFile, "utf8")) as Record<string, string>)
        : {};
    } catch {
      return {};
    }
  };
  let counter = readMap().__next ?? 1;

  const rewrite = (body: string | null): string | null => {
    if (!body) return body;
    try {
      const parsed = JSON.parse(body) as Record<string, unknown>;
      if (typeof parsed.sessionId !== "string" || parsed.sessionId.startsWith(runId)) {
        return body;
      }
      const tagged = `${runId}-${counter++}`;
      const map = readMap();
      map[parsed.sessionId] = tagged;
      map.__next = counter;
      writeFileSync(mappingFile, JSON.stringify(map, null, 2));
      parsed.sessionId = tagged;
      return JSON.stringify(parsed);
    } catch {
      return body;
    }
  };

  void page.route(/ai\/chat\/(poll|stream)/, async (route) => {
    const request = route.request();
    if (request.method() === "POST") {
      await route.continue({
        postData: rewrite(request.postData()),
      });
    } else {
      await route.continue();
    }
  });
}

export function realRunId(): string {
  return (
    process.env.LYNSE_RUN_ID ??
    `e2e-real-${new Date().toISOString().slice(0, 10).replaceAll("-", "")}-${Math.random()
      .toString(16)
      .slice(2, 6)}`
  );
}

export function appendChatNotes(text: string): void {
  const dir = join(process.cwd(), "test-results");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "real-backend-notes.md"), `${text}\n`, { flag: "a" });
}
