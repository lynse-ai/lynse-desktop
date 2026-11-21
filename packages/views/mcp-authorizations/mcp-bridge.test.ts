import { describe, expect, it } from "vitest";
import { parseConsoleState } from "./mcp-bridge";

const record = {
  authorization_id: "record",
  client_id: "client",
  client_name: "Example agent",
  grant_type: "oauth",
  scopes: ["lynse:read"],
  status: "valid",
  authorized_at: 100,
  expires_at: 200,
};

describe("agent authorization console response", () => {
  it("shows pre-gateway authorizations as MCP with legacy actions", () => {
    const state = parseConsoleState({ user: { name: "Alice" }, csrf: "csrf", authorizations: [record] });
    expect(state.authorizations[0]).toMatchObject({ source: "mcp" });
    expect(state.supportsReset).toBe(false);
    expect(state.supportsDeviceAuthorization).toBe(false);
  });

  it("retains CLI source, reset state, and the account binding", () => {
    const state = parseConsoleState({
      user: { name: "Alice", subject: "42" },
      csrf: "csrf",
      authorizations: [{ ...record, source: "cli", status: "reset_required" }],
      supports_reset: true,
      supports_device_authorization: true,
    });
    expect(state.user?.subject).toBe("42");
    expect(state.authorizations[0]).toMatchObject({ source: "cli", status: "reset_required" });
    expect(state.supportsReset).toBe(true);
    expect(state.supportsDeviceAuthorization).toBe(true);
  });

  it("rejects an unknown authorization source", () => {
    expect(() => parseConsoleState({
      user: { name: "Alice" }, csrf: "csrf", authorizations: [{ ...record, source: "unknown" }],
    })).toThrow("invalid authorization record");
  });
});
