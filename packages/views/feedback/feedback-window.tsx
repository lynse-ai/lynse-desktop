"use client";

import { useEffect } from "react";
import { AGENT_API_URL_STORAGE_KEY, CLOUDBASE_AGENT_URL } from "@lynse/core/config";
import { FEEDLOG_BASE_URL } from "./open-feedback";

/**
 * Path on the lynclaw gateway that mints a FeedLog SSO token (HS256 JWT,
 * claims: email + exp) for the signed-in user. The FeedLog org SSO secret
 * lives only on the server; when the endpoint is missing or fails, the
 * widget silently falls back to guest posting (subject to the workspace's
 * Guest access setting).
 */
const SSO_TOKEN_PATH = "/api/feedback/feedlog-token";

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
 * Resolve the lynclaw gateway origin for the SSO token mint. This window
 * renders outside CoreProvider, so the api() client is unavailable — read
 * the persisted agent override and fall back to the production service,
 * mirroring `feedbackBase()` in core/api/feedback.ts.
 */
function resolveAgentBase(): string {
  const override =
    typeof window !== "undefined" ? window.localStorage.getItem(AGENT_API_URL_STORAGE_KEY) : null;
  return (override || CLOUDBASE_AGENT_URL).replace(/\/+$/, "");
}

/**
 * Standalone feature-request window — created by the Rust
 * `open_feedback_window` command for the `?window=feedback` route,
 * mirroring the About window setup.
 *
 * Renders no chrome of its own: the FeedLog widget mounts its launcher and
 * panel at the document level, and `openWidget()` opens the panel
 * programmatically so users land directly on the submission form (SDK 0.2.0
 * retains the instruction even when called before initialization finishes).
 */
export function FeedbackWindow(props: {
  /** Desktop storage accessor (secureStorage) for session + API url. */
  getStoredValue: (key: string) => string | null;
}) {
  const getStoredValue = props.getStoredValue;

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const { createWidget, openWidget } = await import("@feedlog/widget");
      if (cancelled) return;
      createWidget({
        baseUrl: FEEDLOG_BASE_URL,
        // Match the app's current theme rather than the OS, so the panel
        // blends with the window the user opened it from.
        theme: resolveWidgetTheme(),
        auth: {
          getToken: async () => {
            try {
              const token = getStoredValue("lynse_token");
              if (!token) return null;
              const res = await fetch(`${resolveAgentBase()}${SSO_TOKEN_PATH}`, {
                headers: { Authorization: token },
              });
              if (!res.ok) return null;
              const body = (await res.json()) as { token?: string | null; data?: { token?: string | null } };
              // lynclaw may answer bare {token} or a Result envelope {data:{token}}.
              return body?.token ?? body?.data?.token ?? null;
            } catch {
              // No backend endpoint (yet) or offline → guest mode.
              return null;
            }
          },
        },
      });
      openWidget();
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
