/* @vitest-environment node */
/**
 * Manual real-backend E2E for the WorkBuddy chat pipeline — run on demand,
 * never in CI. Skips unless LYNSE_E2E_TOKEN + LYNSE_E2E_API_URL are set (the
 * values live in e2e/.env.real-backend, gitignored):
 *
 *   set -a; source e2e/.env.real-backend; set +a
 *   pnpm --filter @lynse/views exec vitest run workspace/workbuddy-chat-e2e.realbackend.test.ts
 *
 * Sends one real message through WorkBuddyChatTransport against the test
 * backend's WorkBuddy integration and asserts a real reply comes back.
 */
import { describe, expect, it } from "vitest";

import { ApiClient, api, setApiInstance } from "@lynse/core/api";
import { setApiTransportMode } from "@lynse/core/api/client";
import { WorkBuddyChatTransport, fetchWorkBuddyThreadSlice } from "./workbuddy-chat-transport";
import type { ChatStreamEvent } from "./types";

const envProcess = (globalThis as { process?: { env: Record<string, string | undefined> } })
  .process;
const url = envProcess?.env.LYNSE_E2E_API_URL;
const token = envProcess?.env.LYNSE_E2E_TOKEN;
const hasBackend = !!url && !!token;

describe.skipIf(!hasBackend)("WorkBuddy chat real-backend E2E", () => {
  it("fetches the ticket, sends a message, and receives a real reply", { timeout: 120_000 }, async () => {
    setApiTransportMode("direct");
    setApiInstance(new ApiClient(url!));
    api().setBaseUrl(url!);
    api().setToken(token!);

    // Authorization state through the app's own flow.
    const info = await api().get<{ authorized: boolean }>("/api/auth/workbuddy/token");
    expect(info.authorized).toBe(true);

    const events: ChatStreamEvent[] = [];
    const transport = new WorkBuddyChatTransport();
    await transport.send({
      query: "联调测试：请只回复「收到」两个字，不要做任何其他事。",
      sessionId: "e2e-workbuddy",
      userId: "e2e",
      fileIds: [],
      userSpecifiedFile: false,
      onEvent: (event) => events.push(event),
    });

    const types = events.map((e) => e.type);
    expect(types).not.toContain("error");
    expect(types.at(-1)).toBe("done");
    const done = events.at(-1) as Extract<ChatStreamEvent, { type: "done" }>;
    expect(done.text!.length).toBeGreaterThan(0);

    // The server history must now contain the turn — catch-up slice parses.
    const slice = await fetchWorkBuddyThreadSlice();
    expect(slice.length).toBeGreaterThan(0);
    expect(slice.some((e) => e.role === "assistant" && e.content.length > 0)).toBe(true);
    transport.cancel();
  });
});
