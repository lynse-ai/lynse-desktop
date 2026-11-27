/* @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiClient, setApiInstance, setApiTransportMode } from "@lynse/core/api/client";
import { createAuthStore, registerAuthStore } from "@lynse/core/auth";
import { ApiAuthPanel } from "./api-auth-panel";

// No i18n init in tests: labels render as their t() keys, so assertions
// target the domains shown inside the menu items.
vi.mock("@lynse/core/i18n/react", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

beforeEach(() => {
  localStorage.clear();
  const client = new ApiClient("https://gapp.lynse.cn");
  setApiInstance(client);
  setApiTransportMode("direct");
  const saved = new Map<string, string>();
  registerAuthStore(createAuthStore({ api: client, storage: {
    getItem: (key) => saved.get(key) ?? null,
    setItem: (key, value) => { saved.set(key, value); },
    removeItem: (key) => { saved.delete(key); },
  } }));
});

afterEach(() => {
  cleanup();
  setApiTransportMode("proxy");
  localStorage.clear();
});

describe("merged server + region select", () => {
  it("applies the global site and notifies the host when confirmed", async () => {
    const onRegionChange = vi.fn();
    render(<ApiAuthPanel onRegionChange={onRegionChange} />);
    fireEvent.click(screen.getByTestId("api-server-select"));
    fireEvent.click(screen.getByRole("menuitem", { name: /api-en\.lynse\.ai/ }));
    fireEvent.click(screen.getByRole("button", { name: "auth.api_config_confirm" }));
    await waitFor(() => {
      expect(onRegionChange).toHaveBeenCalledWith("intl");
      expect(localStorage.getItem("lynse_api_url")).toBe("https://api-en.lynse.ai");
    });
  });

  it("applies the test gateway without leaving the cn edition", async () => {
    const onRegionChange = vi.fn();
    render(<ApiAuthPanel onRegionChange={onRegionChange} />);
    fireEvent.click(screen.getByTestId("api-server-select"));
    fireEvent.click(screen.getByRole("menuitem", { name: /gapp\.lynse\.cn/ }));
    fireEvent.click(screen.getByRole("button", { name: "auth.api_config_confirm" }));
    await waitFor(() => {
      expect(onRegionChange).toHaveBeenCalledWith("cn");
      expect(localStorage.getItem("lynse_api_url")).toBe("https://gapp.lynse.cn");
    });
  });

  it("connects straight to the selected site when no confirm was pressed", async () => {
    const onRegionChange = vi.fn();
    render(<ApiAuthPanel onRegionChange={onRegionChange} />);
    fireEvent.click(screen.getByTestId("api-server-select"));
    fireEvent.click(screen.getByRole("menuitem", { name: /api\.lynse\.cn/ }));
    fireEvent.change(screen.getByPlaceholderText("dk-..."), { target: { value: "dk-test" } });
    fireEvent.click(screen.getByRole("button", { name: "auth.api_key_connect" }));
    // The login call itself fails without a mocked backend, but the site
    // switch is applied before it — that is what this test pins down.
    await waitFor(() => {
      expect(onRegionChange).toHaveBeenCalledWith("cn");
      expect(localStorage.getItem("lynse_api_url")).toBe("https://api.lynse.cn");
    });
  });
});
