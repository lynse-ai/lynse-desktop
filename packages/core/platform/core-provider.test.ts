import { describe, expect, it, vi } from "vitest";
import { getAuthStore } from "../auth";
import { api } from "../api/client";
import { initCore } from "./core-provider";
import { CLOUDBASE_AGENT_URL, STAGING_CLOUDBASE_AGENT_URL } from "../config";
import type { AuthSession } from "../auth/session";

function memoryStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    removeItem: (key: string) => void map.delete(key),
  };
}

const session = (accessToken: string): AuthSession => ({
  accessToken,
  user: { id: "u1", name: "U", email: "u1@test.dev" },
});

// initCore is a module-level singleton — bootstrap once; later tests rebuild
// sessions through the store instead of re-initializing.
const storage = memoryStorage();
storage.setItem("lynse_token", "stale-token");
initCore("https://backend.test", storage);

describe("core provider auth wiring", () => {
  it("a 401 drops the whole session so the app falls back to the launch page", async () => {
    // Only a saved access token (no API key): restoreSession trusts it and
    // the gate renders the app — until the backend rejects the credential.
    expect(getAuthStore()!.getState().isAuthenticated).toBe(true);

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("{}", { status: 401 })),
    );
    await expect(api().get("/anything")).rejects.toBeTruthy();
    vi.unstubAllGlobals();

    const state = getAuthStore()!.getState();
    // The AuthGate reacts to `isAuthenticated: false` by rendering the
    // launch page; the dead credential is gone from storage.
    expect(state.isAuthenticated).toBe(false);
    expect(storage.getItem("lynse_token")).toBeNull();
  });

  it("the gateway's HTTP-200 auth envelope (code 2013) drops the session too", async () => {
    // The poll/chat gateway answers missing credentials with a 200 envelope,
    // not a 401 — re-establish a session first, then it must still end.
    getAuthStore()!.getState().completeLogin(session("stale-token-2"));
    expect(getAuthStore()!.getState().isAuthenticated).toBe(true);

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({ code: 2013, msg: "Please provide authentication token", data: null }),
          { status: 200 },
        ),
      ),
    );
    await expect(api().get("/anything")).rejects.toBeTruthy();
    vi.unstubAllGlobals();

    const state = getAuthStore()!.getState();
    expect(state.isAuthenticated).toBe(false);
    expect(storage.getItem("lynse_token")).toBeNull();
  });

  it("heals a saved staging agent url onto the production CloudBase service at boot", async () => {
    // initCore is a module singleton (and its imports are cached), so the
    // boot-heal path needs a fresh module graph with its own storage.
    vi.resetModules();
    const { initCore: freshInit } = await import("./core-provider");
    const { api: freshApi } = await import("../api/client");
    const healStorage = memoryStorage();
    healStorage.setItem("lynse_api_url", "https://gapp.lynse.cn");
    // A device that logged in before the staging shutdown saved this preset.
    healStorage.setItem("lynse_agent_api_url", STAGING_CLOUDBASE_AGENT_URL);
    freshInit("https://backend.test", healStorage);
    expect(freshApi().getAgentBaseUrl()).toBe(CLOUDBASE_AGENT_URL);
    // A hand-typed custom agent URL is left untouched (fresh singleton again).
    vi.resetModules();
    const { initCore: customInit } = await import("./core-provider");
    const { api: customApi } = await import("../api/client");
    const customStorage = memoryStorage();
    customStorage.setItem("lynse_api_url", "https://gapp.lynse.cn");
    customStorage.setItem("lynse_agent_api_url", "https://agent.custom.invalid");
    customInit("https://backend.test", customStorage);
    expect(customApi().getAgentBaseUrl()).toBe("https://agent.custom.invalid");
    vi.resetModules();
  });
});
