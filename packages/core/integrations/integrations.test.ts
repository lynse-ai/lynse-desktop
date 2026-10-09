import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../api/client";

const apiMocks = vi.hoisted(() => ({
  get: vi.fn(),
  getWithParams: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  delete: vi.fn(),
  // The Connections BFF origin override (lynse_integrations_api_url); tests
  // run with it unset, so calls still carry their integration auth scope.
  getIntegrationsBaseUrl: vi.fn(() => null),
}));

vi.mock("../api/client", async () => {
  const actual = await vi.importActual<typeof import("../api/client")>("../api/client");
  return {
    ...actual,
    api: () => apiMocks,
  };
});

const {
  disconnectAccount,
  exportActionItems,
  requestOAuthState,
  setDefaultDestination,
} = await import("./api");
const {
  INTEGRATIONS_ERROR,
  isNoDestinationError,
  isNotConfiguredError,
  isRequiresProError,
  isIntegrationAuthError,
} = await import("./errors");

beforeEach(() => {
  vi.clearAllMocks();
});

describe("integrations api", () => {
  it("encodes the provider into the v2 path", async () => {
    apiMocks.get.mockResolvedValue({ connected: false, accounts: [] });
    await requestOAuthState("google-calendar", { platform: "desktop", origin: undefined });
    expect(apiMocks.getWithParams).toHaveBeenCalledWith(
      "/api/v2/integrations/google-calendar/oauth-state",
      { platform: "desktop", origin: undefined },
      { authScope: "integration" },
    );
  });

  it("carries the account id in the query string, since delete() takes no options", async () => {
    apiMocks.delete.mockResolvedValue({ connected: false, remaining: 0 });
    await disconnectAccount("todoist", "acct/2");
    expect(apiMocks.delete).toHaveBeenCalledWith(
      "/api/v2/integrations/todoist/disconnect?account_id=acct%2F2",
      { authScope: "integration" },
    );
  });

  it("sends the destination under the provider-specific field", async () => {
    apiMocks.put.mockResolvedValue({ ok: true, destination_id: "proj-1" });
    await setDefaultDestination("todoist", { account_id: "a1", destination_id: "proj-1" });
    expect(apiMocks.put).toHaveBeenCalledWith(
      "/api/v2/integrations/todoist/default-destination",
      {
        account_id: "a1",
        destination_id: "proj-1",
      },
      { authScope: "integration" },
    );
  });

  it("posts the export payload through", async () => {
    apiMocks.post.mockResolvedValue({ succeeded: [], failed: [] });
    await exportActionItems("google-tasks", {
      action_item_ids: ["t1"],
      default_task_list_id: "list-1",
    });
    expect(apiMocks.post).toHaveBeenCalledWith(
      "/api/v2/integrations/google-tasks/export",
      {
        action_item_ids: ["t1"],
        default_task_list_id: "list-1",
      },
      { authScope: "integration" },
    );
  });
});

describe("error predicates", () => {
  it("recognises service auth failures without treating outages or plan limits as expired connections", () => {
    for (const status of [401, 2000, 2013]) {
      expect(isIntegrationAuthError(new ApiError(status, "expired"))).toBe(true);
    }
    expect(isIntegrationAuthError(INTEGRATIONS_ERROR.UNAUTHORIZED)).toBe(true);
    expect(isIntegrationAuthError(new ApiError(503, "unavailable"))).toBe(false);
    expect(isIntegrationAuthError(new ApiError(403, INTEGRATIONS_ERROR.REQUIRES_PRO))).toBe(false);
  });
  it("requires both the 403 status and the pro key", () => {
    expect(isRequiresProError(new ApiError(403, INTEGRATIONS_ERROR.REQUIRES_PRO))).toBe(true);
    // A 403 for some other reason must not render the paywall copy.
    expect(isRequiresProError(new ApiError(403, "error.auth.forbidden"))).toBe(false);
    // Nor a pro key arriving with the wrong status.
    expect(isRequiresProError(new ApiError(500, INTEGRATIONS_ERROR.REQUIRES_PRO))).toBe(false);
  });

  it("treats any 503 as not-configured", () => {
    expect(isNotConfiguredError(new ApiError(503, "anything"))).toBe(true);
    expect(isNotConfiguredError(new ApiError(502, "anything"))).toBe(false);
  });

  it("recognises the missing-destination bounce by key alone", () => {
    expect(isNoDestinationError(new ApiError(409, INTEGRATIONS_ERROR.NO_DESTINATION))).toBe(true);
    expect(isNoDestinationError(new Error("unrelated"))).toBe(false);
  });
});
