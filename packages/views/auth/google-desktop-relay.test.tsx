/* @vitest-environment jsdom */

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  completeGoogleBrowserRedirect,
  isGoogleConfigured,
  startGoogleBrowserRedirect,
} from "@lynse/core/auth/google";
import { GoogleDesktopRelay } from "./google-desktop-relay";

vi.mock("@lynse/core/i18n/react", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("@lynse/core/auth/google", async () => {
  const actual = await vi.importActual<typeof import("@lynse/core/auth/google")>(
    "@lynse/core/auth/google",
  );
  return {
    ...actual,
    isGoogleConfigured: vi.fn(() => true),
    completeGoogleBrowserRedirect: vi.fn(async () => null),
    startGoogleBrowserRedirect: vi.fn(async () => {}),
  };
});

let assignSpy: ReturnType<typeof vi.fn<(url: string) => void>>;

function setRelayLocation(search: string) {
  assignSpy = vi.fn();
  const parsed = new URL(`https://www.lynse.ai/app/auth/google-desktop${search}`);
  Object.defineProperty(window, "location", {
    configurable: true,
    value: {
      href: parsed.href,
      origin: parsed.origin,
      pathname: parsed.pathname,
      search: parsed.search,
      hash: parsed.hash,
      assign: assignSpy,
    },
  });
}

beforeEach(() => {
  localStorage.clear();
  vi.mocked(isGoogleConfigured).mockReturnValue(true);
  vi.mocked(completeGoogleBrowserRedirect).mockResolvedValue(null);
  vi.mocked(startGoogleBrowserRedirect).mockResolvedValue();
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.clearAllMocks();
});

describe("GoogleDesktopRelay", () => {
  it("starts the Firebase redirect on the initial visit and records the attempted nonce", async () => {
    setRelayLocation("?nonce=nonce-1");
    render(<GoogleDesktopRelay />);

    await waitFor(() => expect(startGoogleBrowserRedirect).toHaveBeenCalledTimes(1));
    expect(localStorage.getItem("lynse_google_desktop_relay_nonce")).toBe("nonce-1");
    expect(localStorage.getItem("lynse_google_desktop_relay_attempted_nonce")).toBe("nonce-1");
    expect(assignSpy).not.toHaveBeenCalled();
  });

  it("fails cleanly instead of looping when getRedirectResult returns null after redirecting", async () => {
    setRelayLocation("?nonce=nonce-1");
    localStorage.setItem("lynse_google_desktop_relay_nonce", "nonce-1");
    localStorage.setItem("lynse_google_desktop_relay_attempted_nonce", "nonce-1");

    render(<GoogleDesktopRelay />);

    await waitFor(() => expect(assignSpy).toHaveBeenCalledTimes(1));
    expect(startGoogleBrowserRedirect).not.toHaveBeenCalled();
    expect(assignSpy).toHaveBeenCalledWith(
      "https://www.lynse.ai/app/auth/google-desktop/done?nonce=nonce-1&error=auth%2Fredirect-result-missing",
    );
    expect(screen.getByText("auth.login_failed")).toBeTruthy();
    expect(screen.getByText("auth/redirect-result-missing")).toBeTruthy();
    expect(localStorage.getItem("lynse_google_desktop_relay_attempted_nonce")).toBeNull();
  });

  it("navigates to the done marker with the identity token and clears relay storage on success", async () => {
    setRelayLocation("?nonce=nonce-2");
    localStorage.setItem("lynse_google_desktop_relay_nonce", "nonce-2");
    localStorage.setItem("lynse_google_desktop_relay_attempted_nonce", "nonce-2");
    vi.mocked(completeGoogleBrowserRedirect).mockResolvedValue("firebase-jwt");

    render(<GoogleDesktopRelay />);

    await waitFor(() => expect(assignSpy).toHaveBeenCalledTimes(1));
    expect(startGoogleBrowserRedirect).not.toHaveBeenCalled();
    expect(assignSpy).toHaveBeenCalledWith(
      "https://www.lynse.ai/app/auth/google-desktop/done?nonce=nonce-2#identityToken=firebase-jwt",
    );
    expect(localStorage.getItem("lynse_google_desktop_relay_nonce")).toBeNull();
    expect(localStorage.getItem("lynse_google_desktop_relay_attempted_nonce")).toBeNull();
  });

  it("allows a fresh attempt with a new nonce after a previous attempt failed", async () => {
    setRelayLocation("?nonce=nonce-1");
    localStorage.setItem("lynse_google_desktop_relay_attempted_nonce", "nonce-1");
    render(<GoogleDesktopRelay />);
    await waitFor(() => expect(assignSpy).toHaveBeenCalledTimes(1));
    cleanup();

    setRelayLocation("?nonce=nonce-3");
    render(<GoogleDesktopRelay />);
    await waitFor(() => expect(startGoogleBrowserRedirect).toHaveBeenCalledTimes(1));
  });
});
