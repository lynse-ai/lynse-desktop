"use client";

import { useEffect } from "react";
import { FEEDBACK_BOARD_URL } from "./open-feedback";

/**
 * Path on the Lynse backend that mints a FeedLog SSO token (HS256 JWT) for
 * the signed-in user (dting-auth FeedLogController, Result envelope). The
 * SSO secret lives only on the server; when the endpoint is missing or
 * fails, the widget silently falls back to guest posting (subject to the
 * workspace's Guest actions setting).
 */
const SSO_TOKEN_PATH = "/api/auth/feedlog/token";

/**
 * Resolve the app's current theme for the widget iframe. The main window
 * stores next-themes' setting ("light" | "dark" | "system") in localStorage
 * under the default "theme" key, which this window shares. The widget only
 * accepts the theme at iframe creation, so a mid-session switch in the main
 * window is picked up on the next time the window is opened.
 */
function resolveWidgetTheme(): "light" | "dark" {
  const stored = typeof window !== "undefined" ? window.localStorage.getItem("theme") : null;
  if (stored === "light" || stored === "dark") return stored;
  const dark = typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: dark)").matches;
  return dark ? "dark" : "light";
}

/**
 * Standalone feature-request window — created by the Rust
 * `open_feedback_window` command for the `?window=feedback` route,
 * mirroring the About window setup.
 *
 * Renders no chrome of its own: the FeedLog widget mounts its launcher and
 * panel at the document level, and the panel is opened programmatically so
 * users land directly on the submission form.
 */
export function FeedbackWindow(props: {
  /** Desktop storage accessor (secureStorage) for session + API url. */
  getStoredValue: (key: string) => string | null;
}) {
  const getStoredValue = props.getStoredValue;

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const { createWidget } = await import("@feedlog/widget");
      if (cancelled) return;
      createWidget({
        baseUrl: FEEDBACK_BOARD_URL,
        // Match the app's current theme rather than the OS, so the panel
        // blends with the window the user opened it from.
        theme: resolveWidgetTheme(),
        auth: {
          getToken: async () => {
            try {
              const token = getStoredValue("lynse_token");
              const apiUrl = getStoredValue("lynse_api_url");
              if (!token || !apiUrl) return null;
              const res = await fetch(`${apiUrl}${SSO_TOKEN_PATH}`, {
                headers: { Authorization: token },
              });
              if (!res.ok) return null;
              const body = (await res.json()) as { data?: { token?: string | null } };
              return body.data?.token ?? null;
            } catch {
              // No backend endpoint (yet) or offline → guest mode.
              return null;
            }
          },
        },
      });
      // The SDK has no programmatic open, so the panel must be opened by
      // "clicking" the launcher inside its open shadow root. It mounts
      // asynchronously (after the branding fetch), hence the retry poll;
      // the visibility check keeps double effects from toggle-closing it.
      const openPanel = (attempts: number) => {
        if (cancelled) return;
        const root = document.getElementById("feedlog-widget")?.shadowRoot;
        const panel = root?.querySelector<HTMLElement>(".panel");
        if (root && panel && !panel.hidden) return;
        const launcher = root?.querySelector<HTMLElement>(".launcher");
        if (launcher) {
          launcher.click();
          return;
        }
        if (attempts > 0) window.setTimeout(() => openPanel(attempts - 1), 150);
      };
      openPanel(40);
    })();
    return () => {
      cancelled = true;
    };
    // The widget is created once per page; getStoredValue is stable storage
    // access and is intentionally excluded.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <div className="h-screen bg-background text-foreground" />;
}
