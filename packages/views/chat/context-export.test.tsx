/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ApiClient, setApiInstance, setApiTransportMode } from "@lynse/core/api/client";
import { ChatAttachments } from "./chat-attachments";

const error = vi.hoisted(() => vi.fn());
vi.mock("sonner", () => ({ toast: { error, success: vi.fn() } }));
vi.mock("@lynse/core/i18n/react", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  setApiTransportMode("proxy");
  error.mockClear();
});

describe("protected context review card", () => {
  it("requires current authentication and does not fall back to opening a revoked export URL", async () => {
    const client = new ApiClient("https://business.invalid");
    client.setAgentBaseUrl("https://agent.invalid");
    client.setToken("test-session");
    client.setApiKey("test-api-key");
    setApiInstance(client);
    setApiTransportMode("direct");
    const fetchMock = vi.fn().mockResolvedValue(new Response("revoked source", { status: 409 }));
    vi.stubGlobal("fetch", fetchMock);
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    render(<ChatAttachments attachments={[{ name: "goal-review.md", type: "file", downloadUrl: "/api/context/goals/goal-1/export" }]} />);
    fireEvent.click(screen.getByRole("button", { name: /goal-review\.md/ }));
    await waitFor(() => expect(error).toHaveBeenCalled());
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://agent.invalid/api/context/goals/goal-1/export");
    expect(fetchMock.mock.calls[0]?.[1].headers.Authorization).toBe("test-session");
    expect(fetchMock.mock.calls[0]?.[1].headers["X-API-Key"]).toBeUndefined();
    expect(open).not.toHaveBeenCalled();
    client.setToken(null);
    fireEvent.click(screen.getByRole("button", { name: /goal-review\.md/ }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(open).not.toHaveBeenCalled();
  });
});
